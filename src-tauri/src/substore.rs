//! Sub-Store lifecycle owner (初步接入) — Rust port of
//! `src/main/substore/service.ts`, the `substore:*` channels.
//!
//! Flow: the service downloads the official backend bundle and frontend
//! distribution from the pinned GitHub releases into `baseDir`, then runs the
//! backend as a child process with SUB_STORE_BACKEND_MERGE=1 so ONE loopback
//! port serves both the static frontend and the API (same origin — no CORS,
//! no second server). The renderer embeds it in an iframe.
//!
//! Lifecycle rules:
//! - Started in the background when enabled; the dedicated page can retry it.
//! - Single-flight ensure: concurrent calls share one start attempt.
//! - The child env is fully constructed (never inherits the main process env).
//! - All state changes flow through this service; the renderer sees snapshots.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// Pinned defaults (the shared/substore.ts consts).
pub const SUB_STORE_BACKEND_DEFAULT_TAG: &str = "2.38.2";
pub const SUB_STORE_FRONTEND_DEFAULT_TAG: &str = "2.31.2";
pub const SUB_STORE_BACKEND_DEFAULT_DIGEST: &str =
    "sha256:f1e1430313c0d5df6f937f5d7f3a90b92efec67bc96e1797502c50f94ec9527a";
pub const SUB_STORE_FRONTEND_DEFAULT_DIGEST: &str =
    "sha256:a30a34fa0af71e8e95a01f25a2b8efeb98942cc6ee3ba2761a000484ffe073c3";
/// Base port for the merged frontend+API listener; increments while busy.
pub const SUB_STORE_PORT_BASE: u16 = 38324;
/// Health-check budget for the worker to come up (download excluded).
pub const SUB_STORE_START_TIMEOUT_MS: u64 = 20_000;
/// Budget for one GitHub asset/API request.
pub const SUB_STORE_FETCH_TIMEOUT_MS: u64 = 60_000;
pub const SUB_STORE_BACKEND_LATEST_API: &str =
    "https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest";
pub const SUB_STORE_FRONTEND_LATEST_API: &str =
    "https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/latest";
pub const SUB_STORE_BACKEND_ASSET: &str = "sub-store.bundle.js";
pub const SUB_STORE_FRONTEND_ASSET: &str = "dist.zip";

const BACKEND_BUNDLE_FILE: &str = "sub-store.bundle.cjs";
const ASSETS_DIR_NAME: &str = "assets";
const FRONTEND_DIR_NAME: &str = "sub-store-frontend";
const FRONTEND_INDEX_REL: &str = "sub-store-frontend/index.html";
const VERSIONS_FILE: &str = "versions.json";
const USER_AGENT: &str = "substore-kernel-manager";
const HEALTH_POLL_MS: u64 = 300;
const BACKEND_MAX_BYTES: u64 = 16 * 1024 * 1024;
const FRONTEND_ZIP_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// GitHub API endpoint listing a specific backend release tag.
pub fn sub_store_backend_release_api(tag: &str) -> String {
    format!("https://api.github.com/repos/sub-store-org/Sub-Store/releases/tags/{tag}")
}

/// GitHub API endpoint listing a specific frontend release tag.
pub fn sub_store_frontend_release_api(tag: &str) -> String {
    format!("https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/tags/{tag}")
}

/// Backend bundle download URL for a release tag.
pub fn sub_store_backend_download_url(tag: &str) -> String {
    format!("https://github.com/sub-store-org/Sub-Store/releases/download/{tag}/{SUB_STORE_BACKEND_ASSET}")
}

/// Frontend distribution (zip) download URL for a release tag.
pub fn sub_store_frontend_download_url(tag: &str) -> String {
    format!("https://github.com/sub-store-org/Sub-Store-Front-End/releases/download/{tag}/{SUB_STORE_FRONTEND_ASSET}")
}

/// Sub-Store release tags are bare semver (`2.38.2`), unlike mihomo's `v` prefix.
pub fn is_valid_sub_store_tag(value: &Value) -> bool {
    value.as_str().is_some_and(|raw| {
        let bytes = raw.as_bytes();
        // ^\d+\.\d+\.\d+$
        let mut parts = raw.split('.');
        let valid = parts.clone().count() == 3
            && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
        std::mem::forget(parts);
        !bytes.is_empty() && valid
    })
}

/// The single merged origin the renderer embeds (same-origin, no CORS).
/// (The renderer iframe composes it; ported for shared-model parity.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn sub_store_merged_origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[derive(Debug)]
struct ResolvedAsset {
    tag: String,
    url: String,
    size: u64,
    digest: String,
}

#[derive(Clone)]
struct Versions {
    backend: String,
    frontend: String,
}

fn versions_value(versions: &Versions) -> Value {
    json!({ "backend": versions.backend, "frontend": versions.frontend })
}

/// The worker handle the service owns: a child process behind a narrow
/// interface so tests can inject a recording fake instead of spawning.
pub struct SubStoreWorkerHandle {
    child: StdMutex<Option<tokio::process::Child>>,
}

impl SubStoreWorkerHandle {
    pub async fn terminate(&self) {
        let taken = self.child.lock().unwrap().take();
        if let Some(mut child) = taken {
            let _ = child.kill().await;
        }
    }

    /// The exit-path kill: SIGKILL delivered synchronously, no await.
    pub fn kill_now(&self) {
        let taken = self.child.lock().unwrap().take();
        if let Some(mut child) = taken {
            let _ = child.start_kill();
        }
    }
}

/// The injectable transport for GitHub HTTP calls (API + asset downloads).
pub type Fetch = Arc<dyn Fn(FetchRequest) -> futures_util::future::BoxFuture<'static, Result<FetchResponse, String>> + Send + Sync>;

pub struct FetchRequest {
    pub url: String,
    pub accept: Option<String>,
}
pub struct FetchResponse {
    pub status: u16,
    /// Response headers (the TS content-length guard folded into the byte
    /// checks; kept for injected-transport fidelity).
    #[allow(dead_code)]
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct SubStoreDeps {
    /// Base directory holding the Sub-Store assets (bundle, frontend,
    /// versions marker and the backend's own data). Everything the feature
    /// writes lives under here so uninstall/removal is one directory delete.
    pub base_dir: PathBuf,
    /// Runtime brand value passed to the backend for display + local-origin CORS.
    pub brand_name: String,
    /// Resolves the kernel mixed-port for the worker's proxy env when
    /// `subStoreUseProxy` is on. None means direct egress.
    pub get_mixed_port: Box<dyn Fn() -> Option<u16> + Send + Sync>,
    /// Injectable for tests; defaults to a real node child process.
    pub create_worker: Option<Arc<dyn Fn(String, HashMap<String, String>) -> SubStoreWorkerHandle + Send + Sync>>,
    /// Injectable for tests; defaults to the real reqwest transport.
    pub fetch_fn: Option<Fetch>,
    /// Injectable port probe for tests.
    pub find_free_port: Option<Arc<dyn Fn(u16) -> futures_util::future::BoxFuture<'static, Result<u16, String>> + Send + Sync>>,
    /// Persisted preference mirrors, resolved at call time (the TS
    /// AppSettingsGateway shape: `get()` reads the live store).
    pub settings: crate::settings::SettingsGateway,
    /// The pinned digests (production uses the shared consts; tests inject).
    pub pinned_digests: (String, String),
}

/// The snapshot shape (`SubStoreState`).
pub fn state_value(state: &SubStoreState) -> Value {
    json!({
        "enabled": state.enabled,
        "useProxy": state.use_proxy,
        "phase": state.phase,
        "port": state.port,
        "version": state.version,
        "assetsReady": state.assets_ready,
        "error": state.error,
    })
}

#[derive(Clone)]
pub struct SubStoreState {
    pub enabled: bool,
    pub use_proxy: bool,
    pub phase: &'static str,
    pub port: Option<u16>,
    pub version: Option<Value>,
    pub assets_ready: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct SubStoreService {
    deps: Arc<SubStoreDeps>,
    inner: Arc<SubStoreInner>,
}

/// The shared mutable core: one instance per process, cloned handles observe
/// the same state.
struct SubStoreInner {
    worker: StdMutex<Option<Arc<SubStoreWorkerHandle>>>,
    unexpected_exit_error: StdMutex<Option<String>>,
    port: StdMutex<Option<u16>>,
    phase: StdMutex<&'static str>,
    error: StdMutex<Option<String>>,
    starting: StdMutex<Option<u64>>,
    updating: StdMutex<Option<u64>>,
    operation_generation: AtomicU64,
    disposed: StdMutex<bool>,
    // Synchronous-mirror caches, hydrated by refresh_caches so the fast IPC
    // path never lies about enabled/useProxy/assets.
    settings_cache: StdMutex<(bool, bool)>,
    versions_cache: StdMutex<Option<Versions>>,
    assets_cache: StdMutex<bool>,
    /// Real HTTP transport (the TS global-fetch default; tests inject `fetch_fn`
    /// and never touch this).
    #[allow(dead_code)]
    http: Arc<SubStoreHttp>,
}

struct SubStoreHttp {
    client: OnceLock<reqwest::Client>,
}

impl SubStoreHttp {
    fn new() -> Self {
        SubStoreHttp { client: OnceLock::new() }
    }

    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_millis(SUB_STORE_FETCH_TIMEOUT_MS))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
    }

    async fn fetch_json(&self, url: &str) -> Result<Value, String> {
        let response = self
            .client()
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", USER_AGENT)
            .timeout(Duration::from_millis(SUB_STORE_FETCH_TIMEOUT_MS))
            .send()
            .await
            .map_err(|error| format!("GitHub 请求失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("GitHub 请求失败：HTTP {}", response.status().as_u16()));
        }
        response.json::<Value>().await.map_err(|error| format!("GitHub 请求失败：{error}"))
    }

    async fn download(&self, url: &str) -> Result<FetchResponse, String> {
        let response = self
            .client()
            .get(url)
            .header("User-Agent", USER_AGENT)
            .timeout(Duration::from_millis(SUB_STORE_FETCH_TIMEOUT_MS))
            .send()
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| value.to_str().ok().map(|text| (name.as_str().to_string(), text.to_string())))
            .collect();
        let body = response.bytes().await.map_err(|error| format!("下载失败：{error}"))?.to_vec();
        Ok(FetchResponse { status, headers, body })
    }
}

fn default_fetch() -> Fetch {
    let client = Arc::new(SubStoreHttp::new());
    Arc::new(move |request: FetchRequest| {
        let client = client.clone();
        Box::pin(async move {
            if request.accept.is_some() {
                client.fetch_json(&request.url).await.map(|value| FetchResponse {
                    status: 200,
                    headers: Vec::new(),
                    body: value.to_string().into_bytes(),
                })
            } else {
                client.download(&request.url).await
            }
        })
    })
}

impl SubStoreService {
    pub fn new(deps: SubStoreDeps) -> Self {
        SubStoreService {
            deps: Arc::new(deps),
            inner: Arc::new(SubStoreInner {
                worker: StdMutex::new(None),
                unexpected_exit_error: StdMutex::new(None),
                port: StdMutex::new(None),
                phase: StdMutex::new("idle"),
                error: StdMutex::new(None),
                starting: StdMutex::new(None),
                updating: StdMutex::new(None),
                operation_generation: AtomicU64::new(0),
                disposed: StdMutex::new(false),
                settings_cache: StdMutex::new((false, false)),
                versions_cache: StdMutex::new(None),
                assets_cache: StdMutex::new(false),
                http: Arc::new(SubStoreHttp::new()),
            }),
        }
    }

    fn fetch(&self) -> Fetch {
        self.deps.fetch_fn.clone().unwrap_or_else(default_fetch)
    }

    fn generation(&self) -> u64 {
        self.inner.operation_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        !*self.inner.disposed.lock().unwrap() && generation == self.inner.operation_generation.load(Ordering::SeqCst)
    }

    fn assets_dir(&self) -> PathBuf {
        self.deps.base_dir.join(ASSETS_DIR_NAME)
    }

    fn backend_bundle_path(&self) -> PathBuf {
        self.assets_dir().join(BACKEND_BUNDLE_FILE)
    }

    fn frontend_index_path(&self) -> PathBuf {
        self.assets_dir().join(FRONTEND_INDEX_REL)
    }

    fn versions_path(&self) -> PathBuf {
        self.assets_dir().join(VERSIONS_FILE)
    }

    async fn read_versions(&self) -> Option<Versions> {
        let raw = tokio::fs::read_to_string(self.versions_path()).await.ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        if is_valid_sub_store_tag(&parsed["backend"]) && is_valid_sub_store_tag(&parsed["frontend"]) {
            return Some(Versions {
                backend: parsed["backend"].as_str().unwrap_or_default().to_string(),
                frontend: parsed["frontend"].as_str().unwrap_or_default().to_string(),
            });
        }
        // Absent or corrupt marker: assets will be re-resolved on demand.
        None
    }

    async fn write_versions(&self, versions: &Versions, root: &Path) -> Result<(), String> {
        tokio::fs::create_dir_all(root).await.map_err(|error| error.to_string())?;
        let tmp = root.join(format!(".{VERSIONS_FILE}.{}.tmp", uuid()));
        tokio::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(&versions_value(versions)).unwrap()))
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::rename(&tmp, root.join(VERSIONS_FILE)).await.map_err(|error| error.to_string())
    }

    async fn resolve_release_asset(
        &self,
        api_url: &str,
        expected_asset_name: &str,
        expected_download_url: impl Fn(&str) -> String,
        max_bytes: u64,
    ) -> Result<ResolvedAsset, String> {
        let body = (self.fetch())(FetchRequest { url: api_url.to_string(), accept: Some("application/vnd.github+json".into()) })
            .await
            .map_err(|error| format!("GitHub 请求失败：{error}"))?;
        let parsed: Value = serde_json::from_slice(&body.body).map_err(|error| format!("GitHub 请求失败：{error}"))?;
        if body.status != 200 && !(200..300).contains(&body.status) {
            return Err(format!("GitHub 请求失败：HTTP {}", body.status));
        }
        if !is_valid_sub_store_tag(&parsed["tag_name"]) || !parsed["assets"].is_array() {
            return Err("GitHub 响应格式异常".into());
        }
        let matches: Vec<&Value> = parsed["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|asset| asset["name"] == json!(expected_asset_name))
            .collect();
        if matches.len() != 1 {
            return Err(format!("GitHub Release 缺少唯一资源：{expected_asset_name}"));
        }
        let asset = matches[0];
        let tag = parsed["tag_name"].as_str().unwrap_or_default().to_string();
        let expected_url = expected_download_url(&tag);
        let digest = asset["digest"].as_str().unwrap_or_default().to_string();
        let valid_digest = digest.len() == 71 && digest.starts_with("sha256:") && digest[7..].bytes().all(|byte| byte.is_ascii_hexdigit());
        if asset["browser_download_url"] != json!(expected_url)
            || asset["size"].as_u64().is_none_or(|size| size == 0 || size > max_bytes)
            || !valid_digest
        {
            return Err(format!("GitHub Release 资源元数据无效：{expected_asset_name}"));
        }
        Ok(ResolvedAsset { tag, url: expected_url, size: asset["size"].as_u64().unwrap_or(0), digest: digest.to_lowercase() })
    }

    async fn download_to(&self, asset: &ResolvedAsset, dest: &Path, max_bytes: u64) -> Result<(), String> {
        let response = (self.fetch())(FetchRequest { url: asset.url.clone(), accept: None })
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        if response.status < 200 || response.status >= 300 {
            return Err(format!("下载失败：HTTP {}", response.status));
        }
        let received = response.body.len() as u64;
        if received > max_bytes || received > asset.size {
            return Err("下载失败：资源超过声明大小或安全上限".into());
        }
        if received != asset.size {
            return Err(format!("下载失败：资源大小不匹配（预期 {}，实际 {}）", asset.size, received));
        }
        let digest = format!("sha256:{}", hex(&Sha256::digest(&response.body)));
        if digest != asset.digest {
            return Err("下载失败：SHA-256 校验不匹配".into());
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;
        }
        let tmp = dest.with_extension(format!("{}.tmp", uuid()));
        let result = tokio::fs::write(&tmp, &response.body).await.map_err(|error| error.to_string());
        match result {
            Ok(()) => tokio::fs::rename(&tmp, dest).await.map_err(|error| error.to_string()),
            Err(error) => Err(error),
        }
    }

    /// Synchronous mirror snapshot (no disk reads) for fast IPC.
    pub fn get_state(&self) -> Value {
        let (enabled, use_proxy) = *self.inner.settings_cache.lock().unwrap();
        state_value(&SubStoreState {
            enabled,
            use_proxy,
            phase: *self.inner.phase.lock().unwrap(),
            port: *self.inner.port.lock().unwrap(),
            version: self.inner.versions_cache.lock().unwrap().as_ref().map(versions_value),
            assets_ready: *self.inner.assets_cache.lock().unwrap(),
            error: self.inner.error.lock().unwrap().clone(),
        })
    }

    /// Refresh the synchronous-mirror caches from the persisted facts.
    async fn refresh_caches(&self) {
        let settings = (self.deps.settings)().await;
        *self.inner.settings_cache.lock().unwrap() = (settings.sub_store_enabled, settings.sub_store_use_proxy);
        *self.inner.versions_cache.lock().unwrap() = self.read_versions().await;
        let backend_ok = tokio::fs::metadata(self.backend_bundle_path()).await.is_ok();
        let frontend_ok = tokio::fs::metadata(self.frontend_index_path()).await.is_ok();
        *self.inner.assets_cache.lock().unwrap() = backend_ok && frontend_ok;
    }

    /// Full snapshot the IPC surface serves: settings mirror + disk facts.
    pub async fn snapshot(&self) -> Value {
        self.refresh_caches().await;
        self.get_state()
    }

    /// React to persisted setting changes driven by the renderer (or defaults).
    pub async fn on_settings(&self, sub_store_enabled: bool, sub_store_use_proxy: bool) {
        if *self.inner.disposed.lock().unwrap() {
            return;
        }
        let previous = *self.inner.settings_cache.lock().unwrap();
        let enabled_changed = sub_store_enabled != previous.0;
        let proxy_changed = sub_store_use_proxy != previous.1;
        *self.inner.settings_cache.lock().unwrap() = (sub_store_enabled, sub_store_use_proxy);
        if !sub_store_enabled {
            if enabled_changed || *self.inner.phase.lock().unwrap() != "idle" || self.inner.starting.lock().unwrap().is_some() {
                self.stop().await;
            }
            return;
        }
        // Only an actual proxy-mode change requires a live worker restart;
        // unrelated app settings are ignored.
        if proxy_changed && *self.inner.phase.lock().unwrap() == "running" && self.inner.port.lock().unwrap().is_some() {
            self.stop().await;
            let _ = self.ensure_running().await;
        }
    }

    /// Ensure the assets exist (downloading pinned defaults when missing) and
    /// the worker is healthy. Idempotent and single-flight.
    pub async fn ensure_running(&self) -> Value {
        if *self.inner.disposed.lock().unwrap() {
            return self.snapshot().await;
        }
        if *self.inner.phase.lock().unwrap() == "running" {
            return self.snapshot().await;
        }
        let already_starting = self.inner.starting.lock().unwrap().is_some();
        if already_starting {
            return self.snapshot().await;
        }
        let generation = self.generation();
        *self.inner.starting.lock().unwrap() = Some(generation);
        let result = self.ensure_running_inner(generation).await;
        *self.inner.starting.lock().unwrap() = None;
        match result {
            Ok(()) => {}
            Err(error) => {
                if self.is_current(generation) {
                    *self.inner.phase.lock().unwrap() = "error";
                    *self.inner.error.lock().unwrap() = Some(error);
                    self.stop_worker().await;
                }
            }
        }
        self.snapshot().await
    }

    async fn ensure_running_inner(&self, generation: u64) -> Result<(), String> {
        let mut versions = self.read_versions().await;
        let backend_ok = tokio::fs::metadata(self.backend_bundle_path()).await.is_ok();
        let frontend_ok = tokio::fs::metadata(self.frontend_index_path()).await.is_ok();
        if !backend_ok || !frontend_ok || versions.is_none() {
            *self.inner.phase.lock().unwrap() = "downloading";
            *self.inner.error.lock().unwrap() = None;
            let staging = self
                .stage_assets(
                    versions.clone().unwrap_or(Versions {
                        backend: SUB_STORE_BACKEND_DEFAULT_TAG.to_string(),
                        frontend: SUB_STORE_FRONTEND_DEFAULT_TAG.to_string(),
                    }),
                    !backend_ok,
                    !frontend_ok,
                    versions.is_none(),
                )
                .await?;
            if !self.is_current(generation) {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err("Sub-Store 操作已取消".to_string());
            }
            self.commit_staged_assets(&staging).await?;
            versions = self.read_versions().await;
            let _ = &versions;
        }
        if !self.is_current(generation) {
            return Err("Sub-Store 操作已取消".to_string());
        }
        self.spawn_worker(generation).await
    }

    async fn stage_assets(
        &self,
        versions: Versions,
        replace_backend: bool,
        replace_frontend: bool,
        force: bool,
    ) -> Result<PathBuf, String> {
        tokio::fs::create_dir_all(&self.deps.base_dir).await.map_err(|error| error.to_string())?;
        let staging = self.deps.base_dir.join(format!(".assets-stage-{}", uuid()));
        let replace_backend = force || replace_backend;
        let replace_frontend = force || replace_frontend;
        let result: Result<(), String> = async {
            if !force && self.assets_dir().exists() {
                copy_dir_recursive(&self.assets_dir(), &staging).await?;
            } else {
                tokio::fs::create_dir_all(&staging).await.map_err(|error| error.to_string())?;
            }
            if replace_backend {
                let asset = self
                    .resolve_release_asset(
                        &sub_store_backend_release_api(&versions.backend),
                        SUB_STORE_BACKEND_ASSET,
                        sub_store_backend_download_url,
                        BACKEND_MAX_BYTES,
                    )
                    .await?;
                if asset.tag != versions.backend {
                    return Err("Sub-Store 后端版本响应不匹配".into());
                }
                if versions.backend == SUB_STORE_BACKEND_DEFAULT_TAG && asset.digest != self.deps.pinned_digests.0 {
                    return Err("Sub-Store 后端默认版本摘要与应用内置值不匹配".into());
                }
                self.download_to(&asset, &staging.join(BACKEND_BUNDLE_FILE), BACKEND_MAX_BYTES).await?;
            }
            if replace_frontend {
                let asset = self
                    .resolve_release_asset(
                        &sub_store_frontend_release_api(&versions.frontend),
                        SUB_STORE_FRONTEND_ASSET,
                        sub_store_frontend_download_url,
                        FRONTEND_ZIP_MAX_BYTES,
                    )
                    .await?;
                if asset.tag != versions.frontend {
                    return Err("Sub-Store 前端版本响应不匹配".into());
                }
                if versions.frontend == SUB_STORE_FRONTEND_DEFAULT_TAG && asset.digest != self.deps.pinned_digests.1 {
                    return Err("Sub-Store 前端默认版本摘要与应用内置值不匹配".into());
                }
                let zip_path = staging.join("frontend-dist.zip");
                self.download_to(&asset, &zip_path, FRONTEND_ZIP_MAX_BYTES).await?;
                let frontend_staging = staging.join(format!("frontend-staging-{}", uuid()));
                let zip_bytes = tokio::fs::read(&zip_path).await.map_err(|error| error.to_string())?;
                let written = crate::substore_zip::extract_zip_bytes(&zip_bytes, &frontend_staging)
                    .map_err(|error| error.to_string())?;
                if !frontend_staging.join("index.html").exists() {
                    return Err("前端压缩包缺少 index.html".into());
                }
                let _ = written;
                let _ = tokio::fs::remove_dir_all(staging.join(FRONTEND_DIR_NAME)).await;
                tokio::fs::rename(&frontend_staging, staging.join(FRONTEND_DIR_NAME))
                    .await
                    .map_err(|error| error.to_string())?;
                let _ = tokio::fs::remove_file(&zip_path).await;
            }
            if !staging.join(BACKEND_BUNDLE_FILE).exists() || !staging.join(FRONTEND_INDEX_REL).exists() {
                return Err("Sub-Store 暂存资源不完整".into());
            }
            self.write_versions(&versions, &staging).await?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => Ok(staging),
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                Err(error)
            }
        }
    }

    /// Replace backend, frontend and their version marker as one
    /// rollback-safe set.
    async fn commit_staged_assets(&self, staging: &Path) -> Result<(), String> {
        let current = self.assets_dir();
        let backup = self.deps.base_dir.join(format!(".assets-backup-{}", uuid()));
        let had_current = current.exists();
        match async {
            if had_current {
                tokio::fs::rename(&current, &backup).await.map_err(|error| error.to_string())?;
            }
            tokio::fs::rename(staging, &current).await.map_err(|error| error.to_string())?;
            let _ = tokio::fs::remove_dir_all(&backup).await;
            // v0.8.0 stored executable assets directly under baseDir. Once
            // the new atomic asset set is committed, remove only those exact
            // legacy paths; the persistent `data/` directory is untouched.
            let _ = tokio::fs::remove_file(self.deps.base_dir.join(BACKEND_BUNDLE_FILE)).await;
            let _ = tokio::fs::remove_dir_all(self.deps.base_dir.join(FRONTEND_DIR_NAME)).await;
            let _ = tokio::fs::remove_file(self.deps.base_dir.join(VERSIONS_FILE)).await;
            Ok(())
        }
        .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&current).await;
                if had_current && backup.exists() {
                    let _ = tokio::fs::rename(&backup, &current).await;
                }
                let _ = tokio::fs::remove_dir_all(staging).await;
                Err(error)
            }
        }
    }

    fn worker_env(&self, port: u16, use_proxy: bool) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("SUB_STORE_BACKEND_API_PORT".to_string(), port.to_string());
        env.insert("SUB_STORE_BACKEND_API_HOST".to_string(), "127.0.0.1".to_string());
        // MERGE mode: the same express app serves the static frontend on
        // every non-API route of this port, so the embedded UI is
        // same-origin. The backend path MUST be '/' — a deeper prefix strips
        // the first segment off API routes and 404s them (verified against
        // the real release): `/api/subs` would become `/subs`.
        env.insert("SUB_STORE_BACKEND_MERGE".to_string(), "1".to_string());
        env.insert("SUB_STORE_FRONTEND_BACKEND_PATH".to_string(), "/".to_string());
        env.insert(
            "SUB_STORE_FRONTEND_PATH".to_string(),
            self.assets_dir().join(FRONTEND_DIR_NAME).to_string_lossy().to_string(),
        );
        env.insert(
            "SUB_STORE_DATA_BASE_PATH".to_string(),
            self.deps.base_dir.join("data").to_string_lossy().to_string(),
        );
        // Setting a custom backend name flips the backend's default Node CORS
        // policy to allow local origins (upstream behavior; merge mode makes
        // it moot, but it also names the backend after the app in the UI).
        env.insert("SUB_STORE_BACKEND_CUSTOM_NAME".to_string(), self.deps.brand_name.clone());
        if use_proxy {
            if let Some(mixed_port) = (self.deps.get_mixed_port)() {
                if mixed_port > 0 {
                    let proxy = format!("http://127.0.0.1:{mixed_port}");
                    env.insert("HTTP_PROXY".to_string(), proxy.clone());
                    env.insert("HTTPS_PROXY".to_string(), proxy.clone());
                    env.insert("ALL_PROXY".to_string(), proxy);
                }
            }
        }
        env
    }

    async fn spawn_worker(&self, generation: u64) -> Result<(), String> {
        if !self.is_current(generation) {
            return Err("Sub-Store 操作已取消".to_string());
        }
        let settings = (self.deps.settings)().await;
        // The bundle writes its root.json at startup WITHOUT creating the
        // data directory — verified against the real 2.38.2 release — so
        // pre-create it.
        tokio::fs::create_dir_all(self.deps.base_dir.join("data"))
            .await
            .map_err(|error| error.to_string())?;
        let port = self.find_free_port().await?;
        if !self.is_current(generation) {
            return Err("Sub-Store 操作已取消".to_string());
        }
        *self.inner.phase.lock().unwrap() = "starting";
        *self.inner.error.lock().unwrap() = None;
        let env = self.worker_env(port, settings.sub_store_use_proxy);
        let bundle_path = self.backend_bundle_path().to_string_lossy().to_string();
        let worker = match &self.deps.create_worker {
            Some(create) => create(bundle_path, env),
            None => default_create_worker(&bundle_path, env),
        };
        let worker = Arc::new(worker);
        *self.inner.unexpected_exit_error.lock().unwrap() = None;
        *self.inner.worker.lock().unwrap() = Some(worker.clone());
        *self.inner.port.lock().unwrap() = Some(port);
        match self.wait_until_healthy(port, generation).await {
            Ok(()) => {
                *self.inner.phase.lock().unwrap() = "running";
                Ok(())
            }
            Err(error) => {
                self.stop_worker().await;
                if self.is_current(generation) {
                    *self.inner.phase.lock().unwrap() = "error";
                    *self.inner.error.lock().unwrap() = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    async fn wait_until_healthy(&self, port: u16, generation: u64) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(SUB_STORE_START_TIMEOUT_MS);
        let url = format!("http://127.0.0.1:{port}/");
        loop {
            if !self.is_current(generation) {
                return Err("Sub-Store 操作已取消".to_string());
            }
            if let Some(error) = self.inner.unexpected_exit_error.lock().unwrap().clone() {
                return Err(error);
            }
            if std::time::Instant::now() > deadline {
                return Err("Sub-Store 启动超时".into());
            }
            let healthy = reqwest::Client::new()
                .get(&url)
                .timeout(Duration::from_millis(2000))
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false);
            if healthy {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(HEALTH_POLL_MS)).await;
        }
    }

    async fn stop_worker(&self) {
        let worker = self.inner.worker.lock().unwrap().take();
        if let Some(worker) = worker {
            worker.terminate().await;
        }
        *self.inner.port.lock().unwrap() = None;
    }

    /// Stop the worker; keeps downloaded assets and the enabled setting.
    pub async fn stop(&self) -> Value {
        self.inner.operation_generation.fetch_add(1, Ordering::SeqCst);
        *self.inner.disposed.lock().unwrap() = false;
        self.stop_worker().await;
        *self.inner.phase.lock().unwrap() = "idle";
        *self.inner.error.lock().unwrap() = None;
        *self.inner.starting.lock().unwrap() = None;
        *self.inner.updating.lock().unwrap() = None;
        self.snapshot().await
    }

    /// Fetch the latest release tags; re-download any asset whose tag changed
    /// and restart the worker when it was running. Assets keep working
    /// offline if the update check fails — the error only surfaces in state.
    pub async fn check_update(&self) -> Value {
        if *self.inner.disposed.lock().unwrap() {
            return self.snapshot().await;
        }
        if self.inner.updating.lock().unwrap().is_some() || self.inner.starting.lock().unwrap().is_some() {
            return self.snapshot().await;
        }
        let was_running = *self.inner.phase.lock().unwrap() == "running";
        let generation = self.generation();
        *self.inner.updating.lock().unwrap() = Some(generation);
        let result = self.check_update_inner(generation, was_running).await;
        *self.inner.updating.lock().unwrap() = None;
        if let Err(error) = result {
            if self.is_current(generation) {
                *self.inner.error.lock().unwrap() = Some(error);
                *self.inner.phase.lock().unwrap() = if was_running && self.inner.worker.lock().unwrap().is_some() {
                    "running"
                } else {
                    "idle"
                };
            }
        }
        self.snapshot().await
    }

    async fn check_update_inner(&self, generation: u64, was_running: bool) -> Result<(), String> {
        let backend_asset = self
            .resolve_release_asset(SUB_STORE_BACKEND_LATEST_API, SUB_STORE_BACKEND_ASSET, sub_store_backend_download_url, BACKEND_MAX_BYTES)
            .await?;
        let frontend_asset = self
            .resolve_release_asset(SUB_STORE_FRONTEND_LATEST_API, SUB_STORE_FRONTEND_ASSET, sub_store_frontend_download_url, FRONTEND_ZIP_MAX_BYTES)
            .await?;
        if !self.is_current(generation) {
            return Err("Sub-Store 操作已取消".to_string());
        }
        let current = self.read_versions().await.unwrap_or(Versions {
            backend: SUB_STORE_BACKEND_DEFAULT_TAG.to_string(),
            frontend: SUB_STORE_FRONTEND_DEFAULT_TAG.to_string(),
        });
        let force = !self.assets_dir().exists();
        let plan_backend = backend_asset.tag != current.backend;
        let plan_frontend = frontend_asset.tag != current.frontend;
        if plan_backend || plan_frontend || force {
            *self.inner.phase.lock().unwrap() = "downloading";
            let staging = self
                .stage_assets(
                    Versions { backend: backend_asset.tag, frontend: frontend_asset.tag },
                    plan_backend,
                    plan_frontend,
                    force,
                )
                .await?;
            if !self.is_current(generation) {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err("Sub-Store 操作已取消".to_string());
            }
            if was_running {
                self.stop_worker().await;
            }
            self.commit_staged_assets(&staging).await?;
            if !self.is_current(generation) {
                return Err("Sub-Store 操作已取消".to_string());
            }
            if was_running {
                self.spawn_worker(generation).await?;
            } else {
                *self.inner.phase.lock().unwrap() = "idle";
            }
        } else {
            *self.inner.phase.lock().unwrap() = if was_running && self.inner.worker.lock().unwrap().is_some() { "running" } else { "idle" };
        }
        *self.inner.error.lock().unwrap() = None;
        Ok(())
    }

    /// Open a validated http(s) URL in the user's browser. The URL itself is
    /// validated at the dispatch layer (`parseSubStoreExternalUrl` copy);
    /// the opener defaults to the platform shell.
    pub async fn open_external(&self, url: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            tokio::process::Command::new("xdg-open")
                .arg(url)
                .spawn()
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            tokio::process::Command::new("open").arg(url).spawn().map_err(|error| error.to_string())?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            // `cmd /c start` requires an empty title argument; `explorer`
            // accepts the URL directly and never spawns a console window.
            tokio::process::Command::new("explorer").arg(url).spawn().map_err(|error| error.to_string())?;
            return Ok(());
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            let _ = url;
            Err("当前平台不支持打开外部链接".to_string())
        }
    }

    /// Terminate the worker during app shutdown; assets persist. The kill is
    /// SYNCHRONOUS (`start_kill` delivers SIGKILL without awaiting) because
    /// this runs on the exit path where a spawned task could be dropped
    /// before it completes — the TS quit flow awaits dispose(), the Tauri
    /// exit hook cannot.
    pub fn dispose(&self) {
        *self.inner.disposed.lock().unwrap() = true;
        self.inner.operation_generation.fetch_add(1, Ordering::SeqCst);
        *self.inner.starting.lock().unwrap() = None;
        *self.inner.updating.lock().unwrap() = None;
        if let Some(worker) = self.inner.worker.lock().unwrap().take() {
            worker.kill_now();
        }
        *self.inner.port.lock().unwrap() = None;
        *self.inner.phase.lock().unwrap() = "idle";
    }

    async fn find_free_port(&self) -> Result<u16, String> {
        if let Some(custom) = &self.deps.find_free_port {
            return custom(SUB_STORE_PORT_BASE).await;
        }
        for candidate in SUB_STORE_PORT_BASE..SUB_STORE_PORT_BASE + 50 {
            if tokio::net::TcpListener::bind(("127.0.0.1", candidate)).await.is_ok() {
                return Ok(candidate);
            }
        }
        Err("没有可用的本地端口".into())
    }
}

fn default_create_worker(bundle_path: &str, env: HashMap<String, String>) -> SubStoreWorkerHandle {
    let mut command = tokio::process::Command::new(&bundle_path);
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    let child = command.spawn().ok();
    SubStoreWorkerHandle { child: StdMutex::new(child) }
}

fn uuid() -> String {
    // A collision-resistant token for temp names (random bytes are not
    // needed: process id + nanotime is enough for a single-writer service).
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(to).await.map_err(|error| error.to_string())?;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&src).await.map_err(|error| error.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|error| error.to_string())? {
            let entry_path = entry.path();
            let entry_dst = dst.join(entry.file_name());
            if entry_path.is_dir() {
                tokio::fs::create_dir_all(&entry_dst).await.map_err(|error| error.to_string())?;
                stack.push((entry_path, entry_dst));
            } else {
                tokio::fs::copy(&entry_path, &entry_dst).await.map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

/// Validate an external URL for `substore:open-external` — the TS
/// `parseSubStoreExternalUrl` copy, byte-verbatim.
pub fn parse_sub_store_external_url(value: &Value) -> Result<String, crate::error::IpcError> {
    let invalid = |message: &str| crate::error::IpcError::invalid_argument(message);
    let raw = value.as_str().ok_or_else(|| invalid("external url must be a string"))?;
    if raw.len() > 2048 {
        return Err(invalid("external url is too long"));
    }
    let parsed = url::Url::parse(raw).map_err(|_| invalid("external url must be a valid URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(invalid("external url must use http or https"));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_with(fetch: Fetch) -> SubStoreService {
        SubStoreService::new(SubStoreDeps {
            base_dir: std::env::temp_dir().join(format!("murge-substore-test-{}", uuid())),
            brand_name: "Murge".to_string(),
            get_mixed_port: Box::new(|| None),
            create_worker: None,
            fetch_fn: Some(fetch),
            find_free_port: Some(Arc::new(|base: u16| {
                Box::pin(async move { Ok(base) })
            })),
            settings: std::sync::Arc::new(|| {
                Box::pin(async { crate::settings::AppSettings::default() })
                    as futures_util::future::BoxFuture<'static, crate::settings::AppSettings>
            }),
            pinned_digests: (SUB_STORE_BACKEND_DEFAULT_DIGEST.to_string(), SUB_STORE_FRONTEND_DEFAULT_DIGEST.to_string()),
        })
    }

    #[test]
    fn tag_validation_and_url_parsing_match_the_ts_copies() {
        assert!(is_valid_sub_store_tag(&json!("2.38.2")));
        assert!(!is_valid_sub_store_tag(&json!("v2.38.2")));
        assert!(!is_valid_sub_store_tag(&json!("2.38")));
        assert!(!is_valid_sub_store_tag(&json!(2)));
        assert_eq!(sub_store_backend_release_api("2.38.2"), "https://api.github.com/repos/sub-store-org/Sub-Store/releases/tags/2.38.2");
        assert_eq!(sub_store_backend_download_url("2.38.2"), "https://github.com/sub-store-org/Sub-Store/releases/download/2.38.2/sub-store.bundle.js");
        assert_eq!(sub_store_merged_origin(38324), "http://127.0.0.1:38324");
        // parseSubStoreExternalUrl copy.
        assert_eq!(parse_sub_store_external_url(&json!("https://a.b/c")).unwrap(), "https://a.b/c");
        assert!(parse_sub_store_external_url(&json!("ftp://a.b")).is_err());
        assert!(parse_sub_store_external_url(&json!("not a url")).is_err());
        assert!(parse_sub_store_external_url(&json!(2)).is_err());
        assert!(parse_sub_store_external_url(&json!(format!("https://{}", "a".repeat(2100)))).is_err());
    }

    #[test]
    fn worker_env_is_fully_constructed_and_never_inherits() {
        let service = service_with(Arc::new(|_request: FetchRequest| {
            Box::pin(async { Err("unused".to_string()) })
        }));
        let env = service.worker_env(38324, false);
        assert_eq!(env["SUB_STORE_BACKEND_API_PORT"], "38324");
        assert_eq!(env["SUB_STORE_BACKEND_API_HOST"], "127.0.0.1");
        assert_eq!(env["SUB_STORE_BACKEND_MERGE"], "1");
        assert_eq!(env["SUB_STORE_FRONTEND_BACKEND_PATH"], "/");
        assert_eq!(env["SUB_STORE_BACKEND_CUSTOM_NAME"], "Murge");
        assert!(!env.contains_key("PATH"));
        assert!(!env.contains_key("HTTP_PROXY"));
        // Proxy env appears only when useProxy is on AND the port resolves.
        let service = SubStoreService::new(SubStoreDeps {
            base_dir: std::env::temp_dir().join(format!("murge-substore-test-{}", uuid())),
            brand_name: "Murge".to_string(),
            get_mixed_port: Box::new(|| Some(7897)),
            create_worker: None,
            fetch_fn: Some(Arc::new(|_request: FetchRequest| {
                Box::pin(async { Err("unused".to_string()) })
            })),
            find_free_port: Some(Arc::new(|base: u16| {
                Box::pin(async move { Ok(base) })
            })),
            settings: std::sync::Arc::new(|| {
                Box::pin(async { crate::settings::AppSettings::default() })
                    as futures_util::future::BoxFuture<'static, crate::settings::AppSettings>
            }),
            pinned_digests: (SUB_STORE_BACKEND_DEFAULT_DIGEST.to_string(), SUB_STORE_FRONTEND_DEFAULT_DIGEST.to_string()),
        });
        let env = service.worker_env(38324, true);
        assert_eq!(env["HTTP_PROXY"], "http://127.0.0.1:7897");
        assert_eq!(env["HTTPS_PROXY"], "http://127.0.0.1:7897");
        assert_eq!(env["ALL_PROXY"], "http://127.0.0.1:7897");
    }

    #[tokio::test]
    async fn snapshot_mirrors_persisted_settings_before_any_change() {
        let service = service_with(Arc::new(|_request: FetchRequest| {
            Box::pin(async { Err("unused".to_string()) })
        }));
        let state = service.snapshot().await;
        // The shipped default is subStoreEnabled: true (mirrors the TS
        // defaults), useProxy false.
        assert_eq!(state["enabled"], true);
        assert_eq!(state["useProxy"], false);
        assert_eq!(state["phase"], "idle");
        assert_eq!(state["port"], Value::Null);
        assert_eq!(state["assetsReady"], false);
    }

    #[tokio::test]
    async fn start_failure_surfaces_as_error_state() {
        // A fetch that always fails: ensure surfaces the GitHub failure copy.
        let service = service_with(Arc::new(|_request: FetchRequest| {
            Box::pin(async { Err("boom".to_string()) })
        }));
        let state = service.ensure_running().await;
        assert_eq!(state["phase"], "error");
        assert!(state["error"].as_str().unwrap().contains("GitHub 请求失败"), "{}", state);
        // stop() clears the error but keeps assets facts.
        let state = service.stop().await;
        assert_eq!(state["phase"], "idle");
        assert_eq!(state["error"], Value::Null);
        let _ = std::fs::remove_dir_all(&service.deps.base_dir);
    }

    #[tokio::test]
    async fn metadata_mismatch_and_digest_guards_reject_before_download() {
        // A GitHub API response whose asset digest is malformed → the
        // metadata-invalid copy, before any bytes are written.
        let api_body = json!({
            "tag_name": "2.38.2",
            "assets": [{
                "name": SUB_STORE_BACKEND_ASSET,
                "browser_download_url": sub_store_backend_download_url("2.38.2"),
                "size": 16 * 1024 * 1024,
                "digest": "sha256:zzzz"
            }]
        })
        .to_string()
        .into_bytes();
        let service = service_with(Arc::new(move |_request: FetchRequest| {
            let body = api_body.clone();
            Box::pin(async move { Ok(FetchResponse { status: 200, headers: Vec::new(), body }) })
        }));
        let error = service
            .resolve_release_asset(
                &sub_store_backend_release_api(SUB_STORE_BACKEND_DEFAULT_TAG),
                SUB_STORE_BACKEND_ASSET,
                sub_store_backend_download_url,
                BACKEND_MAX_BYTES,
            )
            .await
            .unwrap_err();
        assert_eq!(error, "GitHub Release 资源元数据无效：sub-store.bundle.js");
    }
}
