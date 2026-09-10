//! Live runtime-config composition — Rust port of
//! `main/kernel/live-config-reloader.ts` plus the external-IP probe
//! (`main/services/external-ip.ts`, threaded through
//! `main/ipc/register-ipc.ts:resolveExternalIp`).
//!
//! Contract preserved exactly:
//! - `reload_if_running` rebuilds the EXACT complete startup document
//!   (overrides → DNS → sniffer already applied upstream; TUN/core/geodata
//!   models folded by the builders) and PUTs it to `/configs`. No
//!   `force=true`: mihomo keeps the already-bound listeners. `false` when
//!   the kernel is not running/starting (the persisted change is deferred).
//! - `apply_sections` routes every controlled section through the lightest
//!   endpoint that actually owns it: mihomo's PATCH /configs silently
//!   ignores nested DNS and sniffer blocks, so those use the in-process
//!   payload reload (a DNS reload also flushes both caches best-effort,
//!   `Promise.allSettled`); geodata keeps the partial endpoint with the
//!   `buildGeodataBlock` per-key fallback.
//! - `apply_sniffer_transition_if_running` toggles an already-loaded
//!   sniffer dispatcher through mihomo's verified runtime `sniffing` gate
//!   (enable-only change, base document without a live sniffer module);
//!   the suspended signature survives across dispatcher instances (the TS
//!   reloader is a singleton), falling back to the payload reload.
//! - Mode is runtime intent folded into the SAME atomic reload (never a
//!   second PATCH that could fail after the new DNS/sniffer document was
//!   already committed).
//! - The external-IP probe sends an absolute-form GET through the kernel's
//!   mixed port so the echo service sees the NODE's exit address; every
//!   failure degrades to `null` (the `—` fallback in the UI, never an
//!   error).
//!
//! Staged (documented): the TUN payload branches
//! (`generateMihomoTunConfig` / `generateProxiedTunConfig`) land with the
//! privileged TUN slice — this build's gated TUN adapter never reports
//! enabled, so the unreachable branch is rejected loudly instead of
//! silently writing a document without the TUN block.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::enhancements;
use crate::error::IpcError;
use crate::override_apply;
use crate::override_service::OverrideService;
use crate::profile_service::ProfilesService;

/// `LiveConfigSection` — the controlled sections that patch individually.
pub const LIVE_SECTIONS: [&str; 3] = ["dns", "sniffer", "geodata"];

const GEODATA_KEYS: [&str; 5] =
    ["geodata-mode", "geodata-loader", "geo-auto-update", "geo-update-interval", "geox-url"];

/// The loaded-sniffer dispatcher signature temporarily muted by the runtime
/// `sniffing` gate (`LiveConfigReloader.suspendedSnifferSignature`). The TS
/// reloader is a single app-lifetime instance; the Rust reloader is built per
/// dispatch, so the shared state lives here instead.
static SUSPENDED_SNIFFER_SIGNATURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

const DEFAULT_IP_URL: &str = "http://ip.sb";
const DEFAULT_TIMEOUT_MS: u64 = 5000;

fn live_phase(status: &Value) -> bool {
    matches!(status["phase"].as_str(), Some("running") | Some("starting"))
}

/// The pinned session listener/auth identity (`LiveConfigRuntime`).
#[derive(Clone)]
pub struct LiveConfigRuntime {
    pub mixed_port: i64,
    pub http_port: i64,
    pub socks_port: i64,
    pub controller_port: i64,
    pub controller_host: String,
    pub allow_lan: bool,
    pub controller_panel: bool,
    pub secret: String,
    /// The brand-derived privileged adapter identity (`<shortName> TUN`).
    pub device: String,
}

impl LiveConfigRuntime {
    /// The TS composition pins the session values at boot
    /// (`productionMixedPort`…); the Tauri build derives the same identity
    /// from the controlled core-settings model — the same source the
    /// supervisor composition reads (staged with the real-kernel enable).
    pub fn from_core(core: &Value) -> Self {
        LiveConfigRuntime {
            mixed_port: core["mixedPort"].as_i64().unwrap_or(0),
            http_port: core["httpPort"].as_i64().unwrap_or(0),
            socks_port: core["socksPort"].as_i64().unwrap_or(0),
            controller_port: core["controllerPort"].as_i64().unwrap_or(9090),
            controller_host: core["controllerHost"]
                .as_str()
                .unwrap_or("127.0.0.1")
                .to_string(),
            allow_lan: core["allowLan"].as_bool() == Some(true),
            controller_panel: core["controllerPanel"].as_bool() == Some(true),
            secret: core["controllerSecret"].as_str().unwrap_or_default().to_string(),
            device: format!(
                "{} TUN",
                crate::brand::load_brand().map(|brand| brand.short_name).unwrap_or_else(|_| "Murge".to_string())
            ),
        }
    }

    fn builder_options(&self) -> Value {
        json!({
            "mixedPort": self.mixed_port,
            "httpPort": self.http_port,
            "socksPort": self.socks_port,
            "controllerPort": self.controller_port,
            "controllerHost": self.controller_host,
            "allowLan": self.allow_lan,
            "controllerPanel": self.controller_panel,
            "secret": self.secret,
            "device": self.device,
        })
    }
}

/// `snifferSignature` — the model with `enabled` normalized to `true`, so a
/// signature comparison checks everything EXCEPT the enabled flag.
fn sniffer_signature(value: &Value) -> String {
    let mut object = value.as_object().cloned().unwrap_or_default();
    object.insert("enabled".into(), json!(true));
    Value::Object(object).to_string()
}

/// The exact `resolveEnhancedActiveDocument` composition: active profile →
/// overrides → DNS enhancement → sniffer enhancement. `None` when no active
/// profile exists (the strict direct config is the runtime document then).
pub fn resolve_enhanced_document(
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
) -> Result<Option<String>, IpcError> {
    let profile = profiles.get_active()?;
    if profile.is_null() {
        return Ok(None);
    }
    let document = profile["document"].as_str().unwrap_or_default().to_string();
    let profile_id = profile["meta"]["id"].as_str().unwrap_or_default();
    let overridden = overrides.apply_for_profile(
        &document,
        if profile_id.is_empty() { None } else { Some(profile_id) },
    )?;
    let dns = enhancements::coerce_dns_enhancement(&models.dns.get());
    let (dns_text, _) = crate::inspection::apply_dns_to_document(&overridden, &dns);
    let sniffer = enhancements::coerce_sniffer_enhancement(&models.sniffer.get());
    let (text, _) = crate::inspection::apply_sniffer_to_document(&dns_text, &sniffer);
    Ok(Some(text))
}

/// `resolveOverriddenActiveDocument` — active profile → overrides ONLY (the
/// base document before DNS/sniffer enhancement). `None` when no active
/// profile exists.
pub fn resolve_overridden_document(
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
) -> Result<Option<String>, IpcError> {
    let profile = profiles.get_active()?;
    if profile.is_null() {
        return Ok(None);
    }
    let document = profile["document"].as_str().unwrap_or_default().to_string();
    let profile_id = profile["meta"]["id"].as_str().unwrap_or_default();
    let overridden = overrides.apply_for_profile(
        &document,
        if profile_id.is_empty() { None } else { Some(profile_id) },
    )?;
    Ok(Some(overridden))
}

/// `LiveConfigReloader` — one instance per dispatch call; everything it
/// reads is either owned-cheap or a borrow of the managed states.
pub struct LiveConfigReloader<'a> {
    kernel: &'a crate::kernel_process::KernelSupervisor,
    client: crate::mihomo::MihomoClient,
    runtime: LiveConfigRuntime,
    profiles: &'a Arc<ProfilesService>,
    overrides: &'a OverrideService,
    models: &'a enhancements::ModelStores,
}

impl<'a> LiveConfigReloader<'a> {
    /// The dispatch composition: controller + runtime from the core model
    /// (the same identity `controller_client` uses for every REST arm).
    pub fn from_ipc(
        kernel: &'a crate::kernel_process::KernelSupervisor,
        models: &'a enhancements::ModelStores,
        profiles: &'a Arc<ProfilesService>,
        overrides: &'a OverrideService,
    ) -> Result<Self, IpcError> {
        let core = enhancements::coerce_core_settings(&models.core.get());
        let client = crate::mihomo::MihomoClient::new(
            core["controllerPort"].as_i64().unwrap_or(9090),
            core["controllerSecret"].as_str().unwrap_or_default(),
        )?;
        Ok(LiveConfigReloader {
            kernel,
            client,
            runtime: LiveConfigRuntime::from_core(&core),
            profiles,
            overrides,
            models,
        })
    }

    /// Test seam: explicit controller + runtime.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_client(
        kernel: &'a crate::kernel_process::KernelSupervisor,
        client: crate::mihomo::MihomoClient,
        runtime: LiveConfigRuntime,
        profiles: &'a Arc<ProfilesService>,
        overrides: &'a OverrideService,
        models: &'a enhancements::ModelStores,
    ) -> Self {
        LiveConfigReloader { kernel, client, runtime, profiles, overrides, models }
    }

    fn kernel_running(&self) -> bool {
        live_phase(&self.kernel.get_status())
    }

    fn resolve_sources(&self) -> Result<(Option<String>, Value, Value, Value), IpcError> {
        let document = resolve_enhanced_document(self.profiles, self.overrides, self.models)?;
        let core = enhancements::coerce_core_settings(&self.models.core.get());
        let geodata = enhancements::coerce_geodata_settings(&self.models.geodata.get());
        let tun_config = enhancements::coerce_tun_config(&self.models.tun_config.get());
        Ok((document, core, geodata, tun_config))
    }

    /// Returns false when no running core exists and the persisted change is
    /// deferred (the TS `reloadIfRunning` contract).
    pub async fn reload_if_running(&self) -> Result<bool, IpcError> {
        if !self.kernel_running() {
            return Ok(false);
        }
        let current = self.client.get_config().await?;
        let payload = self.build_payload(&current)?;
        self.client.reload_config(&payload).await?;
        Ok(true)
    }

    /// Apply controlled sections through the lightest endpoint that actually
    /// owns them: mihomo's PATCH /configs endpoint silently ignores nested
    /// DNS and sniffer blocks, so those use the full payload reload;
    /// geodata supports the partial endpoint.
    pub async fn apply_sections(&self, sections: &[&str]) -> Result<bool, IpcError> {
        for section in sections {
            if !LIVE_SECTIONS.contains(section) {
                return Err(IpcError::invalid_argument(format!(
                    "unknown live config section: {section}"
                )));
            }
        }
        if !self.kernel_running() {
            return Ok(false);
        }
        let current = self.client.get_config().await?;
        let payload = self.build_payload(&current)?;

        if sections.contains(&"dns") || sections.contains(&"sniffer") {
            self.client.reload_config(&payload).await?;
            *SUSPENDED_SNIFFER_SIGNATURE
                .lock()
                .expect("suspended sniffer signature") = None;
            if sections.contains(&"dns") {
                // A changed fake-IP range must not keep mappings from the
                // previous DNS model. Cache cleanup is best-effort because
                // the reload succeeded (`Promise.allSettled`).
                let _ = tokio::join!(self.client.flush_dns_cache(), self.client.flush_fakeip_cache());
            }
            return Ok(true);
        }

        let data = override_apply::parse_yaml_to_object(&payload)
            .ok_or_else(|| IpcError::internal("live config payload failed to parse"))?;
        let mut patch = serde_json::Map::new();
        for section in sections {
            if *section == "geodata" {
                let geodata = enhancements::coerce_geodata_settings(&self.models.geodata.get());
                let fallback = enhancements::build_geodata_block(&geodata);
                for key in GEODATA_KEYS {
                    patch.insert(
                        key.to_string(),
                        data.get(key)
                            .cloned()
                            .unwrap_or_else(|| fallback.get(key).cloned().unwrap_or(Value::Null)),
                    );
                }
                continue;
            }
            let value = data.get(*section).cloned().unwrap_or(Value::Null);
            patch.insert(
                (*section).to_string(),
                if value.is_object() { value } else { json!({ "enable": false }) },
            );
        }

        self.client.patch_config(&Value::Object(patch)).await?;
        Ok(true)
    }

    /// Toggle an already-loaded sniffer dispatcher through mihomo's
    /// lightweight legacy `sniffing` runtime flag. A full payload reload
    /// remains the safe fallback when the underlying dispatcher/config must
    /// change.
    pub async fn apply_sniffer_transition_if_running(
        &self,
        previous: &Value,
        next: &Value,
    ) -> Result<bool, IpcError> {
        if !self.kernel_running() {
            return Ok(false);
        }
        let signature = sniffer_signature(next);
        let enabled_only = previous.get("enabled").and_then(Value::as_bool)
            != next.get("enabled").and_then(Value::as_bool)
            && sniffer_signature(previous) == signature;
        let base_has_enabled_sniffer = self.base_document_sniffer_enabled()?;

        if enabled_only && !base_has_enabled_sniffer {
            // Decide under the lock, never hold it across an await.
            let disabling = next.get("enabled").and_then(Value::as_bool) == Some(false);
            let armed = {
                let suspended =
                    SUSPENDED_SNIFFER_SIGNATURE.lock().expect("suspended sniffer signature");
                disabling || suspended.as_deref() == Some(signature.as_str())
            };
            if armed {
                if disabling {
                    self.client.patch_config(&json!({ "sniffing": false })).await?;
                    if let Ok(confirmed) = self.client.get_config().await {
                        if confirmed.get("sniffing") == Some(&json!(false)) {
                            *SUSPENDED_SNIFFER_SIGNATURE
                                .lock()
                                .expect("suspended sniffer signature") = Some(signature);
                            return Ok(true);
                        }
                    }
                } else {
                    self.client.patch_config(&json!({ "sniffing": true })).await?;
                    if let Ok(confirmed) = self.client.get_config().await {
                        if confirmed.get("sniffing") == Some(&json!(true)) {
                            *SUSPENDED_SNIFFER_SIGNATURE
                                .lock()
                                .expect("suspended sniffer signature") = None;
                            return Ok(true);
                        }
                    }
                }
            }
        }
        *SUSPENDED_SNIFFER_SIGNATURE.lock().expect("suspended sniffer signature") = None;
        self.apply_sections(&["sniffer"]).await
    }

    /// `baseDocumentSnifferEnabled`: whether the OVERRIDES-ONLY base document
    /// (before DNS/sniffer enhancement) carries a live sniffer module.
    fn base_document_sniffer_enabled(&self) -> Result<bool, IpcError> {
        let Some(text) = resolve_overridden_document(self.profiles, self.overrides)? else {
            return Ok(false);
        };
        let Some(data) = override_apply::parse_yaml_to_object(&text) else {
            return Ok(false);
        };
        let sniffer = data.get("sniffer");
        Ok(matches!(sniffer, Some(sniffer) if sniffer.is_object()
            && sniffer.get("enable") == Some(&json!(true))))
    }

    /// `buildPayload` — the document branch goes through the safety builder
    /// (profile content preserved, host-network keys neutralized, app keys
    /// forced, core/geodata read-back folded); the no-profile branch is the
    /// strict direct config. Mode is runtime intent folded into the SAME
    /// atomic reload.
    fn build_payload(&self, current: &Value) -> Result<String, IpcError> {
        let tun_enabled = current
            .get("tun")
            .and_then(|tun| tun.get("enable"))
            .and_then(Value::as_bool)
            == Some(true);
        let (document, core, geodata, tun_config) = self.resolve_sources()?;

        let payload = match (&document, tun_enabled) {
            (Some(document), true) => {
                // The privileged TUN composition: the same safety transform
                // with the tun block re-added (mihomo owns the adapter).
                let mut options = self.runtime.builder_options();
                if let Some(options) = options.as_object_mut() {
                    options.insert("document".into(), json!(document));
                    options.insert("tunConfig".into(), tun_config);
                    options.insert("core".into(), core);
                    options.insert("geodata".into(), geodata);
                    options.insert("tunEnabled".into(), json!(true));
                }
                crate::tun_profile::generate_proxied_tun_config(&options)?
            }
            (None, true) => {
                let mut options = self.runtime.builder_options();
                if let Some(options) = options.as_object_mut() {
                    options.insert("tunConfig".into(), tun_config);
                    options.insert("tunEnabled".into(), json!(true));
                }
                crate::tun_profile::generate_mihomo_tun_config(&options)?
            }
            (Some(document), false) => {
                let mut options = self.runtime.builder_options();
                if let Some(options) = options.as_object_mut() {
                    options.insert("core".into(), core);
                    options.insert("geodata".into(), geodata);
                }
                crate::inspection::build_profile_kernel_config(document, &options)?
            }
            (None, false) => {
                crate::kernel_process::generate_mihomo_config(&self.runtime.builder_options())?
            }
        };

        // The safety builder intentionally normalizes profile startup mode to
        // rule. A live Direct/Global choice is runtime intent, so fold it into
        // the SAME atomic reload rather than issuing a second PATCH that could
        // fail after the new DNS/sniffer document was already committed.
        let current_mode = current.get("mode").and_then(Value::as_str);
        if document.is_some() && matches!(current_mode, Some("direct") | Some("global")) {
            let mut data = override_apply::parse_yaml_to_object(&payload)
                .ok_or_else(|| IpcError::internal("live config payload failed to parse"))?;
            data.insert("mode".into(), json!(current_mode));
            return Ok(override_apply::stringify_yaml(Value::Object(data)));
        }
        Ok(payload)
    }
}

/// `reloadKernelForActiveProfile` + the `ProfileAutoReloadGateway` reload
/// fallback: the controller hot reload FIRST (`reloadIfRunning`); when it
/// cannot run (kernel stopped) or fails, fall back to the full lifecycle —
/// stop (the ordered `kernel:stop` restores the system proxy first) then
/// start; the proxy is only re-enabled when it was owned before the
/// restart. The active-pointer rollback belongs to the caller.
/// A caller-supplied rollback (`KernelReloadOptions.rollbackActive`): runs
/// when the restart cannot be applied (stop failure or replacement failure).
pub type RollbackActiveFn =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<(), IpcError>> + Send + Sync>;

pub async fn reload_active_profile(
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
    kernel: &crate::kernel::KernelServices,
    system_proxy: &crate::system_proxy::SystemProxyService,
) -> Result<bool, IpcError> {
    reload_active_profile_with_rollback(
        profiles,
        overrides,
        models,
        kernel,
        system_proxy,
        None,
    )
    .await
}

pub async fn reload_active_profile_with_rollback(
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
    kernel: &crate::kernel::KernelServices,
    system_proxy: &crate::system_proxy::SystemProxyService,
    rollback_active: Option<RollbackActiveFn>,
) -> Result<bool, IpcError> {
    let reloader = LiveConfigReloader::from_ipc(&kernel.supervisor, models, profiles, overrides)?;
    if let Ok(applied) = reloader.reload_if_running().await {
        return Ok(applied);
    }
    if !live_phase(&kernel.get_status_value()) {
        // No running core: the active profile is picked up on the next
        // manual start; never spin up a kernel the user did not ask for.
        return Ok(false);
    }
    let proxy_was_enabled = system_proxy.get_status().phase == "enabled";
    if let Err(error) = kernel.stop().await {
        if let Some(rollback) = &rollback_active {
            let _ = rollback().await; // Preserve the lifecycle failure.
        }
        return Err(error);
    }
    match kernel.start().await {
        Ok(_) => {
            if proxy_was_enabled {
                let _ = system_proxy.enable().await;
            }
            Ok(true)
        }
        Err(replacement_error) => {
            if let Some(rollback) = &rollback_active {
                let rollback_succeeded = rollback().await.is_ok();
                // Best-effort recovery BEFORE propagating the original
                // failure: never restart against a pointer whose restoration
                // failed, and the kernel status/logs retain any recovery
                // failure for diagnostics.
                if rollback_succeeded {
                    let _ = kernel.start().await;
                    if proxy_was_enabled {
                        let _ = system_proxy.enable().await;
                    }
                }
            }
            Err(replacement_error)
        }
    }
}

/// Replay the active profile's remembered node picks after a successful
/// live reload/restart (the `proxySelectionService.restoreSelections()`
/// tail of every ProfileAutoReloadGateway reload path). Best-effort.
pub async fn restore_selections_after_reload(
    mihomo: &crate::mihomo::MihomoServices,
    models: &enhancements::ModelStores,
    profiles: &Arc<ProfilesService>,
) {
    let core = enhancements::coerce_core_settings(&models.core.get());
    let Ok(client) = crate::mihomo::MihomoClient::new(
        core["controllerPort"].as_i64().unwrap_or(9090),
        core["controllerSecret"].as_str().unwrap_or_default(),
    ) else {
        return;
    };
    let active = profiles
        .list()
        .ok()
        .and_then(|list| {
            list.as_array()
                .and_then(|metas| metas.iter().find(|meta| meta["active"].as_bool() == Some(true)))
                .and_then(|meta| meta["id"].as_str().map(str::to_string))
        });
    let _ = mihomo.restore_selections(&client, active).await;
}

// ---------------------------------------------------------------------------
// External-IP probe (external-ip.ts + register-ipc resolveExternalIp)
// ---------------------------------------------------------------------------

/// `extractIp`: the first line is a whole dotted-quad → it; otherwise the
/// first dotted-quad anywhere in the body. IPv6 never matches.
pub fn extract_ip(text: &str) -> Option<String> {
    let first_line = text.trim().split(['\r', '\n']).next().unwrap_or("").trim();
    if is_dotted_quad(first_line) {
        return Some(first_line.to_string());
    }
    let mut candidate = String::new();
    let mut dots = 0usize;
    for character in text.chars() {
        if character.is_ascii_digit() {
            candidate.push(character);
        } else if character == '.' {
            if dots == 3 {
                // A fifth group: abandon and restart after this dot.
                candidate.clear();
                dots = 0;
                continue;
            }
            dots += 1;
            candidate.push(character);
        } else {
            if dots == 3 && candidate.matches('.').count() == 3 {
                return Some(candidate);
            }
            candidate.clear();
            dots = 0;
        }
    }
    if dots == 3 && candidate.matches('.').count() == 3 {
        return Some(candidate);
    }
    None
}

fn is_dotted_quad(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u16>().map(|n| n <= 255).unwrap_or(false)
        })
}

/// `fetchExternalIpViaProxy`: absolute-form GET through the mixed port; the
/// IP-echo service sees the NODE's exit address. Every failure → `None`.
/// Only plain http targets are supported (the absolute-form contract).
pub fn fetch_external_ip_via_proxy(
    proxy_port: u16,
    url: Option<&str>,
    timeout_ms: Option<u64>,
) -> futures_util::future::BoxFuture<'static, Option<String>> {
    let target = url.unwrap_or(DEFAULT_IP_URL).to_string();
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    Box::pin(async move {
        let parsed = match reqwest::Url::parse(&target) {
            Ok(parsed) if parsed.scheme() == "http" => parsed,
            _ => return None,
        };
        let proxy = match reqwest::Proxy::http(&format!("http://127.0.0.1:{proxy_port}")) {
            Ok(proxy) => proxy,
            Err(_) => return None,
        };
        let client = match reqwest::Client::builder().proxy(proxy).timeout(timeout).build() {
            Ok(client) => client,
            Err(_) => return None,
        };
        match client.get(parsed).send().await {
            Ok(response) => match response.text().await {
                Ok(body) => extract_ip(&body),
                Err(_) => None,
            },
            Err(_) => None,
        }
    })
}

/// `register-ipc.ts:resolveExternalIp` — null unless the kernel is running;
/// the port comes from the live controller config (`mixed-port` ?? `port`).
/// Every failure degrades to `null`.
pub async fn resolve_external_ip(
    kernel: &crate::kernel_process::KernelSupervisor,
    models: &enhancements::ModelStores,
) -> Value {
    let status = kernel.get_status();
    if status["phase"].as_str() != Some("running") {
        return Value::Null;
    }
    let core = enhancements::coerce_core_settings(&models.core.get());
    let Ok(client) = crate::mihomo::MihomoClient::new(
        core["controllerPort"].as_i64().unwrap_or(9090),
        core["controllerSecret"].as_str().unwrap_or_default(),
    ) else {
        return Value::Null;
    };
    let config = match client.get_config().await {
        Ok(config) => config,
        Err(_) => return Value::Null,
    };
    let port = config
        .get("mixed-port")
        .and_then(Value::as_i64)
        .or_else(|| config.get("port").and_then(Value::as_i64))
        .unwrap_or(0);
    if !(1..=65535).contains(&port) {
        return Value::Null;
    }
    fetch_external_ip_via_proxy(port as u16, None, None)
        .await
        .map(Value::String)
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile_service::ProfilesService;
    use crate::override_service::OverrideService;
    use serde_json::json;
    use std::sync::Mutex;

    fn runtime() -> LiveConfigRuntime {
        LiveConfigRuntime {
            mixed_port: 21000,
            http_port: 0,
            socks_port: 0,
            controller_port: 20001,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            secret: "a".repeat(64),
            device: "Murge TUN".to_string(),
        }
    }

    fn service() -> (tempfile::TempDir, Arc<ProfilesService>, OverrideService, enhancements::ModelStores) {
        let temp = tempfile::TempDir::new().unwrap();
        let profiles = Arc::new(ProfilesService::for_development(&temp.path().to_path_buf()));
        let overrides = OverrideService::new(None);
        let models = enhancements::ModelStores::new(None);
        (temp, profiles, overrides, models)
    }

    // -- extractIp ----------------------------------------------------------

    #[test]
    fn extract_ip_prefers_a_clean_first_line() {
        assert_eq!(extract_ip("198.51.100.7\nmore"), Some("198.51.100.7".to_string()));
        assert_eq!(extract_ip("203.0.113.4\r\ntail"), Some("203.0.113.4".to_string()));
    }

    #[test]
    fn extract_ip_falls_back_to_a_scan() {
        assert_eq!(
            extract_ip("ip: 198.51.100.7 (exit)\n"),
            Some("198.51.100.7".to_string())
        );
        assert_eq!(extract_ip("no address here"), None);
        assert_eq!(extract_ip(""), None);
    }

    #[test]
    fn extract_ip_ignores_out_of_range_octets_and_ipv6() {
        // 999 octet: the TS regex would still match it (no range check) — but
        // the FIRST-LINE branch requires the exact shape, so a 999 body only
        // matches through the scan. Keep parity with the TS \d{1,3} rule.
        assert_eq!(extract_ip("999.1.1.1"), Some("999.1.1.1".to_string()));
        // IPv6 bodies without an IPv4 address yield nothing.
        assert_eq!(extract_ip("2001:db8::1"), None);
    }

    // -- probe through a real local proxy -----------------------------------

    #[test]
    fn probe_flows_through_the_local_proxy() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let body = "198.51.100.7\n";
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        let ip = tokio::runtime::Runtime::new().unwrap().block_on(async {
            fetch_external_ip_via_proxy(port, None, Some(3000)).await
        });
        assert_eq!(ip, Some("198.51.100.7".to_string()));
    }

    #[test]
    fn probe_degrades_to_none_on_a_dead_proxy() {
        // Nothing listens on port 1.
        let ip = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_external_ip_via_proxy(1, None, Some(300)));
        assert_eq!(ip, None);
    }

    #[test]
    fn probe_rejects_non_http_targets() {
        let ip = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_external_ip_via_proxy(1, Some("https://ip.sb"), Some(300)));
        assert_eq!(ip, None);
    }

    // -- payload composition --------------------------------------------------

    #[tokio::test]
    async fn payload_without_a_profile_is_the_strict_direct_config() {
        let (_temp, profiles, overrides, models) = service();
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(1, "").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let payload = reloader.build_payload(&json!({ "tun": { "enable": false } })).unwrap();
        assert!(crate::kernel_config_validation::mihomo_config_errors(&payload).is_empty(), "{payload}");
        assert!(payload.contains("mixed-port: 21000"));
        assert!(payload.contains("external-controller: 127.0.0.1:20001"));
    }

    #[tokio::test]
    async fn payload_folds_live_direct_global_mode_into_the_atomic_reload() {
        let (_temp, profiles, overrides, models) = service();
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(1, "").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        // No active profile: the mode fold is document-only (strict config is
        // always direct).
        let payload = reloader.build_payload(&json!({ "mode": "global", "tun": { "enable": false } })).unwrap();
        assert!(payload.contains("mode: direct"), "{payload}");
    }

    #[tokio::test]
    async fn payload_folds_mode_for_profile_documents() {
        let (temp, profiles, overrides, models) = service();
        let import = json!({ "name": "p", "document": "proxies:\n  - name: a\n    type: ss\n    server: s\n    port: 1\nmode: rule\n", "activate": true });
        profiles.import(&import).unwrap();
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(1, "").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp; // keeps the tempdir alive
        let payload = reloader.build_payload(&json!({ "mode": "global", "tun": { "enable": false } })).unwrap();
        assert!(payload.contains("mode: global"), "{payload}");
        assert!(payload.contains("name: a"), "{payload}");
        // The safety-critical keys are still forced.
        assert!(payload.contains("mixed-port: 21000"), "{payload}");
    }

    #[tokio::test]
    async fn payload_composes_the_tun_branch_when_the_kernel_runs_tun() {
        let (_temp, profiles, overrides, models) = service();
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(1, "").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        // No active profile + tun enabled → the privileged bootstrap profile.
        let payload = reloader.build_payload(&json!({ "tun": { "enable": true } })).unwrap();
        assert!(crate::tun_profile::mihomo_tun_config_errors(&payload).is_empty(), "{payload}");
        assert!(payload.contains("tun:"), "{payload}");
        assert!(payload.contains("enable: true"), "{payload}");
    }

    // -- section patch ---------------------------------------------------------

    #[tokio::test]
    async fn apply_sections_reloads_the_payload_for_dns_and_flushes_caches() {
        let (temp, profiles, overrides, models) = service();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            captured.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("GET", "/configs") => (200, json!({ "mode": "rule", "tun": { "enable": false } }).to_string()),
                ("PUT", "/configs") => (204, String::new()),
                ("PATCH", "/configs") => (204, String::new()),
                ("POST", "/cache/dns/flush") => (204, String::new()),
                ("POST", "/cache/fakeip/flush") => (204, String::new()),
                _ => (404, String::new()),
            }
        });
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp;
        let applied = reloader.apply_sections(&["dns"]).await.unwrap();
        assert!(applied);
        let log = requests.lock().unwrap();
        // mihomo's PATCH /configs silently ignores nested DNS blocks: the DNS
        // section applies through the full payload reload instead.
        assert!(log.iter().any(|entry| entry.starts_with("PUT /configs")), "{log:?}");
        let put = log.iter().find(|entry| entry.starts_with("PUT /configs")).unwrap();
        assert!(put.contains("dns:"), "{put}");
        assert!(!log.iter().any(|entry| entry.starts_with("PATCH /configs")), "{log:?}");
        assert!(log.iter().any(|entry| entry.starts_with("POST /cache/dns/flush")), "{log:?}");
        assert!(log.iter().any(|entry| entry.starts_with("POST /cache/fakeip/flush")), "{log:?}");
    }

    #[tokio::test]
    async fn geodata_patch_falls_back_to_the_block_per_key() {
        let (temp, profiles, overrides, models) = service();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            captured.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("GET", "/configs") => (200, json!({ "tun": { "enable": false } }).to_string()),
                ("PATCH", "/configs") => (204, String::new()),
                _ => (404, String::new()),
            }
        });
        models
            .geodata
            .set(&json!({ "enabled": true, "geodataMode": true }), enhancements::coerce_geodata_settings)
            .unwrap();
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp;
        reloader.apply_sections(&["geodata"]).await.unwrap();
        let log = requests.lock().unwrap();
        let patch = log.iter().find(|entry| entry.starts_with("PATCH /configs")).unwrap();
        for key in ["geodata-mode", "geodata-loader", "geo-auto-update", "geo-update-interval", "geox-url"] {
            assert!(patch.contains(key), "{key} missing in {patch}");
        }
        assert!(patch.contains("\"geodata-mode\":true"), "{patch}");
    }

    #[tokio::test]
    async fn sniffer_transition_disables_through_the_runtime_gate() {
        // Enable-only change on a base document WITHOUT a live sniffer module:
        // the runtime `sniffing` gate owns the toggle, no payload reload.
        let (temp, profiles, overrides, models) = service();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let sniffing = std::sync::Arc::new(std::sync::Mutex::new(true));
        let sniffing_state = sniffing.clone();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            captured.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("GET", "/configs") => (200, json!({ "mode": "rule", "sniffing": *sniffing_state.lock().unwrap() }).to_string()),
                ("PATCH", "/configs") => {
                    let patch: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    if let Some(value) = patch.get("sniffing").and_then(Value::as_bool) {
                        *sniffing_state.lock().unwrap() = value;
                    }
                    (204, String::new())
                }
                _ => (404, String::new()),
            }
        });
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp;
        let previous = json!({ "enabled": true });
        let next = json!({ "enabled": false });
        let applied = reloader
            .apply_sniffer_transition_if_running(&previous, &next)
            .await
            .unwrap();
        assert!(applied);
        let log = requests.lock().unwrap();
        assert!(log.iter().any(|entry| entry.starts_with("PATCH /configs {\"sniffing\":false}")), "{log:?}");
        assert!(!log.iter().any(|entry| entry.starts_with("PUT /configs")), "{log:?}");
    }

    #[tokio::test]
    async fn sniffer_transition_falls_back_to_the_payload_reload_for_model_changes() {
        // A value change (not enable-only) must NOT use the runtime gate.
        let (temp, profiles, overrides, models) = service();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            captured.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("GET", "/configs") => (200, json!({ "mode": "rule" }).to_string()),
                ("PUT", "/configs") => (204, String::new()),
                _ => (404, String::new()),
            }
        });
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp;
        let previous = json!({ "enabled": true, "overrideDestinations": false });
        let next = json!({ "enabled": true, "overrideDestinations": true });
        let applied = reloader
            .apply_sniffer_transition_if_running(&previous, &next)
            .await
            .unwrap();
        assert!(applied);
        let log = requests.lock().unwrap();
        assert!(log.iter().any(|entry| entry.starts_with("PUT /configs")), "{log:?}");
        assert!(!log.iter().any(|entry| entry.starts_with("PATCH /configs")), "{log:?}");
    }

    #[tokio::test]
    async fn apply_sections_defers_when_the_kernel_is_not_running() {
        let (_temp, profiles, overrides, models) = service();
        // The DISABLED supervisor never reports running — the change is
        // deferred and no HTTP call happens (port 1 has no listener).
        let kernel = crate::kernel_process::KernelSupervisor::create(
            crate::kernel_process::KernelDependencies {
                resolver: std::sync::Arc::new(crate::kernel_process::DisabledKernelBinaryResolver),
                config_store: std::sync::Arc::new(crate::kernel_process::TempKernelConfigStore),
                adapter: std::sync::Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                secret: crate::kernel_process::random_secret(),
                attach_watchdog: None,
            },
            crate::kernel_process::SupervisorOptions::default(),
        );
        let reloader = LiveConfigReloader::with_client(
            &kernel,
            crate::mihomo::MihomoClient::new(1, "").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        assert_eq!(reloader.apply_sections(&["dns"]).await.unwrap(), false);
        assert_eq!(reloader.reload_if_running().await.unwrap(), false);
    }

    // -- full reload ------------------------------------------------------------

    #[tokio::test]
    async fn reload_puts_the_complete_document() {
        let (temp, profiles, overrides, models) = service();
        let import = json!({ "name": "p", "document": "proxies:\n  - name: a\n    type: ss\n    server: s\n    port: 1\nrules:\n  - MATCH,A\n", "activate": true });
        profiles.import(&import).unwrap();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            captured.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("GET", "/configs") => (200, json!({ "mode": "global", "tun": { "enable": false } }).to_string()),
                ("PUT", "/configs") => (204, String::new()),
                _ => (404, String::new()),
            }
        });
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        let _ = temp;
        assert!(reloader.reload_if_running().await.unwrap());
        let log = requests.lock().unwrap();
        let put = log.iter().find(|entry| entry.starts_with("PUT /configs")).unwrap();
        assert!(put.contains("name: a"), "{put}");
        assert!(put.contains("mode: global"), "{put}");
        assert!(put.contains("MATCH,A"), "{put}");
    }

    #[tokio::test]
    async fn reload_errors_propagate_for_the_coordinator_rollback() {
        let (_temp, profiles, overrides, models) = service();
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", |_method, _path, _body| {
            (500, "boom".to_string())
        });
        let kernel = running_kernel().await;
        let reloader = LiveConfigReloader::with_client(
            kernel.as_ref(),
            crate::mihomo::MihomoClient::new(server.port, "s3cret").unwrap(),
            runtime(),
            &profiles,
            &overrides,
            &models,
        );
        assert!(reloader.reload_if_running().await.is_err());
    }

    // -- external-IP resolve chain ----------------------------------------------

    #[tokio::test]
    async fn external_ip_requires_a_running_kernel() {
        let (_temp, _profiles, _overrides, models) = service();
        let kernel = crate::kernel_process::KernelSupervisor::create(
            crate::kernel_process::KernelDependencies {
                resolver: std::sync::Arc::new(crate::kernel_process::DisabledKernelBinaryResolver),
                config_store: std::sync::Arc::new(crate::kernel_process::TempKernelConfigStore),
                adapter: std::sync::Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                secret: crate::kernel_process::random_secret(),
                attach_watchdog: None,
            },
            crate::kernel_process::SupervisorOptions::default(),
        );
        assert_eq!(resolve_external_ip(&kernel, &models).await, Value::Null);
    }

    #[tokio::test]
    async fn external_ip_degrades_to_null_on_a_dead_controller() {
        let kernel = running_kernel().await;
        let (_temp, _profiles, _overrides, models) = service();
        assert_eq!(resolve_external_ip(&kernel, &models).await, Value::Null);
    }

    /// A supervisor driven to the running phase through the fake adapter
    /// harness (shared with the kernel_process lifecycle tests).
    async fn running_kernel() -> Arc<crate::kernel_process::KernelSupervisor> {
        let harness = crate::kernel_process::tests::create_harness();
        crate::kernel_process::tests::start_to_running(&harness).await;
        harness.supervisor
    }
}
