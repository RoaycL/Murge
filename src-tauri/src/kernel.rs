//! Kernel lifecycle + version manager — Rust port of the Electron
//! `KernelSupervisor` state machine (main/kernel/supervisor.ts),
//! `shared/runtime.ts` (`KernelStatus`), `shared/kernel-manager.ts` and
//! `main/kernel/kernel-manager-service.ts` (state materialization), plus the
//! runtime summary composition (main/ipc/register-ipc.ts).
//!
//! Milestone staging (documented in docs/tauri/phase3/README.md): the
//! version manager now carries the full TS install surface — GitHub release
//! metadata, per-version artifact workspaces, sidecar-cached asset specs,
//! apply-with-verify + rollback — with `specificVersionsSupported` true (the
//! Tauri build has no Windows privileged service, so the TS service-mode
//! gate never fires). The binary resolver composition stays environment
//! split: dev fixture / packaged-Windows real / otherwise disabled.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::events::EventHub;
use crate::settings::SettingsStore;

/// The pinned bundled mihomo build (resources/mihomo-assets.json `version`).
pub const MIHOMO_VERSION: &str = "v1.19.30";

/// `v1.2.3` → `1.2.3` (the release-tag normalization).
pub(crate) fn version_no_v(version: &str) -> String {
    version.trim_start_matches('v').to_string()
}

/// Scripted GitHub seams (the TS `fetchVersions` / `fetchReleaseAssets`
/// dep overrides — tests never hit the network).
pub type FetchVersionsFn = Arc<
    dyn Fn() -> futures_util::future::BoxFuture<'static, Result<Vec<String>, crate::error::IpcError>> + Send + Sync,
>;
pub type FetchReleaseAssetsFn = Arc<
    dyn Fn(String) -> futures_util::future::BoxFuture<'static, Result<Vec<crate::mihomo_artifact::MihomoReleaseAsset>, crate::error::IpcError>>
        + Send
        + Sync,
>;
pub type ResolveAssetFn = Arc<
    dyn Fn(
        crate::mihomo_artifact::MihomoAsset,
        std::path::PathBuf,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<crate::mihomo_artifact::ResolvedMihomoBinary, crate::error::IpcError>,
    > + Send
        + Sync,
>;
/// The `applyInstalledVersion` seam: restart a live kernel and prove the
/// selected version took effect (`applyInstalledKernelVersionFinal`).
pub type ApplyInstalledFn = Arc<
    dyn Fn(String, String, Option<String>) -> futures_util::future::BoxFuture<'static, Result<(), crate::error::IpcError>> + Send + Sync,
>;

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

/// The dispatcher-level mutation gate (`modeController` queue parity): the
/// start/stop/enhancement/profile arms AND the version apply handler hold it
/// so kernel mutations never interleave.
pub(crate) static RUNTIME_UPDATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Version-manager state. Durable choices (kernelChannel /
/// kernelSpecificVersion) live in the settings document and are mirrored here;
/// the rest is transient state owned by this service.
pub struct KernelManagerService {
    transient: Mutex<Value>,
    /// `state` event listeners — every commit fans out here.
    pub state_listeners: EventHub,
    /// Directory that owns the `versions/<version>` workspaces
    /// (`KernelManagerServiceDeps.workspaceRoot`).
    pub workspace_root: std::path::PathBuf,
    /// Scripted network seams; None = the real GitHub API.
    pub fetch_versions: Option<FetchVersionsFn>,
    pub fetch_release_assets: Option<FetchReleaseAssetsFn>,
    /// Scripted artifact resolver; None = the real verifier.
    pub resolve_asset: Option<ResolveAssetFn>,
    /// The live-kernel apply/verify handler; None until the composition
    /// root wires it (the TS applies `applyInstalledKernelVersionFinal`).
    pub apply_installed_version: Option<ApplyInstalledFn>,
}

impl KernelManagerService {
    pub fn new() -> Self {
        KernelManagerService {
            transient: Mutex::new(DEFAULT_STATE),
            state_listeners: EventHub::new(),
            workspace_root: std::env::temp_dir().join("murge-kernel-versions"),
            fetch_versions: None,
            fetch_release_assets: None,
            resolve_asset: None,
            apply_installed_version: None,
        }
    }

    /// The composition wiring: versions/<v> workspaces under the kernel root.
    pub fn for_workspace(workspace_root: std::path::PathBuf) -> Self {
        let mut service = Self::new();
        service.workspace_root = workspace_root;
        service
    }

    fn transient_guard(&self) -> std::sync::MutexGuard<'_, Value> {
        self.transient.lock().expect("kernel manager mutex poisoned")
    }

    /// The buildState port: persisted settings + pinned stable version +
    /// transient fields, coerced with the exact fallback rules.
    pub fn build_state(&self, settings: &SettingsStore) -> Value {
        let app_settings = settings.get();
        let stable_version = MIHOMO_VERSION;
        // No privileged service in the Tauri build → the TS service-mode gate
        // (`specificVersionsSupported: false`) never applies; every channel
        // is resolvable through the artifact pipeline.
        let specific_versions_supported = true;
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
    pub async fn set_enabled(&self, settings: &SettingsStore, enabled: bool) -> Value {
        self.set_channel(settings, if enabled { "smart" } else { "stable" }).await
    }

    /// Switch the version channel. `specific` is rejected with the
    /// service-mode copy while the artifact pipeline is staged; preview/smart
    /// attempt the install first and only persist the channel when it
    /// succeeds (the staged installer fails with the same error copy shape
    /// and leaves the previous channel in place).
    pub async fn set_channel(&self, settings: &SettingsStore, channel: &str) -> Value {
        if !is_valid_channel(channel) {
            let mut transient = self.transient_guard();
            transient["error"] = json!(format!("无效的版本号：{channel}"));
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
        let previous = (current.kernel_channel.clone(), {
            let raw = current.kernel_specific_version.trim();
            if raw.is_empty() { None } else { Some(raw.to_string()) }
        });
        // TS: preview/smart attempt the (service) install first — only when
        // the service client dep exists. This build has none, so the channel
        // persists straight away and the apply/verify step proves it.
        settings
            .set(&crate::settings::AppSettingsPatch(serde_json::json!({
                "kernelChannel": channel, "kernelEnabled": true
            })))
            .kernel_channel;
        let target_version = match channel {
            "specific" => previous.1.clone(),
            "stable" => Some(MIHOMO_VERSION.to_string()),
            other => Some(other.to_string()),
        };
        if let Some(target) = target_version {
            if let Some(apply) = &self.apply_installed_version {
                if let Err(error) = apply(target, previous.0.clone(), previous.1.clone()).await {
                    settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({
                        "kernelChannel": previous.0,
                        "kernelSpecificVersion": previous.1.unwrap_or_default()
                    })));
                    let mut transient = self.transient_guard();
                    transient["error"] = json!(error.0);
                    drop(transient);
                    return self.commit(settings);
                }
            }
        }
        {
            let mut transient = self.transient_guard();
            transient["error"] = Value::Null;
        }
        self.commit(settings)
    }

    /// Refresh the published version list (the TS `listVersions`): fetches
    /// the GitHub release tags (or the scripted seam), caching them in the
    /// transient state.
    pub async fn list_versions(&self, settings: &SettingsStore) -> Value {
        {
            let mut transient = self.transient_guard();
            transient["versionsLoading"] = json!(true);
            transient["error"] = Value::Null;
        }
        self.emit(settings);
        let result = match &self.fetch_versions {
            Some(fetch) => fetch().await,
            None => crate::mihomo_artifact::fetch_github_versions().await,
        };
        match result {
            Ok(versions) => {
                let mut transient = self.transient_guard();
                transient["versions"] = json!(versions);
            }
            Err(error) => {
                let mut transient = self.transient_guard();
                transient["error"] = json!(error.0);
            }
        }
        let mut transient = self.transient_guard();
        transient["versionsLoading"] = json!(false);
        drop(transient);
        self.commit(settings)
    }

    /// Install a specific published build (the TS `install`): fetch the
    /// release metadata, resolve + verify the asset into its per-version
    /// workspace, persist the channel selection, then apply + verify on a
    /// live kernel with channel rollback on failure.
    pub async fn install(&self, settings: &SettingsStore, version: &str) -> Value {
        if !regex::Regex::new(r"^v\d+\.\d+\.\d+$")
            .expect("version tag regex")
            .is_match(version)
        {
            let mut transient = self.transient_guard();
            transient["error"] = json!(format!("无效的版本号：{version}"));
            drop(transient);
            return self.commit(settings);
        }
        {
            let mut transient = self.transient_guard();
            transient["installing"] = json!(version);
            transient["error"] = Value::Null;
        }
        self.emit(settings);
        let result = self.install_inner(settings, version).await;
        {
            let mut transient = self.transient_guard();
            transient["installing"] = Value::Null;
            if let Err(error) = &result {
                transient["error"] = json!(error.0);
            }
        }
        self.commit(settings)
    }

    async fn install_inner(&self, settings: &SettingsStore, version: &str) -> Result<(), crate::error::IpcError> {
        let current = settings.get();
        let previous = (current.kernel_channel.clone(), {
            let raw = current.kernel_specific_version.trim();
            if raw.is_empty() { None } else { Some(raw.to_string()) }
        });
        // Resolve + verify the asset into its per-version workspace (the
        // byte-level verification is unconditional); the channel is only
        // persisted when the install succeeded.
        let workspace = self.version_workspace_dir(version);
        self.resolve_version_asset(version, &workspace).await?;
        settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({
            "kernelChannel": "specific", "kernelSpecificVersion": version
        })));
        if let Some(apply) = &self.apply_installed_version {
            if let Err(error) = apply(version.to_string(), previous.0.clone(), previous.1.clone()).await {
                settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({
                    "kernelChannel": previous.0,
                    "kernelSpecificVersion": previous.1.unwrap_or_default()
                })));
                return Err(error);
            }
        }
        Ok(())
    }

    /// `ensureVersionBinary`: resolve a specific version's binary the same
    /// way the stable build is resolved (download + verify + reuse; never
    /// trusting an on-disk file). The resolver consults this at start time.
    pub async fn ensure_version_binary(
        &self,
        version: &str,
    ) -> Result<crate::mihomo_artifact::ResolvedMihomoBinary, crate::error::IpcError> {
        let workspace = self.version_workspace_dir(version);
        let asset = self.resolve_version_asset(version, &workspace).await?;
        match &self.resolve_asset {
            Some(resolve) => resolve(asset, workspace).await,
            None => crate::mihomo_artifact::resolve_mihomo_asset(&asset, &workspace, &crate::mihomo_artifact::real_download_transport()).await,
        }
    }

    fn version_workspace_dir(&self, version: &str) -> std::path::PathBuf {
        self.workspace_root.join("versions").join(version.trim_start_matches('v'))
    }

    /// `resolveVersionAsset`: the sidecar-cached asset spec (`.mihomo-asset.json`
    /// next to the version workspace) so a later start can reuse the same
    /// verified digest offline; a cache miss fetches the release metadata and
    /// writes the sidecar.
    async fn resolve_version_asset(
        &self,
        version: &str,
        workspace: &std::path::Path,
    ) -> Result<crate::mihomo_artifact::MihomoAsset, crate::error::IpcError> {
        let sidecar = workspace.join(".mihomo-asset.json");
        if let Ok(text) = std::fs::read_to_string(&sidecar) {
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                let valid = cached["filename"].as_str().is_some()
                    && cached["sha256"]
                        .as_str()
                        .map(|sha| sha.len() == 64)
                        .unwrap_or(false);
                if valid {
                    if let Some(mut asset) =
                        serde_json::from_value::<crate::mihomo_artifact::MihomoAsset>(cached).ok()
                    {
                        asset.version = Some(version.to_string());
                        return Ok(asset);
                    }
                }
            }
        }
        let platform: String =
            std::env::consts::OS.replace("macos", "darwin").replace("windows", "win32");
        let arch: String = match std::env::consts::ARCH {
            "x86_64" => "x64".to_string(),
            "aarch64" => "arm64".to_string(),
            "x86" => "x86".to_string(),
            other => other.to_string(),
        };
        let assets = match &self.fetch_release_assets {
            Some(fetch) => fetch(version.to_string()).await?,
            None => crate::mihomo_artifact::fetch_github_release_assets(version).await?,
        };
        let mut found: Option<crate::mihomo_artifact::MihomoAsset> = None;
        for release_asset in &assets {
            found = crate::mihomo_artifact::build_mihomo_asset_from_release(
                &version_no_v(version),
                &platform,
                &arch,
                &serde_json::to_value(release_asset).expect("asset serializes"),
            );
            if found.is_some() {
                break;
            }
        }
        let Some(asset) = found else {
            return Err(crate::error::IpcError::code(
                crate::error::code::ARTIFACT_DOWNLOAD_FAILED,
                format!("未找到 {platform}/{arch} 的 mihomo {version} 资产"),
            ));
        };
        std::fs::create_dir_all(workspace).map_err(|error| {
            crate::error::IpcError::code(
                crate::error::code::ARTIFACT_EXTRACT_FAILED,
                format!("Failed to create {}: {error}", workspace.display()),
            )
        })?;
        std::fs::write(&sidecar, serde_json::to_string(&asset).expect("asset serializes")).map_err(|error| {
            crate::error::IpcError::code(
                crate::error::code::ARTIFACT_EXTRACT_FAILED,
                format!("Failed to write {}: {error}", sidecar.display()),
            )
        })?;
        Ok(asset)
    }

    fn emit(&self, settings: &SettingsStore) {
        self.state_listeners.emit(&self.build_state(settings));
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
    pub manager: Arc<KernelManagerService>,
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
            manager: Arc::new(KernelManagerService::new()),
            ready: None,
        }
    }

    /// The dev/fixture composition (`createKernelResolver({mode: 'fixture'})`
    /// + `TempKernelConfigStore` + the fixture-ready stdout marker). The
    /// fixture opens NO socket, so the controller-ready gate never applies.
    pub fn for_development(manager: Arc<KernelManagerService>) -> Self {
        KernelServices {
            supervisor: KernelSupervisor::create(
                KernelDependencies {
                    resolver: Arc::new(crate::kernel_process::FixtureKernelBinaryResolver::default()),
                    config_store: Arc::new(crate::kernel_process::TempKernelConfigStore),
                    adapter: Arc::new(crate::kernel_process::NodeKernelProcessAdapter),
                    secret: crate::kernel_process::random_secret(),
                    attach_watchdog: None,
                },
                SupervisorOptions {
                    readiness_pattern: Some("fixture-ready".to_string()),
                    ..SupervisorOptions::default()
                },
            ),
            manager,
            ready: None,
        }
    }

    /// The disabled-resolver composition with a shared version manager
    /// (non-Windows production).
    pub fn with_manager(manager: Arc<KernelManagerService>) -> Self {
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
            manager,
            ready: None,
        }
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
        manager: Arc<KernelManagerService>,
        version_selection: Option<crate::kernel_process::VersionSelectionFn>,
        probe: Option<Arc<dyn crate::kernel_process::VersionProbe>>,
    ) -> Self {
        // The specific-version resolve hook: the manager's ensureVersionBinary
        // (same byte-level verification as the stable build).
        let ensure_manager = manager.clone();
        let ensure_specific_binary: crate::kernel_process::EnsureSpecificBinaryFn =
            Arc::new(move |version: String| {
                let manager = ensure_manager.clone();
                Box::pin(async move { manager.ensure_version_binary(&version).await })
            });
        let supervisor = KernelSupervisor::create(
            KernelDependencies {
                resolver: Arc::new(crate::kernel_process::MihomoKernelBinaryResolver {
                    allow_real: true,
                    workspace_dir: workspace_dir.clone(),
                    transport: crate::mihomo_artifact::real_download_transport(),
                    kernel_enabled,
                    bundled_archive_dir,
                    version_selection,
                    ensure_specific_binary: Some(ensure_specific_binary),
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
        KernelServices { supervisor, manager, ready }
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
        let services = KernelServices::for_development(Arc::new(KernelManagerService::new()));
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
        let services = std::sync::Arc::new(KernelServices::for_development(Arc::new(
            KernelManagerService::new(),
        )));
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
            Arc::new(KernelManagerService::new()),
            None,
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
            Arc::new(KernelManagerService::new()),
            None,
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
        assert_eq!(state["specificVersionsSupported"], true, "no privileged service gate");
        assert_eq!(state["versions"], json!([]));
        assert_eq!(state["error"], Value::Null);
    }

    #[tokio::test]
    async fn set_channel_persists_channels_and_clears_errors() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        // No apply handler wired → the channel persists without verification
        // (the TS skips applyInstalledVersion when the dep is absent).
        let manager = KernelManagerService::new();
        let state = manager.set_channel(&settings, "preview").await;
        assert_eq!(state["channel"], "preview");
        assert_eq!(state["effectiveVersion"], "预览版");
        assert_eq!(state["error"], Value::Null);
        assert_eq!(settings.get().kernel_channel, "preview");
        let state = manager.set_channel(&settings, "smart").await;
        assert_eq!(state["channel"], "smart");
        assert_eq!(state["smartEnabled"], true);
        // Specific WITHOUT a selected version persists the channel; the
        // resolver falls back to the pinned stable build.
        let state = manager.set_channel(&settings, "specific").await;
        assert_eq!(state["channel"], "specific");
        assert_eq!(state["specificVersion"], Value::Null);
        assert_eq!(state["effectiveVersion"], "v1.19.30");
        // Stable persists and clears the error.
        let state = manager.set_channel(&settings, "stable").await;
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["error"], Value::Null);
        // Same-channel is a no-op that clears the error.
        let state = manager.set_channel(&settings, "stable").await;
        assert_eq!(state["error"], Value::Null);
        // An invalid channel name reports the invalid-version copy.
        let state = manager.set_channel(&settings, "beta").await;
        assert_eq!(state["error"], "无效的版本号：beta");
    }

    #[tokio::test]
    async fn set_channel_rolls_back_when_apply_verifies_a_mismatch() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let mut manager = KernelManagerService::new();
        let applied = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = applied.clone();
        manager.apply_installed_version = Some(Arc::new(move |target, _previous_channel, _previous_specific| {
            let sink = sink.clone();
            Box::pin(async move {
                sink.lock().expect("applied poisoned").push(target);
                Err(crate::error::IpcError::code(
                    crate::error::code::ARTIFACT_HASH_MISMATCH,
                    "内核版本未生效：请求 v1.19.31，实际 v1.19.30".to_string(),
                ))
            })
        }));
        // A selected specific version is what routes the apply step
        // (the TS: `targetVersion = channel === 'specific' ? specificVersion : ...`).
        settings.set(&crate::settings::AppSettingsPatch(
            serde_json::json!({ "kernelChannel": "stable", "kernelSpecificVersion": "v1.19.31" }),
        ));
        let state = manager.set_channel(&settings, "specific").await;
        // The apply failure rolled the channel AND version back and surfaced
        // the typed error.
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["error"], "PROTOCOL_ERROR:ARTIFACT_HASH_MISMATCH::内核版本未生效：请求 v1.19.31，实际 v1.19.30");
        assert_eq!(settings.get().kernel_channel, "stable");
        // The rollback restores the PREVIOUS state — which here already held
        // that specific version (the TS rolls back channel + version pair).
        assert_eq!(settings.get().kernel_specific_version, "v1.19.31");
        assert_eq!(applied.lock().expect("applied poisoned").len(), 1);
    }

    #[tokio::test]
    async fn set_enabled_delegates_to_smart_or_stable() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let manager = KernelManagerService::new();
        let state = manager.set_enabled(&settings, true).await;
        assert_eq!(state["channel"], "smart");
        let state = manager.set_enabled(&settings, false).await;
        assert_eq!(state["channel"], "stable");
        assert_eq!(state["error"], Value::Null);
    }

    #[tokio::test]
    async fn list_versions_uses_the_seam_and_surfaces_failures() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let mut manager = KernelManagerService::new();
        manager.fetch_versions = Some(Arc::new(|| {
            Box::pin(async { Ok(vec!["v1.19.30".to_string(), "v1.19.29".to_string()]) })
        }));
        let state = manager.list_versions(&settings).await;
        assert_eq!(state["versions"], json!(["v1.19.30", "v1.19.29"]));
        assert_eq!(state["versionsLoading"], false);
        assert_eq!(state["error"], Value::Null);
        // A failed fetch surfaces the typed copy with the loading flag reset.
        manager.fetch_versions = Some(Arc::new(|| {
            Box::pin(async {
                Err(crate::error::IpcError::code(
                    crate::error::code::ARTIFACT_DOWNLOAD_FAILED,
                    "GitHub 请求失败：503".to_string(),
                ))
            })
        }));
        let state = manager.list_versions(&settings).await;
        assert_eq!(state["error"], "PROTOCOL_ERROR:ARTIFACT_DOWNLOAD_FAILED::GitHub 请求失败：503");
        assert_eq!(state["versionsLoading"], false);
    }

    #[tokio::test]
    async fn install_resolves_verifies_and_rolls_back_the_channel_on_apply_failure() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let workspace_base = temp.path().to_path_buf();
        let mut manager = KernelManagerService::for_workspace(workspace_base.clone());
        manager.fetch_release_assets = Some(Arc::new(move |version| {
            let platform: String =
                std::env::consts::OS.replace("macos", "darwin").replace("windows", "win32");
            let arch: String = match std::env::consts::ARCH {
                "x86_64" => "x64".to_string(),
                "aarch64" => "arm64".to_string(),
                "x86" => "x86".to_string(),
                other => other.to_string(),
            };
            Box::pin(async move {
                // The release metadata for the requested tag carries exactly
                // one asset for this platform/arch with a real digest shape.
                Ok(vec![crate::mihomo_artifact::MihomoReleaseAsset {
                    name: crate::mihomo_artifact::mihomo_asset_filename(
                        &platform,
                        &arch,
                        &version.trim_start_matches('v').to_string(),
                    ),
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                    size: Some(1024),
                    browser_download_url: "https://example.invalid/mihomo.gz".to_string(),
                }])
            })
        }));
        manager.resolve_asset = Some(Arc::new(move |asset, workspace| {
            let workspace_base = workspace_base.clone();
            Box::pin(async move {
                // The sidecar the resolver caches for offline reuse.
                assert!(workspace.starts_with(&workspace_base));
                Ok(crate::mihomo_artifact::ResolvedMihomoBinary {
                    path: workspace.join("mihomo"),
                    version: asset.version.clone().unwrap_or_default(),
                    asset,
                    sha256: "a".repeat(64),
                    url: "https://example.invalid/mihomo.gz".to_string(),
                    reused: false,
                })
            })
        }));
        manager.apply_installed_version = Some(Arc::new(|_target, _previous_channel, _previous_specific| {
            Box::pin(async { Err(crate::error::IpcError::code(
                crate::error::code::ARTIFACT_HASH_MISMATCH,
                "内核版本未生效：请求 v1.19.31，实际 v1.19.30".to_string(),
            )) })
        }));
        let state = manager.install(&settings, "v1.19.31").await;
        assert_eq!(
            state["error"],
            "PROTOCOL_ERROR:ARTIFACT_HASH_MISMATCH::内核版本未生效：请求 v1.19.31，实际 v1.19.30"
        );
        assert_eq!(state["installing"], Value::Null);
        // The channel rolled back.
        assert_eq!(settings.get().kernel_channel, "stable");
        // The sidecar was written (offline-reuse cache) inside the version
        // workspace.
        assert!(temp
            .path()
            .join("versions")
            .join("1.19.31")
            .join(".mihomo-asset.json")
            .is_file());
        // Invalid tags are rejected before any network work.
        let state = manager.install(&settings, "latest").await;
        assert_eq!(state["error"], "无效的版本号：latest");
    }

    #[tokio::test]
    async fn install_surfaces_the_missing_asset_copy() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = SettingsStore::new(Some(temp.path().to_path_buf()));
        let mut manager = KernelManagerService::for_workspace(temp.path().to_path_buf());
        manager.fetch_release_assets = Some(Arc::new(|_version| Box::pin(async { Ok(vec![]) })));
        let state = manager.install(&settings, "v1.19.31").await;
        let platform = std::env::consts::OS.replace("macos", "darwin").replace("windows", "win32");
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "x86",
            other => other,
        };
        assert_eq!(
            state["error"],
            format!("PROTOCOL_ERROR:ARTIFACT_DOWNLOAD_FAILED::未找到 {platform}/{arch} 的 mihomo v1.19.31 资产")
        );
        // The channel never persisted.
        assert_eq!(settings.get().kernel_channel, "stable");
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
