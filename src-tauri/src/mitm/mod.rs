//! HTTPS 解密 + 重写 (docs/MITM_REWRITE.md).
//!
//! - `rules`: Surge-module parsing, hostname matching, rewrite execution.
//! - `ca`: the local root CA, leaf issuance, key vault, Windows trust store.
//! - `engine`: the loopback MITM listener mihomo routes decrypt hosts to.
//!
//! This file owns the persisted settings (`<app-data>/mitm.json`), the
//! process-wide service, the kernel-config injection and the `mitm:*` IPC.

pub mod ca;
pub mod engine;
pub mod rules;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::IpcError;
use ca::{CaAuthority, KeyVault, TrustStore};
use engine::{EngineShared, UpstreamResolver};
use rules::{CompiledRules, ModuleSource};

pub const PROXY_NAME: &str = "Murge-MITM";
const SETTINGS_FILE: &str = "mitm.json";
const MODULE_SIZE_LIMIT: usize = 2 * 1024 * 1024;
const MODULE_LIMIT: usize = 64;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RewriteModule {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Remote modules carry their source URL; local ones do not.
    pub url: Option<String>,
    pub content: String,
    pub enabled: bool,
    pub updated_at: u64,
    pub error: Option<String>,
}

impl Default for RewriteModule {
    fn default() -> Self {
        RewriteModule {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            url: None,
            content: String::new(),
            enabled: true,
            updated_at: 0,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MitmSettings {
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub rewrite_enabled: bool,
    pub skip_server_cert_verify: bool,
    pub hostnames: Vec<String>,
    /// The user's own module (Surge syntax), edited on the 重写 page.
    pub local_module: String,
    pub modules: Vec<RewriteModule>,
}

impl Default for MitmSettings {
    fn default() -> Self {
        MitmSettings {
            enabled: false,
            rewrite_enabled: true,
            skip_server_cert_verify: false,
            hostnames: Vec::new(),
            local_module: String::new(),
            modules: Vec::new(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The injected rules + proxy, given the decision inputs. Pure, for tests.
pub fn inject_into_document(
    document: &str,
    filters: &[(String, String)],
    port: u16,
    password: &str,
) -> Option<String> {
    if filters.is_empty() {
        return None;
    }
    let mut config = crate::override_apply::parse_yaml_to_object(document)?;
    let source = format!("{}/32", engine::UPSTREAM_SOURCE_IP);
    let mut injected: Vec<Value> = Vec::new();
    for (kind, value) in filters {
        injected.push(json!(format!(
            "AND,((NETWORK,UDP),(DST-PORT,443),({kind},{value})),REJECT"
        )));
    }
    for (kind, value) in filters {
        injected.push(json!(format!(
            "AND,((NETWORK,TCP),({kind},{value}),(NOT,((SRC-IP-CIDR,{source})))),{PROXY_NAME}"
        )));
    }
    let existing = config
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    injected.extend(existing);
    config.insert("rules".into(), Value::Array(injected));

    let mut proxies: Vec<Value> = config
        .get("proxies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|proxy| proxy.get("name").and_then(Value::as_str) != Some(PROXY_NAME))
        .collect();
    proxies.push(json!({
        "name": PROXY_NAME,
        "type": "http",
        "server": "127.0.0.1",
        "port": port,
        "username": engine::PROXY_USER,
        "password": password,
    }));
    config.insert("proxies".into(), Value::Array(proxies));
    Some(crate::override_apply::stringify_yaml(Value::Object(config)))
}

pub struct MitmService {
    dir: Option<PathBuf>,
    settings: Mutex<MitmSettings>,
    pub shared: Arc<EngineShared>,
    port: Mutex<Option<u16>>,
    vault: Box<dyn KeyVault>,
    trust: Box<dyn TrustStore>,
    trusted: Mutex<Option<bool>>,
    module_lock: tokio::sync::Mutex<()>,
}

static SERVICE: OnceCell<Arc<MitmService>> = OnceCell::new();

/// The process-wide service (None in unit tests and before setup).
pub fn global() -> Option<Arc<MitmService>> {
    SERVICE.get().cloned()
}

/// The composition hook used by `live_config::resolve_enhanced_document`.
pub fn apply_global(document: &str) -> String {
    match global() {
        Some(service) => service.apply_to_document(document),
        None => document.to_string(),
    }
}

/// App setup: build the service, bind the engine and start serving.
pub fn initialize(app_data_root: Option<PathBuf>, namespace: &str, upstream: UpstreamResolver) {
    let dir = app_data_root.as_ref().map(|root| root.join("mitm"));
    let vault: Box<dyn KeyVault> = match &dir {
        Some(dir) => Box::new(ca::KeyringVault {
            service: format!("{namespace}.mitm"),
            fallback: ca::FileVault {
                path: dir.join("ca.key"),
            },
        }),
        None => Box::new(ca::FileVault {
            path: std::env::temp_dir().join(format!("{namespace}-dev-mitm-ca.key")),
        }),
    };
    let service = Arc::new(MitmService::new(
        app_data_root,
        vault,
        Box::new(ca::SystemTrustStore),
        upstream,
    ));
    match engine::bind() {
        Ok((listener, port)) => {
            *service.port.lock().expect("port") = Some(port);
            let shared = service.shared.clone();
            tauri::async_runtime::spawn(engine::serve(shared, listener));
        }
        Err(_) => crate::diag!("[mitm] engine listener failed to bind"),
    }
    let checker = service.clone();
    std::thread::spawn(move || {
        checker.refresh_trust();
    });
    let _ = SERVICE.set(service);
}

impl MitmService {
    pub fn new(
        app_data_root: Option<PathBuf>,
        vault: Box<dyn KeyVault>,
        trust: Box<dyn TrustStore>,
        upstream: UpstreamResolver,
    ) -> Self {
        let dir = app_data_root.map(|root| root.join("mitm"));
        let settings = dir
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(settings_path(dir)).ok())
            .and_then(|text| serde_json::from_str::<MitmSettings>(&text).ok())
            .unwrap_or_default();
        let service = MitmService {
            dir,
            settings: Mutex::new(settings),
            shared: Arc::new(EngineShared::new(upstream)),
            port: Mutex::new(None),
            vault,
            trust,
            trusted: Mutex::new(None),
            module_lock: tokio::sync::Mutex::new(()),
        };
        service.load_ca();
        service.recompile();
        service
    }

    #[cfg(test)]
    pub fn set_port_for_test(&self, port: u16) {
        *self.port.lock().unwrap() = Some(port);
    }

    fn load_ca(&self) {
        let Some(dir) = &self.dir else {
            return;
        };
        let Some(record) = ca::load_record(dir) else {
            return;
        };
        let Ok(Some(key)) = self.vault.load() else {
            return;
        };
        if let Ok(authority) = CaAuthority::load(record, &key) {
            *self.shared.ca.write().expect("ca") = Some(Arc::new(authority));
        }
    }

    pub fn settings(&self) -> MitmSettings {
        self.settings.lock().expect("settings").clone()
    }

    fn save(&self, settings: &MitmSettings) -> Result<(), IpcError> {
        if let Some(dir) = &self.dir {
            std::fs::create_dir_all(dir).map_err(|e| IpcError::internal(e.to_string()))?;
            let text = serde_json::to_string_pretty(settings)
                .map_err(|e| IpcError::internal(e.to_string()))?
                + "\n";
            let tmp = dir.join(format!(".{SETTINGS_FILE}.{}.tmp", now_ms()));
            std::fs::write(&tmp, text).map_err(|e| IpcError::internal(e.to_string()))?;
            std::fs::rename(&tmp, settings_path(dir))
                .map_err(|e| IpcError::internal(e.to_string()))?;
        }
        Ok(())
    }

    fn update(
        &self,
        change: impl FnOnce(&mut MitmSettings) -> Result<(), IpcError>,
    ) -> Result<(), IpcError> {
        let mut guard = self.settings.lock().expect("settings");
        let mut next = guard.clone();
        change(&mut next)?;
        self.save(&next)?;
        *guard = next;
        drop(guard);
        self.recompile();
        Ok(())
    }

    fn recompile(&self) {
        let settings = self.settings();
        let mut sources = vec![ModuleSource {
            content: &settings.local_module,
        }];
        for module in settings.modules.iter().filter(|m| m.enabled) {
            sources.push(ModuleSource {
                content: &module.content,
            });
        }
        let compiled =
            CompiledRules::build(&settings.hostnames, &sources, settings.rewrite_enabled);
        *self.shared.rules.write().expect("rules") = Arc::new(compiled);
        self.shared
            .enabled
            .store(settings.enabled, Ordering::Relaxed);
        self.shared
            .skip_verify
            .store(settings.skip_server_cert_verify, Ordering::Relaxed);
    }

    pub fn refresh_trust(&self) -> Option<bool> {
        let record = self.shared.ca().map(|ca| ca.record.clone());
        let trusted = record.and_then(|record| self.trust.is_trusted(&record));
        *self.trusted.lock().expect("trusted") = trusted;
        trusted
    }

    /// Why the injection is off (None = active).
    pub fn inactive_reason(&self) -> Option<&'static str> {
        let settings = self.settings();
        if !settings.enabled {
            return Some("解密已关闭");
        }
        if self.shared.ca().is_none() {
            return Some("尚未生成根证书");
        }
        if *self.trusted.lock().expect("trusted") == Some(false) {
            return Some("根证书尚未被系统信任");
        }
        if self.port.lock().expect("port").is_none() {
            return Some("解密引擎未能启动");
        }
        if self.shared.rules().hosts.is_empty() {
            return Some("没有需要解密的主机名");
        }
        None
    }

    /// A stable signature of everything the kernel config depends on.
    pub fn injection_signature(&self) -> String {
        if self.inactive_reason().is_some() {
            return String::new();
        }
        format!("{:?}", self.shared.rules().hosts.mihomo_filters())
    }

    pub fn apply_to_document(&self, document: &str) -> String {
        if self.inactive_reason().is_some() {
            return document.to_string();
        }
        let Some(port) = *self.port.lock().expect("port") else {
            return document.to_string();
        };
        let filters = self.shared.rules().hosts.mihomo_filters();
        inject_into_document(document, &filters, port, &self.shared.password)
            .unwrap_or_else(|| document.to_string())
    }

    // --- CA lifecycle ---

    pub fn generate_ca(&self) -> Result<(), IpcError> {
        let dir = self
            .dir
            .clone()
            .ok_or_else(|| IpcError::unsupported("开发模式下不保存根证书"))?;
        if let Some(old) = self.shared.ca() {
            let _ = self.trust.uninstall(&old.record);
        }
        let name = format!(
            "{} MITM CA ({})",
            brand_short_name(),
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        );
        let (authority, key_pem) = CaAuthority::generate(&name).map_err(IpcError::internal)?;
        self.vault.save(&key_pem).map_err(IpcError::internal)?;
        ca::save_record(&dir, &authority.record).map_err(IpcError::internal)?;
        *self.shared.ca.write().expect("ca") = Some(Arc::new(authority));
        self.refresh_trust();
        Ok(())
    }

    pub fn install_ca(&self) -> Result<(), IpcError> {
        let record = self
            .shared
            .ca()
            .map(|ca| ca.record.clone())
            .ok_or_else(|| IpcError::invalid_argument("请先生成根证书"))?;
        let temp = self
            .dir
            .clone()
            .unwrap_or_else(std::env::temp_dir)
            .join("tmp");
        let result = self.trust.install(&record, &temp);
        self.refresh_trust();
        result.map_err(IpcError::internal)
    }

    pub fn uninstall_ca(&self) -> Result<(), IpcError> {
        let Some(ca) = self.shared.ca() else {
            return Ok(());
        };
        let result = self.trust.uninstall(&ca.record);
        self.refresh_trust();
        result.map_err(IpcError::internal)
    }

    pub fn delete_ca(&self) -> Result<(), IpcError> {
        if let Some(ca) = self.shared.ca() {
            self.trust
                .uninstall(&ca.record)
                .map_err(IpcError::internal)?;
        }
        self.vault.delete().map_err(IpcError::internal)?;
        if let Some(dir) = &self.dir {
            ca::delete_record(dir);
        }
        *self.shared.ca.write().expect("ca") = None;
        *self.trusted.lock().expect("trusted") = None;
        Ok(())
    }

    pub fn ca_pem(&self) -> Option<String> {
        self.shared.ca().map(|ca| ca.record.cert_pem.clone())
    }

    // --- Settings ---

    pub fn set_enabled(&self, enabled: bool) -> Result<(), IpcError> {
        self.update(|s| {
            s.enabled = enabled;
            Ok(())
        })
    }

    pub fn set_rewrite_enabled(&self, enabled: bool) -> Result<(), IpcError> {
        self.update(|s| {
            s.rewrite_enabled = enabled;
            Ok(())
        })
    }

    pub fn set_skip_verify(&self, skip: bool) -> Result<(), IpcError> {
        self.update(|s| {
            s.skip_server_cert_verify = skip;
            Ok(())
        })
    }

    pub fn set_hostnames(&self, hostnames: Vec<String>) -> Result<(), IpcError> {
        let mut cleaned: Vec<String> = Vec::new();
        for host in hostnames {
            let host = host.trim().to_ascii_lowercase();
            if host.is_empty() {
                continue;
            }
            rules::validate_hostname_pattern(&host)
                .map_err(|message| IpcError::invalid_argument(format!("{host}：{message}")))?;
            if !cleaned.contains(&host) {
                cleaned.push(host);
            }
        }
        self.update(|s| {
            s.hostnames = cleaned;
            Ok(())
        })
    }

    pub fn set_local_module(&self, content: String) -> Result<(), IpcError> {
        if content.len() > MODULE_SIZE_LIMIT {
            return Err(IpcError::invalid_argument("内容过大"));
        }
        self.update(|s| {
            s.local_module = content;
            Ok(())
        })
    }

    pub fn set_module_enabled(&self, id: &str, enabled: bool) -> Result<(), IpcError> {
        self.update(|s| {
            let module = s
                .modules
                .iter_mut()
                .find(|m| m.id == id)
                .ok_or_else(|| IpcError::not_found("模块不存在"))?;
            module.enabled = enabled;
            Ok(())
        })
    }

    pub fn remove_module(&self, id: &str) -> Result<(), IpcError> {
        self.update(|s| {
            let before = s.modules.len();
            s.modules.retain(|m| m.id != id);
            if s.modules.len() == before {
                return Err(IpcError::not_found("模块不存在"));
            }
            Ok(())
        })
    }

    async fn fetch_module(&self, url: &str) -> Result<String, String> {
        let parsed = url::Url::parse(url).map_err(|_| "URL 无效".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("只支持 http/https 链接".into());
        }
        let mut attempts: Vec<Option<String>> = Vec::new();
        if let Some(addr) = (self.shared.upstream)() {
            attempts.push(Some(format!("http://{addr}")));
        }
        attempts.push(None);
        let mut last_error = String::from("下载失败");
        for proxy in attempts {
            let mut builder = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .user_agent("Murge");
            builder = match &proxy {
                Some(proxy) => {
                    builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?)
                }
                None => builder.no_proxy(),
            };
            let client = builder.build().map_err(|e| e.to_string())?;
            match client.get(parsed.clone()).send().await {
                Ok(response) if response.status().is_success() => {
                    if response
                        .content_length()
                        .is_some_and(|length| length as usize > MODULE_SIZE_LIMIT)
                    {
                        return Err("模块过大".into());
                    }
                    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
                    if bytes.len() > MODULE_SIZE_LIMIT {
                        return Err("模块过大".into());
                    }
                    return String::from_utf8(bytes.to_vec())
                        .map_err(|_| "模块不是 UTF-8 文本".into());
                }
                Ok(response) => last_error = format!("HTTP {}", response.status().as_u16()),
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(last_error)
    }

    fn module_from_content(id: String, url: Option<String>, content: String) -> RewriteModule {
        let parsed = rules::parse_module(&content);
        let fallback = url
            .as_deref()
            .and_then(|url| url.rsplit('/').next())
            .map(|name| name.split('?').next().unwrap_or(name).to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "未命名模块".into());
        RewriteModule {
            id,
            name: parsed.name.unwrap_or(fallback),
            description: parsed.description.unwrap_or_default(),
            url,
            content,
            enabled: true,
            updated_at: now_ms(),
            error: None,
        }
    }

    pub async fn add_module(&self, url: &str) -> Result<(), IpcError> {
        let _guard = self.module_lock.lock().await;
        let url = url.trim().to_string();
        if self
            .settings()
            .modules
            .iter()
            .any(|m| m.url.as_deref() == Some(url.as_str()))
        {
            return Err(IpcError::invalid_argument("该模块已添加"));
        }
        if self.settings().modules.len() >= MODULE_LIMIT {
            return Err(IpcError::invalid_argument("模块数量已达上限"));
        }
        let content = self
            .fetch_module(&url)
            .await
            .map_err(|message| IpcError::invalid_argument(format!("下载模块失败：{message}")))?;
        let parsed = rules::parse_module(&content);
        if parsed.rule_count() == 0 && parsed.hostnames.is_empty() {
            return Err(IpcError::invalid_argument("没有可用的解密或重写规则"));
        }
        let module =
            Self::module_from_content(uuid::Uuid::new_v4().to_string(), Some(url), content);
        self.update(|s| {
            s.modules.push(module);
            Ok(())
        })
    }

    pub async fn update_module(&self, id: &str) -> Result<(), IpcError> {
        let _guard = self.module_lock.lock().await;
        let module = self
            .settings()
            .modules
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| IpcError::not_found("模块不存在"))?;
        let Some(url) = module.url.clone() else {
            return Ok(());
        };
        let fetched = self.fetch_module(&url).await;
        self.update(|s| {
            if let Some(target) = s.modules.iter_mut().find(|m| m.id == id) {
                match &fetched {
                    Ok(content) => {
                        let mut next = Self::module_from_content(
                            id.to_string(),
                            Some(url.clone()),
                            content.clone(),
                        );
                        next.enabled = target.enabled;
                        *target = next;
                    }
                    Err(message) => target.error = Some(message.clone()),
                }
            }
            Ok(())
        })?;
        fetched
            .map(|_| ())
            .map_err(|message| IpcError::invalid_argument(format!("更新模块失败：{message}")))
    }

    // --- Snapshot for the renderer ---

    pub fn snapshot(&self) -> Value {
        let settings = self.settings();
        let rules = self.shared.rules();
        let local = rules::parse_module(&settings.local_module);
        let modules: Vec<Value> = settings
            .modules
            .iter()
            .map(|module| {
                let parsed = rules::parse_module(&module.content);
                json!({
                    "id": module.id,
                    "name": module.name,
                    "description": module.description,
                    "url": module.url,
                    "enabled": module.enabled,
                    "updatedAt": module.updated_at,
                    "error": module.error,
                    "ruleCount": parsed.rule_count(),
                    "hostnames": parsed.hostnames,
                    "warnings": parsed.warnings,
                })
            })
            .collect();
        let trusted = *self.trusted.lock().expect("trusted");
        let ca = self.shared.ca().map(|ca| {
            json!({
                "commonName": ca.record.common_name,
                "fingerprint": ca.record.fingerprint,
                "notBefore": ca.record.not_before * 1000,
                "notAfter": ca.record.not_after * 1000,
                "trusted": trusted,
            })
        });
        let port = *self.port.lock().expect("port");
        json!({
            "settings": {
                "enabled": settings.enabled,
                "rewriteEnabled": settings.rewrite_enabled,
                "skipServerCertVerify": settings.skip_server_cert_verify,
                "hostnames": settings.hostnames,
                "localModule": settings.local_module,
            },
            "modules": modules,
            "localWarnings": local.warnings,
            "ca": ca,
            "trustSupported": cfg!(windows),
            "engine": { "running": port.is_some(), "port": port },
            "active": self.inactive_reason().is_none(),
            "inactiveReason": self.inactive_reason(),
            "summary": {
                "hostnames": rules.hostnames,
                "urlRewrites": rules.url_rewrites.len(),
                "headerRewrites": rules.header_rewrites.len(),
                "bodyRewrites": rules.body_rewrites.len(),
                "mapLocals": rules.map_locals.len(),
            },
        })
    }
}

fn brand_short_name() -> String {
    crate::brand::load_brand()
        .map(|brand| brand.short_name)
        .unwrap_or_else(|_| "Murge".to_string())
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join(SETTINGS_FILE)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

fn bool_arg(payload: &Value, index: usize, channel: &str) -> Result<bool, IpcError> {
    payload
        .get(index)
        .and_then(Value::as_bool)
        .ok_or_else(|| IpcError::invalid_argument(format!("{channel} requires a boolean")))
}

fn string_arg(payload: &Value, index: usize, channel: &str) -> Result<String, IpcError> {
    payload
        .get(index)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| IpcError::invalid_argument(format!("{channel} requires a string")))
}

/// `mitm:*` channels. Every mutation that changes what the kernel config
/// injects triggers a hot reload of the running core.
pub async fn dispatch(
    channel: &str,
    payload: &Value,
    kernel: &crate::kernel::KernelServices,
    models: &crate::enhancements::ModelStores,
    profiles: &Arc<crate::profile_service::ProfilesService>,
    overrides: &crate::override_service::OverrideService,
) -> Result<Value, IpcError> {
    let service = global().ok_or_else(|| IpcError::unsupported("解密服务未启动"))?;
    let before = service.injection_signature();
    let result: Result<Value, IpcError> = match channel {
        "mitm:get-state" => {
            let checker = service.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || checker.refresh_trust()).await;
            Ok(service.snapshot())
        }
        "mitm:set-enabled" => service
            .set_enabled(bool_arg(payload, 0, channel)?)
            .map(|_| Value::Null),
        "mitm:set-rewrite-enabled" => service
            .set_rewrite_enabled(bool_arg(payload, 0, channel)?)
            .map(|_| Value::Null),
        "mitm:set-skip-verify" => service
            .set_skip_verify(bool_arg(payload, 0, channel)?)
            .map(|_| Value::Null),
        "mitm:set-hostnames" => {
            let hosts = payload
                .get(0)
                .and_then(Value::as_array)
                .ok_or_else(|| IpcError::invalid_argument("mitm:set-hostnames requires a list"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            service.set_hostnames(hosts).map(|_| Value::Null)
        }
        "mitm:set-local-module" => service
            .set_local_module(string_arg(payload, 0, channel)?)
            .map(|_| Value::Null),
        "mitm:generate-ca" => {
            let worker = service.clone();
            tauri::async_runtime::spawn_blocking(move || worker.generate_ca())
                .await
                .map_err(|e| IpcError::internal(e.to_string()))?
                .map(|_| Value::Null)
        }
        "mitm:install-ca" => {
            let worker = service.clone();
            tauri::async_runtime::spawn_blocking(move || worker.install_ca())
                .await
                .map_err(|e| IpcError::internal(e.to_string()))?
                .map(|_| Value::Null)
        }
        "mitm:uninstall-ca" => {
            let worker = service.clone();
            tauri::async_runtime::spawn_blocking(move || worker.uninstall_ca())
                .await
                .map_err(|e| IpcError::internal(e.to_string()))?
                .map(|_| Value::Null)
        }
        "mitm:delete-ca" => {
            let worker = service.clone();
            tauri::async_runtime::spawn_blocking(move || worker.delete_ca())
                .await
                .map_err(|e| IpcError::internal(e.to_string()))?
                .map(|_| Value::Null)
        }
        "mitm:export-ca" => {
            let pem = service
                .ca_pem()
                .ok_or_else(|| IpcError::invalid_argument("请先生成根证书"))?;
            let choice = rfd::AsyncFileDialog::new()
                .set_title("导出根证书")
                .set_file_name(format!("{}-MITM-CA.crt", brand_short_name()))
                .add_filter("证书", &["crt", "pem", "cer"])
                .save_file()
                .await;
            match choice {
                Some(file) => std::fs::write(file.path(), pem)
                    .map(|_| json!({ "saved": true }))
                    .map_err(|e| IpcError::internal(e.to_string())),
                None => Ok(json!({ "saved": false })),
            }
        }
        "mitm:add-module" => service
            .add_module(&string_arg(payload, 0, channel)?)
            .await
            .map(|_| Value::Null),
        "mitm:update-module" => service
            .update_module(&string_arg(payload, 0, channel)?)
            .await
            .map(|_| Value::Null),
        "mitm:remove-module" => service
            .remove_module(&string_arg(payload, 0, channel)?)
            .map(|_| Value::Null),
        "mitm:set-module-enabled" => service
            .set_module_enabled(
                &string_arg(payload, 0, channel)?,
                bool_arg(payload, 1, channel)?,
            )
            .map(|_| Value::Null),
        "mitm:recent-requests" => serde_json::to_value(service.shared.log.list())
            .map_err(|e| IpcError::internal(e.to_string())),
        "mitm:clear-requests" => {
            service.shared.log.clear();
            Ok(Value::Null)
        }
        _ => Err(IpcError::unsupported_channel(channel)),
    };
    let after = service.injection_signature();
    if before != after {
        // A failed hot reload must not hide the saved change; the next kernel
        // start composes the same document anyway.
        if let Ok(reloader) =
            crate::live_config::LiveConfigReloader::from_ipc(kernel, models, profiles, overrides)
        {
            let _ = reloader.reload_if_running().await;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoTrust(Mutex<Option<bool>>);
    impl TrustStore for NoTrust {
        fn is_trusted(&self, _record: &ca::CaRecord) -> Option<bool> {
            *self.0.lock().unwrap()
        }
        fn install(&self, _record: &ca::CaRecord, _temp: &Path) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(true);
            Ok(())
        }
        fn uninstall(&self, _record: &ca::CaRecord) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(false);
            Ok(())
        }
    }

    fn service(dir: &Path) -> MitmService {
        MitmService::new(
            Some(dir.to_path_buf()),
            Box::new(ca::FileVault {
                path: dir.join("mitm").join("ca.key"),
            }),
            Box::new(NoTrust(Mutex::new(Some(false)))),
            Arc::new(|| None),
        )
    }

    const DOC: &str = "proxies:\n  - name: A\n    type: http\n    server: 1.2.3.4\n    port: 80\nrules:\n  - MATCH,A\n";

    #[test]
    fn injection_prepends_rules_and_adds_the_proxy() {
        let text = inject_into_document(
            DOC,
            &[("DOMAIN-SUFFIX".into(), "example.com".into())],
            40000,
            "pw",
        )
        .unwrap();
        let config = crate::override_apply::parse_yaml_to_object(&text).unwrap();
        let rules = config["rules"].as_array().unwrap();
        assert_eq!(
            rules[0],
            "AND,((NETWORK,UDP),(DST-PORT,443),(DOMAIN-SUFFIX,example.com)),REJECT"
        );
        assert_eq!(
            rules[1],
            "AND,((NETWORK,TCP),(DOMAIN-SUFFIX,example.com),(NOT,((SRC-IP-CIDR,127.0.0.2/32)))),Murge-MITM"
        );
        assert_eq!(rules[2], "MATCH,A");
        let proxies = config["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 2);
        assert_eq!(proxies[1]["name"], PROXY_NAME);
        assert_eq!(proxies[1]["port"], 40000);
        assert_eq!(proxies[1]["password"], "pw");
        // Re-injection replaces the proxy instead of duplicating it.
        let again =
            inject_into_document(&text, &[("DOMAIN".into(), "a.com".into())], 1, "x").unwrap();
        let config = crate::override_apply::parse_yaml_to_object(&again).unwrap();
        assert_eq!(config["proxies"].as_array().unwrap().len(), 2);
        assert!(inject_into_document(DOC, &[], 1, "x").is_none());
    }

    #[test]
    fn service_only_injects_when_fully_ready() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        service.set_port_for_test(41000);
        assert_eq!(service.apply_to_document(DOC), DOC);
        assert_eq!(service.inactive_reason(), Some("解密已关闭"));

        service.set_enabled(true).unwrap();
        assert_eq!(service.inactive_reason(), Some("尚未生成根证书"));
        service.generate_ca().unwrap();
        assert_eq!(service.inactive_reason(), Some("根证书尚未被系统信任"));
        service.install_ca().unwrap();
        assert_eq!(service.inactive_reason(), Some("没有需要解密的主机名"));
        assert!(service.set_hostnames(vec!["*".into()]).is_err());
        service
            .set_hostnames(vec!["API.example.com".into(), "api.example.com".into()])
            .unwrap();
        assert_eq!(service.settings().hostnames, vec!["api.example.com"]);
        assert_eq!(service.inactive_reason(), None);
        let text = service.apply_to_document(DOC);
        assert!(text.contains("Murge-MITM"), "{text}");
        assert!(text.contains("(DOMAIN,api.example.com)"), "{text}");
        assert!(!service.injection_signature().is_empty());

        // Settings and CA persist across instances.
        let reopened = self::service(dir.path());
        assert!(reopened.settings().enabled);
        assert!(reopened.shared.ca().is_some());

        service.uninstall_ca().unwrap();
        assert_eq!(service.apply_to_document(DOC), DOC);
        service.delete_ca().unwrap();
        assert!(service.shared.ca().is_none());
        assert!(!dir.path().join("mitm").join("ca.key").exists());
    }

    #[test]
    fn local_module_hostnames_and_rules_compile() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        service
            .set_local_module("[MITM]\nhostname = %APPEND% m.example.com\n[URL Rewrite]\n^https://m\\.example\\.com/ad - reject\n".into())
            .unwrap();
        let rules = service.shared.rules();
        assert!(rules.hosts.should_decrypt("m.example.com", 443));
        assert_eq!(rules.url_rewrites.len(), 1);
        let snapshot = service.snapshot();
        assert_eq!(snapshot["summary"]["urlRewrites"], 1);
        assert_eq!(snapshot["summary"]["hostnames"][0], "m.example.com");
        service.set_rewrite_enabled(false).unwrap();
        assert_eq!(service.shared.rules().url_rewrites.len(), 0);
    }
}
