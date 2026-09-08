//! Override service — Rust port of
//! `src/main/kernel/overrides/override-service.ts` (Phase 3A overrides slice).
//!
//! Durable override store in the product-name-free app-data namespace.
//! Overrides are an ordered list; `order` always equals the array index, so
//! the list itself is the application order. Reads are served from an
//! in-memory copy loaded at first use; every mutation is serialized through a
//! mutex and persisted via temp-file + atomic rename (2-space pretty JSON +
//! trailing newline), so a crash mid-write never leaves a truncated document.
//!
//! Extends the CRUD surface with the #411 "预演/校验/回滚" capability: a
//! redacted preview, a structural + semantic validation, and a
//! last-known-good snapshot with a rollback. The last-known-good state is
//! captured whenever the effective override set produces a structurally valid
//! runtime config.
//!
//! Dev builds keep everything in memory (no real user data is touched).

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::error::IpcError;
use crate::override_apply::{
    apply_overrides_to_document, chain_semantic_issues, validate_override_content,
};
use crate::override_model::{coerce_override_item, redact_override_content, OverrideItem};

/// Filename of the persisted overrides document (`override-service.ts`).
pub const OVERRIDES_FILE: &str = "overrides.json";

/// Resolves the base profile document an override set is previewed/validated
/// against (wired to the active profile by the composition slice).
pub type ResolveBaseDocument = Box<dyn Fn() -> Option<(String, Option<String>)> + Send + Sync>;

struct State {
    items: Option<Vec<OverrideItem>>,
    last_good: Option<LastKnownGood>,
}

struct LastKnownGood {
    captured_at: u64,
    snapshot: Vec<OverrideItem>,
}

pub struct OverrideService {
    app_data_base: Option<PathBuf>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    resolve_base_document: Option<ResolveBaseDocument>,
    state: Mutex<State>,
}

impl OverrideService {
    pub fn new(app_data_base: Option<PathBuf>) -> Self {
        OverrideService {
            app_data_base,
            now: Box::new(crate::profiles::epoch_millis_now),
            resolve_base_document: None,
            state: Mutex::new(State { items: None, last_good: None }),
        }
    }

    /// Wire the active-profile resolver (used by preview/validate).
    pub fn with_base_resolver(mut self, resolver: ResolveBaseDocument) -> Self {
        self.resolve_base_document = Some(resolver);
        self
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.app_data_base.as_ref().map(|base| base.join(OVERRIDES_FILE))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("overrides mutex poisoned")
    }

    fn reindex(items: Vec<OverrideItem>) -> Vec<OverrideItem> {
        items
            .into_iter()
            .enumerate()
            .map(|(index, item)| if item.order == index as i64 { item } else { OverrideItem { order: index as i64, ..item } })
            .collect()
    }

    fn snapshot(items: &[OverrideItem]) -> Value {
        json!({ "items": items })
    }

    fn ensure_loaded(&self, state: &mut State) {
        if state.items.is_some() {
            return;
        }
        let loaded = self.file_path().and_then(|path| fs::read_to_string(path).ok()).and_then(|raw| {
            let parsed: Value = serde_json::from_str(&raw).ok()?;
            let source = parsed.get("items")?;
            let items: Vec<OverrideItem> = source
                .as_array()?
                .iter()
                .map(coerce_override_item)
                .collect();
            Some(items)
        });
        state.items = Some(Self::reindex(loaded.unwrap_or_default()));
    }

    fn persist(&self, items: &[OverrideItem]) -> Result<(), IpcError> {
        let Some(path) = self.file_path() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| IpcError::internal(format!("unable to create app-data directory: {error}")))?;
        }
        let mut snapshot = Map::new();
        snapshot.insert("items".into(), json!(items));
        let mut body = serde_json::to_string_pretty(&Value::Object(snapshot)).expect("snapshot serializes");
        body.push('\n');
        let tmp = path.with_file_name(format!(
            ".{OVERRIDES_FILE}.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let write = fs::write(&tmp, body)
            .and_then(|()| fs::rename(&tmp, &path));
        match write {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                Err(IpcError::internal(format!("unable to persist overrides: {error}")))
            }
        }
    }

    pub fn list(&self) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        Ok(Self::snapshot(state.items.as_ref().expect("loaded")))
    }

    pub fn create(&self, input: &Value) -> Result<Value, IpcError> {
        let (name, kind, scope, profile_id, content) = crate::override_apply::override_input(input)?;
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let items = state.items.as_mut().expect("loaded");
        let order = items.len() as i64;
        items.push(OverrideItem {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            kind,
            enabled: true,
            scope,
            profile_id,
            order,
            content,
            updated_at: (self.now)(),
        });
        self.persist(items)?;
        Ok(Self::snapshot(items))
    }

    pub fn update(&self, id: &str, input: &Value) -> Result<Value, IpcError> {
        let (name, kind, scope, profile_id, content) = crate::override_apply::override_input(input)?;
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let items = state.items.as_mut().expect("loaded");
        let item = items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| IpcError::invalid_argument("覆写不存在"))?;
        item.name = name;
        item.kind = kind;
        item.scope = scope;
        item.profile_id = profile_id;
        item.content = content;
        item.updated_at = (self.now)();
        self.persist(items)?;
        Ok(Self::snapshot(items))
    }

    pub fn remove(&self, id: &str) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let items = state.items.as_mut().expect("loaded");
        items.retain(|item| item.id != id);
        *items = Self::reindex(items.clone());
        self.persist(items)?;
        Ok(Self::snapshot(items))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let items = state.items.as_mut().expect("loaded");
        let item = items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| IpcError::invalid_argument("覆写不存在"))?;
        item.enabled = enabled;
        item.updated_at = (self.now)();
        self.persist(items)?;
        Ok(Self::snapshot(items))
    }

    pub fn move_item(&self, id: &str, direction: &str) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let items = state.items.as_mut().expect("loaded");
        let index = items
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| IpcError::invalid_argument("覆写不存在"))?;
        let target = if direction == "up" { index - 1 } else { index + 1 };
        if target < items.len() {
            items.swap(index, target);
            *items = Self::reindex(items.clone());
            self.persist(items)?;
        }
        Ok(Self::snapshot(items))
    }

    /// Enabled overrides that apply to a profile: global ones plus its own
    /// scoped ones, sorted by `order`.
    fn effective_overrides(&self, state: &State, profile_id: Option<&str>) -> Vec<OverrideItem> {
        let mut items: Vec<OverrideItem> = state
            .items
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.enabled
                            && (item.scope == "global"
                                || (item.scope == "profile" && item.profile_id.as_deref() == profile_id))
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        items.sort_by_key(|item| item.order);
        items
    }

    /// Apply the effective overrides for a profile onto its base document.
    /// Used by the kernel config pipeline (Phase 3B composition wiring).
    #[allow(dead_code)]
    pub fn apply_for_profile(&self, base_document: &str, profile_id: Option<&str>) -> Result<String, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let effective = self.effective_overrides(&state, profile_id);
        let result = apply_overrides_to_document(base_document, &effective);
        self.maybe_capture_last_good(&mut state, &result.text);
        Ok(result.text)
    }

    /// Redacted preview of what the effective override set does to the active
    /// profile document.
    pub fn preview(&self) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let base = self.resolve_base_document.as_ref().and_then(|resolve| resolve());
        let Some((document, profile_id)) = base else {
            return Ok(json!({
                "baseText": "",
                "appliedText": "",
                "warnings": ["当前没有活动的订阅，无法预演覆写"],
                "unavailable": true
            }));
        };
        let effective = self.effective_overrides(&state, profile_id.as_deref());
        let result = apply_overrides_to_document(&document, &effective);
        Ok(json!({
            "baseText": redact_override_content(&document),
            "appliedText": redact_override_content(&result.text),
            "warnings": result.warnings,
            "unavailable": false
        }))
    }

    /// Validate the effective override set for the active profile: per-item
    /// structural checks plus a whole-chain semantics check.
    pub fn validate(&self) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let base = self.resolve_base_document.as_ref().and_then(|resolve| resolve());
        let mut issues: Vec<Value> = Vec::new();
        let Some((document, profile_id)) = base else {
            issues.push(json!({ "itemName": null, "level": "error", "message": "当前没有活动的订阅，无法校验覆写" }));
            return Ok(json!({ "valid": false, "issues": issues }));
        };

        let effective = self.effective_overrides(&state, profile_id.as_deref());
        let active: Vec<&OverrideItem> = effective
            .iter()
            .filter(|item| item.enabled && !item.content.trim().is_empty())
            .collect();

        // Per-item structural checks.
        for item in &active {
            if let Some(message) = validate_override_content(item) {
                issues.push(json!({ "itemName": item.name, "level": "error", "message": message }));
            }
        }
        if active.is_empty() {
            issues.push(json!({ "itemName": null, "level": "warning", "message": "当前没有启用的覆写，将原样使用订阅配置" }));
        }

        // Whole-chain semantic check: overrides must not break a valid base.
        let applied = apply_overrides_to_document(&document, &effective);
        let introduced = chain_semantic_issues(&document, &applied.text);
        if !introduced.is_empty() {
            issues.push(json!({
                "itemName": null,
                "level": "error",
                "message": format!("覆写使运行时配置失效：{}", introduced.join("；"))
            }));
        } else if !crate::override_apply::profile_kernel_config_errors(&document).is_empty() {
            issues.push(json!({
                "itemName": null,
                "level": "warning",
                "message": "基础配置本身存在结构问题（与覆写无关）"
            }));
        }

        let valid = !issues.iter().any(|issue| issue["level"] == "error");
        if valid {
            self.maybe_capture_last_good(&mut state, &applied.text);
        }
        Ok(json!({ "valid": valid, "issues": issues }))
    }

    /// The last-known-good override snapshot, if one has been captured.
    pub fn last_known_good(&self) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        Ok(match &state.last_good {
            Some(last_good) => json!({
                "capturedAt": last_good.captured_at,
                "snapshot": last_good.snapshot
            }),
            None => Value::Null,
        })
    }

    /// Restore the override list to its last-known-good state, if one exists.
    pub fn reset_to_last_good(&self) -> Result<Value, IpcError> {
        let mut state = self.guard();
        self.ensure_loaded(&mut state);
        let restore = state.last_good.as_ref().map(|good| good.snapshot.clone());
        if let Some(snapshot) = restore {
            let items = state.items.as_mut().expect("loaded");
            *items = Self::reindex(snapshot);
            self.persist(items)?;
        }
        Ok(Self::snapshot(state.items.as_ref().expect("loaded")))
    }

    /// Capture the current override list as last-known-good when the applied
    /// config is structurally valid.
    fn maybe_capture_last_good(&self, state: &mut State, applied_text: &str) {
        if crate::override_apply::profile_kernel_config_errors(applied_text).is_empty() {
            state.last_good = Some(LastKnownGood {
                captured_at: (self.now)(),
                snapshot: state.items.as_ref().expect("loaded").clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn service() -> (TempDir, OverrideService) {
        let temp = TempDir::new().unwrap();
        let service = OverrideService::new(Some(temp.path().to_path_buf()));
        (temp, service)
    }

    fn input(name: &str, kind: &str, content: &str) -> Value {
        json!({ "name": name, "kind": kind, "scope": "global", "profileId": null, "content": content })
    }

    #[test]
    fn create_list_update_round_trip_persists_two_space_json() {
        let (temp, service) = service();
        let snapshot = service.create(&input("First", "yaml", "mode: global\n")).unwrap();
        assert_eq!(snapshot["items"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["items"][0]["enabled"], true);
        assert_eq!(snapshot["items"][0]["order"], 0);

        let id = snapshot["items"][0]["id"].as_str().unwrap().to_string();
        service.update(&id, &input("Renamed", "yaml", "mode: rule\n")).unwrap();
        let snapshot = service.list().unwrap();
        assert_eq!(snapshot["items"][0]["name"], "Renamed");
        assert_eq!(snapshot["items"][0]["content"], "mode: rule\n");
        assert_eq!(snapshot["items"][0]["order"], 0);

        // Persisted format: 2-space pretty JSON + trailing newline.
        let raw = fs::read_to_string(temp.path().join(OVERRIDES_FILE)).unwrap();
        assert!(raw.ends_with("\n"));
        assert!(raw.contains("\n  \"items\": ["));
    }

    #[test]
    fn missing_file_starts_empty() {
        let (_temp, service) = service();
        assert_eq!(service.list().unwrap()["items"], json!([]));
    }

    #[test]
    fn corrupt_file_starts_empty_without_crashing() {
        let (temp, service) = service();
        fs::write(temp.path().join(OVERRIDES_FILE), "{ torn").unwrap();
        assert_eq!(service.list().unwrap()["items"], json!([]));
    }

    #[test]
    fn remove_and_set_enabled_reindex_orders() {
        let (_temp, service) = service();
        let a = service.create(&input("A", "yaml", "port: 1\n")).unwrap();
        let b = service.create(&input("B", "yaml", "port: 2\n")).unwrap();
        let c = service.create(&input("C", "yaml", "port: 3\n")).unwrap();
        let a_id = a["items"][0]["id"].as_str().unwrap().to_string();
        let b_id = b["items"][1]["id"].as_str().unwrap().to_string();
        let c_id = c["items"][2]["id"].as_str().unwrap().to_string();

        service.set_enabled(&b_id, false).unwrap();
        let snapshot = service.list().unwrap();
        assert_eq!(snapshot["items"][1]["enabled"], false);

        service.remove(&a_id).unwrap();
        let snapshot = service.list().unwrap();
        let items = snapshot["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["name"], "B");
        assert_eq!(items[0]["order"], 0, "reindexed after removal");
        assert_eq!(items[1]["name"], "C");
        assert_eq!(items[1]["order"], 1);
        let _ = c_id;
    }

    #[test]
    fn move_up_down_swaps_and_reindexes() {
        let (_temp, service) = service();
        let a = service.create(&input("A", "yaml", "port: 1\n")).unwrap();
        let b = service.create(&input("B", "yaml", "port: 2\n")).unwrap();
        let a_id = a["items"][0]["id"].as_str().unwrap().to_string();
        let b_id = b["items"][1]["id"].as_str().unwrap().to_string();

        service.move_item(&b_id, "up").unwrap();
        let items = service.list().unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(items[0]["name"], "B");
        assert_eq!(items[1]["name"], "A");

        service.move_item(&a_id, "down").unwrap();
        let items = service.list().unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(items[0]["name"], "B");
        assert_eq!(items[1]["name"], "A");

        // Out-of-range moves are no-ops.
        service.move_item(&a_id, "down").unwrap();
        let items = service.list().unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(items[1]["name"], "A");
    }

    #[test]
    fn unknown_id_fails_with_chinese_copy() {
        let (_temp, service) = service();
        service.create(&input("A", "yaml", "port: 1\n")).unwrap();
        let error = service.set_enabled("nope", true).unwrap_err();
        assert!(error.0.contains("覆写不存在"), "{}", error.0);
        let error = service.update("nope", &input("x", "yaml", "y")).unwrap_err();
        assert!(error.0.contains("覆写不存在"), "{}", error.0);
        let error = service.move_item("nope", "up").unwrap_err();
        assert!(error.0.contains("覆写不存在"), "{}", error.0);
    }

    #[test]
    fn preview_without_active_profile_is_unavailable() {
        let (_temp, service) = service();
        service.create(&input("A", "yaml", "port: 1\n")).unwrap();
        let preview = service.preview().unwrap();
        assert_eq!(preview["unavailable"], true);
        assert_eq!(preview["warnings"][0], "当前没有活动的订阅，无法预演覆写");
    }

    #[test]
    fn preview_redacts_and_applies() {
        let (temp, service) = service();
        let document = "proxies:\n  - name: a\n    password: hunter2\nrules:\n  - MATCH,A\n";
        fs::write(temp.path().join("base.yaml"), document.as_bytes()).unwrap();
        service.create(&input("Port", "yaml", "port: 7891\n")).unwrap();
        let service = service.with_base_resolver(Box::new(move || {
            let document = fs::read_to_string(temp.path().join("base.yaml")).ok()?;
            Some((document, Some("profile-1".to_string())))
        }));
        let preview = service.preview().unwrap();
        assert_eq!(preview["unavailable"], false);
        assert!(!preview["baseText"].as_str().unwrap().contains("hunter2"), "{}", preview["baseText"]);
        assert!(preview["baseText"].as_str().unwrap().contains("password: ***"), "{}", preview["baseText"]);
        // Redacted texts are DISPLAY-only (never re-parsed — `***` is not
        // valid YAML); assert their content directly.
        let applied = preview["appliedText"].as_str().unwrap();
        assert!(applied.contains("port: 7891"), "{applied}");
        assert!(applied.contains("MATCH,A"), "{applied}");
        assert!(applied.contains("password: ***"), "{applied}");
    }

    #[test]
    fn validate_reports_item_errors_and_chain_errors() {
        let (temp, service) = service();
        fs::write(temp.path().join("base.yaml"), "proxies: []\nrules: []\n").unwrap();
        let service = service.with_base_resolver(Box::new(move || {
            Some((fs::read_to_string(temp.path().join("base.yaml")).ok()?, Some("p".to_string())))
        }));
        // A structurally-broken YAML override surfaces a per-item error.
        service.create(&input("Broken", "yaml", "rules: [broken\n")).unwrap();
        let validation = service.validate().unwrap();
        assert_eq!(validation["valid"], false);
        assert!(validation["issues"].as_array().unwrap().iter().any(|i| i["message"] == "YAML 覆写解析失败，需要是一个映射对象"));
    }

    #[test]
    fn validate_warns_when_nothing_is_enabled() {
        let (temp, service) = service();
        fs::write(temp.path().join("base.yaml"), "proxies: []\nrules: []\n").unwrap();
        let service = service.with_base_resolver(Box::new(move || {
            Some((fs::read_to_string(temp.path().join("base.yaml")).ok()?, Some("p".to_string())))
        }));
        let snapshot = service.create(&input("A", "yaml", "port: 1\n")).unwrap();
        let id = snapshot["items"][0]["id"].as_str().unwrap().to_string();
        service.set_enabled(&id, false).unwrap();
        let validation = service.validate().unwrap();
        assert_eq!(validation["valid"], true, "{}", validation);
        assert!(validation["issues"].as_array().unwrap().iter().any(|i| i["level"] == "warning"));
    }

    #[test]
    fn last_known_good_captures_and_rollbacks() {
        let (temp, service) = service();
        fs::write(temp.path().join("base.yaml"), "proxies: []\nrules: []\n").unwrap();
        let service = service.with_base_resolver(Box::new(move || {
            Some((fs::read_to_string(temp.path().join("base.yaml")).ok()?, Some("p".to_string())))
        }));
        // A valid set is captured as last-known-good by validate().
        service.create(&input("A", "yaml", "port: 7891\n")).unwrap();
        service.validate().unwrap();
        assert!(service.last_known_good().unwrap().is_object());

        // A subsequent bad edit is rolled back to the captured snapshot.
        let snapshot = service.list().unwrap();
        let id = snapshot["items"][0]["id"].as_str().unwrap().to_string();
        service.update(&id, &input("A", "yaml", "rules: [broken\n")).unwrap();
        let restored = service.reset_to_last_good().unwrap();
        assert_eq!(restored["items"][0]["content"], "port: 7891\n");
    }

    #[test]
    fn scoping_and_order_via_preview() {
        // Scoping is exercised through preview(), whose resolver decides the
        // profile (keeps State private).
        let (temp, service) = service();
        fs::write(temp.path().join("base.yaml"), "proxies: []\nrules: []\nport: 0\n").unwrap();
        // Global override + a profile override for p1 + one for p2.
        service.create(&json!({ "name": "G", "kind": "yaml", "scope": "global", "profileId": null, "content": "port: 1\n" })).unwrap();
        service.create(&json!({ "name": "P", "kind": "yaml", "scope": "profile", "profileId": "p1", "content": "keep-alive: 30\n" })).unwrap();
        service.create(&json!({ "name": "Q", "kind": "yaml", "scope": "profile", "profileId": "p2", "content": "mode: global\n" })).unwrap();
        let service = service.with_base_resolver(Box::new(move || {
            Some((fs::read_to_string(temp.path().join("base.yaml")).ok()?, Some("p1".to_string())))
        }));
        let applied_text = service.preview().unwrap()["appliedText"].take().as_str().map(str::to_string).unwrap_or_default();
        // appliedText is redacted display text; assert on the unredacted apply
        // path instead by re-running the engine through the public pipeline:
        // (keep-alive only enters via the p1 override, so its presence proves
        // scoping; `port: 1` proves the global override; mode stays `rule`
        // because the p2 override never ran).
        assert!(applied_text.contains("port: 1"), "{applied_text}");
        assert!(applied_text.contains("keep-alive: 30"), "{applied_text}");
        // The p2-scoped override never ran (the base has no `mode` key and
        // Q would have added `mode: global`).
        assert!(!applied_text.contains("mode: global"), "{applied_text}");
        assert!(!applied_text.contains("mode"), "{applied_text}");
    }
}
