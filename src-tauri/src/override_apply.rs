//! Override application engine — Rust port of
//! `src/main/kernel/overrides/apply-overrides.ts` (YAML kind) and
//! `profile-kernel-config.ts` (`profileKernelConfigErrors` gate).
//!
//! The pipeline: parse the base document into an object model → apply each
//! enabled override in `order` → re-serialize. Every step fails OPEN at the
//! per-item level: a malformed YAML override leaves the current config intact
//! and adds a warning, so one bad override can never break the kernel start.
//!
//! The `js` kind runs through the sealed boa sandbox (`crate::js_sandbox`) —
//! the `node:vm` contract port (shadow console, no Node globals, hard
//! runaway-trap bound). YAML output formatting may
//! differ byte-wise from the Electron `yaml.stringify` (no 80-column folding,
//! no leading `---`), which is semantically neutral for mihomo and documented
//! in docs/tauri/phase3/README.md.

use serde_json::{Map, Value};
use yaml_rust2::Yaml;
use yaml_rust2::yaml::Hash;

use crate::error::IpcError;
use crate::override_model::{OverrideItem, KIND_JS, KIND_YAML};

/// The transformed document plus non-fatal diagnostics.
pub struct ApplyOverridesResult {
    pub text: String,
    pub warnings: Vec<String>,
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// Combine array leaves, deduplicating by stringified value.
fn merge_list(base: &Value, next: &Value, mode: &str) -> Value {
    let empty = Vec::new();
    let lhs = base.as_array().unwrap_or(&empty);
    let rhs = next.as_array().unwrap_or(&empty);
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    let mut push = |value: &Value, out: &mut Vec<Value>| {
        let key = serde_json::to_string(value).unwrap_or_default();
        if seen.insert(key) {
            out.push(value.clone());
        }
    };
    if mode == "prepend" {
        for value in rhs {
            push(value, &mut out);
        }
        for value in lhs {
            push(value, &mut out);
        }
    } else {
        for value in lhs {
            push(value, &mut out);
        }
        for value in rhs {
            push(value, &mut out);
        }
    }
    Value::Array(out)
}

/// Deep-merge a YAML override object into the base config.
///
/// Plain objects merge recursively; arrays and scalars replace unless the key
/// uses the `+key` (prepend) or `key+` (append) modifier, in which case the
/// base list is combined with the override list. The modifier name is always
/// written back as the clean `key`, so `+rules` becomes `rules`.
pub fn merge_override_object(base: &mut Map<String, Value>, r#override: &Map<String, Value>) {
    for (raw_key, value) in r#override.iter() {
        let mut key = raw_key.clone();
        let mut mode: Option<&str> = None;
        if key.ends_with('+') {
            key.pop();
            mode = Some("append");
        } else if let Some(stripped) = raw_key.strip_prefix('+') {
            key = stripped.to_string();
            mode = Some("prepend");
        }

        if let Some(direction) = mode {
            let merged = merge_list(base.get(&key).unwrap_or(&Value::Null), value, direction);
            base.insert(key, merged);
            continue;
        }

        let base_value = base.get(&key).cloned().unwrap_or(Value::Null);
        if is_plain_object(&base_value) && is_plain_object(value) {
            if let (Some(base_object), Some(override_object)) = (base_value.as_object(), value.as_object()) {
                let mut merged = base_object.clone();
                merge_override_object(&mut merged, override_object);
                base.insert(key, Value::Object(merged));
            }
        } else {
            base.insert(key, value.clone());
        }
    }
}

/// Parse a YAML document into the object model. Returns None on parse errors,
/// duplicate keys or non-mapping roots (fail-open upstream).
pub fn parse_yaml_to_object(text: &str) -> Option<Map<String, Value>> {
    let docs = yaml_rust2::YamlLoader::load_from_str(text).ok()?;
    let yaml = docs.into_iter().next()?;
    match yaml_to_json(yaml) {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn yaml_to_json(yaml: Yaml) -> Value {
    match yaml {
        Yaml::Real(text) => {
            let number = text.parse::<f64>().ok();
            match number {
                Some(v) if v.is_finite() => serde_json::Number::from_f64(v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                _ => Value::String(text),
            }
        }
        Yaml::Integer(v) => Value::Number(v.into()),
        Yaml::String(s) => Value::String(s),
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Array(items) => Value::Array(items.iter().map(|item| yaml_to_json(item.clone())).collect()),
        Yaml::Hash(map) => {
            let mut object = Map::new();
            for (key, value) in map.iter() {
                let key = match key {
                    Yaml::String(s) => s.clone(),
                    Yaml::Integer(i) => i.to_string(),
                    Yaml::Real(r) => r.clone(),
                    Yaml::Boolean(b) => b.to_string(),
                    _ => continue,
                };
                object.insert(key, yaml_to_json(value.clone()));
            }
            Value::Object(object)
        }
        _ => Value::Null,
    }
}

fn json_to_yaml(value: Value) -> Yaml {
    match value {
        Value::Null => Yaml::Null,
        Value::Bool(b) => Yaml::Boolean(b),
        Value::Number(number) => {
            if let Some(i) = number.as_i64() {
                Yaml::Integer(i)
            } else if let Some(u) = number.as_u64() {
                Yaml::Integer(u as i64)
            } else if let Some(f) = number.as_f64() {
                Yaml::Real(format!("{f}"))
            } else {
                Yaml::Null
            }
        }
        Value::String(s) => Yaml::String(s),
        Value::Array(items) => Yaml::Array(items.into_iter().map(json_to_yaml).collect()),
        Value::Object(map) => {
            let mut hash = Hash::new();
            for (key, value) in map.into_iter() {
                hash.insert(Yaml::String(key), json_to_yaml(value));
            }
            Yaml::Hash(hash)
        }
    }
}

/// Serialize the object model back to YAML (the runtime config text).
pub fn stringify_yaml(value: Value) -> String {
    let yaml = json_to_yaml(value);
    let mut out = String::new();
    let mut emitter = yaml_rust2::YamlEmitter::new(&mut out);
    if emitter.dump(&yaml).is_err() {
        return String::new();
    }
    out.strip_prefix("---\n").map(str::to_string).unwrap_or(out)
}

fn is_runnable(item: &OverrideItem) -> bool {
    item.enabled && !item.content.trim().is_empty()
}

/// Structural validation for a single override item, independent of any base
/// document. Returns Some(copy) when the item is malformed, None when
/// structurally acceptable.
pub fn validate_override_content(item: &OverrideItem) -> Option<String> {
    if item.content.trim().is_empty() {
        return Some("覆写内容为空".into());
    }
    if item.kind == KIND_YAML {
        return if parse_yaml_to_object(&item.content).is_some() {
            None
        } else {
            Some("YAML 覆写解析失败，需要是一个映射对象".into())
        };
    }
    if item.kind == KIND_JS {
        return crate::js_sandbox::validate_js_override(&item.content);
    }
    Some("未知的覆写类型".into())
}

/// Apply every enabled override (already selected & ordered by the caller) to
/// a base profile document. With no runnable overrides the base text is
/// returned verbatim.
pub fn apply_overrides_to_document(base: &str, items: &[OverrideItem]) -> ApplyOverridesResult {
    let runnable: Vec<&OverrideItem> = items.iter().filter(|item| is_runnable(item)).collect();
    if runnable.is_empty() {
        return ApplyOverridesResult { text: base.to_string(), warnings: Vec::new() };
    }

    let Some(config) = parse_yaml_to_object(base) else {
        // Base is unparseable — leave it verbatim and let the validator reject it.
        return ApplyOverridesResult {
            text: base.to_string(),
            warnings: vec!["基础配置文件无法解析，已跳过全部覆写".into()],
        };
    };
    let mut config = config;

    let mut warnings: Vec<String> = Vec::new();
    let mut ordered: Vec<&OverrideItem> = runnable;
    ordered.sort_by_key(|item| item.order);
    for item in ordered {
        if item.kind == KIND_YAML {
            let Some(r#override) = parse_yaml_to_object(&item.content) else {
                warnings.push(format!("覆写「{}」YAML 解析失败，已跳过", item.name));
                continue;
            };
            merge_override_object(&mut config, &r#override);
        } else {
            // JS kind: the sealed sandbox (see module doc).
            let result = crate::js_sandbox::run_js_override(&item.content, &Value::Object(config.clone()));
            config = match result.next {
                Value::Object(map) => map,
                // run_js_override always returns an object here; the guard
                // keeps the merge chain object-typed regardless.
                _ => continue,
            };
            warnings.extend(result.warnings.into_iter().map(|message| format!("覆写「{}」：{}", item.name, message)));
        }
    }

    ApplyOverridesResult { text: stringify_yaml(Value::Object(config)), warnings }
}

/// Structural gate for a runtime profile config — Rust port of
/// `profileKernelConfigErrors`. YAML parse-error copy follows the Rust parser
/// (engine-specific wording, documented).
pub fn profile_kernel_config_errors(text: &str) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    if text.trim().is_empty() {
        return vec!["配置文档为空".into()];
    }

    let parsed = yaml_rust2::YamlLoader::load_from_str(text);
    let root = match parsed {
        Ok(docs) => docs.into_iter().next(),
        Err(error) => {
            errors.push(format!("YAML 解析错误: {error}"));
            return errors;
        }
    };
    let Some(Yaml::Hash(root)) = root else {
        errors.push("配置顶层必须是一个 YAML 映射".into());
        return errors;
    };

    let mut keys = std::collections::HashSet::new();
    for (key, _) in root.iter() {
        if let Yaml::String(key) = key {
            keys.insert(key.clone());
        }
    }

    let has_content = keys.contains("proxies")
        || keys.contains("proxy-groups")
        || keys.contains("proxy-providers")
        || keys.contains("rules");
    if !has_content {
        errors.push("文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段".into());
    }

    errors.sort();
    errors.dedup();
    errors
}

/// Validate the effective override set's whole-chain semantics: overrides must
/// not break a previously-valid base config.
pub fn chain_semantic_issues(base_text: &str, applied_text: &str) -> Vec<String> {
    let base_errors = profile_kernel_config_errors(base_text);
    let applied_errors = profile_kernel_config_errors(applied_text);
    applied_errors
        .iter()
        .filter(|error| !base_errors.contains(error))
        .cloned()
        .collect()
}

/// Arg-coercion helper shared by dispatch handlers.
pub fn override_input(input: &Value) -> Result<(String, String, String, Option<String>, String), IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| IpcError::invalid_argument("override input must be an object"))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("override input.name must be a string"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("override input.kind must be a string"))?;
    if kind != KIND_YAML && kind != KIND_JS {
        return Err(IpcError::invalid_argument("override input.kind must be 'yaml' or 'js'"));
    }
    let scope = object
        .get("scope")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("override input.scope must be a string"))?;
    if scope != SCOPE_CHECK.0 && scope != SCOPE_CHECK.1 {
        return Err(IpcError::invalid_argument("override input.scope must be 'global' or 'profile'"));
    }
    let profile_id = match object.get("profileId") {
        Some(Value::String(id)) if !id.trim().is_empty() => Some(id.clone()),
        _ => None,
    };
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("override input.content must be a string"))?;
    Ok((name.to_string(), kind.to_string(), scope.to_string(), profile_id, content.to_string()))
}

const SCOPE_CHECK: (&str, &str) = ("global", "profile");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(kind: &str, content: &str, order: i64) -> OverrideItem {
        OverrideItem {
            id: format!("id-{order}"),
            name: format!("override-{order}"),
            kind: kind.into(),
            enabled: true,
            scope: "global".into(),
            profile_id: None,
            order,
            content: content.into(),
            updated_at: 0,
        }
    }

    #[test]
    fn yaml_override_merges_scalars_and_objects() {
        let base = "port: 7890\nmode: rule\ndns:\n  enable: false\n";
        let result = apply_overrides_to_document(
            base,
            &[item("yaml", "mode: global\ndns:\n  enable: true\n  ipv6: false\n", 0)],
        );
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let merged = parse_yaml_to_object(&result.text).unwrap();
        assert_eq!(merged["mode"], json!("global"));
        assert_eq!(merged["port"], json!(7890));
        assert_eq!(merged["dns"]["enable"], json!(true));
        assert_eq!(merged["dns"]["ipv6"], json!(false));
    }

    #[test]
    fn append_and_prepend_modifiers_dedupe() {
        let base = "rules:\n  - MATCH,A\n";
        let append = apply_overrides_to_document(base, &[item("yaml", "rules+:\n  - MATCH,B\n", 0)]);
        let rules = parse_yaml_to_object(&append.text).unwrap()["rules"].clone();
        assert_eq!(rules, json!(["MATCH,A", "MATCH,B"]));
        let prepend = apply_overrides_to_document(base, &[item("yaml", "+rules:\n  - MATCH,B\n", 0)]);
        let rules = parse_yaml_to_object(&prepend.text).unwrap()["rules"].clone();
        assert_eq!(rules, json!(["MATCH,B", "MATCH,A"]));
        // Exact duplicates are dropped.
        let dup = apply_overrides_to_document(base, &[item("yaml", "rules+:\n  - MATCH,A\n", 0)]);
        assert_eq!(parse_yaml_to_object(&dup.text).unwrap()["rules"], json!(["MATCH,A"]));
    }

    #[test]
    fn malformed_yaml_override_fails_open_with_warning() {
        let base = "mode: rule\n";
        let result = apply_overrides_to_document(base, &[item("yaml", "rules: [broken\n", 0)]);
        // The base IS parsed (so the text re-serializes), the bad item is
        // skipped with a warning, and the good keys survive.
        assert!(result.warnings.iter().any(|w| w.contains("YAML 解析失败")), "{:?}", result.warnings);
        assert_eq!(parse_yaml_to_object(&result.text).unwrap()["mode"], json!("rule"));
    }

    #[test]
    fn unparseable_base_skips_everything() {
        let result = apply_overrides_to_document("\t- not a map", &[item("yaml", "mode: global\n", 0)]);
        assert_eq!(result.text, "\t- not a map");
        assert!(result.warnings.iter().any(|w| w.contains("基础配置文件无法解析")));
    }

    #[test]
    fn js_overrides_run_through_the_sealed_sandbox() {
        let base = "mode: rule\n";
        let result = apply_overrides_to_document(base, &[item("js", "function main(c) { c.mode = 'global' }", 0)]);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(parse_yaml_to_object(&result.text).unwrap()["mode"], json!("global"));
    }

    #[test]
    fn a_failing_js_override_is_fail_open_with_the_wrapped_warning() {
        let base = "mode: rule\n";
        let result = apply_overrides_to_document(base, &[item("js", "function main(c) { throw new Error('boom') }", 0)]);
        assert_eq!(parse_yaml_to_object(&result.text).unwrap()["mode"], json!("rule"), "config untouched");
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
        assert!(result.warnings[0].starts_with("覆写「override-0」：JS 覆写 main(config) 执行失败："), "{}", result.warnings[0]);
    }

    #[test]
    fn a_js_override_with_console_output_keeps_call_order_after_script_warnings() {
        let base = "mode: rule\n";
        let content = "function main(c) { console.log('hi'); throw new Error('x') }";
        let result = apply_overrides_to_document(base, &[item("js", content, 0)]);
        // TS: [...warnings, ...messages] — the script failure first, console after.
        assert_eq!(result.warnings.len(), 2, "{:?}", result.warnings);
        assert!(result.warnings[0].contains("JS 覆写 main(config) 执行失败："));
        assert!(result.warnings[1].ends_with("：hi"));
    }

    #[test]
    fn empty_content_and_disabled_items_are_not_runnable() {
        let base = "mode: rule\n";
        let result = apply_overrides_to_document(base, &[item("yaml", "   ", 0)]);
        assert_eq!(result.text, base);
        let mut disabled = item("yaml", "mode: global\n", 0);
        disabled.enabled = false;
        assert_eq!(apply_overrides_to_document(base, &[disabled]).text, base);
    }

    #[test]
    fn apply_order_follows_order_field() {
        let base = "mode: rule\n";
        let result = apply_overrides_to_document(
            base,
            &[
                item("yaml", "port: 1\n", 1),
                item("yaml", "port: 2\n", 0), // lower order runs first
            ],
        );
        // Ascending order; the LAST applied item wins.
        assert_eq!(parse_yaml_to_object(&result.text).unwrap()["port"], json!(1));
    }

    #[test]
    fn validate_override_content_checks_yaml_mapping() {
        assert_eq!(validate_override_content(&item("yaml", "mode: rule\n", 0)), None);
        assert_eq!(
            validate_override_content(&item("yaml", "rules: [broken\n", 0)).as_deref(),
            Some("YAML 覆写解析失败，需要是一个映射对象")
        );
        assert_eq!(validate_override_content(&item("yaml", "  \n", 0)).as_deref(), Some("覆写内容为空"));
        assert_eq!(validate_override_content(&item("js", "function main() {}", 0)), None);
        assert_eq!(
            validate_override_content(&item("js", "const x = 1", 0)).as_deref(),
            Some("JS 覆写未定义 main(config) 函数")
        );
    }

    #[test]
    fn kernel_config_errors_gate_content_sections() {
        assert_eq!(profile_kernel_config_errors("   "), vec!["配置文档为空"]);
        assert_eq!(
            profile_kernel_config_errors("mode: rule\n"),
            vec!["文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段"]
        );
        let good = "proxies: []\nrules: []\n";
        assert!(profile_kernel_config_errors(good).is_empty());
        assert_eq!(
            profile_kernel_config_errors("- list\n"),
            vec!["配置顶层必须是一个 YAML 映射"]
        );
    }

    #[test]
    fn chain_semantics_detect_introduced_errors_only() {
        let base = "proxies: []\nrules: []\n";
        let applied_broken = "proxies: []\nrules: []\nmode: rule\nmode: global\n";
        let introduced = chain_semantic_issues(base, applied_broken);
        assert!(introduced.iter().any(|e| e.contains("重复") || e.contains("duplicate") || e.contains("解析")), "{:?}", introduced);
        // A base with pre-existing problems does not blame the overrides.
        let bad_base = "mode: rule\n";
        let applied_same_shape = "mode: rule\n";
        assert!(chain_semantic_issues(bad_base, applied_same_shape).is_empty());
    }

    #[test]
    fn stringify_round_trips_through_the_object_model() {
        let object = parse_yaml_to_object("port: 7890\ndns:\n  nameserver:\n    - 223.5.5.5\n    - 8.8.8.8\n").unwrap();
        let text = stringify_yaml(Value::Object(object));
        let reparsed = parse_yaml_to_object(&text).unwrap();
        assert_eq!(reparsed["port"], json!(7890));
        assert_eq!(reparsed["dns"]["nameserver"], json!(["223.5.5.5", "8.8.8.8"]));
        assert!(!text.starts_with("---"), "no document header");
    }

    #[test]
    fn override_input_is_validated() {
        assert!(override_input(&json!({ "name": "n", "kind": "yaml", "scope": "global", "content": "x" })).is_ok());
        assert!(override_input(&json!({ "kind": "yaml", "scope": "global", "content": "x" })).is_err());
        assert!(override_input(&json!({ "name": "n", "kind": "lua", "scope": "global", "content": "x" })).is_err());
        assert!(override_input(&json!({ "name": "n", "kind": "yaml", "scope": "zone", "content": "x" })).is_err());
        assert!(override_input(&json!({ "name": "n", "kind": "yaml", "scope": "profile", "content": "x" }))
            .map(|(_, _, _, profile_id, _)| profile_id.is_none())
            .unwrap_or(false));
    }
}
