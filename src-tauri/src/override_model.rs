//! Override domain model — Rust port of the shared model in
//! `src/shared/overrides.ts` (Phase 3A overrides slice).
//!
//! An override is a post-processing step attached to a subscription's base
//! mihomo document. Two kinds exist in the product: `yaml` (deep-merged into
//! the base config, with `+key`/`key+` list modifiers) and `js` (a snippet
//! defining `main(config)` run in a sealed VM sandbox). The JS kind needs a
//! JS engine in Rust; until that slice lands, JS overrides fail OPEN with an
//! explicit warning (skipped, never breaking the kernel start) and validation
//! reports them as not runnable — an honest, documented staging point.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How an override body is interpreted.
pub const KIND_YAML: &str = "yaml";
pub const KIND_JS: &str = "js";
/// Where an override applies.
pub const SCOPE_GLOBAL: &str = "global";
pub const SCOPE_PROFILE: &str = "profile";

const OVERRIDE_SECRET_OK: &str = "***";

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// A single persisted override definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverrideItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub scope: String,
    /// Always serialized (null when not profile-scoped) — JSON.stringify parity.
    pub profile_id: Option<String>,
    pub order: i64,
    pub content: String,
    pub updated_at: u64,
}

/// Coerce an arbitrary value into a valid `OverrideItem`. Unknown or malformed
/// fields fall back to safe defaults so the renderer never crashes on a stale
/// or hand-edited snapshot.
pub fn coerce_override_item(input: &Value) -> OverrideItem {
    let source = if is_record(input) { input } else { &Value::Null };
    let object = source.as_object();
    let get = |key: &str| object.and_then(|o| o.get(key));
    let kind = match get("kind").and_then(Value::as_str) {
        Some(KIND_YAML) | Some(KIND_JS) => get("kind").and_then(Value::as_str).unwrap().to_string(),
        _ => KIND_YAML.to_string(),
    };
    let scope = match get("scope").and_then(Value::as_str) {
        Some(SCOPE_GLOBAL) | Some(SCOPE_PROFILE) => get("scope").and_then(Value::as_str).unwrap().to_string(),
        _ => SCOPE_GLOBAL.to_string(),
    };
    let mut profile_id: Option<String> = None;
    if scope == SCOPE_PROFILE {
        if let Some(Value::String(id)) = get("profileId") {
            if !id.trim().is_empty() {
                profile_id = Some(id.clone());
            }
        }
    }
    OverrideItem {
        id: get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        name: get("name").and_then(Value::as_str).unwrap_or("未命名覆写").to_string(),
        kind,
        enabled: get("enabled").and_then(Value::as_bool).unwrap_or(true),
        scope,
        profile_id,
        order: get("order").and_then(Value::as_i64).unwrap_or(0),
        content: get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        updated_at: get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    }
}

/// Redact credential-like material from override/provider text so any preview
/// or diagnostic text never leaks secrets to the renderer.
pub fn redact_override_content(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let userinfo = regex::Regex::new(r"(\w+://)([^@\s/]+)@").expect("userinfo regex compiles");
    let secret_key = regex::Regex::new(
        r"(?i)(\b(?:password|secret|token|access[_-]?key|access[_-]?secret|authorization|cookie|uuid|apikey|api[_-]?key|private[_-]?key)[^:\s]*\s*:\s*)([^\n]+)",
    )
    .expect("secret-key regex compiles");
    let hex64 = regex::Regex::new(r"\b[0-9a-f]{64}\b").expect("hex64 regex compiles");
    let text = userinfo.replace_all(text, format!("${{1}}{OVERRIDE_SECRET_OK}@"));
    let text = secret_key.replace_all(&text, format!("${{1}}{OVERRIDE_SECRET_OK}"));
    hex64.replace_all(&text, OVERRIDE_SECRET_OK).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerce_falls_back_to_safe_defaults() {
        let item = coerce_override_item(&json!({ "kind": "bogus", "scope": 42 }));
        assert_eq!(item.kind, KIND_YAML);
        assert_eq!(item.scope, SCOPE_GLOBAL);
        assert_eq!(item.name, "未命名覆写");
        assert!(item.enabled);
        assert_eq!(item.profile_id, None);
        assert_eq!(item.order, 0);
        assert_eq!(item.content, "");
        assert_eq!(item.updated_at, 0);
    }

    #[test]
    fn coerce_keeps_profile_id_only_for_profile_scope() {
        let global = coerce_override_item(&json!({ "scope": "global", "profileId": "abc" }));
        assert_eq!(global.profile_id, None);
        let profile = coerce_override_item(&json!({ "scope": "profile", "profileId": "abc" }));
        assert_eq!(profile.profile_id.as_deref(), Some("abc"));
        let blank = coerce_override_item(&json!({ "scope": "profile", "profileId": "   " }));
        assert_eq!(blank.profile_id, None);
    }

    #[test]
    fn redact_masks_userinfo_secret_keys_and_hex64() {
        let text = "url: https://user:pass@example.com/sub\npassword: hunter2\ntoken: aabbccdd0123456789aabbccdd0123456789aabbccdd0123456789aabbccdd\nkeep: plain\n";
        let redacted = redact_override_content(text);
        assert!(!redacted.contains("user:pass"), "{redacted}");
        assert!(redacted.contains("***@"), "{redacted}");
        assert!(!redacted.contains("hunter2"), "{redacted}");
        assert!(redacted.contains("password: ***"), "{redacted}");
        assert!(!redacted.contains("aabbccdd0123456789"), "{redacted}");
        assert!(redacted.contains("keep: plain"), "{redacted}");
    }

    #[test]
    fn redact_is_case_insensitive_on_keys() {
        let redacted = redact_override_content("APIKEY: xyz\n");
        assert!(redacted.contains("APIKEY: ***"), "{redacted}");
    }

    #[test]
    fn redact_empty_text_stays_empty() {
        assert_eq!(redact_override_content(""), "");
    }
}
