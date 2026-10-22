//! Bounded, allowlisted filesystem operations and crash-recoverable restore.
use super::archive::{self, Payload, Result, MAX_ARCHIVE, MAX_CONTENT, MAX_FILE, MAX_FILES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::Path,
};

pub trait SecretCodec {
    fn encrypt(&self, value: &str) -> Result<Vec<u8>>;
    fn decrypt(&self, value: &[u8]) -> Result<String>;
}

pub fn safe(root: &Path, relative: &str) -> Result<()> {
    let mut current = root.to_path_buf();
    for part in std::iter::once("").chain(relative.split('/')) {
        if !part.is_empty() {
            current.push(part);
        }
        match fs::symlink_metadata(&current) {
            Ok(info) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    info.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if info.file_type().is_symlink() || reparse {
                    return Err("配置目录包含符号链接，已阻止备份或恢复".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法访问配置目录".into()),
        }
    }
    Ok(())
}

pub fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取备份文件")?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取备份文件")?;
    if bytes.len() > limit {
        return Err("备份文件超过上限".into());
    }
    Ok(bytes)
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("配置目录无效")?).map_err(|_| "无法创建配置目录")?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "无法写入备份文件")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法写入备份文件".into())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_file_name(format!(".murge-backup-{}.tmp", uuid::Uuid::new_v4()));
    let result = write(&temp, bytes)
        .and_then(|_| fs::rename(&temp, path).map_err(|_| "无法保存备份文件".into()));
    let _ = fs::remove_file(temp);
    result
}

fn entries(root: &Path, relative: &str) -> Result<Vec<fs::DirEntry>> {
    safe(root, relative)?;
    match fs::read_dir(root.join(relative)) {
        Ok(dir) => dir
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|_| "无法读取配置目录".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(_) => Err("无法读取配置目录".into()),
    }
}

fn add(root: &Path, path: &str, files: &mut BTreeSet<String>) -> Result<()> {
    safe(root, path)?;
    if root.join(path).is_file() {
        files.insert(path.into());
    }
    if files.len() > MAX_FILES {
        return Err("配置文件数量超过备份上限".into());
    }
    Ok(())
}

pub fn list(root: &Path, sources: bool) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    for path in archive::ROOT_FILES {
        add(root, path, &mut files)?;
    }
    for entry in entries(root, "profiles")? {
        let path = format!("profiles/{}", entry.file_name().to_string_lossy());
        if archive::is_backup_path(&path) {
            add(root, &path, &mut files)?;
        }
    }
    add(root, "substore/root.json", &mut files)?;
    add(root, "substore/sub-store.json", &mut files)?;
    fn walk(root: &Path, dir: &str, depth: usize, files: &mut BTreeSet<String>) -> Result<()> {
        if depth >= 6 {
            return Ok(());
        }
        for entry in entries(root, dir)? {
            let path = format!("{dir}/{}", entry.file_name().to_string_lossy());
            if !archive::is_backup_path(&path) {
                continue;
            }
            safe(root, &path)?;
            if entry.file_type().map_err(|_| "无法读取配置目录")?.is_dir() {
                walk(root, &path, depth + 1, files)?;
            } else {
                add(root, &path, files)?;
            }
        }
        Ok(())
    }
    walk(root, "substore/data", 0, &mut files)?;
    if sources {
        let mut count = 0;
        for entry in entries(root, "profiles/.sources")? {
            let path = format!("profiles/.sources/{}", entry.file_name().to_string_lossy());
            if archive::is_restore_path(&path) {
                safe(root, &path)?;
                if entry.file_type().map_err(|_| "无法读取配置目录")?.is_file() {
                    files.insert(path);
                    count += 1;
                }
            }
        }
        if count > MAX_FILES {
            return Err("订阅来源数量超过上限".into());
        }
    }
    Ok(files)
}

pub fn collect(root: &Path, version: &str, codec: &dyn SecretCodec) -> Result<Payload> {
    let mut files = BTreeMap::new();
    let mut source_urls = BTreeMap::new();
    let mut total = 0;
    for path in list(root, true)? {
        let content = read(&root.join(&path), MAX_FILE)?;
        if let Some(id) = path
            .strip_prefix("profiles/.sources/")
            .and_then(|p| p.strip_suffix(".source.enc"))
        {
            source_urls.insert(id.into(), codec.decrypt(&content)?);
        } else {
            total += content.len();
            if total > MAX_CONTENT {
                return Err("备份内容超过上限".into());
            }
            files.insert(path, STANDARD.encode(content));
        }
    }
    let payload = Payload {
        app_id: crate::brand::load_brand()?.app_id,
        app_version: version.into(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        files,
        source_urls,
    };
    archive::validate(&payload)?;
    Ok(payload)
}

pub fn impact(
    root: &Path,
    payload: &Payload,
    keyring_paths: &[String],
) -> Result<serde_json::Value> {
    let mut current = list(root, true)?;
    current.extend(keyring_paths.iter().cloned());
    let incoming: BTreeSet<_> = payload
        .files
        .keys()
        .cloned()
        .chain(
            payload
                .source_urls
                .keys()
                .map(|id| format!("profiles/.sources/{id}.source.enc")),
        )
        .collect();
    Ok(
        json!({"replaceCount":incoming.intersection(&current).count(),"addCount":incoming.difference(&current).count(),"removeCount":current.difference(&incoming).count()}),
    )
}

const PENDING: &str = ".config-restore-pending";
#[derive(Serialize, Deserialize)]
struct Manifest {
    state: String,
    files: Vec<String>,
}

pub fn stage(root: &Path, payload: &Payload, version: &str, codec: &dyn SecretCodec) -> Result<()> {
    archive::validate(payload)?;
    if !archive::compatibility(&payload.app_version, version).0 {
        return Err("备份版本与当前应用不兼容".into());
    }
    safe(root, PENDING)?;
    if root.join(PENDING).exists() {
        return Err("已有待恢复备份，请先重启应用".into());
    }
    let mut files: BTreeMap<_, _> = payload
        .files
        .iter()
        .map(|(p, c)| Ok((p.clone(), archive::decode(c)?)))
        .collect::<Result<_>>()?;
    for (id, url) in &payload.source_urls {
        files.insert(
            format!("profiles/.sources/{id}.source.enc"),
            codec.encrypt(url)?,
        );
    }
    for path in files.keys() {
        safe(root, path)?;
    }
    let stage = root.join(format!(".config-restore-stage-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::create_dir(&stage).map_err(|_| "无法创建恢复目录")?;
        for (path, content) in &files {
            write(&stage.join("files").join(path), content)?;
        }
        write(
            &stage.join("manifest.json"),
            &serde_json::to_vec(&Manifest {
                state: "prepared".into(),
                files: files.into_keys().collect(),
            })
            .map_err(|_| "待恢复文件清单无效")?,
        )?;
        fs::rename(&stage, root.join(PENDING)).map_err(|_| "无法保存恢复目录".into())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

fn validate_paths(paths: &[String]) -> Result<()> {
    if paths.len() > MAX_FILES * 2 || paths.iter().any(|p| !archive::is_restore_path(p)) {
        return Err("待恢复文件清单无效".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn apply(root: &Path) -> Result<&'static str> {
    apply_with_sources(root, &|_| Ok(()))
}

pub fn apply_with_sources(
    root: &Path,
    sync: &dyn Fn(&BTreeSet<String>) -> Result<()>,
) -> Result<&'static str> {
    safe(root, PENDING)?;
    let pending = root.join(PENDING);
    if !pending.exists() {
        return Ok("none");
    }
    safe(&pending, "manifest.json")?;
    let mut manifest: Manifest =
        serde_json::from_slice(&read(&pending.join("manifest.json"), MAX_ARCHIVE)?)
            .map_err(|_| "待恢复文件清单无效")?;
    validate_paths(&manifest.files)?;
    for path in &manifest.files {
        safe(root, path)?;
        safe(&pending, &format!("files/{path}"))?;
    }
    fn rollback(
        root: &Path,
        pending: &Path,
        manifest: &Manifest,
        sync: &dyn Fn(&BTreeSet<String>) -> Result<()>,
    ) -> Result<()> {
        safe(pending, "rollback-index.json")?;
        let previous: Vec<String> =
            serde_json::from_slice(&read(&pending.join("rollback-index.json"), MAX_ARCHIVE)?)
                .map_err(|_| "回滚清单无效")?;
        validate_paths(&previous)?;
        for path in previous
            .iter()
            .chain(&manifest.files)
            .collect::<BTreeSet<_>>()
        {
            safe(root, path)?;
            if previous.contains(path) {
                safe(pending, &format!("rollback/{path}"))?;
                atomic_write(
                    &root.join(path),
                    &read(&pending.join("rollback").join(path), MAX_FILE)?,
                )?;
            } else if root.join(path).exists() {
                fs::remove_file(root.join(path)).map_err(|_| "无法恢复原配置")?;
            }
        }
        sync(
            &previous
                .into_iter()
                .chain(manifest.files.iter().cloned())
                .collect(),
        )?;
        Ok(())
    }
    if manifest.state == "applying" {
        rollback(root, &pending, &manifest, sync)?;
        fs::remove_dir_all(pending).map_err(|_| "无法清理恢复目录")?;
        return Ok("rolled-back");
    }
    if manifest.state == "done" {
        fs::remove_dir_all(pending).map_err(|_| "无法清理恢复目录")?;
        return Ok("restored");
    }
    if manifest.state != "prepared" {
        return Err("待恢复状态无效".into());
    }
    let current = list(root, true)?;
    for path in &current {
        safe(&pending, &format!("rollback/{path}"))?;
        atomic_write(
            &pending.join("rollback").join(path),
            &read(&root.join(path), MAX_FILE)?,
        )?;
    }
    atomic_write(
        &pending.join("rollback-index.json"),
        &serde_json::to_vec(&current).map_err(|_| "回滚清单无效")?,
    )?;
    manifest.state = "applying".into();
    atomic_write(
        &pending.join("manifest.json"),
        &serde_json::to_vec(&manifest).map_err(|_| "待恢复文件清单无效")?,
    )?;
    let result = (|| -> Result<()> {
        for path in &current {
            if !manifest.files.contains(path) {
                safe(root, path)?;
                fs::remove_file(root.join(path)).map_err(|_| "无法移除旧配置")?;
            }
        }
        for path in &manifest.files {
            safe(root, path)?;
            safe(&pending, &format!("files/{path}"))?;
            atomic_write(
                &root.join(path),
                &read(&pending.join("files").join(path), MAX_FILE)?,
            )?;
        }
        sync(
            &current
                .iter()
                .cloned()
                .chain(manifest.files.iter().cloned())
                .collect(),
        )?;
        Ok(())
    })();
    if result.is_err() {
        rollback(root, &pending, &manifest, sync)?;
        fs::remove_dir_all(pending).map_err(|_| "无法清理恢复目录")?;
        return Ok("rolled-back");
    }
    manifest.state = "done".into();
    atomic_write(
        &pending.join("manifest.json"),
        &serde_json::to_vec(&manifest).map_err(|_| "待恢复文件清单无效")?,
    )?;
    fs::remove_dir_all(pending).map_err(|_| "无法清理恢复目录")?;
    Ok("restored")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Codec;
    impl SecretCodec for Codec {
        fn encrypt(&self, s: &str) -> Result<Vec<u8>> {
            Ok(format!("encrypted:{s}").into_bytes())
        }
        fn decrypt(&self, b: &[u8]) -> Result<String> {
            String::from_utf8_lossy(b)
                .strip_prefix("encrypted:")
                .map(str::to_owned)
                .ok_or("ciphertext invalid".into())
        }
    }
    #[test]
    fn restore_substore_roots_sources_and_remove_obsolete_without_touching_cache() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        for path in [
            "substore/root.json",
            "substore/sub-store.json",
            "substore/data/root.json",
            "profiles/id.yaml",
            "profiles/id.meta.json",
        ] {
            write(&source.path().join(path), b"{}").unwrap();
        }
        write(
            &source.path().join("profiles/.sources/id.source.enc"),
            &Codec.encrypt("https://example.com/?token=private").unwrap(),
        )
        .unwrap();
        write(&source.path().join("logs/app.log"), b"excluded").unwrap();
        write(&target.path().join("profiles/obsolete.yaml"), b"obsolete").unwrap();
        write(&target.path().join("substore/assets/cache"), b"cache").unwrap();
        let payload = collect(source.path(), "0.9.20", &Codec).unwrap();
        assert!(!payload.files.contains_key("logs/app.log"));
        assert_eq!(
            impact(target.path(), &payload, &[]).unwrap()["removeCount"],
            1
        );
        stage(target.path(), &payload, "0.9.30", &Codec).unwrap();
        assert_eq!(apply(target.path()).unwrap(), "restored");
        assert_eq!(apply(target.path()).unwrap(), "none");
        assert!(!target.path().join("profiles/obsolete.yaml").exists());
        assert!(target.path().join("substore/assets/cache").exists());
        assert!(target.path().join("substore/root.json").exists());
        assert!(target.path().join("substore/sub-store.json").exists());
        assert!(Codec
            .decrypt(
                &read(
                    &target.path().join("profiles/.sources/id.source.enc"),
                    MAX_FILE
                )
                .unwrap()
            )
            .unwrap()
            .contains("private"));
    }
    #[test]
    fn failed_apply_rolls_back_and_pending_blocks_second_restore() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write(&source.path().join("app-settings.json"), b"new").unwrap();
        write(&target.path().join("app-settings.json"), b"old").unwrap();
        let payload = collect(source.path(), "0.9.20", &Codec).unwrap();
        stage(target.path(), &payload, "0.9.30", &Codec).unwrap();
        assert!(stage(target.path(), &payload, "0.9.30", &Codec).is_err());
        fs::remove_file(target.path().join(PENDING).join("files/app-settings.json")).unwrap();
        assert_eq!(apply(target.path()).unwrap(), "rolled-back");
        assert_eq!(
            read(&target.path().join("app-settings.json"), 100).unwrap(),
            b"old"
        );
    }

    #[test]
    fn interrupted_apply_restores_previous_files_and_secret_store() {
        let root = tempfile::tempdir().unwrap();
        let pending = root.path().join(PENDING);
        write(&root.path().join("app-settings.json"), b"new").unwrap();
        write(&pending.join("files/app-settings.json"), b"new").unwrap();
        write(&pending.join("rollback/app-settings.json"), b"old").unwrap();
        write(
            &pending.join("rollback-index.json"),
            br#"["app-settings.json"]"#,
        )
        .unwrap();
        write(&pending.join("manifest.json"),br#"{"state":"applying","files":["app-settings.json","profiles/.sources/new.source.enc"]}"#).unwrap();
        let called = std::cell::Cell::new(false);
        assert_eq!(
            apply_with_sources(root.path(), &|paths| {
                assert!(paths.contains("profiles/.sources/new.source.enc"));
                assert_eq!(
                    read(&root.path().join("app-settings.json"), 100).unwrap(),
                    b"old"
                );
                called.set(true);
                Ok(())
            })
            .unwrap(),
            "rolled-back"
        );
        assert!(called.get());
    }

    #[test]
    fn rejects_tampered_manifest_paths_before_any_write() {
        for path in [
            "../outside",
            "/absolute",
            "profiles/.sources/../../escape",
            "logs/app.log",
        ] {
            let root = tempfile::tempdir().unwrap();
            write(&root.path().join("app-settings.json"), b"old").unwrap();
            write(
                &root.path().join(PENDING).join("manifest.json"),
                json!({"state":"prepared","files":[path]})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            assert!(apply(root.path()).is_err());
            assert_eq!(
                read(&root.path().join("app-settings.json"), 100).unwrap(),
                b"old"
            );
        }
    }

    #[test]
    fn secret_store_failure_rolls_back_before_marking_restore_done() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write(&source.path().join("app-settings.json"), b"new").unwrap();
        write(&root.path().join("app-settings.json"), b"old").unwrap();
        stage(
            root.path(),
            &collect(source.path(), "0.9.20", &Codec).unwrap(),
            "0.9.30",
            &Codec,
        )
        .unwrap();
        let calls = std::cell::Cell::new(0);
        let result = apply_with_sources(root.path(), &|_| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Err("credential store unavailable".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(result, "rolled-back");
        assert_eq!(calls.get(), 2);
        assert_eq!(
            read(&root.path().join("app-settings.json"), 100).unwrap(),
            b"old"
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_for_collect_stage_and_pending_manifest() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("substore")).unwrap();
        assert!(collect(root.path(), "0.9.30", &Codec).is_err());
        fs::remove_file(root.path().join("substore")).unwrap();
        symlink(outside.path(), root.path().join(PENDING)).unwrap();
        assert!(apply(root.path()).is_err());
    }
}
