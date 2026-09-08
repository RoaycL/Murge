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
//!   `delayTestUrl` accepts only absolute http(s) URLs.
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub auto_start_kernel: bool,
    pub auto_check_update: bool,
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
        // Byte-for-byte mirror of DEFAULT_APP_SETTINGS (@shared/app-settings.ts).
        AppSettings {
            auto_start_kernel: true,
            auto_check_update: true,
            system_proxy_desired: false,
            tun_desired: false,
            kernel_enabled: true,
            kernel_channel: "stable".into(),
            kernel_specific_version: String::new(),
            delay_test_url_scope: "group".into(),
            delay_test_url: String::new(),
            silent_launch: false,
            close_to_tray: true,
            proxy_guard: true,
            sub_store_enabled: true,
            sub_store_use_proxy: false,
        }
    }
}

/// Mirror of TS `parseDelayTestUrl`: absolute http(s) URLs only.
fn parse_delay_test_url(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value.and_then(|v| v.as_str()) else {
        return String::new();
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return String::new();
    }
    match url::Url::parse(normalized) {
        Ok(parsed)
            if parsed.scheme() == "http" || parsed.scheme() == "https" =>
        {
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
    let boolean = |key: &str, default: bool| object.get(key).and_then(|v| v.as_bool()).unwrap_or(default);
    let string = |key: &str, default: &str| object
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default.to_string());
    let defaults = AppSettings::default();
    AppSettings {
        auto_start_kernel: boolean("autoStartKernel", defaults.auto_start_kernel),
        auto_check_update: boolean("autoCheckUpdate", defaults.auto_check_update),
        system_proxy_desired: boolean("systemProxyDesired", defaults.system_proxy_desired),
        tun_desired: boolean("tunDesired", defaults.tun_desired),
        kernel_enabled: true,
        kernel_channel: is_valid_channel(object.get("kernelChannel"))
            .unwrap_or_else(|| defaults.kernel_channel.clone()),
        kernel_specific_version: string("kernelSpecificVersion", &defaults.kernel_specific_version),
        delay_test_url_scope: is_valid_scope(object.get("delayTestUrlScope"))
            .unwrap_or_else(|| defaults.delay_test_url_scope.clone()),
        delay_test_url: parse_delay_test_url(object.get("delayTestUrl")),
        silent_launch: boolean("silentLaunch", defaults.silent_launch),
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

/// The settings store. A `Mutex` serializes read-modify-write cycles (the TS
/// version used a promise queue); dev mode keeps memory-only state.
pub struct SettingsStore {
    app_data_root: Option<PathBuf>,
    state: Mutex<MemoryState>,
}

#[derive(Default)]
struct MemoryState {
    cached: Option<AppSettings>,
}

impl SettingsStore {
    pub fn new(app_data_root: Option<PathBuf>) -> Self {
        SettingsStore { app_data_root, state: Mutex::new(MemoryState { cached: None }) }
    }

    /// Store for the current runtime mode: real paths in production, an
    /// in-memory store in dev (dev never persists real user data).
    pub fn for_environment(paths: &AppPaths) -> Self {
        SettingsStore::new(paths.app_data_root.clone())
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.app_data_root.as_ref().map(|root| root.join(APP_SETTINGS_FILE))
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
                eprintln!("[app-settings] unable to read persisted settings: {error}");
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
        let target = path.with_file_name(format!(
            "{}.corrupt-{}",
            APP_SETTINGS_FILE,
            epoch_millis()
        ));
        match fs::rename(path, &target) {
            Ok(()) => eprintln!("[app-settings] quarantined invalid settings at {}", target.display()),
            Err(error) => eprintln!(
                "[app-settings] invalid settings could not be quarantined: {error}"
            ),
        }
    }

    /// Patch merge identical to the TS service: only known fields, invalid
    /// values keep current, `kernelEnabled` forced true, atomic 2-space write.
    pub fn set(&self, patch: &AppSettingsPatch) -> AppSettings {
        let mut state = self.state.lock().expect("settings mutex poisoned");
        let current = state.cached.clone().unwrap_or_else(|| self.read_from_disk());
        let patch = patch.0.as_object().cloned().unwrap_or_default();
        let boolean = |key: &str, current: bool| patch.get(key).and_then(|v| v.as_bool()).unwrap_or(current);
        let string = |key: &str, current: &str| patch
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| current.to_string());
        let next = AppSettings {
            auto_start_kernel: boolean("autoStartKernel", current.auto_start_kernel),
            auto_check_update: boolean("autoCheckUpdate", current.auto_check_update),
            system_proxy_desired: boolean("systemProxyDesired", current.system_proxy_desired),
            tun_desired: boolean("tunDesired", current.tun_desired),
            kernel_enabled: true,
            kernel_channel: is_valid_channel(patch.get("kernelChannel"))
                .unwrap_or(current.kernel_channel),
            kernel_specific_version: string("kernelSpecificVersion", &current.kernel_specific_version),
            delay_test_url_scope: is_valid_scope(patch.get("delayTestUrlScope"))
                .unwrap_or(current.delay_test_url_scope),
            // The TS set() stores the raw string; URL validation happens on
            // the next read (parseDelayTestUrl), exactly mirrored here.
            delay_test_url: string("delayTestUrl", &current.delay_test_url),
            silent_launch: boolean("silentLaunch", current.silent_launch),
            close_to_tray: boolean("closeToTray", current.close_to_tray),
            proxy_guard: boolean("proxyGuard", current.proxy_guard),
            sub_store_enabled: boolean("subStoreEnabled", current.sub_store_enabled),
            sub_store_use_proxy: boolean("subStoreUseProxy", current.sub_store_use_proxy),
        };
        self.write_to_disk(&next);
        state.cached = Some(next.clone());
        next
    }

    fn write_to_disk(&self, settings: &AppSettings) {
        let Some(path) = self.file_path() else { return };
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("[app-settings] unable to create app-data directory: {error}");
                return;
            }
        }
        let tmp = path.with_file_name(format!(".{}.{}.tmp", APP_SETTINGS_FILE, Uuid::new_v4()));
        let mut body = serde_json::to_string_pretty(settings).expect("settings serialize");
        body.push('\n');
        if let Err(error) = fs::write(&tmp, body) {
            eprintln!("[app-settings] unable to write settings: {error}");
            return;
        }
        if let Err(error) = fs::rename(&tmp, &path) {
            eprintln!("[app-settings] unable to finalize settings write: {error}");
        }
    }
}

/// Tiny helpers above keep the patch merge readable; nothing else.

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
        store.set(&AppSettingsPatch(serde_json::json!({ "silentLaunch": true })));
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
    fn delay_test_url_is_validated_on_read_not_on_set() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        // set() stores the raw string (TS parity).
        let set = store.set(&AppSettingsPatch(
            serde_json::json!({ "delayTestUrl": "ftp://example.com" })
        ));
        assert_eq!(set.delay_test_url, "ftp://example.com");
        // ...while the parse path (next launch read) normalizes it away.
        let raw = fs::read_to_string(temp.path().join(APP_SETTINGS_FILE)).unwrap();
        let document: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parse_app_settings(&document).delay_test_url, "");
        let ok = parse_app_settings(&serde_json::json!({ "delayTestUrl": "https://example.com/speed" }));
        assert_eq!(ok.delay_test_url, "https://example.com/speed");
    }

    #[test]
    fn dev_store_is_memory_only() {
        let store = SettingsStore::new(None);
        let next = store.set(&AppSettingsPatch(serde_json::json!({ "closeToTray": false })));
        assert!(!next.close_to_tray);
        assert_eq!(store.get().close_to_tray, false);
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
        assert!(parsed.auto_start_kernel, "invalid type falls back to default");
    }
}
