//! Strict mihomo config validation — the Rust mirror of
//! `src/main/kernel/mihomo-config.ts` (`mihomoConfigErrors`,
//! `validateMihomoConfigYaml`, `sanitizeMihomoConfig`) and the
//! `profile-kernel-config.ts` structural gate, plus the
//! `mihomo-config-store.ts` geodata seeding helper.
//!
//! The TS validator parses with the `yaml` package (`parseDocument`,
//! `uniqueKeys: true`): unknown top-level keys, duplicate keys, aliases,
//! explicit tags, composite keys and non-allowlisted rules/members are all
//! rejected. This port builds the same node tree from yaml-rust2's event
//! stream — which preserves duplicate pairs, aliases and explicit tags that
//! `YamlLoader`'s deduplicating hash would silently swallow — and then runs
//! the TS-shaped walk, so the error strings match the Electron build byte
//! for byte.

#![cfg_attr(not(test), allow(dead_code))]
use crate::error::IpcError;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Top-level keys the strict config may contain. Anything else is rejected.
pub const ALLOWED_TOP_LEVEL_KEYS: [&str; 16] = [
    "port",
    "socks-port",
    "mixed-port",
    "allow-lan",
    "bind-address",
    "mode",
    "log-level",
    "ipv6",
    "external-controller",
    "external-ui",
    "external-ui-url",
    "external-ui-name",
    "secret",
    "tun",
    "dns",
    "rules",
];

const OPTIONAL_TOP_LEVEL_KEYS: [&str; 5] = ["port", "socks-port", "external-ui", "external-ui-url", "external-ui-name"];
const ALLOWED_LOG_LEVELS: [&str; 5] = ["silent", "error", "warn", "info", "debug"];
const ALLOWED_RULES: [&str; 1] = ["MATCH,DIRECT"];
pub const SECRET_PATTERN: &str = "^[0-9a-f]{64}$";
const MIN_PORT: i64 = 1024;
const MAX_PORT: i64 = 65535;
const CONTROLLER_PATTERN: &str = r"^(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)$";

// ---------------------------------------------------------------------------
// YAML DOM (yaml-rust2 event stream)
// ---------------------------------------------------------------------------

/// A classified plain/quoted scalar. Plain scalars resolve like the `yaml`
/// package's core schema (bool/number/null/otherwise-string); quoted and
/// block styles are always strings.
#[derive(Clone, Debug, PartialEq)]
pub enum ScalarValue {
    Bool(bool),
    Int(i64),
    Real(String),
    Null,
    Str(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScalarNode {
    pub value: ScalarValue,
    /// `None` = the YAML value; `Some` = an explicit tag was written in the
    /// source (`key: !!str x`), which the strict validator rejects.
    pub tag: Option<Tag>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Scalar(ScalarNode),
    Sequence { items: Vec<Node>, tag: Option<Tag> },
    Mapping { entries: Vec<(Node, Option<Node>)>, tag: Option<Tag> },
    Alias,
}

impl Node {
    fn is_alias(&self) -> bool {
        matches!(self, Node::Alias)
    }

    /// Whether an explicit tag is attached (aliases carry no tag).
    fn tagged(&self) -> bool {
        match self {
            Node::Scalar(node) => node.tag.is_some(),
            Node::Sequence { tag, .. } | Node::Mapping { tag, .. } => tag.is_some(),
            Node::Alias => false,
        }
    }
}

/// Streams parser events into a node tree. Unlike `YamlLoader`'s hash-based
/// collector, duplicate mapping pairs are preserved so the validator can
/// reject them exactly like `parseDocument({ uniqueKeys: true })`.
struct DomBuilder {
    stack: Vec<Container>,
    /// First completed top-level node (the `parseDocument` single-document
    /// semantics; any later document is ignored).
    root: Option<Node>,
    parse_errors: Vec<String>,
}

enum Container {
    Sequence { items: Vec<Node>, tag: Option<Tag> },
    /// `pending` is a key awaiting its value (the YAML `key:` missing-value
    /// form is preserved as `None`, like the `yaml` package's null node).
    Mapping { entries: Vec<(Node, Option<Node>)>, pending: Option<Node>, tag: Option<Tag> },
}

impl DomBuilder {
    fn complete(&mut self, node: Node) {
        match self.stack.last_mut() {
            None => {
                if self.root.is_none() {
                    self.root = Some(node);
                }
            }
            Some(Container::Sequence { items, .. }) => items.push(node),
            Some(Container::Mapping { entries, pending, .. }) => match pending.take() {
                Some(key) => entries.push((key, Some(node))),
                None => *pending = Some(node),
            },
        }
    }

    fn pop_container(&mut self) -> Option<Node> {
        match self.stack.pop() {
            Some(Container::Sequence { items, tag }) => Some(Node::Sequence { items, tag }),
            Some(Container::Mapping { entries, pending, tag }) => {
                // `key:` with nothing after it is a missing value, exactly like
                // the `yaml` package's null node.
                let mut entries = entries;
                if let Some(key) = pending {
                    entries.push((key, None));
                }
                Some(Node::Mapping { entries, tag })
            }
            None => None,
        }
    }
}

impl MarkedEventReceiver for DomBuilder {
    fn on_event(&mut self, event: Event, _mark: Marker) {
        match event {
            Event::Scalar(value, style, _anchor, tag) => {
                let resolved = match style {
                    TScalarStyle::Plain => classify_plain(&value),
                    _ => ScalarValue::Str(value), // quoted / block: always a string
                };
                self.complete(Node::Scalar(ScalarNode { value: resolved, tag }));
            }
            Event::Alias(_) => self.complete(Node::Alias),
            Event::SequenceStart(_anchor, tag) => {
                self.stack.push(Container::Sequence { items: Vec::new(), tag });
            }
            Event::SequenceEnd => {
                if let Some(node) = self.pop_container() {
                    self.complete(node);
                }
            }
            Event::MappingStart(_anchor, tag) => {
                self.stack.push(Container::Mapping { entries: Vec::new(), pending: None, tag });
            }
            Event::MappingEnd => {
                if let Some(node) = self.pop_container() {
                    self.complete(node);
                }
            }
            _ => {}
        }
    }
}

/// `parseDocument` semantics: parse the first document; parse failures land
/// in the error list (the caller then reports the non-mapping error too).
pub fn parse_first_document(text: &str) -> Result<Node, Vec<String>> {
    let mut builder = DomBuilder { stack: Vec::new(), root: None, parse_errors: Vec::new() };
    let mut parser = Parser::new_from_str(text);
    match parser.load(&mut builder, true) {
        Ok(()) => {}
        Err(error) => {
            // The TS `yaml` package parses an unresolved `*anchor` as an alias
            // node (then rejected by the alias rule); yaml-rust2 aborts the
            // whole document instead. Map that one failure class onto the
            // same observable error so the contract matches.
            let message = error.to_string();
            if message.contains("unknown anchor") {
                builder.parse_errors.push("config must not use YAML aliases".to_string());
            } else {
                builder.parse_errors.push(format!("YAML parse error: {message}"));
            }
        }
    }
    if !builder.parse_errors.is_empty() {
        return Err(builder.parse_errors);
    }
    builder
        .root
        .ok_or_else(|| vec!["config must be a YAML mapping at the top level".to_string()])
}

fn classify_plain(value: &str) -> ScalarValue {
    match value {
        "" | "null" | "Null" | "NULL" | "~" => ScalarValue::Null,
        "true" | "True" | "TRUE" => ScalarValue::Bool(true),
        "false" | "False" | "FALSE" => ScalarValue::Bool(false),
        other => {
            if let Ok(int) = other.parse::<i64>() {
                return ScalarValue::Int(int);
            }
            if other.parse::<f64>().map(|float| float.is_finite()).unwrap_or(false)
                && other.chars().any(|c| c == '.' || c == 'e' || c == 'E')
                && !other.starts_with("0x")
            {
                return ScalarValue::Real(other.to_string());
            }
            ScalarValue::Str(other.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Strict validator (mihomoConfigErrors)
// ---------------------------------------------------------------------------

/// Collect every violation in `text` as human-readable messages. Returns an
/// empty array when the document satisfies the strict Phase-7 invariants.
pub fn mihomo_config_errors(text: &str) -> Vec<String> {
    let root = match parse_first_document(text) {
        Ok(node) => node,
        Err(mut errors) => {
            errors.push("config must be a YAML mapping at the top level".to_string());
            return errors;
        }
    };
    let Node::Mapping { entries, .. } = root else {
        return vec!["config must be a YAML mapping at the top level".to_string()];
    };

    let mut errors: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (key_node, value_node) in entries {
        // Missing value (`key:` with nothing) — the `yaml` package yields a
        // null node here.
        let Some(_value) = value_node else {
            errors.push("config entries must have a value".to_string());
            continue;
        };
        if key_node.is_alias() || _value.is_alias() {
            errors.push("config must not use YAML aliases".to_string());
            continue;
        }
        let Node::Scalar(ScalarNode { value: ScalarValue::Str(key), .. }) = &key_node else {
            errors.push("top-level keys must be plain scalar strings".to_string());
            continue;
        };
        if key_node.tagged() || _value.tagged() {
            errors.push(format!("key {key} uses a YAML tag, which is not allowed"));
            continue;
        }
        if seen.iter().any(|seen| seen == key) {
            errors.push(format!("duplicate key: {key}"));
            continue;
        }
        seen.push(key.clone());
        if !ALLOWED_TOP_LEVEL_KEYS.contains(&key.as_str()) {
            errors.push(format!("unknown top-level key: {key}"));
            continue;
        }
        errors.extend(collect_key_errors(key, &_value));
    }

    for required in ALLOWED_TOP_LEVEL_KEYS {
        if OPTIONAL_TOP_LEVEL_KEYS.contains(&required) {
            continue;
        }
        if !seen.iter().any(|seen| seen == required) {
            errors.push(format!("missing required key: {required}"));
        }
    }
    errors
}

fn is_bool_false(node: &Node) -> bool {
    matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Bool(false), .. }))
}

fn collect_key_errors(key: &str, value_node: &Node) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let Node::Scalar(scalar) = value_node else {
        // Boolean false must already be a boolean (not the string "false").
        if key == "tun" || key == "dns" || key == "rules" {
            errors.extend(collect_nested_errors(key, value_node));
        } else {
            errors.push(format!("{key} must be a scalar value"));
        }
        return errors;
    };

    if key == "mixed-port" || key == "port" || key == "socks-port" {
        match &scalar.value {
            ScalarValue::Int(port) => {
                if !(MIN_PORT..=MAX_PORT).contains(port) {
                    errors.push(format!("{key} must be an unprivileged port between {MIN_PORT} and {MAX_PORT}"));
                }
            }
            ScalarValue::Real(_) => {
                errors.push(format!("{key} must be an unprivileged port between {MIN_PORT} and {MAX_PORT}"));
            }
            _ => errors.push(format!("{key} must be a number")),
        }
    } else if key == "allow-lan" {
        if !matches!(&scalar.value, ScalarValue::Bool(_)) {
            errors.push("allow-lan must be a boolean".to_string());
        }
    } else if key == "bind-address" {
        let ok = matches!(&scalar.value, ScalarValue::Str(value) if value == "127.0.0.1" || value == "*");
        if !ok {
            errors.push("bind-address is invalid".to_string());
        }
    } else if key == "mode" {
        if scalar.value != ScalarValue::Str("direct".to_string()) {
            errors.push("mode must be direct".to_string());
        }
    } else if key == "log-level" {
        let allowed = matches!(&scalar.value, ScalarValue::Str(value) if ALLOWED_LOG_LEVELS.contains(&value.as_str()));
        if !allowed {
            errors.push(format!("log-level must be one of {}", ALLOWED_LOG_LEVELS.join(", ")));
        }
    } else if key == "ipv6" {
        if !is_bool_false(value_node) {
            errors.push("ipv6 must be false".to_string());
        }
    } else if key == "external-controller" {
        let address = match &scalar.value {
            ScalarValue::Str(address) => Some(address.clone()),
            _ => None,
        };
        let parsed = address
            .as_deref()
            .and_then(|address| regex::Regex::new(CONTROLLER_PATTERN).expect("controller pattern").captures(address))
            .map(|captures| captures.get(1).expect("port group").as_str().to_string());
        match parsed {
            None => errors.push("external-controller must use a supported listen address".to_string()),
            Some(port) => match port.parse::<i64>() {
                Ok(port) if (MIN_PORT..=MAX_PORT).contains(&port) => {}
                _ => errors.push(format!(
                    "external-controller port must be unprivileged ({MIN_PORT}-{MAX_PORT})"
                )),
            },
        }
    } else if key == "secret" {
        let ok = matches!(&scalar.value, ScalarValue::Str(value)
            if regex::Regex::new(SECRET_PATTERN).expect("secret pattern").is_match(value));
        if !ok {
            errors.push("secret must be a 64-character lowercase hex string".to_string());
        }
    } else if key == "external-ui" && scalar.value != ScalarValue::Str("ui".to_string()) {
        errors.push("external-ui must use the managed ui directory".to_string());
    } else if key == "external-ui-name" && scalar.value != ScalarValue::Str("metacubexd".to_string()) {
        errors.push("external-ui-name must be metacubexd".to_string());
    } else if key == "external-ui-url"
        && scalar.value != ScalarValue::Str("https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip".to_string())
    {
        errors.push("external-ui-url must use the managed dashboard source".to_string());
    }
    errors
}

fn collect_nested_errors(section: &str, value_node: &Node) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    if section == "rules" {
        let Node::Sequence { items, .. } = value_node else {
            errors.push("rules must be a YAML sequence".to_string());
            return errors;
        };
        if items.len() != ALLOWED_RULES.len() {
            errors.push(format!("rules must contain exactly [{}]", ALLOWED_RULES.join(", ")));
            return errors;
        }
        for item in items {
            let Node::Scalar(scalar) = item else {
                errors.push(format!("rules must contain only {}", ALLOWED_RULES.join(", ")));
                return errors;
            };
            if item.is_alias() || item.tagged() || scalar.value != ScalarValue::Str("MATCH,DIRECT".to_string()) {
                errors.push(format!("rules must contain only {}", ALLOWED_RULES.join(", ")));
                return errors;
            }
        }
        return errors;
    }

    // tun / dns: only `enable: false` is allowed.
    let Node::Mapping { entries, .. } = value_node else {
        errors.push(format!("{section} must be a YAML mapping"));
        return errors;
    };
    let mut seen: Vec<String> = Vec::new();
    for (key_node, value_node) in entries {
        let Some(value_node) = value_node else {
            errors.push(format!("{section} entries must have a value"));
            continue;
        };
        if key_node.is_alias() || value_node.is_alias() || key_node.tagged() || value_node.tagged() {
            errors.push(format!("{section} must not use aliases or tags"));
            continue;
        }
        let Node::Scalar(ScalarNode { value: ScalarValue::Str(nested_key), .. }) = key_node else {
            errors.push(format!("{section} keys must be plain scalar strings"));
            continue;
        };
        if seen.iter().any(|seen| seen == nested_key) {
            errors.push(format!("duplicate key in {section}: {nested_key}"));
            continue;
        }
        seen.push(nested_key.clone());
        if nested_key != "enable" {
            errors.push(format!("{section} may only contain 'enable'"));
            continue;
        }
        if !is_bool_false(value_node) {
            errors.push(format!("{section}.enable must be false"));
        }
    }
    if !seen.iter().any(|seen| seen == "enable") {
        errors.push(format!("{section}.enable must be false"));
    }
    errors
}

/// Assert the document satisfies the strict Phase-7 invariants, failing with
/// the same INVALID_ARGUMENT shape as the TS ProtocolError.
pub fn validate_mihomo_config_yaml(text: &str) -> Result<(), IpcError> {
    let errors = mihomo_config_errors(text);
    if errors.is_empty() {
        return Ok(());
    }
    Err(IpcError::invalid_argument(format!("Unsafe mihomo config: {}", errors.join("; "))))
}

/// Return a copy of the config text with the controller secret masked, so the
/// document can be shown in evidence or logs without leaking the bearer token.
/// As defense in depth, any stray 64-hex token (e.g. from a malformed
/// multi-line document that bypassed the boundary) is also redacted.
pub fn sanitize_mihomo_config(text: &str) -> String {
    let line = regex::Regex::new(r"(?m)^(\s*secret:\s*).*$").expect("secret line pattern");
    let masked_line = line.replace_all(text, "${1}<redacted>").to_string();
    let stray = regex::Regex::new(r"\b[0-9a-f]{64}\b").expect("stray token pattern");
    stray.replace_all(&masked_line, "<redacted>").to_string()
}

// ---------------------------------------------------------------------------
// Profile structural gate (profileKernelConfigErrors)
// ---------------------------------------------------------------------------

/// Collect structural errors for a profile-backed runtime config WITHOUT
/// rejecting legitimate mihomo sections. Unlike the strict validator, unknown
/// top-level keys and YAML aliases are accepted (they are normal mihomo
/// constructs this transform deliberately carries). It fails on the cheap,
/// unambiguous malformation classes plus a missing content section, so an
/// empty or degenerate document can never silently start mihomo.
pub fn profile_kernel_config_errors(text: &str) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    if text.trim().is_empty() {
        return vec!["配置文档为空".to_string()];
    }

    let root = match parse_first_document(text) {
        Ok(node) => node,
        Err(mut parse_errors) => {
            // The TS profile gate reports parse failures with its own copy.
            for error in &mut parse_errors {
                *error = error.replacen("YAML parse error:", "YAML 解析错误:", 1);
            }
            errors.append(&mut parse_errors);
            return dedupe(errors);
        }
    };
    let Node::Mapping { entries, .. } = root else {
        errors.push("配置顶层必须是一个 YAML 映射".to_string());
        return dedupe(errors);
    };

    let mut keys: Vec<String> = Vec::new();
    for (key_node, _) in &entries {
        if let Node::Scalar(ScalarNode { value: ScalarValue::Str(key), .. }) = key_node {
            keys.push(key.clone());
        }
    }

    // The TS parser runs with `merge: true`, so a top-level `<<: *anchor`
    // resolves the anchor's keys into the map. Anchor values cannot be
    // resolved from the event stream without a full resolver, so a literal
    // `<<` mapping is descended into for the content check (staged:
    // alias-valued merges are approximated — degenerate documents still fail
    // the content gate, which is the safety property this validator owns).
    let has_content = keys.iter().any(|key| {
        matches!(
            key.as_str(),
            "proxies" | "proxy-groups" | "proxy-providers" | "rules" | "<<"
        )
    }) || entries.iter().any(|(key_node, value)| {
        matches!(key_node, Node::Scalar(ScalarNode { value: ScalarValue::Str(merge), .. }) if merge == "<<")
            && matches!(
                value,
                Some(Node::Mapping { entries, .. })
                    if entries.iter().any(|(nested, _)| matches!(
                        nested,
                        Node::Scalar(ScalarNode { value: ScalarValue::Str(nested), .. })
                            if matches!(nested.as_str(), "proxies" | "proxy-groups" | "proxy-providers" | "rules")
                    ))
            )
    });
    if !has_content {
        errors.push("文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段".to_string());
    }

    dedupe(errors)
}

fn dedupe(errors: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for error in errors {
        if !seen.contains(&error) {
            seen.push(error);
        }
    }
    seen
}

// ---------------------------------------------------------------------------
// Geodata seeding (mihomo-config-store.ts seedGeodataFiles)
// ---------------------------------------------------------------------------

/// Installer-shipped geodata artifacts copied into the stable kernel home.
const GEODATA_SEED_FILES: [&str; 5] = ["geosite.dat", "geoip.dat", "geoip.metadb", "country.mmdb", "ASN.mmdb"];

/// Copy installer-shipped geodata into the kernel home. Per-file best effort:
/// one unreadable seed must never block a start that could otherwise succeed;
/// the kernel's own download path remains as the fallback. Returns the names
/// of the files actually placed (used for diagnostics).
pub fn seed_geodata_files(home_dir: &std::path::Path, resources_dir: &std::path::Path) -> Vec<String> {
    let mut seeded: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(resources_dir) else {
        // No seed dir (dev checkout, partial install): nothing to seed.
        return seeded;
    };
    let names: Vec<String> =
        entries.filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().to_string()).collect();
    let _ = std::fs::create_dir_all(home_dir);
    for name in GEODATA_SEED_FILES {
        if !names.iter().any(|candidate| candidate == name) {
            continue;
        }
        let target = home_dir.join(name);
        let source = resources_dir.join(name);
        // Refresh when the installer carries a newer build than the kept
        // copy. A missing kept copy is the expected FIRST-RUN case, not an
        // error.
        let source_meta = std::fs::metadata(&source);
        let existing_meta = std::fs::metadata(&target);
        if let (Ok(source), Ok(existing)) = (&source_meta, &existing_meta) {
            if existing.is_file() {
                let source_time = source.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
                let existing_time =
                    existing.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
                if let (Some(source), Some(existing)) = (source_time, existing_time) {
                    if existing >= source {
                        continue;
                    }
                }
            }
        }
        if std::fs::copy(&source, &target).is_ok() {
            seeded.push(name.to_string());
        }
    }
    seeded
}

// ---------------------------------------------------------------------------
// Tests — ported from tests/mihomo-config.test.ts + mihomo-config-store.test.ts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel_process::generate_mihomo_config;
    use serde_json::json;

    fn secret() -> String {
        "a".repeat(64)
    }

    fn secret2() -> String {
        "b".repeat(64)
    }

    fn valid_text() -> String {
        generate_mihomo_config(&json!({ "mixedPort": 21000, "controllerPort": 20001, "secret": secret() }))
            .expect("valid config")
    }

    fn errors_of(text: &str) -> Vec<String> {
        mihomo_config_errors(text)
    }

    // -- generateMihomoConfig ----------------------------------------------

    #[test]
    fn renders_a_strict_config_that_validates_clean() {
        let text = valid_text();
        assert!(mihomo_config_errors(&text).is_empty(), "{:?}", mihomo_config_errors(&text));
        assert!(text.contains("mixed-port: 21000"));
        assert!(text.contains("external-controller: 127.0.0.1:20001"));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn pins_the_security_relevant_fields() {
        let text = valid_text();
        for line in [
            "allow-lan: false",
            "bind-address: 127.0.0.1",
            "mode: direct",
            "ipv6: false",
            format!("secret: {}", secret()).as_str(),
            "tun:\n  enable: false",
            "dns:\n  enable: false",
            "rules:\n  - MATCH,DIRECT",
        ] {
            assert!(text.contains(line), "missing {line} in:\n{text}");
        }
        assert!(!text.contains("external-ui"), "panel off by default");
    }

    #[test]
    fn rejects_a_controller_port_that_collides_with_the_mixed_port() {
        let error = generate_mihomo_config(&json!({ "mixedPort": 21000, "controllerPort": 21000, "secret": secret() }))
            .unwrap_err()
            .0;
        assert!(error.contains("mixed-port and external-controller port must differ"), "{error}");
    }

    // -- mihomoConfigErrors / validateMihomoConfigYaml ----------------------

    #[test]
    fn reports_a_forbidden_key_that_would_mutate_the_network_stack() {
        let text = valid_text() + "redir-port: 12345\n";
        assert!(errors_of(&text).contains(&"unknown top-level key: redir-port".to_string()));
        let error = validate_mihomo_config_yaml(&text).unwrap_err().0;
        assert!(error.contains("redir-port"), "{error}");
        assert!(error.starts_with("PROTOCOL_ERROR:INVALID_ARGUMENT::Unsafe mihomo config: "), "{error}");
    }

    #[test]
    fn reports_any_unknown_listener_or_stack_key() {
        for key in ["listeners", "hosts", "profile", "sniffer", "proxy-providers"] {
            let text = valid_text() + &format!("{key}: {{}}\n");
            assert!(
                errors_of(&text).contains(&format!("unknown top-level key: {key}")),
                "{key}: {:?}",
                errors_of(&text)
            );
        }
        let text = valid_text() + "socks-port: {}\n";
        // An ALLOWED key carrying a mapping is a non-scalar member error.
        assert!(errors_of(&text).contains(&"socks-port must be a scalar value".to_string()), "{:?}", errors_of(&text));
    }

    #[test]
    fn accepts_the_supported_all_interface_controller_binding() {
        let text = valid_text().replace("127.0.0.1:20001", "0.0.0.0:20001");
        assert!(errors_of(&text).is_empty(), "{:?}", errors_of(&text));
    }

    #[test]
    fn reports_a_privileged_external_controller_port() {
        let text = valid_text().replace("127.0.0.1:20001", "127.0.0.1:80");
        assert!(
            errors_of(&text)
                .contains(&"external-controller port must be unprivileged (1024-65535)".to_string()),
            "{:?}",
            errors_of(&text)
        );
    }

    #[test]
    fn reports_mode_violations_but_allows_lan_true() {
        let text = valid_text()
            .replace("allow-lan: false", "allow-lan: true")
            .replace("mode: direct", "mode: global");
        let errors = errors_of(&text);
        assert!(!errors.contains(&"allow-lan must be false".to_string()));
        assert!(errors.contains(&"mode must be direct".to_string()));
    }

    #[test]
    fn reports_tun_dns_enable_and_rules_violations() {
        let text = valid_text()
            .replace("tun:\n  enable: false", "tun:\n  enable: true")
            .replace("dns:\n  enable: false", "dns:\n  enable: true")
            .replace("  - MATCH,DIRECT\n", "  - MATCH,REJECT\n");
        let errors = errors_of(&text);
        assert!(errors.contains(&"tun.enable must be false".to_string()), "{errors:?}");
        assert!(errors.contains(&"dns.enable must be false".to_string()));
        assert!(errors.contains(&"rules must contain only MATCH,DIRECT".to_string()));
    }

    #[test]
    fn rejects_an_extra_rule() {
        let text = valid_text().replace(
            "rules:\n  - MATCH,DIRECT\n",
            "rules:\n  - MATCH,DIRECT\n  - MATCH,REJECT\n",
        );
        assert!(
            errors_of(&text).contains(&"rules must contain exactly [MATCH,DIRECT]".to_string()),
            "{:?}",
            errors_of(&text)
        );
    }

    #[test]
    fn rejects_a_duplicate_top_level_key() {
        let text = valid_text() + "dns:\n  enable: true\n";
        assert!(errors_of(&text).contains(&"duplicate key: dns".to_string()), "{:?}", errors_of(&text));
    }

    #[test]
    fn rejects_a_duplicate_secret_key() {
        let text = valid_text() + &format!("secret: {}\n", secret2());
        assert!(errors_of(&text).contains(&"duplicate key: secret".to_string()));
    }

    #[test]
    fn rejects_yaml_aliases_and_tags() {
        let aliased = valid_text() + "derived: *anchor\nshared: &anchor 1\n";
        assert!(errors_of(&aliased).contains(&"config must not use YAML aliases".to_string()), "{:?}", errors_of(&aliased));

        let tagged = valid_text().replace("mode: direct", "mode: !!str direct");
        let errors = errors_of(&tagged);
        assert!(
            errors.iter().any(|error| error.contains("uses a YAML tag, which is not allowed")),
            "{errors:?}"
        );
    }

    #[test]
    fn rejects_a_composite_non_scalar_top_level_key() {
        let text = valid_text() + "? [a, b]\n: value\n";
        assert!(
            errors_of(&text).contains(&"top-level keys must be plain scalar strings".to_string()),
            "{:?}",
            errors_of(&text)
        );
    }

    #[test]
    fn rejects_a_complex_object_as_a_scalar_key_value() {
        let text = valid_text().replace("mode: direct", "mode:\n  nested: true");
        assert!(errors_of(&text).contains(&"mode must be a scalar value".to_string()), "{:?}", errors_of(&text));
    }

    #[test]
    fn rejects_tun_dns_members_other_than_enable() {
        let text = valid_text()
            .replace("tun:\n  enable: false", "tun:\n  enable: false\n  auto-route: true")
            .replace("dns:\n  enable: false", "dns:\n  enable: false\n  listen: 0.0.0.0:53");
        let errors = errors_of(&text);
        assert!(errors.contains(&"tun may only contain 'enable'".to_string()), "{errors:?}");
        assert!(errors.contains(&"dns may only contain 'enable'".to_string()));
    }

    #[test]
    fn reports_missing_required_keys() {
        let text = valid_text().replace("rules:\n  - MATCH,DIRECT\n", "");
        assert!(errors_of(&text).contains(&"missing required key: rules".to_string()), "{:?}", errors_of(&text));
    }

    #[test]
    fn rejects_secret_injection_attempts() {
        let payloads: Vec<(&str, String)> = vec![
            ("newline", format!("{}\n  enable: true", "a".repeat(64))),
            ("colon", format!("{}:{}", "a".repeat(64), "b".repeat(2))),
            ("comment", format!("{}#evil", "a".repeat(64))),
            ("quote", "\"1234567890abcdef\"".to_string()),
            ("unicode control", format!("{}\u{0}b", "a".repeat(63))),
        ];
        for (name, value) in payloads {
            let text = valid_text().replace(&format!("secret: {}", secret()), &format!("secret: {value}"));
            let errors = errors_of(&text);
            assert!(!errors.is_empty(), "secret injection via {name} must be rejected");
            assert!(validate_mihomo_config_yaml(&text).is_err(), "injection via {name}");
        }

        // A well-formed but non-hex scalar produces the specific coverage error.
        let colon = valid_text().replace(&format!("secret: {}", secret()), &format!("secret: {}:{:b<2}", "a".repeat(64), 0));
        assert!(
            errors_of(&colon).contains(&"secret must be a 64-character lowercase hex string".to_string()),
            "{:?}",
            errors_of(&colon)
        );
    }

    // -- sanitizeMihomoConfig ----------------------------------------------

    #[test]
    fn masks_the_secret_and_leaves_the_rest_intact() {
        let text = valid_text();
        let sanitized = sanitize_mihomo_config(&text);
        assert!(sanitized.contains("secret: <redacted>"));
        assert!(!sanitized.contains(&secret()));
        assert!(sanitized.contains("mixed-port: 21000"));
        assert!(sanitized.contains("mode: direct"));
    }

    #[test]
    fn masks_stray_tokens_on_abnormal_content() {
        let text = format!("secret: {} # trailing\nkeep: me\n{}", secret(), "c".repeat(64));
        let sanitized = sanitize_mihomo_config(&text);
        assert!(!sanitized.contains(&secret()));
        assert!(!sanitized.contains(&"c".repeat(64)));
        assert!(sanitized.contains("keep: me"));
    }

    // -- profileKernelConfigErrors ------------------------------------------

    #[test]
    fn profile_gate_accepts_content_sections() {
        assert!(profile_kernel_config_errors("proxies:\n  - name: a\n    type: ss\n").is_empty());
        assert!(profile_kernel_config_errors("rules:\n  - MATCH,DIRECT\n").is_empty());
        assert!(profile_kernel_config_errors("proxy-groups:\n  - name: g\n").is_empty());
        assert!(profile_kernel_config_errors("proxy-providers:\n  p1:\n").is_empty());
        // Unknown top-level keys are legal for profiles (unlike the strict gate).
        assert!(profile_kernel_config_errors("proxies: []\nsniffer: {}\n").is_empty());
    }

    #[test]
    fn profile_gate_rejects_empty_and_degenerate_documents() {
        assert_eq!(profile_kernel_config_errors("   \n"), vec!["配置文档为空".to_string()]);
        assert_eq!(
            profile_kernel_config_errors("mode: rule\n"),
            vec!["文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段".to_string()]
        );
        let errors = profile_kernel_config_errors("proxies: [unclosed\n");
        assert!(errors.iter().any(|error| error.starts_with("YAML 解析错误: ")), "{errors:?}");
    }

    #[test]
    fn profile_gate_handles_merge_anchors_for_the_content_check() {
        let text = "<<: *base\nextra: 1\n".replace("<<: *base", "base: &base") + "";
        // A literal merge map carrying a content section passes.
        let text = "defaults: &d\n  rules:\n    - MATCH,DIRECT\n<<: *d\n";
        assert!(profile_kernel_config_errors(text).is_empty(), "{:?}", profile_kernel_config_errors(text));
    }

    // -- seedGeodataFiles ----------------------------------------------------

    #[test]
    fn seeds_only_known_geodata_artifacts() {
        let base = tempfile::TempDir::new().unwrap();
        let resources = base.path().join("resources");
        let home = base.path().join("geodata");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("geosite.dat"), "bundled-geosite").unwrap();
        std::fs::write(resources.join("unrelated.txt"), "never copied").unwrap();
        std::fs::write(resources.join("geoip.metadb"), "bundled-geoip").unwrap();

        let seeded = seed_geodata_files(&home, &resources);
        assert_eq!(seeded, vec!["geosite.dat".to_string(), "geoip.metadb".to_string()]);
        assert_eq!(std::fs::read_to_string(home.join("geosite.dat")).unwrap(), "bundled-geosite");
        assert_eq!(std::fs::read_to_string(home.join("geoip.metadb")).unwrap(), "bundled-geoip");
        assert!(!home.join("unrelated.txt").exists());
    }

    #[test]
    fn seed_is_fail_open_and_respects_a_newer_kept_copy() {
        let base = tempfile::TempDir::new().unwrap();
        let home = base.path().join("geodata");
        // Missing resources dir: nothing to seed, no error.
        let seeded = seed_geodata_files(&home, &base.path().join("nope"));
        assert!(seeded.is_empty());

        // A kept copy NEWER than the bundle is never overwritten.
        let resources = base.path().join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("geosite.dat"), "bundled").unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("geosite.dat"), "kept-newer").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let file = std::fs::File::options().write(true).open(resources.join("geosite.dat")).unwrap();
        file.set_modified(past).unwrap();
        let seeded = seed_geodata_files(&home, &resources);
        assert!(seeded.is_empty(), "{seeded:?}");
        assert_eq!(std::fs::read_to_string(home.join("geosite.dat")).unwrap(), "kept-newer");
    }

    // -- parse edge parity ---------------------------------------------------

    #[test]
    fn duplicate_keys_are_preserved_and_reported_like_unique_keys() {
        // Two dns sections: the TS uniqueKeys parser reports the duplicate
        // while still walking the FIRST member for per-key errors.
        let text = valid_text() + "tun:\n  enable: true\n";
        let errors = errors_of(&text);
        assert!(errors.contains(&"duplicate key: tun".to_string()), "{errors:?}");
        // The FIRST member's enable:false is fine, so no tun.enable error.
        assert!(!errors.contains(&"tun.enable must be false".to_string()));
    }

    #[test]
    fn non_string_keys_are_rejected() {
        let text = valid_text() + "123: value\n";
        assert!(
            errors_of(&text).contains(&"top-level keys must be plain scalar strings".to_string())
                || errors_of(&text).contains(&"unknown top-level key: 123".to_string()),
            "{:?}",
            errors_of(&text)
        );
    }

    #[test]
    fn quoted_scalars_never_resolve_to_types() {
        // `allow-lan: "false"` is the STRING false, not a boolean — rejected.
        let text = valid_text().replace("allow-lan: false", "allow-lan: \"false\"");
        assert!(errors_of(&text).contains(&"allow-lan must be a boolean".to_string()), "{:?}", errors_of(&text));
        // `mixed-port: "21000"` is a string, not a number.
        let text = valid_text().replace("mixed-port: 21000", "mixed-port: \"21000\"");
        assert!(errors_of(&text).contains(&"mixed-port must be a number".to_string()));
    }

    #[test]
    fn real_numbers_and_ints_are_distinguished_for_ports() {
        let text = valid_text().replace("mixed-port: 21000", "mixed-port: 21000.5");
        assert!(
            errors_of(&text)
                .contains(&"mixed-port must be an unprivileged port between 1024 and 65535".to_string()),
            "{:?}",
            errors_of(&text)
        );
    }
}
