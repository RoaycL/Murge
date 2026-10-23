//! Six-channel backup boundary: native dialogs, opaque preview tokens and a
//! restart only after the existing network-restore gate succeeds.
mod archive;
mod managed;
mod secrets;
mod webdav;

use crate::{
    error::IpcError,
    paths::AppPaths,
    profiles::{KeyringProfileSourceStore, ProfileSourceStore},
};
use managed::SecretCodec;
use serde_json::{json, Value};
use std::{path::Path, sync::OnceLock};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static PENDING: tokio::sync::Mutex<Option<Pending>> = tokio::sync::Mutex::const_new(None);
struct Pending {
    token: String,
    payload: archive::Payload,
    compatible: bool,
}

pub fn initialize(app: tauri::AppHandle, paths: &AppPaths) -> Result<(), std::convert::Infallible> {
    crate::diagnostics::initialize();
    if let Some(root) = &paths.app_data_root {
        let codec = secrets::Codec { root: root.clone() };
        let rolled_back = std::cell::Cell::new(false);
        let warn = |message: &'static str| {
            if message == RESTORE_ROLLED_BACK {
                rolled_back.set(true);
            }
            startup_warning(message);
        };
        initialize_with(
            root,
            &codec,
            &store(),
            |root| {
                let root = root.to_owned();
                // Only pending restore gates config readers. Routine credential
                // migration must never hold up the window or service composition.
                tauri::async_runtime::spawn_blocking(move || {
                    synchronize_sources(
                        &root,
                        &secrets::Codec { root: root.clone() },
                        &store(),
                        &startup_warning,
                    );
                });
            },
            &warn,
        )?;
        if rolled_back.get() {
            show_restore_rolled_back();
        }
    }
    let _ = APP.set(app);
    Ok(())
}

const RESTORE_ROLLED_BACK: &str = "pending restore rolled back; continuing startup";

/// Electron's startup "配置恢复未完成" dialog: a restore the user asked for
/// did not happen, so say so instead of only logging it.
fn show_restore_rolled_back() {
    let product = crate::brand::load_brand()
        .map(|brand| brand.product_name)
        .unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        rfd::AsyncMessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title(format!("{product} 配置恢复未完成"))
            .set_description("配置恢复失败，已回滚到恢复前的配置。请查看运行日志后重试。")
            .set_buttons(rfd::MessageButtons::Ok)
            .show()
            .await;
    });
}

fn startup_warning(message: &'static str) {
    // Fixed messages only: neither errors, paths nor subscription URLs enter logs.
    crate::diag!("[backup] {message}");
}

fn initialize_with(
    root: &Path,
    codec: &dyn SecretCodec,
    source_store: &dyn ProfileSourceStore,
    schedule_migration: impl FnOnce(&Path),
    warn: &dyn Fn(&'static str),
) -> Result<(), std::convert::Infallible> {
    // Synchronous and before SettingsStore/ProfilesService: rollback and apply
    // stay inside the same recoverable transaction as the credential writes.
    match managed::apply_with_sources(root, &|paths| {
        sync_changed_sources(root, paths, codec, source_store)
    }) {
        Ok("rolled-back") => warn(RESTORE_ROLLED_BACK),
        Err(_) => warn("pending restore recovery failed; continuing startup"),
        _ => {}
    }
    schedule_migration(root);
    Ok(())
}

fn store() -> KeyringProfileSourceStore {
    KeyringProfileSourceStore::new(crate::paths::app_data_namespace())
}

fn sync_changed_sources(
    root: &Path,
    paths: &std::collections::BTreeSet<String>,
    codec: &dyn SecretCodec,
    store: &dyn ProfileSourceStore,
) -> archive::Result<()> {
    for path in paths {
        if let Some(id) = path
            .strip_prefix("profiles/.sources/")
            .and_then(|p| p.strip_suffix(".source.enc"))
        {
            managed::safe(root, path)?;
            if root.join(path).exists() {
                let url = codec.decrypt(&managed::read(&root.join(path), archive::MAX_FILE)?)?;
                store
                    .set(id, &url)
                    .map_err(|_| "系统安全存储不可用，无法恢复订阅地址")?;
            } else {
                store
                    .delete(id)
                    .map_err(|_| "系统安全存储不可用，无法恢复订阅地址")?;
            }
        }
    }
    Ok(())
}

fn persist_current_sources(root: &Path) -> archive::Result<()> {
    let codec = secrets::Codec { root: root.into() };
    let store = store();
    for path in managed::list(root, false)? {
        if let Some(id) = path
            .strip_prefix("profiles/")
            .and_then(|p| p.strip_suffix(".meta.json"))
        {
            if let Some(url) = store.get(id).map_err(|_| "系统安全存储不可用")? {
                let path = format!("profiles/.sources/{id}.source.enc");
                managed::safe(root, &path)?;
                managed::atomic_write(&root.join(path), &codec.encrypt(&url)?)?;
            }
        }
    }
    Ok(())
}

fn synchronize_sources(
    root: &Path,
    codec: &dyn SecretCodec,
    store: &dyn ProfileSourceStore,
    warn: &dyn Fn(&'static str),
) {
    if managed::safe(root, "profiles/.sources").is_err() {
        warn("unsafe source directory; migration skipped");
        return;
    }
    let entries = match std::fs::read_dir(root.join("profiles/.sources")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            warn("cannot enumerate source files; migration skipped");
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            warn("cannot read source entry; continuing migration");
            continue;
        };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(id) = name.strip_suffix(".source.enc") else {
            continue;
        };
        let path = format!("profiles/.sources/{name}");
        if crate::profiles::sanitize_id(id).is_err() || managed::safe(root, &path).is_err() {
            warn("unsafe source file; continuing migration");
            continue;
        }
        match store.get(id) {
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(_) => {
                warn("credential read failed; continuing migration");
                continue;
            }
        }
        let url = match managed::read(&root.join(path), archive::MAX_FILE)
            .and_then(|bytes| codec.decrypt(&bytes))
        {
            Ok(url) => url,
            Err(_) => {
                warn("source decryption failed; continuing migration");
                continue;
            }
        };
        if store.set(id, &url).is_err() {
            warn("credential write failed; continuing migration");
        }
    }
}

fn root(paths: &AppPaths, restore: bool) -> Result<&Path, IpcError> {
    paths.app_data_root.as_deref().ok_or_else(|| {
        IpcError::internal(if restore {
            "配置恢复仅在安装版中可用"
        } else {
            "配置备份仅在安装版中可用"
        })
    })
}
fn string(payload: &Value, index: usize) -> Result<&str, IpcError> {
    payload
        .get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::internal("备份参数无效"))
}
fn app() -> Result<&'static tauri::AppHandle, IpcError> {
    APP.get()
        .ok_or_else(|| IpcError::internal("备份服务尚未初始化"))
}

fn create_archive(root: &Path, password: &str) -> archive::Result<Vec<u8>> {
    archive::password(password)?;
    let mut payload = managed::collect(
        root,
        env!("CARGO_PKG_VERSION"),
        &secrets::Codec { root: root.into() },
    )?;
    // Tauri sources live in the OS credential store; legacy Electron sources
    // above remain readable and current keyring values take precedence.
    let store = store();
    for path in payload.files.keys() {
        if let Some(id) = path
            .strip_prefix("profiles/")
            .and_then(|p| p.strip_suffix(".meta.json"))
        {
            if let Some(url) = store
                .get(id)
                .map_err(|_| "系统安全存储不可用，无法备份订阅地址")?
            {
                payload.source_urls.insert(id.into(), url);
            }
        }
    }
    archive::encrypt(&payload, password)
}

fn preview(root: &Path, bytes: &[u8], password: &str) -> Result<(Pending, Value), IpcError> {
    let (payload, mut preview) =
        archive::inspect(bytes, password, env!("CARGO_PKG_VERSION")).map_err(IpcError::internal)?;
    let store = store();
    let mut keyring_paths = Vec::new();
    for path in managed::list(root, false).map_err(IpcError::internal)? {
        if let Some(id) = path
            .strip_prefix("profiles/")
            .and_then(|p| p.strip_suffix(".meta.json"))
        {
            if store.get(id)?.is_some() {
                keyring_paths.push(format!("profiles/.sources/{id}.source.enc"));
            }
        }
    }
    let impact = managed::impact(root, &payload, &keyring_paths).map_err(IpcError::internal)?;
    let token = uuid::Uuid::new_v4().to_string();
    let pending = Pending {
        token: token.clone(),
        compatible: preview["compatible"] == true,
        payload,
    };
    preview
        .as_object_mut()
        .expect("preview object")
        .extend(impact.as_object().expect("impact object").clone());
    preview["token"] = json!(token);
    Ok((pending, preview))
}

pub async fn create(paths: &AppPaths, payload: &Value) -> Result<Value, IpcError> {
    let root = root(paths, false)?.to_path_buf();
    let password = string(payload, 0)?.to_owned();
    let bytes = tokio::task::spawn_blocking(move || create_archive(&root, &password))
        .await
        .map_err(|_| IpcError::internal("备份创建失败"))?
        .map_err(IpcError::internal)?;
    let brand = crate::brand::load_brand().map_err(IpcError::internal)?;
    let name = format!(
        "{}-config-{}.murge-backup",
        brand.executable_name,
        chrono::Utc::now().format("%Y-%m-%d")
    );
    let choice = rfd::AsyncFileDialog::new()
        .set_title(format!("保存 {} 配置备份", brand.product_name))
        .set_file_name(name)
        .add_filter(
            format!("{} 加密备份", brand.product_name),
            &["murge-backup"],
        )
        .save_file()
        .await;
    let Some(choice) = choice else {
        return Ok(json!({"saved":false}));
    };
    managed::atomic_write(choice.path(), &bytes).map_err(IpcError::internal)?;
    Ok(json!({"saved":true}))
}

pub async fn local_preview(paths: &AppPaths, payload: &Value) -> Result<Value, IpcError> {
    let root = root(paths, true)?;
    let mut pending = PENDING.lock().await;
    *pending = None;
    let brand = crate::brand::load_brand().map_err(IpcError::internal)?;
    let choice = rfd::AsyncFileDialog::new()
        .set_title(format!("选择 {} 配置备份", brand.product_name))
        .add_filter(
            format!("{} 加密备份", brand.product_name),
            &["murge-backup"],
        )
        .pick_file()
        .await;
    let Some(choice) = choice else {
        return Ok(Value::Null);
    };
    let bytes = managed::read(choice.path(), archive::MAX_ARCHIVE).map_err(IpcError::internal)?;
    let (next, value) = preview(root, &bytes, string(payload, 0)?)?;
    *pending = Some(next);
    Ok(value)
}

pub async fn webdav_upload(paths: &AppPaths, payload: &Value) -> Result<Value, IpcError> {
    let root = root(paths, false)?.to_path_buf();
    let pass = string(payload, 1)?.to_owned();
    let bytes = tokio::task::spawn_blocking(move || create_archive(&root, &pass))
        .await
        .map_err(|_| IpcError::internal("备份创建失败"))?
        .map_err(IpcError::internal)?;
    webdav::upload(payload.get(0).unwrap_or(&Value::Null), bytes)
        .await
        .map_err(IpcError::internal)?;
    Ok(json!({"saved":true}))
}

pub async fn webdav_preview(paths: &AppPaths, payload: &Value) -> Result<Value, IpcError> {
    let root = root(paths, true)?;
    let mut pending = PENDING.lock().await;
    *pending = None;
    let bytes = webdav::download(payload.get(0).unwrap_or(&Value::Null))
        .await
        .map_err(IpcError::internal)?;
    let (next, value) = preview(root, &bytes, string(payload, 1)?)?;
    *pending = Some(next);
    Ok(value)
}

pub async fn restore(paths: &AppPaths, payload: &Value) -> Result<Value, IpcError> {
    let token = string(payload, 0)?;
    let mut pending = PENDING.lock().await;
    if !pending
        .as_ref()
        .is_some_and(|p| p.token == token && p.compatible)
    {
        return Err(IpcError::internal("请重新选择兼容的备份并确认预览"));
    }
    let root = root(paths, true)?;
    let next = pending.take().expect("validated preview");
    persist_current_sources(root).map_err(IpcError::internal)?;
    managed::stage(
        root,
        &next.payload,
        env!("CARGO_PKG_VERSION"),
        &secrets::Codec { root: root.into() },
    )
    .map_err(IpcError::internal)?;
    let handle = app()?.clone();
    drop(pending);
    crate::lifecycle::begin_application_restart(handle).await?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::collections::BTreeMap;
    struct StartupCodec;
    impl SecretCodec for StartupCodec {
        fn encrypt(&self, value: &str) -> archive::Result<Vec<u8>> {
            Ok(format!("encrypted:{value}").into_bytes())
        }
        fn decrypt(&self, value: &[u8]) -> archive::Result<String> {
            std::str::from_utf8(value)
                .ok()
                .and_then(|s| s.strip_prefix("encrypted:"))
                .map(str::to_owned)
                .ok_or_else(|| "https://private.invalid/?token=secret".into())
        }
    }
    #[derive(Default)]
    struct StartupStore {
        inner: crate::profiles::MemoryProfileSourceStore,
        fail_read: bool,
        fail_write: bool,
    }
    impl ProfileSourceStore for StartupStore {
        fn get(&self, id: &str) -> crate::profiles::ProfileResult<Option<String>> {
            if self.fail_read && id == "bad" {
                return Err(IpcError::internal("https://private.invalid/?token=secret"));
            }
            self.inner.get(id)
        }
        fn set(&self, id: &str, url: &str) -> crate::profiles::ProfileResult<()> {
            if self.fail_write {
                return Err(IpcError::internal("private storage error"));
            }
            self.inner.set(id, url)
        }
        fn delete(&self, id: &str) -> crate::profiles::ProfileResult<()> {
            self.inner.delete(id)
        }
    }
    fn initialize_inline(
        root: &Path,
        store: &StartupStore,
        messages: &std::cell::RefCell<Vec<&'static str>>,
    ) -> Result<(), std::convert::Infallible> {
        let warn = |message| messages.borrow_mut().push(message);
        initialize_with(
            root,
            &StartupCodec,
            store,
            |root| synchronize_sources(root, &StartupCodec, store, &warn),
            &warn,
        )
    }
    fn source_file(root: &Path, id: &str, bytes: &[u8]) {
        std::fs::create_dir_all(root.join("profiles/.sources")).unwrap();
        std::fs::write(
            root.join(format!("profiles/.sources/{id}.source.enc")),
            bytes,
        )
        .unwrap();
    }
    fn assert_startup_continues(root: &Path) {
        // This is the next operation in the real composition root.
        let settings = crate::settings::SettingsStore::new(Some(root.to_owned()));
        assert!(!settings.get().close_to_tray);
    }
    #[test]
    fn initialize_ok_with_corrupt_source_and_other_sources_still_migrate() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("app-settings.json"),
            br#"{"closeToTray":false}"#,
        )
        .unwrap();
        source_file(root.path(), "bad", b"corrupt DPAPI ciphertext");
        source_file(
            root.path(),
            "good",
            b"encrypted:https://example.invalid/sub?token=secret",
        );
        let store = StartupStore::default();
        let messages = std::cell::RefCell::new(Vec::new());
        assert!(initialize_inline(root.path(), &store, &messages).is_ok());
        assert!(store.inner.get("bad").unwrap().is_none());
        assert!(store.inner.get("good").unwrap().is_some());
        assert!(messages
            .borrow()
            .iter()
            .any(|m| m.contains("decryption failed")));
        assert!(messages
            .borrow()
            .iter()
            .all(|m| !m.contains("https:") && !m.contains("secret")));
        assert_startup_continues(root.path());
    }
    #[test]
    fn initialize_ok_with_keyring_read_failure_and_other_sources_still_migrate() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("app-settings.json"),
            br#"{"closeToTray":false}"#,
        )
        .unwrap();
        source_file(root.path(), "bad", b"encrypted:https://private.invalid/sub");
        source_file(
            root.path(),
            "good",
            b"encrypted:https://example.invalid/sub",
        );
        let store = StartupStore {
            fail_read: true,
            ..Default::default()
        };
        let messages = std::cell::RefCell::new(Vec::new());
        assert!(initialize_inline(root.path(), &store, &messages).is_ok());
        assert!(store.inner.get("good").unwrap().is_some());
        assert!(messages
            .borrow()
            .iter()
            .any(|m| m.contains("credential read failed")));
        assert!(messages
            .borrow()
            .iter()
            .all(|m| !m.contains("https:") && !m.contains("secret")));
        assert_startup_continues(root.path());
    }
    #[test]
    fn initialize_ok_with_invalid_pending_manifest_and_keeps_existing_settings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("app-settings.json"),
            br#"{"closeToTray":false}"#,
        )
        .unwrap();
        let pending = root.path().join(".config-restore-pending");
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::write(
            pending.join("manifest.json"),
            b"invalid private https://url",
        )
        .unwrap();
        let messages = std::cell::RefCell::new(Vec::new());
        assert!(initialize_inline(root.path(), &StartupStore::default(), &messages).is_ok());
        assert!(messages
            .borrow()
            .iter()
            .any(|m| m.contains("restore recovery failed")));
        assert!(
            pending.exists(),
            "retain invalid journal for diagnosis; never trust its paths"
        );
        assert_startup_continues(root.path());
    }
    #[test]
    fn initialize_applies_restore_before_scheduling_routine_migration() {
        let root = tempfile::tempdir().unwrap();
        let payload = archive::Payload {
            app_id: crate::paths::app_data_namespace(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: "2026-10-22T00:00:00Z".into(),
            files: [(
                "app-settings.json".into(),
                base64::engine::general_purpose::STANDARD.encode(br#"{"closeToTray":false}"#),
            )]
            .into(),
            source_urls: BTreeMap::new(),
        };
        managed::stage(
            root.path(),
            &payload,
            env!("CARGO_PKG_VERSION"),
            &StartupCodec,
        )
        .unwrap();
        let scheduled = std::cell::Cell::new(false);
        assert!(initialize_with(
            root.path(),
            &StartupCodec,
            &StartupStore::default(),
            |root| {
                assert_startup_continues(root);
                scheduled.set(true); // Scheduler need not run migration to return Ok.
            },
            &|_| {}
        )
        .is_ok());
        assert!(scheduled.get());
        assert_startup_continues(root.path());
    }
    #[test]
    fn initialize_rolls_back_failed_restore_without_aborting_startup() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("app-settings.json"),
            br#"{"closeToTray":false}"#,
        )
        .unwrap();
        source_file(root.path(), "old", b"encrypted:https://old.invalid/sub");
        let payload = archive::Payload {
            app_id: crate::paths::app_data_namespace(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: "2026-10-22T00:00:00Z".into(),
            files: [(
                "app-settings.json".into(),
                base64::engine::general_purpose::STANDARD.encode(br#"{"closeToTray":true}"#),
            )]
            .into(),
            source_urls: [("new".into(), "https://new.invalid/sub".into())].into(),
        };
        managed::stage(
            root.path(),
            &payload,
            env!("CARGO_PKG_VERSION"),
            &StartupCodec,
        )
        .unwrap();
        let store = StartupStore {
            fail_write: true,
            ..Default::default()
        };
        let messages = std::cell::RefCell::new(Vec::new());
        assert!(initialize_inline(root.path(), &store, &messages).is_ok());
        assert!(root
            .path()
            .join("profiles/.sources/old.source.enc")
            .exists());
        assert!(!root
            .path()
            .join("profiles/.sources/new.source.enc")
            .exists());
        assert_startup_continues(root.path());
    }

    fn dev() -> AppPaths {
        AppPaths {
            app_data_root: None,
            profile_root: None,
        }
    }
    #[tokio::test]
    async fn all_file_and_webdav_channels_preserve_installed_only_guard() {
        for result in [
            create(&dev(), &json!(["password"])).await,
            local_preview(&dev(), &json!(["password"])).await,
            webdav_upload(&dev(), &json!([{}, "password"])).await,
            webdav_preview(&dev(), &json!([{}, "password"])).await,
        ] {
            let error = result.unwrap_err();
            assert!(error.0.contains("仅在安装版中可用"));
            assert!(error.0.starts_with("PROTOCOL_ERROR:INTERNAL::"));
        }
    }
    #[tokio::test]
    async fn restore_rejects_unpreviewed_token() {
        let error = restore(&dev(), &json!(["unknown"])).await.unwrap_err();
        assert!(error.0.contains("请重新选择兼容的备份"));
    }
    #[test]
    fn preview_returns_opaque_token_impact_and_expected_shape() {
        let root = tempfile::tempdir().unwrap();
        let payload = archive::Payload {
            app_id: crate::paths::app_data_namespace(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: "2026-09-29T00:00:00.000Z".into(),
            files: BTreeMap::new(),
            source_urls: BTreeMap::new(),
        };
        let bytes = archive::encrypt(&payload, "password").unwrap();
        let (pending, value) = preview(root.path(), &bytes, "password").unwrap();
        assert_eq!(value["token"], pending.token);
        assert!(pending.compatible);
        assert_eq!(value["fileCount"], 0);
        assert_eq!(value["replaceCount"], 0);
    }
}
