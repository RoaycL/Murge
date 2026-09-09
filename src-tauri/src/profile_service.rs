//! Profile service — Rust port of `src/main/profiles/profile-service.ts`
//! (Phase 3A "profiles + source metadata" slice).
//!
//! The validator is the only gate for activation and document edits: a profile
//! is never marked active and a rejected edit never leaves a half-edited
//! document on disk (validate the WOULD-BE state before writing). The raw
//! subscription URL lives ONLY in the source store (OS credential store in
//! production, memory in dev); renderer-visible metadata keeps the redacted
//! URL.
//!
//! Staging notes (fail-closed channels, never silent):
//! - `import-from-url` / `update-from-source` need the subscription fetcher —
//!   the Phase 3C network slice. They error with UNSUPPORTED until then.
//! - `get-provider-content` reads provider caches through the privileged Go
//!   service — the Phase 3D slice.
//! - `inspect-active-config` composes the EFFECTIVE document (overrides +
//!   core/geodata/TUN runtime composition) — lands with those slices.
//! - Group order and provider catalog parse the active document directly; the
//!   enhanced-document composition arrives with the overrides slice. With all
//!   overrides disabled the enhanced document IS the raw document, so the
//!   staging point is behavior-identical until composition lands.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::error::IpcError;
use crate::profiles::{
    ConfigEdit, MemoryProfileSourceStore, ProfileRepository, ProfileResult, ProfileSourceStore,
};
use crate::redact::{is_redacted_url, redact_credentials};
use crate::subscription::SubscriptionFetcher;
use crate::validate::{throw_if_invalid, validate_document};

pub struct ProfilesService {
    pub(crate) repository: ProfileRepository,
    source_store: Box<dyn ProfileSourceStore + Send + Sync>,
    /// Subscription transport (Phase 3C); the system-proxy-aware client is
    /// wired by the 3D system-proxy slice, until then fetches go direct only.
    fetcher: SubscriptionFetcher,
    /// Serializes mutations, mirroring the TS gateway's `runExclusive`.
    lock: Mutex<()>,
}

impl ProfilesService {
    /// Production constructor: real profile directory + OS credential store.
    pub fn for_paths(profile_root: &PathBuf, service_name: &str) -> Self {
        ProfilesService {
            repository: ProfileRepository::new(profile_root.clone()),
            source_store: Box::new(crate::profiles::KeyringProfileSourceStore::new(service_name.to_string())),
            fetcher: SubscriptionFetcher::new(None),
            lock: Mutex::new(()),
        }
    }

    /// Development/test constructor: ephemeral workspace + memory secrets.
    pub fn for_development(profile_root: &PathBuf) -> Self {
        ProfilesService {
            repository: ProfileRepository::new(profile_root.clone()),
            source_store: Box::new(MemoryProfileSourceStore::default()),
            fetcher: SubscriptionFetcher::new(None),
            lock: Mutex::new(()),
        }
    }

    /// Test builder: swap in a fetcher with an injected resolver/timeout.
    #[allow(dead_code)] // exercised by tests; production uses the default fetcher
    pub fn with_fetcher(mut self, fetcher: SubscriptionFetcher) -> Self {
        self.fetcher = fetcher;
        self
    }

    /// Test hook: replace the fetcher in place (Fixture-style composition).
    #[allow(dead_code)] // exercised by tests; production uses the default fetcher
    pub fn set_fetcher(&mut self, fetcher: SubscriptionFetcher) {
        self.fetcher = fetcher;
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().expect("profiles mutex poisoned")
    }

    pub fn list(&self) -> ProfileResult<Value> {
        let _guard = self.guard();
        Ok(json!(self.repository.list()?))
    }

    pub fn get(&self, id: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        self.repository.get(id)
    }

    /// The active profile (document + metadata) or null. The kernel config
    /// store consumes this at start time (Phase 3B wiring); staging keeps the
    /// method `#[allow(dead_code)]` until then.
    #[allow(dead_code)]
    pub fn get_active(&self) -> ProfileResult<Value> {
        let _guard = self.guard();
        Ok(self
            .repository
            .get_active()?
            .and_then(|profile| if profile.is_null() { None } else { Some(profile) })
            .unwrap_or(Value::Null))
    }

    pub fn import(&self, request: &Value) -> ProfileResult<Value> {
        let _guard = self.guard();
        let name = string_arg(request, "name").unwrap_or_default();
        let document = string_arg(request, "document")
            .ok_or_else(|| IpcError::invalid_argument("profile import requires a document"))?;
        let source = request
            .get("source")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "manual" }));
        let activate = request.get("activate").and_then(Value::as_bool).unwrap_or(false);
        // Validate BEFORE anything reaches disk (the import envelope is
        // redacted inside the repository).
        throw_if_invalid(&validate_document(&document)?)?;
        self.repository.import(&name, &document, &source, activate)
    }

    /// `importFromUrl`: fetch the subscription, derive the effective name
    /// (explicit → Content-Disposition suggestion → URL host → 远程订阅),
    /// import WITHOUT activating, secure the raw refresh URL, then activate.
    /// A secure-storage failure deletes the just-created profile and
    /// rethrows, exactly like the TS composition.
    pub async fn import_from_url(&self, name: &str, url: &str, activate: bool) -> ProfileResult<Value> {
        let fetched = crate::subscription::fetch_with_fallback(&self.fetcher, url).await?;
        let trimmed = name.trim();
        let effective_name = if !trimmed.is_empty() {
            trimmed.to_string()
        } else if let Some(suggested) = &fetched.suggested_name {
            suggested.clone()
        } else if let Some(fallback) = crate::subscription::derive_fallback_subscription_name(url) {
            fallback
        } else {
            "远程订阅".to_string()
        };
        let meta = self.import(&json!({
            "name": effective_name,
            "document": fetched.document,
            "source": fetched.source,
            // Secure the refresh URL before moving the active pointer. If
            // secure storage fails, the previously active profile remains
            // untouched.
            "activate": false,
        }))?;
        let id = meta["id"].as_str().unwrap_or_default().to_string();
        if let Err(error) = self.source_store.set(&id, url) {
            let _ = self.repository.delete(&id);
            return Err(error);
        }
        if activate {
            self.activate(&id)
        } else {
            Ok(meta)
        }
    }

    /// `updateFromSource`: re-fetch a URL-backed profile's subscription and
    /// replace its stored document with the freshly validated one. The name,
    /// id and active pointer are untouched. The fetch prefers the private raw
    /// URL held in the source store; a REDACTED display URL is refused with
    /// actionable copy instead of a confusing network error.
    pub async fn update_from_source(&self, id: &str) -> ProfileResult<Value> {
        let profile = self.repository.get(id)?;
        let source = &profile["meta"]["source"];
        if source["type"] != json!("url") || source["url"].as_str().map(str::is_empty).unwrap_or(true) {
            return Err(IpcError::invalid_argument("该配置没有远程订阅地址，无法更新"));
        }
        let display_url = source["url"].as_str().unwrap_or_default().to_string();
        let refresh_url = match self.source_store.get(id)? {
            Some(url) => Some(url),
            // A NON-redacted display URL is still safe to fetch.
            None if !is_redacted_url(&display_url) => Some(display_url.clone()),
            None => None,
        };
        let Some(refresh_url) = refresh_url else {
            return Err(IpcError::invalid_argument(
                "缺少原始订阅地址，无法更新；请删除后重新添加该订阅",
            ));
        };
        let fetched = crate::subscription::fetch_with_fallback(&self.fetcher, &refresh_url).await?;
        // Validate BEFORE writing so a failed update cannot corrupt the doc.
        throw_if_invalid(&validate_document(&fetched.document)?)?;
        // Persist/migrate the private refresh address before replacing a
        // valid existing document. A secure-storage failure must leave that
        // document intact.
        self.source_store.set(id, &refresh_url)?;
        self.repository.replace_from_source(id, &fetched.document, &fetched.source)
    }

    pub fn activate(&self, id: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        let profile = self.repository.get(id)?;
        let document = profile["document"].as_str().unwrap_or_default();
        throw_if_invalid(&validate_document(document)?)?;
        // Compensate a failed pointer write by restoring the prior active
        // profile — the app never points at a half-activated profile.
        let previous_active = self
            .repository
            .list()?
            .into_iter()
            .find(|meta| meta["active"] == Value::Bool(true))
            .and_then(|meta| meta["id"].as_str().map(str::to_string));
        match self.repository.activate(id) {
            Ok(meta) => Ok(meta),
            Err(error) => {
                if let Some(previous) = previous_active {
                    let _ = self.repository.activate(&previous);
                }
                Err(error)
            }
        }
    }

    pub fn delete(&self, id: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        self.repository.delete(id)?;
        // Auxiliary per-profile secrets follow the profile in death. Proxy
        // selection cleanup rides the selection store slice (3B).
        self.source_store.delete(id)?;
        Ok(Value::Null)
    }

    pub fn rename(&self, id: &str, name: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        self.repository.rename(id, name)
    }

    pub fn edit_document(&self, id: &str, edits: &[ConfigEdit]) -> ProfileResult<Value> {
        let _guard = self.guard();
        // Validate the would-be document so a rejected edit never persists.
        let preview = self.repository.preview_edit(id, edits)?;
        throw_if_invalid(&validate_document(&preview)?)?;
        self.repository.edit_document(id, edits)
    }

    pub fn replace_document(&self, id: &str, document: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        throw_if_invalid(&validate_document(document)?)?;
        self.repository.replace_document(id, document)
    }

    pub fn get_source_url(&self, id: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        Ok(match self.source_store.get(id)? {
            Some(url) => Value::String(url),
            None => Value::Null,
        })
    }

    pub fn set_source_url(&self, id: &str, url: &str) -> ProfileResult<Value> {
        let _guard = self.guard();
        let profile = self.repository.get(id)?;
        if profile["meta"]["source"]["type"] != Value::String("url".into()) {
            return Err(IpcError::invalid_argument("只有远程配置可以修改订阅地址"));
        }
        self.source_store.set(id, url)?;
        let mut source = profile["meta"]["source"].clone();
        if let Some(object) = source.as_object_mut() {
            object.insert("url".into(), Value::String(redact_credentials(url)));
        }
        self.repository.replace_source(id, &source)
    }

    pub fn validate(&self, document: &str) -> ProfileResult<Value> {
        let result = validate_document(document)?;
        Ok(json!({ "ok": result.ok, "issues": result.issues }))
    }

    /// Ordered `proxy-groups` names from the active profile document.
    /// (Enhanced-document composition arrives with the overrides slice; with
    /// all overrides disabled this is the same input the TS gate parses.)
    pub fn get_active_group_order(&self) -> ProfileResult<Value> {
        let _guard = self.guard();
        let document = self.active_document()?;
        Ok(json!(crate::profile_parse::parse_proxy_group_order(&document)))
    }

    /// Declared provider catalog from the active profile document.
    /// `restoreProfileDocument`: write a previous document back (the edit
    /// rollback path of the profile auto-reload gateway). The active pointer
    /// is restored separately.
    pub fn restore_document(&self, id: &str, document: &str) -> ProfileResult<()> {
        let _guard = self.guard();
        self.repository.restore_document(id, document)
    }

    /// `deactivateProfile`: clear the active pointer (rollback of a first
    /// activation).
    pub fn deactivate(&self) -> ProfileResult<()> {
        let _guard = self.guard();
        self.repository.deactivate()
    }

    pub fn get_active_provider_catalog(&self) -> ProfileResult<Value> {
        let _guard = self.guard();
        let document = self.active_document()?;
        Ok(json!(crate::profile_parse::parse_provider_catalog(&document)))
    }

    fn active_document(&self) -> ProfileResult<String> {
        Ok(self
            .repository
            .get_active()?
            .and_then(|profile| profile["document"].as_str().map(str::to_string))
            .unwrap_or_default())
    }
}

fn string_arg(request: &Value, key: &str) -> Option<String> {
    request.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service() -> (TempDir, ProfilesService) {
        let temp = TempDir::new().unwrap();
        let service = ProfilesService::for_development(&temp.path().to_path_buf());
        (temp, service)
    }

    fn import_request(name: &str, document: &str) -> Value {
        json!({ "name": name, "document": document, "source": { "type": "manual" }, "activate": false })
    }

    #[test]
    fn import_validates_before_persisting() {
        let (_temp, service) = service();
        let error = service.import(&import_request("Bad", "\t- tab\n")).unwrap_err();
        assert!(error.0.contains("INVALID_ARGUMENT"), "{}", error.0);
        assert!(error.0.contains("配置校验失败"), "{}", error.0);
        assert!(service.list().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn import_then_list_and_get() {
        let (_temp, service) = service();
        let meta = service.import(&import_request("Home", "port: 7890\n")).unwrap();
        assert_eq!(meta["name"], "Home");
        assert_eq!(service.list().unwrap().as_array().unwrap().len(), 1);
        let profile = service.get(meta["id"].as_str().unwrap()).unwrap();
        assert_eq!(profile["document"], "port: 7890\n");
    }

    #[test]
    fn activate_gates_on_validation() {
        let (_temp, service) = service();
        // Seed an INVALID meta+doc directly (bypassing import validation) to
        // prove activation refuses invalid documents.
        let meta = service.repository.import("Bad", "doc", &json!({"type":"manual"}), false).unwrap();
        let id = meta["id"].as_str().unwrap().to_string();
        // Overwrite the doc with a duplicate-key document (structurally invalid).
        std::fs::write(
            service.repository.doc_path(&id).unwrap(),
            "port: 1\nport: 2\n",
        )
        .unwrap();
        let error = service.activate(&id).unwrap_err();
        assert!(error.0.contains("重复的顶层键"), "{}", error.0);
        assert_eq!(service.get_active().unwrap(), Value::Null);
    }

    #[test]
    fn activate_then_list_marks_active() {
        let (_temp, service) = service();
        let a = service.import(&import_request("A", "port: 1\n")).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        let meta = service.activate(&id).unwrap();
        assert_eq!(meta["active"], true);
        let list = service.list().unwrap();
        assert_eq!(list.as_array().unwrap()[0]["active"], true);
        assert!(service.get_active().unwrap().is_object());
    }

    #[test]
    fn delete_removes_profile_and_secret() {
        let (_temp, service) = service();
        let a = service
            .import(&json!({ "name": "A", "document": "mode: rule\n", "source": { "type": "url", "url": "https://old.example.com" } }))
            .unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        service.set_source_url(&id, "https://example.com/sub?token=1").unwrap();
        service.delete(&id).unwrap();
        assert!(service.list().unwrap().as_array().unwrap().is_empty());
        assert_eq!(service.get_source_url(&id).unwrap(), Value::Null);
    }

    #[test]
    fn set_source_url_requires_url_type() {
        let (_temp, service) = service();
        let a = service.import(&import_request("A", "mode: rule\n")).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        let error = service.set_source_url(&id, "https://example.com").unwrap_err();
        assert!(error.0.contains("只有远程配置可以修改订阅地址"), "{}", error.0);
    }

    #[test]
    fn set_source_url_redacts_but_keeps_raw_in_store() {
        let (_temp, service) = service();
        let a = service
            .import(&import_request("S", "mode: rule\n"))
            .unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        // Promote to a url source through replace_source, then set the URL.
        service.repository
            .replace_source(&id, &json!({ "type": "url", "url": "https://old.example.com" }))
            .unwrap();
        let meta = service.set_source_url(&id, "https://user:secret@example.com/sub?token=abc").unwrap();
        assert!(!meta["source"]["url"].as_str().unwrap().contains("secret"));
        let raw = service.get_source_url(&id).unwrap();
        assert_eq!(raw, Value::String("https://user:secret@example.com/sub?token=abc".into()));
    }

    #[test]
    fn edit_document_validates_preview() {
        let (_temp, service) = service();
        let a = service.import(&import_request("A", "port: 1\nmode: rule\n")).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        // A valid scalar edit succeeds and keeps other lines.
        let meta = service
            .edit_document(&id, &[ConfigEdit { key: "mode".into(), value: "global".into() }])
            .unwrap();
        assert_eq!(meta["updatedAt"].as_u64().is_some(), true);
        let profile = service.get(&id).unwrap();
        assert_eq!(profile["document"], "port: 1\nmode: global\n");
    }

    #[test]
    fn replace_document_gates_invalid() {
        let (_temp, service) = service();
        let a = service.import(&import_request("A", "mode: rule\n")).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        let error = service.replace_document(&id, "rules: ['x'\n").unwrap_err();
        assert!(error.0.contains("存在未闭合的方括号或花括号"), "{}", error.0);
        // The stored document is untouched after a rejected replace.
        assert_eq!(service.get(&id).unwrap()["document"], "mode: rule\n");
    }

    #[test]
    fn validate_reports_issues_envelope() {
        let (_temp, service) = service();
        let result = service.validate("udp: true\nmode: rule\n").unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["issues"].as_array().unwrap().iter().any(|i| i["severity"] == "warning"));
    }

    #[test]
    fn group_order_and_catalog_read_active_document() {
        let (_temp, service) = service();
        let document = "proxy-groups:\n  - name: A\n    type: select\nproxy-providers:\n  p:\n    url: https://x\n";
        let a = service.import(&import_request("A", document)).unwrap();
        service.activate(a["id"].as_str().unwrap()).unwrap();
        assert_eq!(service.get_active_group_order().unwrap(), json!(["A"]));
        let catalog = service.get_active_provider_catalog().unwrap();
        assert_eq!(catalog["proxy"][0]["name"], "p");
    }

    #[test]
    fn group_order_is_empty_without_active_profile() {
        let (_temp, service) = service();
        assert_eq!(service.get_active_group_order().unwrap(), json!([]));
        let catalog = service.get_active_provider_catalog().unwrap();
        assert_eq!(catalog["proxy"], json!([]));
        assert_eq!(catalog["rule"], json!([]));
    }
}
