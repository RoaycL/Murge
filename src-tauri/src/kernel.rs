//! Kernel lifecycle + version manager — Rust port of the Electron
//! `KernelSupervisor` state machine (main/kernel/supervisor.ts),
//! `shared/runtime.ts` (`KernelStatus`), `shared/kernel-manager.ts` and
//! `main/kernel/kernel-manager-service.ts` (state materialization), plus the
//! runtime summary composition (main/ipc/register-ipc.ts).
//!
//! Milestone staging (documented in docs/tauri/phase3/README.md): the binary
//! resolver is the DisabledKernelResolver port (the same UNSUPPORTED copy the
//! Electron dev/fixture build uses) until the artifact pipeline (download,
//! verify, extract) lands with the network slices. The manager's
//! `specificVersionsSupported` is therefore false, which matches the Electron
//! service-mode behavior byte for byte (same guards, same error copies, the
//! renderer hides the specific-version UI).

use std::sync::Mutex;

use serde_json::{json, Value};

use crate::error::IpcError;
use crate::events::EventHub;
use crate::settings::SettingsStore;

pub const DISABLED_RESOLVER_MESSAGE: &str =
    "Kernel execution is disabled in this build; no real kernel is started.";
/// The pinned bundled mihomo build (resources/mihomo-assets.json `version`).
pub const MIHOMO_VERSION: &str = "v1.19.30";

const UNSUPPORTED_CHANNEL_MESSAGE: &str = "当前 Windows 服务模式仅支持安装包内置的稳定内核。";
const UNSUPPORTED_INSTALL_MESSAGE: &str = "当前 Windows 服务模式不能安装指定内核版本。";

fn is_valid_channel(value: &str) -> bool {
    matches!(value, "stable" | "preview" | "smart" | "specific")
}

// ---------------------------------------------------------------------------
// Kernel status + supervisor
// ---------------------------------------------------------------------------

fn stopped_status() -> Value {
    json!({
        "phase": "stopped",
        "pid": null,
        "version": null,
        "controllerUrl": null,
        "startedAt": null,
        "lastError": null
    })
}

/// The supervisor state machine. Serialization mirrors the TS `chain` promise:
/// operations run one at a time against the status store.
pub struct KernelSupervisor {
    status: Mutex<Value>,
    queue: Mutex<()>,
    /// `status` event listeners — every `setStatus` fans out here (the TS
    /// supervisor EventEmitter contract; the push forwarder subscribes).
    pub status_listeners: EventHub,
}

impl KernelSupervisor {
    pub fn new() -> Self {
        KernelSupervisor {
            status: Mutex::new(stopped_status()),
            queue: Mutex::new(()),
            status_listeners: EventHub::new(),
        }
    }

    pub fn get_status(&self) -> Value {
        self.status.lock().expect("kernel status mutex poisoned").clone()
    }

    fn set_status(&self, patch: Value) {
        let mut status = self.status.lock().expect("kernel status mutex poisoned");
        if let (Some(target), Some(patch)) = (status.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                target.insert(key.clone(), value.clone());
            }
        }
        let snapshot = status.clone();
        drop(status);
        self.status_listeners.emit(&snapshot);
    }

    /// Start the kernel. The disabled resolver fails exactly like the Electron
    /// fixture/disabled milestone: phase `failed` + the UNSUPPORTED message as
    /// `lastError`, and the same error propagates to the renderer.
    pub fn start(&self) -> Result<Value, IpcError> {
        let _serial = self.queue.lock().expect("kernel queue mutex poisoned");
        let phase = self.get_status()["phase"].take().as_str().unwrap_or("stopped").to_string();
        if phase == "running" || phase == "starting" || phase == "stopping" {
            return Ok(self.get_status());
        }
        self.set_status(json!({ "phase": "starting", "lastError": null }));
        // Resolver step: this build stages the artifact pipeline, so resolve
        // fails with the DisabledKernelResolver copy (raiseFailed: phase
        // `failed` + lastError, and the error propagates).
        self.set_status(json!({ "phase": "failed", "lastError": DISABLED_RESOLVER_MESSAGE, "pid": null }));
        Err(IpcError::unsupported(DISABLED_RESOLVER_MESSAGE))
    }

    /// Stop the kernel. With no process ever spawned (the resolver gate fails
    /// first), every transition lands on a clean `stopped` state.
    pub fn stop(&self) -> Result<Value, IpcError> {
        let _serial = self.queue.lock().expect("kernel queue mutex poisoned");
        let phase = self.get_status()["phase"].take().as_str().unwrap_or("stopped").to_string();
        if phase == "stopped" {
            return Ok(self.get_status());
        }
        if phase == "running" || phase == "starting" {
            self.set_status(json!({ "phase": "stopping" }));
        }
        self.set_status(json!({ "phase": "stopped", "pid": null, "lastError": null }));
        Ok(self.get_status())
    }
}

impl Default for KernelSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Kernel manager (version channels)
// ---------------------------------------------------------------------------

const DEFAULT_STATE: Value = Value::Null;

/// Version-manager state. Durable choices (kernelChannel /
/// kernelSpecificVersion) live in the settings document and are mirrored here;
/// the rest is transient state owned by this service.
pub struct KernelManagerService {
    transient: Mutex<Value>,
    /// `state` event listeners — every commit fans out here.
    pub state_listeners: EventHub,
}

impl KernelManagerService {
    pub fn new() -> Self {
        KernelManagerService { transient: Mutex::new(DEFAULT_STATE), state_listeners: EventHub::new() }
    }

    fn transient_guard(&self) -> std::sync::MutexGuard<'_, Value> {
        self.transient.lock().expect("kernel manager mutex poisoned")
    }

    /// The buildState port: persisted settings + pinned stable version +
    /// transient fields, coerced with the exact fallback rules.
    pub fn build_state(&self, settings: &SettingsStore) -> Value {
        let app_settings = settings.get();
        let stable_version = MIHOMO_VERSION;
        let specific_versions_supported = false; // staged: artifact pipeline (network slice)
        let raw_channel = app_settings.kernel_channel.as_str();
        let channel = if specific_versions_supported && is_valid_channel(raw_channel) {
            raw_channel.to_string()
        } else {
            "stable".to_string()
        };
        let specific_version = {
            let raw = app_settings.kernel_specific_version.trim();
            if raw.is_empty() { None } else { Some(raw.to_string()) }
        };
        let effective_version = match (channel.as_str(), &specific_version) {
            ("specific", Some(version)) => version.clone(),
            ("preview", _) => "预览版".to_string(),
            ("smart", _) => "Smart".to_string(),
            _ => stable_version.to_string(),
        };
        let transient = self.transient_guard().clone();
        json!({
            // Kept for wire compatibility; the kernel now always follows the app.
            "enabled": true,
            "smartEnabled": channel == "smart",
            "channel": channel,
            "stableVersion": stable_version,
            "specificVersion": specific_version,
            "effectiveVersion": effective_version,
            "specificVersionsSupported": specific_versions_supported,
            "versions": transient.get("versions").cloned().unwrap_or(json!([])),
            "versionsLoading": transient.get("versionsLoading").and_then(Value::as_bool).unwrap_or(false),
            "installing": transient.get("installing").cloned().unwrap_or(Value::Null),
            "error": transient.get("error").cloned().unwrap_or(Value::Null)
        })
    }

    pub fn get_state(&self, settings: &SettingsStore) -> Value {
        self.build_state(settings)
    }

    fn commit(&self, settings: &SettingsStore) -> Value {
        let state = self.build_state(settings);
        self.state_listeners.emit(&state);
        state
    }

    /// setEnabled(true) selects Smart, setEnabled(false) back to stable — the
    /// exact TS delegation.
    pub fn set_enabled(&self, settings: &SettingsStore, enabled: bool) -> Value {
        self.set_channel(settings, if enabled { "smart" } else { "stable" })
    }

    /// Switch the version channel. `specific` is rejected with the
    /// service-mode copy while the artifact pipeline is staged; preview/smart
    /// attempt the install first and only persist the channel when it
    /// succeeds (the staged installer fails with the same error copy shape
    /// and leaves the previous channel in place).
    pub fn set_channel(&self, settings: &SettingsStore, channel: &str) -> Value {
        if !is_valid_channel(channel) {
            let mut transient = self.transient_guard();
            transient["error"] = json!(format!("无效的版本号：{channel}"));
            drop(transient);
            return self.commit(settings);
        }
        if channel == "specific" {
            let mut transient = self.transient_guard();
            transient["error"] = json!(UNSUPPORTED_CHANNEL_MESSAGE);
            drop(transient);
            return self.commit(settings);
        }
        let current = settings.get();
        if current.kernel_channel == channel {
            let mut transient = self.transient_guard();
            transient["error"] = Value::Null;
            drop(transient);
            return self.commit(settings);
        }
        let previous_channel = current.kernel_channel.clone();
        if channel == "preview" || channel == "smart" {
            // The staged installer cannot download non-bundled builds yet, so
            // the attempt fails and the channel stays as before (TS: install
            // runs BEFORE settings.set, and its failure commits with the
            // previous settings untouched).
            {
                let mut transient = self.transient_guard();
                transient["installing"] = json!(channel);
                drop(transient);
                let mut transient = self.transient_guard();
                transient["installing"] = Value::Null;
                transient["error"] = json!(format!(
                    "安装{label}内核失败",
                    label = if channel == "smart" { " Smart" } else { "预览" }
                ));
            }
            return self.commit(settings);
        }
        let _ = previous_channel;
        settings
            .set(&crate::settings::AppSettingsPatch(serde_json::json!({
                "kernelChannel": channel, "kernelEnabled": true
            })))
            .kernel_channel;
        {
            let mut transient = self.transient_guard();
            transient["error"] = Value::Null;
        }
        self.commit(settings)
    }

    /// Refresh the published version list — needs the GitHub API (staged with
    /// the network slice); the unsupported guard fires first and matches the
    /// Electron service-mode copy.
    pub fn list_versions(&self, settings: &SettingsStore) -> Value {
        let mut transient = self.transient_guard();
        transient["error"] = json!(UNSUPPORTED_CHANNEL_MESSAGE);
        transient["versionsLoading"] = json!(false);
        drop(transient);
        self.commit(settings)
    }

    /// Install a specific published build — needs the downloader + verifier
    /// (staged with the network slice); the unsupported guard fires first.
    pub fn install(&self, settings: &SettingsStore, version: &str) -> Value {
        if !regex::Regex::new("^v\\d+\\.\\d+\\.\\d+$")
            .expect("version tag regex")
            .is_match(version)
        {
            let mut transient = self.transient_guard();
            transient["error"] = json!(format!("无效的版本号：{version}"));
            drop(transient);
            return self.commit(settings);
        }
        let mut transient = self.transient_guard();
        transient["error"] = json!(UNSUPPORTED_INSTALL_MESSAGE);
        drop(transient);
        self.commit(settings)
    }
}

impl Default for KernelManagerService {
    fn default() -> Self {
        Self::new()
    }
}

/// The supervisor + manager pair managed in app state.
pub struct KernelServices {
    pub supervisor: KernelSupervisor,
    pub manager: KernelManagerService,
}

impl KernelServices {
    pub fn new() -> Self {
        KernelServices { supervisor: KernelSupervisor::new(), manager: KernelManagerService::new() }
    }
}

impl Default for KernelServices {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Runtime summary
// ---------------------------------------------------------------------------

/// The Activity-page summary. The Electron composition falls back to the same
/// values whenever the controller/owners are unreachable, which is exactly the
/// state of the Rust shell until the controller client + system-proxy + TUN
/// slices land: mode `rule`, brand default profile name when nothing is
/// active, all ownership flags false, no external IP probe.
pub fn build_runtime_summary(active_profile_name: Option<&str>) -> Value {
    let profile_name = active_profile_name.unwrap_or("Murge Default");
    json!({
        "networkName": "Ethernet",
        "profileName": profile_name,
        "mode": "rule",
        "externalIp": null,
        "systemProxyEnabled": false,
        "tunEnabled": false
    })
}

/// The external-IP probe: null unless the kernel is running (which it never is
/// in this build — the resolver gate). The probe itself lands with the network
/// slice.
pub fn resolve_external_ip(kernel_status: &Value) -> Value {
    if kernel_status["phase"].as_str() == Some("running") {
        // Staged: the proxy probe (fetchExternalIpViaProxy) lands with the
        // controller client; a running kernel in that slice will probe.
        Value::Null
    } else {
        Value::Null
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_starts_stopped_and_start_fails_with_disabled_resolver() {
        let supervisor = KernelSupervisor::new();
        assert_eq!(supervisor.get_status(), stopped_status());
        let error = supervisor.start().unwrap_err();
        assert_eq!(error.0, format!("PROTOCOL_ERROR:UNSUPPORTED::{DISABLED_RESOLVER_MESSAGE}"));
        let status = supervisor.get_status();
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["lastError"], DISABLED_RESOLVER_MESSAGE);
        assert_eq!(status["pid"], Value::Null);
    }

    #[test]
    fn stop_from_failed_returns_to_stopped() {
        let supervisor = KernelSupervisor::new();
        let _ = supervisor.start();
        let status = supervisor.stop().unwrap();
        assert_eq!(status["phase"], "stopped");
        assert_eq!(status["lastError"], Value::Null);
        // Idempotent stop.
        assert_eq!(supervisor.stop().unwrap()["phase"], "stopped");
    }

    #[test]
    fn manager_defaults_mirror_the_pinned_build() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let manager = KernelManagerService::new();
        let state = manager.get_state(&settings);
        assert_eq!(state["enabled"], true, "kept for wire compatibility");
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["stableVersion"], "v1.19.30");
        assert_eq!(state["effectiveVersion"], "v1.19.30");
        assert_eq!(state["specificVersion"], Value::Null);
        assert_eq!(state["specificVersionsSupported"], false, "staged artifact pipeline");
        assert_eq!(state["versions"], json!([]));
        assert_eq!(state["error"], Value::Null);
    }

    #[test]
    fn set_channel_persists_and_rejects_specific() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let manager = KernelManagerService::new();
        let state = manager.set_channel(&settings, "preview");
        // The staged installer fails, so the channel does NOT persist.
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["installing"], Value::Null);
        assert_eq!(state["error"], "安装预览内核失败");
        assert_eq!(settings.get().kernel_channel, "stable");
        // Smart reports its label and the same failure shape.
        let state = manager.set_channel(&settings, "smart");
        assert_eq!(state["error"], "安装 Smart内核失败");
        // Specific is rejected with the unsupported copy.
        let state = manager.set_channel(&settings, "specific");
        assert_eq!(state["error"], UNSUPPORTED_CHANNEL_MESSAGE);
        // Stable persists (no installer needed for the bundled build).
        let state = manager.set_channel(&settings, "stable");
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["error"], Value::Null);
        // Same-channel is a no-op that clears the error.
        let state = manager.set_channel(&settings, "stable");
        assert_eq!(state["error"], Value::Null);
        // An invalid channel name reports the invalid-version copy.
        let state = manager.set_channel(&settings, "beta");
        assert_eq!(state["error"], "无效的版本号：beta");
    }

    #[test]
    fn set_enabled_delegates_to_smart_or_stable() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let manager = KernelManagerService::new();
        let state = manager.set_enabled(&settings, true);
        assert_eq!(state["error"], "安装 Smart内核失败");
        let state = manager.set_enabled(&settings, false);
        assert_eq!(state["error"], Value::Null);
    }

    #[test]
    fn list_versions_and_install_stage_with_the_network_slice() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let manager = KernelManagerService::new();
        let state = manager.list_versions(&settings);
        assert_eq!(state["error"], UNSUPPORTED_CHANNEL_MESSAGE);
        assert_eq!(state["versionsLoading"], false);
        let state = manager.install(&settings, "v1.19.31");
        assert_eq!(state["error"], UNSUPPORTED_INSTALL_MESSAGE);
        // Invalid tags are rejected before the unsupported guard.
        let state = manager.install(&settings, "latest");
        assert_eq!(state["error"], "无效的版本号：latest");
    }

    #[test]
    fn runtime_summary_uses_active_profile_or_brand_default() {
        let summary = build_runtime_summary(Some("Home"));
        assert_eq!(summary["profileName"], "Home");
        assert_eq!(summary["mode"], "rule");
        assert_eq!(summary["networkName"], "Ethernet");
        assert_eq!(summary["systemProxyEnabled"], false);
        assert_eq!(summary["tunEnabled"], false);
        assert_eq!(summary["externalIp"], Value::Null);
        let summary = build_runtime_summary(None);
        assert_eq!(summary["profileName"], "Murge Default", "brand defaultProfileName");
    }

    #[test]
    fn external_ip_is_null_until_the_kernel_runs() {
        let supervisor = KernelSupervisor::new();
        assert_eq!(resolve_external_ip(&supervisor.get_status()), Value::Null);
    }
}
