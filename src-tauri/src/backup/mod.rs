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
use tauri::Manager;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static PENDING: tokio::sync::Mutex<Option<Pending>> = tokio::sync::Mutex::const_new(None);
struct Pending {
    token: String,
    payload: archive::Payload,
    compatible: bool,
}

pub fn initialize(app: tauri::AppHandle, paths: &AppPaths) -> Result<(), std::io::Error> {
    crate::diagnostics::initialize();
    if let Some(root) = &paths.app_data_root {
        let outcome = managed::apply_with_sources(root, &|paths| sync_changed_sources(root, paths))
            .map_err(std::io::Error::other)?;
        synchronize_sources(root, outcome == "restored").map_err(std::io::Error::other)?;
    }
    let _ = APP.set(app);
    Ok(())
}

fn store() -> KeyringProfileSourceStore {
    KeyringProfileSourceStore::new(crate::paths::app_data_namespace())
}

fn sync_changed_sources(
    root: &Path,
    paths: &std::collections::BTreeSet<String>,
) -> archive::Result<()> {
    let codec = secrets::Codec { root: root.into() };
    let store = store();
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

fn synchronize_sources(root: &Path, restored: bool) -> archive::Result<()> {
    let codec = secrets::Codec { root: root.into() };
    let store = store();
    for path in managed::list(root, true)? {
        if let Some(id) = path
            .strip_prefix("profiles/.sources/")
            .and_then(|p| p.strip_suffix(".source.enc"))
        {
            if restored || store.get(id).map_err(|_| "系统安全存储不可用")?.is_none() {
                let url = codec.decrypt(&managed::read(&root.join(&path), archive::MAX_FILE)?)?;
                store
                    .set(id, &url)
                    .map_err(|_| "系统安全存储不可用，无法恢复订阅地址")?;
            }
        }
    }
    Ok(())
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
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        // Reuse the existing network gate. A restore failure leaves the staged
        // archive recoverable and keeps the live core/window available.
        if !crate::lifecycle::restore_network_before_quit(&handle).await {
            return;
        }
        let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
        if let Some(kernel) = handle.try_state::<std::sync::Arc<crate::kernel::KernelServices>>() {
            if kernel.stop().await.is_err() {
                return;
            }
        }
        handle.restart();
    });
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
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
