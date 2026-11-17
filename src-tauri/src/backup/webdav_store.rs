//! Remembered WebDAV backup target and the scheduled upload.
//!
//! Address, file path, user name and the schedule live in
//! `webdav-backup.json` under the app-data root (deliberately NOT one of the
//! archived files: a restore on another computer must not start uploading
//! over the original target). The WebDAV password and the archive passphrase
//! go to the OS credential store (Windows Credential Manager) and are never
//! returned to the renderer; it only learns whether one is saved.
use super::{
    archive::Result,
    managed::{self},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const FILE: &str = "webdav-backup.json";
/// Choices offered in the UI, in hours.
pub const INTERVALS: &[u32] = &[1, 6, 12, 24, 72, 168];
const DEFAULT_INTERVAL: u32 = 24;
/// A failed scheduled upload is retried no sooner than this.
const RETRY_MS: i64 = 30 * 60 * 1000;
pub const PASSWORD: &str = "password";
pub const PASSPHRASE: &str = "passphrase";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub address: String,
    pub file_path: String,
    /// The composed file URL the renderer showed as "remote file".
    pub url: String,
    pub username: String,
    pub auto_enabled: bool,
    pub interval_hours: u32,
    pub last_success_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub last_error: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            address: String::new(),
            file_path: String::new(),
            url: String::new(),
            username: String::new(),
            auto_enabled: false,
            interval_hours: DEFAULT_INTERVAL,
            last_success_at: None,
            last_attempt_at: None,
            last_error: None,
        }
    }
}

pub fn load(root: &Path) -> Settings {
    let path = root.join(FILE);
    managed::read(&path, 64 * 1024)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .map(|mut settings| {
            if !INTERVALS.contains(&settings.interval_hours) {
                settings.interval_hours = DEFAULT_INTERVAL;
            }
            settings
        })
        .unwrap_or_default()
}

pub fn save(root: &Path, settings: &Settings) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "无法保存 WebDAV 备份设置")?;
    managed::atomic_write(&root.join(FILE), &bytes)
}

/// Serializes read-modify-write of the settings file between the IPC
/// handlers and the scheduler.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn update(root: &Path, change: impl FnOnce(&mut Settings)) -> Result<Settings> {
    let _guard = LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut settings = load(root);
    change(&mut settings);
    save(root, &settings)?;
    Ok(settings)
}

pub fn record(
    root: &Path,
    now: i64,
    outcome: &std::result::Result<(), String>,
) -> Result<Settings> {
    update(root, |settings| {
        settings.last_attempt_at = Some(now);
        match outcome {
            Ok(()) => {
                settings.last_success_at = Some(now);
                settings.last_error = None;
            }
            Err(error) => settings.last_error = Some(error.clone()),
        }
    })
}

/// The password and passphrase. A trait so tests do not touch the real
/// credential store.
pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

pub struct KeyringSecrets {
    service: String,
}

impl KeyringSecrets {
    pub fn new() -> Self {
        KeyringSecrets {
            service: format!("{}.webdav-backup", crate::paths::app_data_namespace()),
        }
    }
    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, key).map_err(|_| UNAVAILABLE.into())
    }
}

const UNAVAILABLE: &str = "系统安全存储不可用，无法保存 WebDAV 凭据";

impl Secrets for KeyringSecrets {
    fn get(&self, key: &str) -> Result<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.entry(key)?
            .set_password(value)
            .map_err(|_| UNAVAILABLE.into())
    }
    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
}

/// Whether a stored secret exists; a broken store reads as "not saved".
fn has(secrets: &dyn Secrets, key: &str) -> bool {
    matches!(secrets.get(key), Ok(Some(value)) if !value.is_empty())
}

/// What the renderer sees: the settings plus `hasPassword`/`hasPassphrase`,
/// never the secrets themselves.
pub fn view(settings: &Settings, secrets: &dyn Secrets) -> Value {
    let mut value = serde_json::to_value(settings).expect("settings serialize");
    value["hasPassword"] = json!(has(secrets, PASSWORD));
    value["hasPassphrase"] = json!(has(secrets, PASSPHRASE));
    value["intervals"] = json!(INTERVALS);
    value
}

/// Input of `backup:webdav-save`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Form {
    pub address: String,
    pub file_path: String,
    pub url: String,
    pub username: String,
    pub auto_enabled: bool,
    pub interval_hours: u32,
}

/// `null`/absent keeps the saved value, a non-empty string replaces it.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SecretInput {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

pub fn apply(
    root: &Path,
    secrets: &dyn Secrets,
    form: Form,
    input: SecretInput,
) -> Result<Settings> {
    let form = Form {
        address: form.address.trim().to_owned(),
        file_path: form.file_path.trim().to_owned(),
        url: form.url.trim().to_owned(),
        username: form.username.trim().to_owned(),
        ..form
    };
    if form.address.encode_utf16().count() > 2048 || form.file_path.encode_utf16().count() > 1024 {
        return Err("WebDAV 参数无效".into());
    }
    if !form.url.is_empty() {
        super::webdav::validate(
            &json!({"url": form.url, "username": form.username, "password": ""}),
        )?;
    }
    if !INTERVALS.contains(&form.interval_hours) {
        return Err("自动备份间隔无效".into());
    }
    if let Some(passphrase) = input.passphrase.as_deref().filter(|p| !p.is_empty()) {
        super::archive::password(passphrase).map_err(|_| "WebDAV 加密口令至少 8 位")?;
    }
    if form.auto_enabled {
        if form.url.is_empty() {
            return Err("请先填写 WebDAV 地址再开启自动备份".into());
        }
        let has_passphrase =
            input.passphrase.as_deref().is_some_and(|p| !p.is_empty()) || has(secrets, PASSPHRASE);
        if !has_passphrase {
            return Err("开启自动备份需要先设置加密口令".into());
        }
    }
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        if password.encode_utf16().count() > 1024 {
            return Err("WebDAV 参数无效".into());
        }
        secrets.set(PASSWORD, password)?;
    }
    if let Some(passphrase) = input.passphrase.as_deref().filter(|p| !p.is_empty()) {
        secrets.set(PASSPHRASE, passphrase)?;
    }
    update(root, |settings| {
        let target_changed = settings.url != form.url || settings.username != form.username;
        settings.address = form.address;
        settings.file_path = form.file_path;
        settings.url = form.url;
        settings.username = form.username;
        settings.auto_enabled = form.auto_enabled;
        settings.interval_hours = form.interval_hours;
        if target_changed {
            // A new target has never been uploaded to: back it up on the next check.
            settings.last_success_at = None;
            settings.last_attempt_at = None;
            settings.last_error = None;
        }
    })
}

/// Forget the password and passphrase; scheduled backup cannot run without
/// them, so it is switched off too.
pub fn forget(root: &Path, secrets: &dyn Secrets) -> Result<Settings> {
    secrets.delete(PASSWORD)?;
    secrets.delete(PASSPHRASE)?;
    update(root, |settings| {
        settings.auto_enabled = false;
        settings.last_error = None;
    })
}

/// Fill a missing (`null`/absent) password from the credential store.
pub fn resolve_target(target: &Value, secrets: &dyn Secrets) -> Result<Value> {
    let mut target = target.clone();
    if !target.is_object() {
        return Ok(target);
    }
    if target.get("password").is_none_or(Value::is_null) {
        target["password"] = json!(secrets.get(PASSWORD)?.unwrap_or_default());
    }
    Ok(target)
}

/// A missing (`null`) passphrase is taken from the credential store.
pub fn resolve_passphrase(value: Option<&Value>, secrets: &dyn Secrets) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(passphrase) => Ok(passphrase.to_owned()),
        None => secrets
            .get(PASSPHRASE)?
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "请输入 WebDAV 备份的加密口令".into()),
    }
}

/// Whether the scheduler should upload now.
pub fn due(settings: &Settings, now: i64, has_passphrase: bool) -> bool {
    if !settings.auto_enabled || settings.url.is_empty() || !has_passphrase {
        return false;
    }
    let interval = i64::from(settings.interval_hours) * 3_600_000;
    let since_success = now - settings.last_success_at.unwrap_or(i64::MIN / 2);
    let since_attempt = now - settings.last_attempt_at.unwrap_or(i64::MIN / 2);
    since_success >= interval && since_attempt >= RETRY_MS.min(interval)
}

/// The scheduled upload. Wakes every ten minutes after a short startup
/// delay; the decision is `due()`, so a missed slot (computer asleep, app
/// closed) is caught up on the next check.
pub fn start_scheduler(root: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        loop {
            run_once(&root).await;
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        }
    });
}

async fn run_once(root: &Path) {
    let secrets = KeyringSecrets::new();
    let settings = load(root);
    let now = chrono::Utc::now().timestamp_millis();
    let passphrase = secrets
        .get(PASSPHRASE)
        .ok()
        .flatten()
        .filter(|p| !p.is_empty());
    if !due(&settings, now, passphrase.is_some()) {
        return;
    }
    let target = json!({
        "url": settings.url,
        "username": settings.username,
        "password": secrets.get(PASSWORD).ok().flatten().unwrap_or_default(),
    });
    let outcome = super::upload_archive(root, &target, passphrase.unwrap_or_default()).await;
    let was_failing = settings.last_error.is_some();
    match &outcome {
        Ok(()) => crate::diag!("[backup] scheduled WebDAV backup uploaded"),
        Err(_) => crate::diag!("[backup] scheduled WebDAV backup failed"),
    }
    let _ = record(root, now, &outcome);
    // Toast once per failure streak, not on every retry.
    if let (Err(error), false) = (&outcome, was_failing) {
        if let Some(app) = super::APP.get() {
            crate::notifications::show_navigate_toast(
                app,
                crate::i18n::t("notify.webdavBackupFailedTitle").to_string(),
                crate::i18n::tf(
                    "notify.webdavBackupFailedBody",
                    &[error.trim_end_matches('。')],
                ),
                "/general",
            );
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemorySecrets(pub Mutex<HashMap<String, String>>);
    impl Secrets for MemorySecrets {
        fn get(&self, key: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<()> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn form(url: &str, auto: bool) -> Form {
        Form {
            address: "https://dav.example.com/dav".into(),
            file_path: "App/app.murge-backup".into(),
            url: url.into(),
            username: "alice".into(),
            auto_enabled: auto,
            interval_hours: 24,
        }
    }
    const URL: &str = "https://dav.example.com/dav/App/app.murge-backup";

    #[test]
    fn saved_target_and_secrets_come_back_without_exposing_secrets() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        apply(
            root.path(),
            &secrets,
            form(URL, false),
            SecretInput {
                password: Some("dav-secret".into()),
                passphrase: Some("long-passphrase".into()),
            },
        )
        .unwrap();
        let view = view(&load(root.path()), &secrets);
        assert_eq!(view["address"], "https://dav.example.com/dav");
        assert_eq!(view["filePath"], "App/app.murge-backup");
        assert_eq!(view["username"], "alice");
        assert_eq!(view["hasPassword"], true);
        assert_eq!(view["hasPassphrase"], true);
        let text = view.to_string();
        assert!(!text.contains("dav-secret") && !text.contains("long-passphrase"));
        let file = std::fs::read_to_string(root.path().join(FILE)).unwrap();
        assert!(!file.contains("dav-secret") && !file.contains("long-passphrase"));

        // Empty/null secrets keep what is stored.
        apply(
            root.path(),
            &secrets,
            form(URL, true),
            SecretInput::default(),
        )
        .unwrap();
        assert_eq!(secrets.get(PASSWORD).unwrap().unwrap(), "dav-secret");
        let target = resolve_target(
            &json!({"url": URL, "username": "alice", "password": null}),
            &secrets,
        )
        .unwrap();
        assert_eq!(target["password"], "dav-secret");
        assert_eq!(
            resolve_passphrase(Some(&Value::Null), &secrets).unwrap(),
            "long-passphrase"
        );
        assert_eq!(
            resolve_passphrase(Some(&json!("typed-pass")), &secrets).unwrap(),
            "typed-pass"
        );

        forget(root.path(), &secrets).unwrap();
        let view = super::view(&load(root.path()), &secrets);
        assert_eq!(view["hasPassword"], false);
        assert_eq!(view["autoEnabled"], false);
        assert!(resolve_passphrase(None, &secrets).is_err());
    }

    #[test]
    fn auto_backup_needs_target_and_passphrase_and_valid_interval() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        assert!(apply(
            root.path(),
            &secrets,
            form("", true),
            SecretInput::default()
        )
        .is_err());
        assert!(apply(
            root.path(),
            &secrets,
            form(URL, true),
            SecretInput::default()
        )
        .is_err());
        assert!(apply(
            root.path(),
            &secrets,
            form("http://x/a.murge-backup", false),
            SecretInput::default()
        )
        .is_err());
        assert!(apply(
            root.path(),
            &secrets,
            Form {
                interval_hours: 5,
                ..form(URL, false)
            },
            SecretInput::default()
        )
        .is_err());
        assert!(apply(
            root.path(),
            &secrets,
            form(URL, true),
            SecretInput {
                passphrase: Some("short".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(apply(
            root.path(),
            &secrets,
            form(URL, true),
            SecretInput {
                passphrase: Some("long-enough".into()),
                ..Default::default()
            }
        )
        .is_ok());
    }

    #[test]
    fn due_respects_interval_and_failure_backoff() {
        let hour = 3_600_000;
        let mut settings = Settings {
            url: URL.into(),
            auto_enabled: true,
            interval_hours: 6,
            ..Default::default()
        };
        assert!(due(&settings, 10 * hour, true), "never backed up");
        assert!(!due(&settings, 10 * hour, false), "no passphrase");
        settings.last_success_at = Some(10 * hour);
        settings.last_attempt_at = Some(10 * hour);
        assert!(!due(&settings, 15 * hour, true));
        assert!(due(&settings, 16 * hour, true));
        // Failed at 16h: wait 30 minutes before retrying.
        settings.last_attempt_at = Some(16 * hour);
        assert!(!due(&settings, 16 * hour + 10 * 60_000, true));
        assert!(due(&settings, 16 * hour + 30 * 60_000, true));
        settings.auto_enabled = false;
        assert!(!due(&settings, 100 * hour, true));
    }

    #[test]
    fn changing_target_resets_history_and_record_tracks_outcome() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        apply(
            root.path(),
            &secrets,
            form(URL, false),
            SecretInput::default(),
        )
        .unwrap();
        record(root.path(), 5, &Err("WebDAV 认证失败或没有权限".into())).unwrap();
        assert_eq!(
            load(root.path()).last_error.as_deref(),
            Some("WebDAV 认证失败或没有权限")
        );
        record(root.path(), 6, &Ok(())).unwrap();
        let settings = load(root.path());
        assert_eq!(
            (settings.last_success_at, settings.last_error),
            (Some(6), None)
        );
        apply(
            root.path(),
            &secrets,
            form("https://dav.example.com/dav/Other/x.murge-backup", false),
            SecretInput::default(),
        )
        .unwrap();
        assert_eq!(load(root.path()).last_success_at, None);
    }

    #[test]
    fn settings_file_is_not_part_of_the_backup_archive() {
        assert!(!super::super::archive::ROOT_FILES.contains(&FILE));
        assert!(!super::super::archive::is_backup_path(FILE));
    }
}
