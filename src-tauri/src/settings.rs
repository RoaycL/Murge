//! Application settings — byte-compatible port of
//! `src/main/app-settings/service.ts` + `src/shared/app-settings.ts`.
//!
//! Contract preserved exactly:
//! - File: `<appDataRoot>/app-settings.json` (Phase 3A writes the real store;
//!   dev keeps an in-memory mirror so tests never touch user data).
//! - Read: missing file -> defaults; corrupt file -> quarantine to
//!   `app-settings.json.corrupt-<epoch-ms>` (evidence is never overwritten),
//!   then defaults.
//! - Parse: per-field type check against defaults (`parseAppSettings` mirror);
//!   `kernelEnabled` is a deprecated field always normalized to true;
//!   `delayTestUrl` accepts only absolute http(s) URLs on the READ path.
//! - Write: mkdir -p, temp file `.app-settings.json.<uuid>.tmp`, 2-space
//!   pretty JSON + trailing newline, atomic rename.
//! - Set: the patch merge mirrors the TS service field-for-field (unknown
//!   fields ignored, invalid values keep current, kernelEnabled forced true).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::paths::AppPaths;

pub const APP_SETTINGS_FILE: &str = "app-settings.json";

/// Stamp the NSIS installer writes into the install directory on every
/// install that is not this build's own self-update (`src-tauri/nsis/hooks.nsh`).
/// Running the Tauri installer means this build was chosen, but each user's
/// settings file may still say "stable": the Electron build writes its whole
/// settings object on every change, channel included. Without the reset the
/// first update check would download the Electron installer and the next quit
/// would install it over this build.
pub const INSTALLER_CHANNEL_RESET_FILE: &str = "update-channel-reset";

/// Per-user record of the install stamp already applied (its modified time),
/// so each user resets once per install and a later choice of "stable" stays.
pub const INSTALLER_CHANNEL_RESET_SEEN_FILE: &str = "update-channel-reset-seen";

fn modified_stamp(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let nanos = modified.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(nanos.to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub auto_start_kernel: bool,
    pub auto_check_update: bool,
    /// Release channel the updater follows: "stable" (the Electron build) or
    /// "experimental" (this Tauri build).
    pub update_channel: String,
    pub system_proxy_desired: bool,
    pub tun_desired: bool,
    pub kernel_enabled: bool,
    pub kernel_channel: String,
    pub kernel_specific_version: String,
    pub delay_test_url_scope: String,
    pub delay_test_url: String,
    pub silent_launch: bool,
    pub close_to_tray: bool,
    pub proxy_guard: bool,
    pub sub_store_enabled: bool,
    pub sub_store_use_proxy: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        // Byte-for-byte mirror of DEFAULT_APP_SETTINGS (@shared/app-settings.ts),
        // except the update channel: a settings file without one belongs to a
        // fresh install of this build, which must keep following its own
        // (experimental) channel rather than switch to Electron.
        AppSettings {
            auto_start_kernel: true,
            auto_check_update: true,
            update_channel: "experimental".into(),
            system_proxy_desired: false,
            tun_desired: false,
            kernel_enabled: true,
            kernel_channel: "stable".into(),
            kernel_specific_version: String::new(),
            delay_test_url_scope: "group".into(),
            delay_test_url: String::new(),
            // Login launch is always tray-only.
            silent_launch: true,
            close_to_tray: true,
            proxy_guard: true,
            sub_store_enabled: true,
            sub_store_use_proxy: false,
        }
    }
}

/// Mirror of TS `parseDelayTestUrl`: absolute http(s) URLs only. Used on the
/// READ path — the TS set() stores the raw string.
pub fn parse_delay_test_url(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value.and_then(|v| v.as_str()) else {
        return String::new();
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return String::new();
    }
    match url::Url::parse(normalized) {
        Ok(parsed) if parsed.scheme() == "http" || parsed.scheme() == "https" => {
            normalized.to_string()
        }
        _ => String::new(),
    }
}

fn is_valid_channel(value: Option<&serde_json::Value>) -> Option<String> {
    match value.and_then(|v| v.as_str()) {
        Some("stable") | Some("preview") | Some("smart") | Some("specific") => {
            value.map(|v| v.as_str().unwrap_or_default().to_string())
        }
        _ => None,
    }
}

fn valid_update_channel(value: Option<&serde_json::Value>) -> Option<String> {
    match value.and_then(|v| v.as_str()) {
        Some(channel @ ("stable" | "experimental")) => Some(channel.to_string()),
        _ => None,
    }
}

fn is_valid_scope(value: Option<&serde_json::Value>) -> Option<String> {
    match value.and_then(|v| v.as_str()) {
        Some("global") => Some("global".into()),
        _ => None, // 'group' or anything else falls back to the default scope
    }
}

/// Mirror of TS `parseAppSettings(raw)`: strict per-field salvage with
/// defaults. `kernelEnabled` is always true (deprecated field, migrated).
pub fn parse_app_settings(document: &serde_json::Value) -> AppSettings {
    let object = match document.as_object() {
        Some(object) => object,
        None => return AppSettings::default(),
    };
    let boolean =
        |key: &str, default: bool| object.get(key).and_then(|v| v.as_bool()).unwrap_or(default);
    let string = |key: &str, default: &str| {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.to_string())
    };
    let defaults = AppSettings::default();
    AppSettings {
        auto_start_kernel: boolean("autoStartKernel", defaults.auto_start_kernel),
        auto_check_update: boolean("autoCheckUpdate", defaults.auto_check_update),
        update_channel: valid_update_channel(object.get("updateChannel"))
            .unwrap_or_else(|| defaults.update_channel.clone()),
        system_proxy_desired: boolean("systemProxyDesired", defaults.system_proxy_desired),
        tun_desired: boolean("tunDesired", defaults.tun_desired),
        kernel_enabled: true,
        kernel_channel: is_valid_channel(object.get("kernelChannel"))
            .unwrap_or_else(|| defaults.kernel_channel.clone()),
        kernel_specific_version: string("kernelSpecificVersion", &defaults.kernel_specific_version),
        delay_test_url_scope: is_valid_scope(object.get("delayTestUrlScope"))
            .unwrap_or_else(|| defaults.delay_test_url_scope.clone()),
        delay_test_url: parse_delay_test_url(object.get("delayTestUrl")),
        // Kept on disk for schema compatibility; every old visible-login
        // preference migrates to the tray-only contract (app-settings.ts).
        silent_launch: true,
        close_to_tray: boolean("closeToTray", defaults.close_to_tray),
        proxy_guard: boolean("proxyGuard", defaults.proxy_guard),
        sub_store_enabled: boolean("subStoreEnabled", defaults.sub_store_enabled),
        sub_store_use_proxy: boolean("subStoreUseProxy", defaults.sub_store_use_proxy),
    }
}

/// The patch the renderer sends (`appSettings.set(patch)`), deserialized from
/// raw JSON so invalid values keep current state exactly like the TS service.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AppSettingsPatch(pub serde_json::Value);

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The TS `AppSettingsGateway` analog: resolves the live settings snapshot at
/// call time through a captured store handle.
pub type SettingsGateway =
    std::sync::Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, AppSettings> + Send + Sync>;

/// The settings store. A `Mutex` serializes read-modify-write cycles (the TS
/// version used a promise queue); dev mode keeps memory-only state.
pub struct SettingsStore {
    app_data_root: Option<PathBuf>,
    state: Mutex<MemoryState>,
    listeners: crate::events::EventHub,
}

#[derive(Default)]
struct MemoryState {
    cached: Option<AppSettings>,
}

impl SettingsStore {
    pub fn new(app_data_root: Option<PathBuf>) -> Self {
        SettingsStore {
            app_data_root,
            state: Mutex::new(MemoryState { cached: None }),
            listeners: crate::events::EventHub::new(),
        }
    }

    /// Store for the current runtime mode: real paths in production, an
    /// in-memory store in dev (dev never persists real user data).
    pub fn for_environment(paths: &AppPaths) -> Self {
        SettingsStore::new(paths.app_data_root.clone())
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.app_data_root
            .as_ref()
            .map(|root| root.join(APP_SETTINGS_FILE))
    }

    /// Read-through cache mirroring the TS `read()` semantics.
    pub fn get(&self) -> AppSettings {
        let mut state = self.state.lock().expect("settings mutex poisoned");
        if let Some(cached) = &state.cached {
            return cached.clone();
        }
        let settings = self.read_from_disk();
        state.cached = Some(settings.clone());
        settings
    }

    fn read_from_disk(&self) -> AppSettings {
        let Some(path) = self.file_path() else {
            return AppSettings::default();
        };
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            // ENOENT -> defaults, same as the TS service.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return AppSettings::default()
            }
            Err(error) => {
                crate::diag!("[app-settings] unable to read persisted settings: {error}");
                return AppSettings::default();
            }
        };
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(document) if document.is_object() => parse_app_settings(&document),
            // Preserve the damaged document for support/recovery instead of
            // letting the next write overwrite the only evidence.
            _ => {
                self.quarantine(&path);
                AppSettings::default()
            }
        }
    }

    fn quarantine(&self, path: &Path) {
        let target =
            path.with_file_name(format!("{}.corrupt-{}", APP_SETTINGS_FILE, epoch_millis()));
        match fs::rename(path, &target) {
            Ok(()) => crate::diag!(
                "[app-settings] quarantined invalid settings at {}",
                target.display()
            ),
            Err(error) => {
                crate::diag!("[app-settings] invalid settings could not be quarantined: {error}")
            }
        }
    }

    /// Patch merge identical to the TS service: only known fields, invalid
    /// values keep current, `kernelEnabled` forced true, atomic 2-space write.
    pub fn set(&self, patch: &AppSettingsPatch) -> AppSettings {
        let mut state = self.state.lock().expect("settings mutex poisoned");
        let current = state
            .cached
            .clone()
            .unwrap_or_else(|| self.read_from_disk());
        let patch = patch.0.as_object().cloned().unwrap_or_default();
        let boolean =
            |key: &str, current: bool| patch.get(key).and_then(|v| v.as_bool()).unwrap_or(current);
        let string = |key: &str, current: &str| {
            patch
                .get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| current.to_string())
        };
        let next = AppSettings {
            auto_start_kernel: boolean("autoStartKernel", current.auto_start_kernel),
            auto_check_update: boolean("autoCheckUpdate", current.auto_check_update),
            update_channel: valid_update_channel(patch.get("updateChannel"))
                .unwrap_or(current.update_channel),
            system_proxy_desired: boolean("systemProxyDesired", current.system_proxy_desired),
            tun_desired: boolean("tunDesired", current.tun_desired),
            kernel_enabled: true,
            kernel_channel: is_valid_channel(patch.get("kernelChannel"))
                .unwrap_or(current.kernel_channel),
            kernel_specific_version: string(
                "kernelSpecificVersion",
                &current.kernel_specific_version,
            ),
            delay_test_url_scope: is_valid_scope(patch.get("delayTestUrlScope"))
                .unwrap_or(current.delay_test_url_scope),
            // The TS set() stores the raw string; URL validation happens on
            // the next read (parseDelayTestUrl), exactly mirrored here.
            delay_test_url: string("delayTestUrl", &current.delay_test_url),
            silent_launch: true,
            close_to_tray: boolean("closeToTray", current.close_to_tray),
            proxy_guard: boolean("proxyGuard", current.proxy_guard),
            sub_store_enabled: boolean("subStoreEnabled", current.sub_store_enabled),
            sub_store_use_proxy: boolean("subStoreUseProxy", current.sub_store_use_proxy),
        };
        self.write_to_disk(&next);
        state.cached = Some(next.clone());
        drop(state);
        // The TS appSettings.onChange fan-out (outside the store lock so a
        // listener may read the store again).
        if let Ok(value) = serde_json::to_value(&next) {
            self.listeners.emit(&value);
        }
        next
    }

    /// Apply the installer's channel stamp in `install_dir` once per install
    /// for this user: follow this build's (experimental) channel. Returns
    /// true when a new stamp was applied. Call once at startup, before the
    /// updater reads the channel. The stamp is recorded as applied only once
    /// the channel is on disk, so a failed write is retried next launch.
    pub fn apply_installer_channel_reset(&self, install_dir: Option<&Path>) -> bool {
        let (Some(root), Some(install_dir)) = (&self.app_data_root, install_dir) else {
            return false;
        };
        let Some(stamp) = modified_stamp(&install_dir.join(INSTALLER_CHANNEL_RESET_FILE)) else {
            return false;
        };
        let seen_path = root.join(INSTALLER_CHANNEL_RESET_SEEN_FILE);
        if fs::read_to_string(&seen_path).ok().as_deref() == Some(stamp.as_str()) {
            return false;
        }
        if self.get().update_channel != "experimental" {
            self.set(&AppSettingsPatch(
                serde_json::json!({ "updateChannel": "experimental" }),
            ));
            if self.read_from_disk().update_channel != "experimental" {
                crate::diag!(
                    "[app-settings] update channel reset not persisted; retrying next launch"
                );
                return false;
            }
        }
        if let Err(error) = fs::write(&seen_path, &stamp) {
            crate::diag!("[app-settings] unable to record the installer channel stamp: {error}");
        }
        true
    }

    /// Subscribe to every applied `set` (the TS `onChange`).
    pub fn subscribe(&self, listener: crate::events::EventListener) -> i64 {
        self.listeners.subscribe(listener)
    }

    fn write_to_disk(&self, settings: &AppSettings) {
        let Some(path) = self.file_path() else { return };
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                crate::diag!("[app-settings] unable to create app-data directory: {error}");
                return;
            }
        }
        let tmp = path.with_file_name(format!(".{}.{}.tmp", APP_SETTINGS_FILE, Uuid::new_v4()));
        let mut body = serde_json::to_string_pretty(settings).expect("settings serialize");
        body.push('\n');
        if let Err(error) = fs::write(&tmp, body) {
            crate::diag!("[app-settings] unable to write settings: {error}");
            return;
        }
        if let Err(error) = fs::rename(&tmp, &path) {
            crate::diag!("[app-settings] unable to finalize settings write: {error}");
        }
    }
}

// Tiny helpers above keep the patch merge readable; nothing else.

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store_in(temp: &TempDir) -> SettingsStore {
        SettingsStore::new(Some(temp.path().to_path_buf()))
    }

    #[test]
    fn missing_file_yields_defaults() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        assert_eq!(store.get(), AppSettings::default());
    }

    #[test]
    fn corrupt_file_is_quarantined_and_defaults_served() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(APP_SETTINGS_FILE);
        fs::write(&path, "{ not json").unwrap();
        let store = store_in(&temp);
        assert_eq!(store.get(), AppSettings::default());
        // The damaged evidence must survive under the quarantine name.
        let quarantined = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined, "corrupt settings must be quarantined");
        assert!(!path.exists(), "original must move away");
    }

    #[test]
    fn write_is_two_space_pretty_with_trailing_newline() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        store.set(&AppSettingsPatch(
            serde_json::json!({ "silentLaunch": true }),
        ));
        let raw = fs::read_to_string(temp.path().join(APP_SETTINGS_FILE)).unwrap();
        assert!(raw.ends_with("\n"));
        assert!(raw.contains("\n  \"silentLaunch\": true"));
    }

    #[test]
    fn patch_merge_rejects_invalid_values_and_forces_kernel_enabled() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        let next = store.set(&AppSettingsPatch(serde_json::json!({
            "kernelChannel": "bogus",
            "kernelEnabled": false,
            "delayTestUrlScope": "weird",
            "proxyGuard": false
        })));
        assert_eq!(next.kernel_channel, "stable");
        assert!(next.kernel_enabled, "kernelEnabled is migrated to true");
        assert_eq!(next.delay_test_url_scope, "group");
        assert!(!next.proxy_guard);
    }

    #[test]
    fn update_channel_accepts_only_the_two_channels() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        // A fresh Tauri install stays on its own channel.
        assert_eq!(store.get().update_channel, "experimental");
        let next = store.set(&AppSettingsPatch(
            serde_json::json!({ "updateChannel": "stable" }),
        ));
        assert_eq!(next.update_channel, "stable");
        let kept = store.set(&AppSettingsPatch(
            serde_json::json!({ "updateChannel": "nightly" }),
        ));
        assert_eq!(kept.update_channel, "stable");
        let raw = fs::read_to_string(temp.path().join(APP_SETTINGS_FILE)).unwrap();
        assert!(raw.contains("\"updateChannel\": \"stable\""));
    }

    #[test]
    fn installer_stamp_moves_an_electron_stable_channel_to_experimental() {
        let temp = TempDir::new().unwrap();
        let install = TempDir::new().unwrap();
        // What Electron v0.9.31 leaves behind after any settings change.
        fs::write(
            temp.path().join(APP_SETTINGS_FILE),
            r#"{ "updateChannel": "stable", "closeToTray": false }"#,
        )
        .unwrap();
        let store = store_in(&temp);
        assert!(
            !store.apply_installer_channel_reset(Some(install.path())),
            "no stamp, no change"
        );
        assert_eq!(store.get().update_channel, "stable");

        let stamp = install.path().join(INSTALLER_CHANNEL_RESET_FILE);
        fs::write(&stamp, "experimental").unwrap();
        assert!(store.apply_installer_channel_reset(Some(install.path())));
        assert_eq!(store.get().update_channel, "experimental");
        assert!(!store.get().close_to_tray, "other settings are kept");
        let raw = fs::read_to_string(temp.path().join(APP_SETTINGS_FILE)).unwrap();
        assert!(raw.contains("\"updateChannel\": \"experimental\""));

        // Applied once per stamp: a later choice of "stable" stays.
        store.set(&AppSettingsPatch(
            serde_json::json!({ "updateChannel": "stable" }),
        ));
        assert!(!store.apply_installer_channel_reset(Some(install.path())));
        assert_eq!(store.get().update_channel, "stable");

        // Another user of the same install still gets the reset once.
        let other = TempDir::new().unwrap();
        fs::write(
            other.path().join(APP_SETTINGS_FILE),
            r#"{ "updateChannel": "stable" }"#,
        )
        .unwrap();
        let other_store = store_in(&other);
        assert!(other_store.apply_installer_channel_reset(Some(install.path())));
        assert_eq!(other_store.get().update_channel, "experimental");

        // A new install (a rewritten stamp) applies again.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(&stamp)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert!(store.apply_installer_channel_reset(Some(install.path())));
        assert_eq!(store.get().update_channel, "experimental");
    }

    #[test]
    fn delay_test_url_is_validated_on_read_not_on_set() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        // set() stores the raw string (TS parity).
        let set = store.set(&AppSettingsPatch(
            serde_json::json!({ "delayTestUrl": "ftp://example.com" }),
        ));
        assert_eq!(set.delay_test_url, "ftp://example.com");
        // ...while the parse path (next launch read) normalizes it away.
        let raw = fs::read_to_string(temp.path().join(APP_SETTINGS_FILE)).unwrap();
        let document: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parse_app_settings(&document).delay_test_url, "");
        let ok =
            parse_app_settings(&serde_json::json!({ "delayTestUrl": "https://example.com/speed" }));
        assert_eq!(ok.delay_test_url, "https://example.com/speed");
    }

    #[test]
    fn dev_store_is_memory_only() {
        let store = SettingsStore::new(None);
        let next = store.set(&AppSettingsPatch(
            serde_json::json!({ "closeToTray": false }),
        ));
        assert!(!next.close_to_tray);
        assert!(!store.get().close_to_tray);
    }

    #[test]
    fn parse_salvages_known_fields_and_defaults_the_rest() {
        let parsed = parse_app_settings(&serde_json::json!({
            "tunDesired": true,
            "kernelChannel": "specific",
            "kernelSpecificVersion": "v1.19.30",
            "autoStartKernel": "not-a-bool"
        }));
        assert!(parsed.tun_desired);
        assert_eq!(parsed.kernel_channel, "specific");
        assert_eq!(parsed.kernel_specific_version, "v1.19.30");
        assert!(
            parsed.auto_start_kernel,
            "invalid type falls back to default"
        );
    }
}
