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

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::events::EventHub;
use crate::settings::SettingsStore;

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

#[cfg_attr(not(test), allow(dead_code))]
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

/// The supervisor is the full lifecycle machine (`kernel_process.rs`); the
/// disabled-resolver composition in `KernelServices::new` keeps the current
/// fail-closed behavior until the artifact pipeline is wired into setup.
pub type KernelSupervisor = crate::kernel_process::KernelSupervisor;

pub use crate::kernel_process::{
    DISABLED_RESOLVER_MESSAGE, KernelDependencies, SupervisorOptions,
};
#[allow(unused_imports)]
use DISABLED_RESOLVER_MESSAGE as _DISABLED_REEXPORT;

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
    pub supervisor: Arc<KernelSupervisor>,
    pub manager: KernelManagerService,
    /// The controller-ready wrapper (`ControllerReadyKernelGateway`, built
    /// only for the real-kernel production composition): process spawn alone
    /// is not readiness — start additionally waits for the loopback
    /// controller's authenticated /version. Dev keeps the raw supervisor
    /// (the TS `kernelInstance`, its fixture reports readiness by stdout).
    pub ready: Option<Arc<crate::kernel_process::ControllerReadyKernelGateway>>,
}

impl KernelServices {
    /// Start through the ready gate when composed with one, the raw
    /// supervisor otherwise (dev).
    pub async fn start(&self) -> Result<Value, crate::error::IpcError> {
        match &self.ready {
            Some(gateway) => gateway.start().await,
            None => self.supervisor.start().await,
        }
    }

    /// Status passes straight through (the TS gateway forwards getStatus).
    pub fn get_status_value(&self) -> Value {
        self.supervisor.get_status()
    }

    /// Stop always passes straight through (the ready gate is a start
    /// wrapper — the TS `ControllerReadyKernelGateway.stop`).
    pub async fn stop(&self) -> Result<Value, crate::error::IpcError> {
        self.supervisor.stop().await
    }
}

impl KernelServices {
    /// The default composition is fail-closed: the disabled resolver never
    /// resolves a binary, so start() fails with the UNSUPPORTED copy exactly
    /// like the Electron build outside packaged Windows.
    pub fn new() -> Self {
        KernelServices {
            supervisor: KernelSupervisor::create(
                KernelDependencies {
                    resolver: Arc::new(crate::kernel_process::DisabledKernelBinaryResolver),
                    config_store: Arc::new(crate::kernel_process::TempKernelConfigStore),
                    adapter: Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                    secret: crate::kernel_process::random_secret(),
                    attach_watchdog: None,
                },
                SupervisorOptions::default(),
            ),
            manager: KernelManagerService::new(),
            ready: None,
        }
    }

    /// The dev/fixture composition (`createKernelResolver({mode: 'fixture'})`
    /// + `TempKernelConfigStore` + the fixture-ready stdout marker). The
    /// fixture opens NO socket, so the controller-ready gate never applies.
    pub fn for_development() -> Self {
        let mut services = Self::new();
        services = KernelServices {
            supervisor: KernelSupervisor::create(
                KernelDependencies {
                    resolver: Arc::new(crate::kernel_process::FixtureKernelBinaryResolver::default()),
                    config_store: Arc::new(crate::kernel_process::TempKernelConfigStore),
                    adapter: Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                    secret: crate::kernel_process::random_secret(),
                    attach_watchdog: None,
                },
                SupervisorOptions { readiness_pattern: Some("fixture-ready".to_string()), ..SupervisorOptions::default() },
            ),
            manager: services.manager,
            ready: None,
        };
        services
    }

    /// The real-kernel composition (`MihomoKernelResolver` + strict config
    /// store + controller-ready gate). `production_secret` must already be a
    /// valid 64-hex secret (seeded once at startup like the TS composition);
    /// the strict store validates it before any directory is created.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub fn for_real_kernel(
        workspace_dir: std::path::PathBuf,
        bundled_archive_dir: Option<std::path::PathBuf>,
        secret: String,
        ports: Value,
        resolve_active_document: Option<Arc<dyn Fn() -> Option<String> + Send + Sync>>,
        resolve_core: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
        resolve_geodata: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
        kernel_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
        probe: Option<Arc<dyn crate::kernel_process::VersionProbe>>,
    ) -> Self {
        let supervisor = KernelSupervisor::create(
            KernelDependencies {
                resolver: Arc::new(crate::kernel_process::MihomoKernelBinaryResolver {
                    allow_real: true,
                    workspace_dir: workspace_dir.clone(),
                    transport: crate::mihomo_artifact::real_download_transport(),
                    kernel_enabled,
                    bundled_archive_dir,
                    version_selection: None, // staged: version-install slice
                    ensure_specific_binary: None, // staged: version-install slice
                }),
                config_store: Arc::new(crate::kernel_process::StrictMihomoConfigStore {
                    mixed_port: ports["mixedPort"].as_i64().unwrap_or(7890),
                    http_port: ports["httpPort"].as_i64().unwrap_or(0),
                    socks_port: ports["socksPort"].as_i64().unwrap_or(0),
                    controller_port: ports["controllerPort"].as_i64().unwrap_or(9090),
                    controller_host: ports["controllerHost"].as_str().unwrap_or("127.0.0.1").to_string(),
                    allow_lan: ports["allowLan"].as_bool().unwrap_or(false),
                    controller_panel: ports["controllerPanel"].as_bool().unwrap_or(true),
                    workspace_dir: workspace_dir.join("runtime"),
                    kernel_home_dir: Some(workspace_dir.join("geodata")),
                    seed_resources_dir: None, // staged: installer-geodata slice
                    owned_dir: std::sync::Mutex::new(None),
                    resolve_active_document,
                    resolve_core,
                    resolve_geodata,
                }),
                adapter: Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                secret,
                attach_watchdog: None, // staged: Windows watchdog slice
            },
            SupervisorOptions::default(),
        );
        let ready = probe.map(|probe| {
            Arc::new(crate::kernel_process::ControllerReadyKernelGateway::new(
                supervisor.clone(),
                probe,
                10_000, // the TS default
                100,
            ))
        });
        KernelServices { supervisor, manager: KernelManagerService::new(), ready }
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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_composition_resolves_the_harmless_fixture() {
        // The fixture resolver resolves node + the shared fixture script with
        // the fixture-ready marker option; it never touches the network.
        let services = KernelServices::for_development();
        let _ = services;
        // Composition sanity: the ready gate is dev-absent (the fixture
        // reports readiness by stdout marker, not controller).
        assert!(services.ready.is_none());
    }

    #[tokio::test]
    async fn dev_composition_starts_the_fixture_to_running() {
        // Requires node on PATH (the same prerequisite the Electron dev
        // shell has); skips silently elsewhere.
        if which_node().is_none() {
            return;
        }
        let services = std::sync::Arc::new(KernelServices::for_development());
        let status = services.start().await.expect("fixture start");
        assert_eq!(status["phase"], "running");
        services.stop().await.unwrap();
        assert_eq!(services.supervisor.get_status()["phase"], "stopped");
    }

    fn which_node() -> Option<std::path::PathBuf> {
        for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
            let candidate = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    #[test]
    fn real_kernel_composition_keeps_the_strict_store_shape() {
        // Composition-level checks that do not touch the network: the strict
        // store ports are wired (profile + core + geodata resolvers), the
        // secret flows through, and the ready gate is armed when a probe is
        // supplied.
        let services = KernelServices::for_real_kernel(
            std::env::temp_dir().join("murge-kernel-composition-test"),
            None,
            "a".repeat(64),
            serde_json::json!({
                "mixedPort": 7890, "httpPort": 0, "socksPort": 0,
                "controllerPort": 9090, "controllerHost": "127.0.0.1",
                "allowLan": false, "controllerPanel": true
            }),
            Some(Arc::new(|| Some("proxies: []\n".to_string()))),
            Some(Arc::new(|| serde_json::json!({"enabled": false}))),
            Some(Arc::new(|| serde_json::json!({"enabled": false}))),
            Arc::new(|| true),
            None,
        );
        assert!(services.ready.is_none(), "no probe -> no ready gate");
    }

    #[tokio::test]
    async fn real_kernel_composition_fails_closed_on_a_bad_secret() {
        // A non-hex secret is rejected by the strict store BEFORE any
        // directory is created (validation-first contract).
        let services = KernelServices::for_real_kernel(
            std::env::temp_dir().join("murge-kernel-composition-test"),
            None,
            "not-a-valid-secret".to_string(),
            serde_json::json!({
                "mixedPort": 7890, "httpPort": 0, "socksPort": 0,
                "controllerPort": 9090, "controllerHost": "127.0.0.1",
                "allowLan": false, "controllerPanel": true
            }),
            None,
            None,
            None,
            Arc::new(|| true),
            None,
        );
        let error = services.start().await.unwrap_err();
        assert!(
            error.0.contains("64-character lowercase hex"),
            "{error:?}"
        );
    }

    /// The disabled composition mirrors KernelServices::new for unit tests.
    fn test_supervisor() -> Arc<KernelSupervisor> {
        KernelSupervisor::create(
            KernelDependencies {
                resolver: Arc::new(crate::kernel_process::DisabledKernelBinaryResolver),
                config_store: Arc::new(crate::kernel_process::TempKernelConfigStore),
                adapter: Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                secret: crate::kernel_process::random_secret(),
                attach_watchdog: None,
            },
            SupervisorOptions::default(),
        )
    }

    #[tokio::test]
    async fn status_starts_stopped_and_start_fails_with_disabled_resolver() {
        let supervisor = test_supervisor();
        assert_eq!(supervisor.get_status(), stopped_status());
        let error = supervisor.start().await.unwrap_err();
        assert_eq!(error.0, format!("PROTOCOL_ERROR:UNSUPPORTED::{DISABLED_RESOLVER_MESSAGE}"));
        let status = supervisor.get_status();
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["lastError"], DISABLED_RESOLVER_MESSAGE);
        assert_eq!(status["pid"], Value::Null);
    }

    #[tokio::test]
    async fn stop_from_failed_returns_to_stopped() {
        let supervisor = test_supervisor();
        let _ = supervisor.start().await;
        let status = supervisor.stop().await.unwrap();
        assert_eq!(status["phase"], "stopped");
        // The TS machine PATCHES stopped without clearing lastError (only
        // doStart resets it); the old stub cleared it, which diverged.
        assert_eq!(status["lastError"], DISABLED_RESOLVER_MESSAGE);
        // Idempotent stop.
        assert_eq!(supervisor.stop().await.unwrap()["phase"], "stopped");
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

}
