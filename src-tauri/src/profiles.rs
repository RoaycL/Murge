//! Profile storage — byte-compatible port of
//! `src/main/profiles/profile-repository.ts` + `profile-source-store.ts`
//! (Phase 3A "profiles + source metadata" slice).
//!
//! Contract preserved exactly:
//! - Layout: `<rootDir>/<id>.yaml` (verbatim document) + `<id>.meta.json`
//!   (compact JSON) + `active.json` (active id or empty). Reads/writes are
//!   restricted to the root; an imported document can never escape it.
//! - Every write is atomic (temp `.tmp-<ms>-<uuid>` + fsync + rename) with
//!   0o600 permissions: a profile YAML can embed proxy credentials, so it must
//!   never be group/other-readable, and a crash mid-write can never leave a
//!   torn file that would silently deactivate the kernel's profile.
//! - Commit order on import: document, then meta, then (optionally) the
//!   activation pointer — a partially-imported profile is never listed.
//! - Names are unique case-insensitively; ids are restricted to
//!   `[A-Za-z0-9_-]+` (path-traversal safe); meta files that fail to parse are
//!   skipped by `list` instead of failing the whole list; deleting the active
//!   profile clears the pointer.
//! - Documents are NEVER re-serialized wholesale: supported edits are surgical
//!   scalar replacements that preserve unknown keys, their order and comments.
//! - Meta JSON is compact (`JSON.stringify` parity) with insertion-order keys
//!   (serde_json `preserve_order`), unknown meta fields survive rewrites.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::error::IpcError;
use crate::redact::redact_credentials;

pub const DOC_EXTENSION: &str = ".yaml";
pub const META_EXTENSION: &str = ".meta.json";
pub const ACTIVE_FILE: &str = "active.json";

pub type ProfileResult<T> = Result<T, IpcError>;

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reject identifiers that could break out of the profile directory through
/// path traversal or separator tricks.
pub fn sanitize_id(id: &str) -> ProfileResult<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(IpcError::invalid_argument(
            "profile id contains invalid characters",
        ));
    }
    Ok(())
}

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The profile directory repository. Sync by design: callers serialize access
/// through the service mutex (the TS version used a promise queue).
pub struct ProfileRepository {
    root_dir: PathBuf,
    id_generator: Box<dyn Fn() -> String + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl ProfileRepository {
    pub fn new(root_dir: PathBuf) -> Self {
        ProfileRepository {
            root_dir,
            id_generator: Box::new(|| uuid::Uuid::new_v4().to_string()),
            now: Box::new(epoch_millis),
        }
    }

    /// Test constructor with an injectable clock and id generator.
    #[allow(dead_code)]
    pub fn with_injections(
        root_dir: PathBuf,
        id_generator: Box<dyn Fn() -> String + Send + Sync>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        ProfileRepository { root_dir, id_generator, now }
    }

    /// Lexical path resolution mirroring TS `resolve()`: normalize `.`/`..`
    /// without following symlinks or requiring existence.
    fn lexical_resolve(&self, target: &Path) -> PathBuf {
        let combined = if target.is_absolute() {
            target.to_path_buf()
        } else {
            self.root_dir.join(target)
        };
        let mut out = PathBuf::new();
        for component in combined.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    }

    fn assert_inside_root(&self, target: &Path) -> ProfileResult<()> {
        let root = self.lexical_resolve(Path::new(""));
        let resolved = self.lexical_resolve(target);
        if resolved != root && !resolved.starts_with(&root) {
            return Err(IpcError::invalid_argument(
                "path escapes the profile directory",
            ));
        }
        Ok(())
    }

    pub(crate) fn doc_path(&self, id: &str) -> ProfileResult<PathBuf> {
        sanitize_id(id)?;
        let path = self.root_dir.join(format!("{id}{DOC_EXTENSION}"));
        self.assert_inside_root(&path)?;
        Ok(path)
    }

    pub(crate) fn meta_path(&self, id: &str) -> ProfileResult<PathBuf> {
        sanitize_id(id)?;
        let path = self.root_dir.join(format!("{id}{META_EXTENSION}"));
        self.assert_inside_root(&path)?;
        Ok(path)
    }

    fn active_path(&self) -> PathBuf {
        self.root_dir.join(ACTIVE_FILE)
    }

    fn read_active(&self) -> Option<String> {
        let raw = fs::read_to_string(self.active_path()).ok()?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// Atomic 0o600 write with fsync: crash leaves either the old or the new
    /// content, never a torn file. A failed write removes its temp file.
    fn write_bytes(&self, path: &Path, content: &str) -> ProfileResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| IpcError::internal(format!("unable to create profile directory: {error}")))?;
        }
        let temp = self
            .root_dir
            .join(format!(".tmp-{}-{}", epoch_millis(), uuid::Uuid::new_v4()));
        self.assert_inside_root(&temp)?;
        let open = || -> std::io::Result<File> {
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&temp)
        };
        let result = open().and_then(|mut handle| {
            handle.write_all(content.as_bytes())?;
            handle.flush()?;
            handle.sync_all()
        });
        match result {
            Ok(()) => {
                fs::rename(&temp, path).map_err(|error| {
                    let _ = fs::remove_file(&temp);
                    IpcError::internal(format!("unable to finalize profile write: {error}"))
                })
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                Err(IpcError::internal(format!("unable to write profile: {error}")))
            }
        }
    }

    fn write_active(&self, id: Option<&str>) -> ProfileResult<()> {
        self.write_bytes(&self.active_path(), id.unwrap_or(""))
    }

    /// Generate a fresh identifier not already present on disk.
    fn create_id(&self) -> String {
        loop {
            let id = (self.id_generator)();
            if !self.meta_path(&id).map(|p| p.exists()).unwrap_or(true) {
                return id;
            }
        }
    }

    fn read_meta(&self, id: &str) -> ProfileResult<Value> {
        let path = self.meta_path(id)?;
        let raw = fs::read_to_string(&path)
            .map_err(|_| IpcError::not_found(format!("profile {id} not found")))?;
        serde_json::from_str(&raw)
            .map_err(|_| IpcError::not_found(format!("profile {id} not found")))
    }

    /// All metas sorted by creation time, with the active flag from the
    /// pointer. Torn/unreadable meta files are skipped, not fatal.
    pub fn list(&self) -> ProfileResult<Vec<Value>> {
        fs::create_dir_all(&self.root_dir)
            .map_err(|error| IpcError::internal(format!("unable to create profile directory: {error}")))?;
        let active_id = self.read_active();
        let entries = fs::read_dir(&self.root_dir)
            .map_err(|error| IpcError::internal(format!("unable to read profile directory: {error}")))?;
        let mut metas: Vec<Value> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(META_EXTENSION) {
                continue;
            }
            let id = &name[..name.len() - META_EXTENSION.len()];
            let Ok(raw) = fs::read_to_string(self.meta_path(id).unwrap_or_default()) else {
                continue;
            };
            let Ok(mut meta) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(object) = meta.as_object_mut() {
                object.insert("active".into(), Value::Bool(active_id.as_deref() == Some(id)));
                metas.push(meta);
            }
        }
        metas.sort_by_key(|meta| meta["createdAt"].as_u64().unwrap_or(0));
        Ok(metas)
    }

    /// Metadata plus the verbatim document.
    pub fn get(&self, id: &str) -> ProfileResult<Value> {
        let meta = self.read_meta(id)?;
        let doc_path = self.doc_path(id)?;
        let document = fs::read_to_string(&doc_path).map_err(|error| {
            IpcError::internal(format!("unable to read profile document: {error}"))
        })?;
        let mut meta = meta;
        if let Some(object) = meta.as_object_mut() {
            object.insert(
                "active".into(),
                Value::Bool(self.read_active().as_deref() == Some(id)),
            );
        }
        Ok(json!({ "meta": meta, "document": document }))
    }

    /// The currently active profile, or null when none is active. A pointer to
    /// a deleted profile reads as null (NOT_FOUND is swallowed).
    pub fn get_active(&self) -> ProfileResult<Option<Value>> {
        let Some(active_id) = self.read_active() else {
            return Ok(None);
        };
        match self.get(&active_id) {
            Ok(profile) => Ok(Some(profile)),
            Err(error) if error.0.contains("NOT_FOUND") => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn ensure_unique_name(&self, name: &str, exclude_id: Option<&str>) -> ProfileResult<()> {
        let normalized = normalize_name(name);
        for meta in self.list()? {
            let id = meta["id"].as_str().unwrap_or_default();
            let existing = meta["name"].as_str().unwrap_or_default();
            if exclude_id != Some(id) && normalize_name(existing) == normalized {
                return Err(IpcError::invalid_argument(format!(
                    "a profile named \"{name}\" already exists"
                )));
            }
        }
        Ok(())
    }

    /// Persist a new profile: document first, then meta, then the activation
    /// pointer. Source URLs are credential-redacted before persisting.
    pub fn import(
        &self,
        name: &str,
        document: &str,
        source: &Value,
        activate: bool,
    ) -> ProfileResult<Value> {
        fs::create_dir_all(&self.root_dir)
            .map_err(|error| IpcError::internal(format!("unable to create profile directory: {error}")))?;
        self.ensure_unique_name(name, None)?;
        let id = self.create_id();
        let timestamp = (self.now)();

        let mut source = source.clone();
        if let Some(object) = source.as_object_mut() {
            if let Some(Value::String(url)) = object.get("url") {
                let redacted = redact_credentials(url);
                object.insert("url".into(), Value::String(redacted));
            }
        }

        let mut meta = Map::new();
        meta.insert("id".into(), Value::String(id.clone()));
        meta.insert("name".into(), Value::String(name.trim().to_string()));
        meta.insert("source".into(), source);
        meta.insert(
            "size".into(),
            Value::Number(document.as_bytes().len().into()),
        );
        meta.insert("createdAt".into(), Value::Number(timestamp.into()));
        meta.insert("updatedAt".into(), Value::Number(timestamp.into()));
        meta.insert("active".into(), Value::Bool(false));
        let mut meta = Value::Object(meta);

        self.write_bytes(&self.doc_path(&id)?, document)?;
        self.write_bytes(
            &self.meta_path(&id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        if activate {
            self.write_active(Some(&id))?;
            if let Some(object) = meta.as_object_mut() {
                object.insert("active".into(), Value::Bool(true));
            }
        }
        Ok(meta)
    }

    pub fn activate(&self, id: &str) -> ProfileResult<Value> {
        let profile = self.get(id)?;
        self.write_active(Some(id))?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("active".into(), Value::Bool(true));
        }
        Ok(meta)
    }

    /// Clear the active pointer without deleting a stored profile.
    #[allow(dead_code)]
    pub fn deactivate(&self) -> ProfileResult<()> {
        self.write_active(None)
    }

    pub fn delete(&self, id: &str) -> ProfileResult<()> {
        let active_id = self.read_active();
        let _ = fs::remove_file(self.doc_path(id)?);
        let _ = fs::remove_file(self.meta_path(id)?);
        // Deleting the active profile clears the pointer so the app never
        // references a missing profile.
        if active_id.as_deref() == Some(id) {
            self.write_active(None)?;
        }
        Ok(())
    }

    pub fn rename(&self, id: &str, name: &str) -> ProfileResult<Value> {
        self.ensure_unique_name(name, Some(id))?;
        let profile = self.get(id)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("name".into(), Value::String(name.trim().to_string()));
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(meta)
    }

    /// The document `edit_document` would write, WITHOUT persisting it — the
    /// service validates the preview before anything reaches disk.
    pub fn preview_edit(&self, id: &str, edits: &[ConfigEdit]) -> ProfileResult<String> {
        let profile = self.get(id)?;
        let document = profile["document"]
            .as_str()
            .ok_or_else(|| IpcError::internal("profile document is not a string"))?
            .to_string();
        Ok(apply_edits(&document, edits))
    }

    /// Surgical scalar edits: only listed top-level keys change; unknown keys,
    /// their order and comments survive verbatim.
    pub fn edit_document(&self, id: &str, edits: &[ConfigEdit]) -> ProfileResult<Value> {
        let profile = self.get(id)?;
        let updated_document = apply_edits(
            profile["document"].as_str().unwrap_or_default(),
            edits,
        );
        self.write_bytes(&self.doc_path(id)?, &updated_document)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
            object.insert(
                "size".into(),
                Value::Number(updated_document.as_bytes().len().into()),
            );
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(meta)
    }

    /// Atomically restore a trusted document snapshot after a failed live
    /// apply.
    #[allow(dead_code)]
    pub fn restore_document(&self, id: &str, document: &str) -> ProfileResult<()> {
        let profile = self.get(id)?;
        self.write_bytes(&self.doc_path(id)?, document)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
            object.insert("size".into(), Value::Number(document.as_bytes().len().into()));
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(())
    }

    pub fn replace_document(&self, id: &str, document: &str) -> ProfileResult<Value> {
        let profile = self.get(id)?;
        self.write_bytes(&self.doc_path(id)?, document)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
            object.insert("size".into(), Value::Number(document.as_bytes().len().into()));
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(meta)
    }

    pub fn replace_source(&self, id: &str, source: &Value) -> ProfileResult<Value> {
        let profile = self.get(id)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("source".into(), source.clone());
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(meta)
    }

    /// Replace document AND source envelope in one commit (a subscription
    /// update). Name, id and active pointer preserved; callers validate first.
    #[allow(dead_code)]
    pub fn replace_from_source(
        &self,
        id: &str,
        document: &str,
        source: &Value,
    ) -> ProfileResult<Value> {
        let profile = self.get(id)?;
        self.write_bytes(&self.doc_path(id)?, document)?;
        let mut meta = profile["meta"].clone();
        if let Some(object) = meta.as_object_mut() {
            object.insert("source".into(), source.clone());
            object.insert("updatedAt".into(), Value::Number((self.now)().into()));
            object.insert("size".into(), Value::Number(document.as_bytes().len().into()));
        }
        self.write_bytes(
            &self.meta_path(id)?,
            &serde_json::to_string(&meta).expect("meta serializes"),
        )?;
        Ok(meta)
    }
}

/// One supported scalar edit (`shared/profiles.ts` `ConfigEdit`).
#[derive(Debug, Clone)]
pub struct ConfigEdit {
    pub key: String,
    pub value: String,
}

/// Replace `<key>: <value>` scalar lines at the top level, preserving the rest.
pub fn apply_edits(document: &str, edits: &[ConfigEdit]) -> String {
    let mut output = document.to_string();
    for edit in edits {
        output = replace_scalar(&output, &edit.key, &edit.value);
    }
    output
}

fn escape_regex(value: &str) -> String {
    regex::escape(value)
}

/// Find the index where an inline YAML `#` comment begins, quote-aware.
fn find_comment_index(value_text: &str) -> Option<usize> {
    let mut in_single = false;
    let mut in_double = false;
    for (i, ch) in value_text.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double && (i == 0 || matches!(value_text.as_bytes()[i - 1], b' ' | b'\t')) => {
                return Some(i)
            }
            _ => {}
        }
    }
    None
}

fn replace_scalar(document: &str, key: &str, value: &str) -> String {
    let lines: Vec<&str> = document.split('\n').collect();
    let pattern = format!("^(\\s*)({}):(\\s*)(.*)$", escape_regex(key));
    let compiled = regex::Regex::new(&pattern).expect("edit regex compiles");
    let mut start_index: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(captures) = compiled.captures(line) {
            // Only treat it as top-level when it is not indented (column 1).
            if captures.get(1).map(|m| m.as_str()).unwrap_or("").is_empty() {
                start_index = Some(i);
                break;
            }
        }
    }
    let Some(start_index) = start_index else {
        return insert_key(document, key, value);
    };
    let captures = compiled.captures(lines[start_index]).expect("matched above");
    let value_text = captures.get(4).map(|m| m.as_str()).unwrap_or("");
    let replacement = match find_comment_index(value_text) {
        Some(comment_index) => {
            let comment = &value_text[comment_index..];
            format!("{key}: {value} {}", comment.trim_start())
        }
        None => format!("{key}: {value}"),
    };
    let mut updated: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
    updated[start_index] = replacement;
    updated.join("\n")
}

fn insert_key(document: &str, key: &str, value: &str) -> String {
    let lines: Vec<&str> = document.split('\n').collect();
    let mapping_key = regex::Regex::new(r"^[A-Za-z0-9_.-]+\s*:").expect("mapping regex compiles");
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        // Stop at the first non-comment, non-empty top-level mapping line.
        if !trimmed.is_empty() && !trimmed.starts_with('#') && mapping_key.is_match(trimmed) {
            let indent_len = line.len() - line.trim_start().len();
            let indent = &line[..indent_len];
            let mut updated: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
            updated.insert(i, format!("{indent}{key}: {value}"));
            updated.insert(i, format!("{indent}# Added by {key} setting"));
            return updated.join("\n");
        }
    }
    if document.trim().is_empty() {
        return format!("{key}: {value}\n");
    }
    format!(
        "{}\n\n# Added by {key} setting\n{key}: {value}\n",
        document.trim_end()
    )
}

/// Main-process-only storage for raw subscription URLs (the renderer-visible
/// metadata keeps only the redacted URL). The encrypted production store uses
/// the OS credential store — the Tauri equivalent of Electron safeStorage.
pub trait ProfileSourceStore: Send + Sync {
    fn get(&self, id: &str) -> ProfileResult<Option<String>>;
    fn set(&self, id: &str, url: &str) -> ProfileResult<()>;
    fn delete(&self, id: &str) -> ProfileResult<()>;
}

/// In-memory store: development/test backend (never real user data).
#[derive(Default)]
pub struct MemoryProfileSourceStore {
    values: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl ProfileSourceStore for MemoryProfileSourceStore {
    fn get(&self, id: &str) -> ProfileResult<Option<String>> {
        Ok(self.values.lock().expect("source store mutex").get(id).cloned())
    }

    fn set(&self, id: &str, url: &str) -> ProfileResult<()> {
        self.values
            .lock()
            .expect("source store mutex")
            .insert(id.to_string(), url.to_string());
        Ok(())
    }

    fn delete(&self, id: &str) -> ProfileResult<()> {
        self.values.lock().expect("source store mutex").remove(id);
        Ok(())
    }
}

/// OS credential-store backend (`keyring` crate). Service name is the brand
/// appId; account is the profile id — the same isolation the Electron
/// safeStorage codec gave per-profile secrets.
pub struct KeyringProfileSourceStore {
    service: String,
}

impl KeyringProfileSourceStore {
    pub fn new(service: String) -> Self {
        KeyringProfileSourceStore { service }
    }

    fn entry(&self, id: &str) -> ProfileResult<keyring::Entry> {
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(IpcError::invalid_argument("invalid profile id"));
        }
        keyring::Entry::new(&self.service, id)
            .map_err(|error| IpcError::internal(format!("credential store unavailable: {error}")))
    }
}

impl ProfileSourceStore for KeyringProfileSourceStore {
    fn get(&self, id: &str) -> ProfileResult<Option<String>> {
        match self.entry(id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)) => {
                Err(IpcError::internal("无法解密订阅地址"))
            }
            Err(error) => Err(IpcError::internal(format!("credential store error: {error}"))),
        }
    }

    fn set(&self, id: &str, url: &str) -> ProfileResult<()> {
        // keyring v3 set_password is an upsert on every supported backend.
        let entry = self.entry(id)?;
        entry.set_password(url).map_err(|error| match error {
            keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
                IpcError::unsupported("系统安全存储不可用，无法安全保存订阅地址")
            }
            other => IpcError::internal(format!("credential store error: {other}")),
        })
    }

    fn delete(&self, id: &str) -> ProfileResult<()> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(IpcError::internal(format!("credential store error: {error}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn repo_in(temp: &TempDir) -> ProfileRepository {
        ProfileRepository::new(temp.path().to_path_buf())
    }

    fn url_source(url: Option<&str>) -> Value {
        match url {
            Some(url) => json!({ "type": "url", "url": url }),
            None => json!({ "type": "manual" }),
        }
    }

    #[test]
    fn import_then_list_then_get_round_trips() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let meta = repo
            .import("Home", "port: 7890\n", &url_source(None), false)
            .unwrap();
        assert_eq!(meta["name"], "Home");
        assert_eq!(meta["active"], false);
        assert_eq!(meta["size"], 11);
        let list = repo.list().unwrap();
        assert_eq!(list.len(), 1);
        let profile = repo.get(meta["id"].as_str().unwrap()).unwrap();
        assert_eq!(profile["document"], "port: 7890\n");
    }

    #[test]
    fn import_meta_is_compact_json_with_insertion_order() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let meta = repo.import("A", "mode: rule\n", &url_source(None), false).unwrap();
        let raw = fs::read_to_string(
            temp.path().join(format!(
                "{}{META_EXTENSION}",
                meta["id"].as_str().unwrap()
            )),
        )
        .unwrap();
        assert_eq!(raw, serde_json::to_string(&meta).unwrap());
        assert!(raw.starts_with("{\"id\":"));
    }

    #[test]
    fn names_are_unique_case_insensitively() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        repo.import("Home", "mode: rule\n", &url_source(None), false).unwrap();
        let error = repo.import(" home ", "doc2", &url_source(None), false).unwrap_err();
        assert!(error.0.contains("INVALID_ARGUMENT"), "{}", error.0);
        assert!(error.0.contains("a profile named \" home \" already exists"));
    }

    #[test]
    fn activate_sets_pointer_and_list_reflects_it() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let a = repo.import("A", "mode: rule\n", &url_source(None), false).unwrap();
        let b = repo.import("B", "doc", &url_source(None), false).unwrap();
        repo.activate(b["id"].as_str().unwrap()).unwrap();
        let list = repo.list().unwrap();
        let active: Vec<&Value> = list.iter().filter(|m| m["active"] == true).collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["id"], b["id"]);
        let _ = a;
    }

    #[test]
    fn get_active_returns_null_for_missing_pointer() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        assert_eq!(repo.get_active().unwrap(), None);
    }

    #[test]
    fn get_active_returns_null_when_pointer_is_stale() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let a = repo.import("A", "mode: rule\n", &url_source(None), false).unwrap();
        repo.activate(a["id"].as_str().unwrap()).unwrap();
        // Simulate a pointer to a profile deleted out-of-band.
        fs::remove_file(
            temp.path().join(format!("{}{META_EXTENSION}", a["id"].as_str().unwrap())),
        )
        .unwrap();
        fs::remove_file(temp.path().join(format!("{}{DOC_EXTENSION}", a["id"].as_str().unwrap()))).unwrap();
        assert_eq!(repo.get_active().unwrap(), None);
    }

    #[test]
    fn delete_clears_active_pointer() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let a = repo.import("A", "mode: rule\n", &url_source(None), false).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        repo.activate(&id).unwrap();
        repo.delete(&id).unwrap();
        assert_eq!(repo.get_active().unwrap(), None);
        assert!(repo.list().unwrap().is_empty());
    }

    #[test]
    fn edit_preserves_comments_unknown_keys_and_updates_size() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let doc = "port: 7890 # keep me\nmode: rule\nsecret: abc\n";
        let a = repo.import("A", doc, &url_source(None), false).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        let meta = repo
            .edit_document(&id, &[ConfigEdit { key: "mode".into(), value: "global".into() }])
            .unwrap();
        let profile = repo.get(&id).unwrap();
        assert_eq!(
            profile["document"],
            "port: 7890 # keep me\nmode: global\nsecret: abc\n"
        );
        assert_eq!(meta["size"], profile["document"].as_str().unwrap().len());
    }

    #[test]
    fn edit_inserts_missing_top_level_key_with_marker_comment() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let doc = "proxies: []\n";
        let a = repo.import("A", doc, &url_source(None), false).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        repo.edit_document(&id, &[ConfigEdit { key: "ipv6".into(), value: "false".into() }])
            .unwrap();
        let profile = repo.get(&id).unwrap();
        assert_eq!(
            profile["document"],
            "# Added by ipv6 setting\nipv6: false\nproxies: []\n"
        );
    }

    #[test]
    fn edit_on_empty_document_appends() {
        assert_eq!(apply_edits("", &[ConfigEdit { key: "mode".into(), value: "rule".into() }]), "mode: rule\n");
    }

    #[test]
    fn ids_are_sanitized_against_traversal() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        assert!(repo.get("../escape").is_err());
        assert!(repo.get("a/b").is_err());
        assert!(repo.get("").is_err());
    }

    #[test]
    fn import_redacts_source_url_credentials() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let meta = repo
            .import(
                "Sub",
                "doc",
                &url_source(Some("https://user:secret@example.com/token123?token=abc")),
                false,
            )
            .unwrap();
        let url = meta["source"]["url"].as_str().unwrap();
        assert!(!url.contains("secret"), "{url}");
        assert!(!url.contains("user:"), "{url}");
        assert!(url.contains("token=***REDACTED***"), "{url}");
        assert!(url.contains("token123"), "{url}");
        // Long hex path segments are redacted like the TS fetcher does.
        let meta2 = repo
            .import(
                "Sub2",
                "doc",
                &url_source(Some("https://user:secret@example.com/a0123456789abcdef01234567")),
                false,
            )
            .unwrap();
        let url2 = meta2["source"]["url"].as_str().unwrap();
        assert!(url2.contains("[UUID_REDACTED]"), "{url2}");
        assert!(!url2.contains("secret"), "{url2}");
    }

    #[test]
    fn memory_source_store_round_trips() {
        let store = MemoryProfileSourceStore::default();
        assert_eq!(store.get("x").unwrap(), None);
        store.set("x", "https://example.com/sub").unwrap();
        assert_eq!(store.get("x").unwrap().as_deref(), Some("https://example.com/sub"));
        store.delete("x").unwrap();
        assert_eq!(store.get("x").unwrap(), None);
    }

    #[test]
    fn replace_from_source_preserves_name_and_pointer() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let a = repo.import("Keep", "mode: rule\n", &url_source(Some("https://e.com/s")), true).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        let meta = repo
            .replace_from_source(&id, "mode: global\n", &json!({ "type": "url", "url": "https://e.com/s2" }))
            .unwrap();
        assert_eq!(meta["name"], "Keep");
        assert_eq!(meta["source"]["url"], "https://e.com/s2");
        assert_eq!(meta["active"], true);
        assert_eq!(repo.get(&id).unwrap()["document"], "mode: global\n");
    }

    #[test]
    fn torn_meta_files_are_skipped_by_list() {
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        repo.import("Good", "mode: rule\n", &url_source(None), false).unwrap();
        fs::write(temp.path().join("bad.meta.json"), "{ torn").unwrap();
        let list = repo.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "Good");
    }

    #[test]
    fn meta_files_use_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let repo = repo_in(&temp);
        let a = repo.import("A", "mode: rule\n", &url_source(None), false).unwrap();
        let doc = temp.path().join(format!("{}{DOC_EXTENSION}", a["id"].as_str().unwrap()));
        let mode = fs::metadata(doc).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
