//! TUN profile generation — Rust port of `main/tun/mihomo-tun-config.ts`
//! (`generateMihomoTunConfig` / `mihomoTunConfigErrors` /
//! `generateProxiedTunConfig` / `proxiedTunConfigErrors`).
//!
//! Two profiles exist and the difference is deliberate:
//! - the BOOTSTRAP profile is the only Phase-9B document a fresh privileged
//!   start may receive: an exact top-level allowlist, `mode: direct`,
//!   `MATCH,DIRECT` and a controlled DNS block — it can start the kernel
//!   before any user content exists;
//! - the PROXIED profile carries the user's real subscription content: the
//!   main-kernel safety transform (`buildProfileKernelConfig`) is reused
//!   verbatim, `tun` is re-added on top of the transform that intentionally
//!   removed it, and validation is limited to the NON-NEGOTIABLE invariants
//!   the privileged service re-checks independently (no public bind, no
//!   unauthenticated controller surface, no extra inbound, no alias/tag
//!   tricks, TUN actually on, provider writes confined to the state
//!   directory).
//!
//! Staged approximations (documented, same as the profile gate):
//! - YAML merge keys (`<<: *anchor`) are not resolved by the event-stream
//!   parser; documents using them are validated on their literal content
//!   and a merge-resolver lands with the resolver slice.
//! - Error copy for duplicate keys follows the shared Rust validator
//!   convention (`duplicate tun key: x`) rather than the `yaml` package's
//!   parse-error wording; the accept/reject decision is identical.

use serde_json::{json, Map, Value};

use crate::error::{code, IpcError};
use crate::kernel_config_validation::{
    parse_first_document, Node, ScalarNode, ScalarValue, SECRET_PATTERN,
};

const PORT_MIN: i64 = 1024;
const PORT_MAX: i64 = 65535;

/// The service enforces a hard 2 MiB ceiling on the submitted profile
/// (`maxProfileBytes` in native/tun-service/protocol.go). Fail with a legible
/// message instead of letting the service close the pipe without a response.
pub const TUN_PROFILE_MAX_BYTES: usize = 2 * 1024 * 1024;

/// `shared/tun-config.ts EMPTY_TUN_CONFIG.device` — the stock default marks
/// "the user did not customize the device".
const EMPTY_TUN_DEVICE: &str = "Mihomo";

const DEVICE_PATTERN: &str = "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$";
const STACKS: [&str; 3] = ["mixed", "system", "gvisor"];
const LOG_LEVELS: [&str; 5] = ["silent", "error", "warn", "info", "debug"];

const TOP_KEYS: [&str; 16] = [
    "port", "socks-port", "mixed-port", "allow-lan", "bind-address", "mode", "log-level", "ipv6",
    "external-controller", "secret", "external-ui", "external-ui-url", "external-ui-name", "tun",
    "dns", "rules",
];
const REQUIRED_TOP_KEYS: [&str; 11] = [
    "mixed-port", "allow-lan", "bind-address", "mode", "log-level", "ipv6",
    "external-controller", "secret", "tun", "dns", "rules",
];
const TUN_KEYS: [&str; 7] = [
    "enable", "device", "stack", "auto-route", "auto-detect-interface", "strict-route",
    "dns-hijack",
];
const OPTIONAL_TUN_KEYS: [&str; 3] = ["mtu", "route-address", "route-exclude-address"];
const DNS_KEYS: [&str; 5] = [
    "enable", "enhanced-mode", "fake-ip-range", "fake-ip-filter", "nameserver",
];

/// Top-level keys that must never reach the elevated child, mirroring the
/// service-side blacklist (`native/tun-service/protocol.go forbiddenTopKeys`
/// — the lists must stay in lockstep so a subscription that carries one is
/// stripped here instead of failing opaquely at the service).
const FORBIDDEN_TOP_KEYS: [&str; 14] = [
    "redir-port", "tproxy-port", "listeners", "tunnels",
    "external-controller-unix", "external-controller-pipe", "external-controller-tls",
    "external-controller-routing-mark", "external-controller-cors", "external-doh-server",
    "ntp",
    "ss-config", "vmess-config", "tuic-server",
];

/// Sections whose entries carry a `path` mihomo WRITES downloaded content to.
const PROVIDER_SECTIONS: [&str; 2] = ["proxy-providers", "rule-providers"];

/// Hosts kept on real IPs under fake-ip mode, clash-party's shipped default
/// verbatim. Only injected when the profile omits its own filter.
const TUN_DEFAULT_FAKE_IP_FILTER: [&str; 6] =
    ["*", "+.lan", "+.local", "time.*.com", "ntp.*.com", "+.market.xiaomi.com"];

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::code(code::INVALID_ARGUMENT, message.into())
}

fn assert_port(value: i64, label: &str) -> Result<(), IpcError> {
    if value < PORT_MIN || value > PORT_MAX {
        return Err(invalid(format!(
            "{label} must be an integer between {PORT_MIN} and {PORT_MAX}"
        )));
    }
    Ok(())
}

/// Resolve the effective `tun.device` (adapter identity). The brand-derived
/// intent is the DEFAULT; the persisted TUN config model overrides it only
/// when the user actually customized the device.
fn resolve_device(model: Option<&Value>, fallback: &str) -> String {
    match model {
        None => fallback.to_string(),
        Some(model) => {
            let device = model["device"].as_str().unwrap_or_default();
            if device == EMPTY_TUN_DEVICE { fallback.to_string() } else { device.to_string() }
        }
    }
}

fn is_valid_tun_mtu(value: i64) -> bool {
    (576..=65535).contains(&value)
}

fn device_pattern_matches(device: &str) -> bool {
    regex::Regex::new(DEVICE_PATTERN).expect("device pattern").is_match(device)
}

fn scalar_text(node: &Node) -> Option<&str> {
    match node {
        Node::Scalar(ScalarNode { value: ScalarValue::Str(text) | ScalarValue::Real(text), .. }) => {
            Some(text)
        }
        _ => None,
    }
}

fn is_int_in(node: &Node, min: i64, max: i64) -> bool {
    matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Int(int), .. })
        if *int >= min && *int <= max)
}

fn is_bool(node: &Node) -> bool {
    matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Bool(_), .. }))
}

fn is_bool_value(node: &Node, expected: bool) -> bool {
    matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Bool(value), .. }) if *value == expected)
}

/// `isValidDnsHijackEntry` (shared/tun-config.ts).
fn is_valid_dns_hijack_entry(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    if v == "any" {
        return true;
    }
    if let Some(rest) = v.strip_prefix('[') {
        let Some(close) = rest.find(']') else {
            return false;
        };
        let host = &rest[..close];
        if !crate::net_validators::is_valid_ip(host) {
            return false;
        }
        let after = &rest[close..];
        if after == "]" {
            return true;
        }
        let port = after.trim_start_matches(']');
        return port.starts_with(':') && is_single_port(&port[1..]);
    }
    match v.rfind(':') {
        None => crate::net_validators::is_valid_ip(v) || crate::net_validators::is_valid_hostname(v),
        Some(idx) => {
            let (host_part, port_part) = (&v[..idx], &v[idx + 1..]);
            if !is_single_port(port_part) {
                return false;
            }
            host_part == "any"
                || crate::net_validators::is_valid_ip(host_part)
                || crate::net_validators::is_valid_hostname(host_part)
        }
    }
}

fn is_single_port(value: &str) -> bool {
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    value.parse::<u32>().map(|n| (1..=65535).contains(&n)).unwrap_or(false)
}

fn is_valid_tun_route_address(value: &str) -> bool {
    crate::net_validators::is_valid_address_or_cidr(value)
}

/// Shared `mapping()` helper: scalar string keys with values, unknown/duplicate
/// keys reported against the allowed set.
fn mapping<'a>(
    node: &'a Node,
    allowed: &[&str],
    label: &str,
    errors: &mut Vec<String>,
) -> Vec<(&'a str, &'a Node)> {
    let mut found: Vec<(&str, &Node)> = Vec::new();
    let Node::Mapping { entries, .. } = node else {
        errors.push(format!("{label} must be a mapping"));
        return found;
    };
    for (key_node, value_node) in entries {
        let Some(key) = scalar_text(key_node) else {
            errors.push(format!("{label} keys must be scalar strings with values"));
            continue;
        };
        let Some(value) = value_node else {
            errors.push(format!("{label} keys must be scalar strings with values"));
            continue;
        };
        if !allowed.contains(&key) {
            errors.push(format!("unknown {label} key: {key}"));
        }
        if found.iter().any(|(seen, _)| *seen == key) {
            errors.push(format!("duplicate {label} key: {key}"));
        }
        found.push((key, value));
    }
    found
}

fn require_exact_keys(found: &[(&str, &Node)], required: &[&str], label: &str, errors: &mut Vec<String>) {
    for key in required {
        if !found.iter().any(|(seen, _)| seen == key) {
            errors.push(format!("missing {label} key: {key}"));
        }
    }
}

fn scalar_matches(found: &[(&str, &Node)], key: &str, test: impl Fn(&Node) -> bool, message: &str, errors: &mut Vec<String>) {
    match found.iter().find(|(seen, _)| *seen == key) {
        Some((_, node)) if test(node) => {}
        _ => errors.push(message.to_string()),
    }
}

fn scalar_equals_str(found: &[(&str, &Node)], key: &str, expected: &str, errors: &mut Vec<String>) {
    scalar_matches(
        found,
        key,
        |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if value == expected),
        &format!("{key} must equal {expected}"),
        errors,
    )
}

fn sequence_equals(node: &Node, expected: &[&str], label: &str, errors: &mut Vec<String>) {
    let Node::Sequence { items, .. } = node else {
        errors.push(format!("{label} must contain exactly [{}]", expected.join(", ")));
        return;
    };
    let matches = items.len() == expected.len()
        && items.iter().zip(expected).all(|(item, expect)| {
            matches!(item, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if value == expect)
        });
    if !matches {
        errors.push(format!("{label} must contain exactly [{}]", expected.join(", ")));
    }
}

fn validate_route_list(node: &Node, label: &str, errors: &mut Vec<String>) {
    let Node::Sequence { items, .. } = node else {
        errors.push(format!("{label} must be a non-empty sequence"));
        return;
    };
    if items.is_empty() {
        errors.push(format!("{label} must be a non-empty sequence"));
        return;
    }
    for item in items {
        let Some(text) = scalar_text(item) else {
            errors.push(format!("invalid {label} entry:"));
            continue;
        };
        if !is_valid_tun_route_address(text) {
            errors.push(format!("invalid {label} entry: {text}"));
        }
    }
}

/// Reject aliases and explicit tags anywhere in the document.
fn scan_unsafe_nodes(node: &Node, errors: &mut Vec<String>) {
    match node {
        Node::Alias => errors.push("YAML aliases are not allowed".to_string()),
        Node::Scalar(ScalarNode { tag, .. }) | Node::Sequence { tag, .. } | Node::Mapping { tag, .. } => {
            if tag.is_some() {
                errors.push("YAML tags are not allowed".to_string());
            }
        }
    }
    if let Node::Mapping { entries, .. } = node {
        for (key, value) in entries {
            scan_unsafe_nodes(key, errors);
            if let Some(value) = value {
                scan_unsafe_nodes(value, errors);
            }
        }
    }
    if let Node::Sequence { items, .. } = node {
        for item in items {
            scan_unsafe_nodes(item, errors);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap profile (generateMihomoTunConfig / mihomoTunConfigErrors)         */
/* -------------------------------------------------------------------------- */

/// Generate the only supported Phase 9B bootstrap profile. No I/O performed.
/// When `tunConfig` is present its fields are folded into the `tun:` block;
/// otherwise the conservative safe defaults are emitted unchanged. Every
/// generated profile, regardless of source, must still pass
/// `mihomo_tun_config_errors`.
pub fn generate_mihomo_tun_config(options: &Value) -> Result<String, IpcError> {
    let mixed_port = options["mixedPort"].as_i64().unwrap_or(0);
    let controller_port = options["controllerPort"].as_i64().unwrap_or(0);
    let http_port = options["httpPort"].as_i64().unwrap_or(0);
    let socks_port = options["socksPort"].as_i64().unwrap_or(0);
    let secret = options["secret"].as_str().unwrap_or_default();
    let model = options.get("tunConfig").filter(|model| model.is_object());

    assert_port(mixed_port, "mixed-port")?;
    assert_port(controller_port, "external-controller port")?;
    if mixed_port == controller_port {
        return Err(invalid("controller and mixed ports must differ"));
    }
    for (index, port) in [http_port, socks_port].into_iter().enumerate() {
        if port != 0 {
            assert_port(port, if index == 0 { "HTTP port" } else { "SOCKS port" })?;
        }
    }
    let mut active_ports = vec![mixed_port, controller_port];
    for port in [http_port, socks_port] {
        if port != 0 {
            active_ports.push(port);
        }
    }
    let unique: std::collections::HashSet<i64> = active_ports.iter().copied().collect();
    if unique.len() != active_ports.len() {
        return Err(invalid("listener ports must differ"));
    }
    if !crate::kernel_process::is_valid_secret(secret) {
        return Err(invalid("secret must be a 64-character lowercase hex string"));
    }
    let log_level = options["logLevel"].as_str().unwrap_or("info");
    if !LOG_LEVELS.contains(&log_level) {
        return Err(invalid(format!("unsupported log level: {log_level}")));
    }

    let device = resolve_device(model, options["device"].as_str().unwrap_or_default());
    if !device_pattern_matches(&device) {
        return Err(invalid("device contains unsupported characters or length"));
    }
    let stack = model
        .and_then(|model| model["stack"].as_str())
        .or_else(|| options["stack"].as_str())
        .unwrap_or("mixed");
    if !STACKS.contains(&stack) {
        return Err(invalid(format!("unsupported TUN stack: {stack}")));
    }

    let tun_enabled = options["tunEnabled"].as_bool().unwrap_or(true);
    let mut tun_lines = vec![
        "tun:".to_string(),
        format!("  enable: {tun_enabled}"),
        format!("  device: {device}"),
        format!("  stack: {stack}"),
    ];
    let model_mtu = model.and_then(|model| model["mtu"].as_i64()).filter(|mtu| is_valid_tun_mtu(*mtu));
    if let Some(mtu) = model_mtu {
        tun_lines.push(format!("  mtu: {mtu}"));
    }
    let hijack: Vec<String> = match model {
        Some(model) => model["dnsHijack"]
            .as_array()
            .map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        None => vec!["any:53".to_string()],
    };
    tun_lines.push(format!("  auto-route: {}", model.map(|model| model["autoRoute"].as_bool().unwrap_or(true)).unwrap_or(true)));
    tun_lines.push(format!("  auto-detect-interface: {}", model.map(|model| model["autoDetectInterface"].as_bool().unwrap_or(true)).unwrap_or(true)));
    tun_lines.push(format!("  strict-route: {}", model.map(|model| model["strictRoute"].as_bool().unwrap_or(false)).unwrap_or(false)));
    tun_lines.push("  dns-hijack:".to_string());
    for entry in &hijack {
        tun_lines.push(format!("    - {entry}"));
    }
    let route_address = model
        .map(|model| model["routeAddress"].as_array().map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default())
        .unwrap_or_default();
    if !route_address.is_empty() {
        tun_lines.push("  route-address:".to_string());
        for cidr in &route_address {
            tun_lines.push(format!("    - {cidr}"));
        }
    }
    let route_exclude = model
        .map(|model| model["routeExcludeAddress"].as_array().map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default())
        .unwrap_or_default();
    if !route_exclude.is_empty() {
        tun_lines.push("  route-exclude-address:".to_string());
        for cidr in &route_exclude {
            tun_lines.push(format!("    - {cidr}"));
        }
    }

    let allow_lan = options["allowLan"].as_bool().unwrap_or(false);
    let controller_panel = options["controllerPanel"].as_bool().unwrap_or(false);
    let controller_host = options["controllerHost"].as_str().unwrap_or("127.0.0.1");
    let mut lines: Vec<String> = Vec::new();
    if http_port != 0 {
        lines.push(format!("port: {http_port}"));
    }
    if socks_port != 0 {
        lines.push(format!("socks-port: {socks_port}"));
    }
    lines.push(format!("mixed-port: {mixed_port}"));
    lines.push(format!("allow-lan: {allow_lan}"));
    lines.push(format!("bind-address: {}", if allow_lan { "'*'" } else { "127.0.0.1" }));
    lines.push("mode: direct".to_string());
    lines.push(format!("log-level: {log_level}"));
    lines.push("ipv6: false".to_string());
    lines.push(format!("external-controller: {controller_host}:{controller_port}"));
    lines.push(format!("secret: {secret}"));
    if controller_panel {
        lines.push("external-ui: ui".to_string());
        lines.push("external-ui-name: metacubexd".to_string());
        lines.push("external-ui-url: https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip".to_string());
    }
    lines.extend(tun_lines);
    lines.push("dns:".to_string());
    lines.push("  enable: true".to_string());
    lines.push("  enhanced-mode: fake-ip".to_string());
    lines.push("  fake-ip-range: 198.18.0.1/16".to_string());
    lines.push("  fake-ip-filter:".to_string());
    // Quote glob entries: a leading `*` is a YAML alias token and would be
    // rejected by the no-alias validator.
    for entry in TUN_DEFAULT_FAKE_IP_FILTER {
        lines.push(format!("    - {}", json!(entry)));
    }
    lines.push("  nameserver:".to_string());
    lines.push("    - system".to_string());
    lines.push("rules:".to_string());
    lines.push("  - MATCH,DIRECT".to_string());
    lines.push(String::new());
    let text = lines.join("\n");

    let errors = mihomo_tun_config_errors(&text);
    if !errors.is_empty() {
        return Err(invalid(format!("generated TUN config failed validation: {}", errors.join("; "))));
    }
    Ok(text)
}

/// Strict validation for generated or persisted Phase 9B profiles.
pub fn mihomo_tun_config_errors(text: &str) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let root = match parse_first_document(text) {
        Ok(node) => node,
        Err(mut parse_errors) => {
            errors.append(&mut parse_errors);
            errors.push("config must be a YAML mapping".to_string());
            return dedupe(errors);
        }
    };
    scan_unsafe_nodes(&root, &mut errors);
    let Node::Mapping { .. } = root else {
        errors.push("config must be a YAML mapping".to_string());
        return dedupe(errors);
    };

    let root_map = mapping(&root, &TOP_KEYS, "config", &mut errors);
    require_exact_keys(&root_map, &REQUIRED_TOP_KEYS, "config", &mut errors);

    scalar_matches(&root_map, "allow-lan", is_bool, "allow-lan has an invalid value", &mut errors);
    scalar_matches(
        &root_map,
        "bind-address",
        |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if value == "127.0.0.1" || value == "*"),
        "bind-address has an invalid value",
        &mut errors,
    );
    scalar_equals_str(&root_map, "mode", "direct", &mut errors);
    scalar_matches(&root_map, "ipv6", |node| is_bool_value(node, false), "ipv6 must equal false", &mut errors);
    scalar_matches(&root_map, "mixed-port", |node| is_int_in(node, PORT_MIN, PORT_MAX), "mixed-port has an invalid value", &mut errors);
    for key in ["port", "socks-port"] {
        if root_map.iter().any(|(seen, _)| *seen == key) {
            scalar_matches(
                &root_map,
                key,
                |node| is_int_in(node, PORT_MIN, PORT_MAX),
                &format!("{key} has an invalid value"),
                &mut errors,
            );
        }
    }
    scalar_matches(
        &root_map,
        "external-controller",
        |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. })
            if regex::Regex::new(r"^(?:127\.0\.0\.1|0\.0\.0\.0):(?:[1-9]\d*)$").expect("controller pattern").is_match(value)),
        "external-controller has an invalid value",
        &mut errors,
    );
    scalar_matches(
        &root_map,
        "secret",
        |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. })
            if regex::Regex::new(SECRET_PATTERN).expect("secret pattern").is_match(value)),
        "secret has an invalid value",
        &mut errors,
    );
    scalar_matches(
        &root_map,
        "log-level",
        |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if LOG_LEVELS.contains(&value.as_str())),
        "log-level has an invalid value",
        &mut errors,
    );
    let has_ui = ["external-ui", "external-ui-name", "external-ui-url"]
        .iter()
        .any(|key| root_map.iter().any(|(seen, _)| seen == key));
    if has_ui {
        scalar_equals_str(&root_map, "external-ui", "ui", &mut errors);
        scalar_equals_str(&root_map, "external-ui-name", "metacubexd", &mut errors);
        scalar_equals_str(
            &root_map,
            "external-ui-url",
            "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
            &mut errors,
        );
    }

    let mut tun_allowed: Vec<&str> = TUN_KEYS.to_vec();
    tun_allowed.extend(OPTIONAL_TUN_KEYS);
    let tun_node = root_map.iter().find(|(seen, _)| *seen == "tun").map(|(_, node)| *node);
    match tun_node {
        None => errors.push("tun must be a mapping".to_string()),
        Some(tun_node) => {
            if !matches!(tun_node, Node::Mapping { .. }) {
                errors.push("tun must be a mapping".to_string());
            } else {
                let tun = mapping(tun_node, &tun_allowed, "tun", &mut errors);
                require_exact_keys(&tun, &TUN_KEYS, "tun", &mut errors);
                scalar_matches(&tun, "enable", is_bool, "tun.enable must be a boolean", &mut errors);
                // auto-route / auto-detect-interface / strict-route are
                // runtime-tunable via the TUN config model; only their type is
                // constrained here.
                scalar_matches(&tun, "auto-route", is_bool, "auto-route must be a boolean", &mut errors);
                scalar_matches(&tun, "auto-detect-interface", is_bool, "auto-detect-interface must be a boolean", &mut errors);
                scalar_matches(&tun, "strict-route", is_bool, "strict-route must be a boolean", &mut errors);
                scalar_matches(
                    &tun,
                    "device",
                    |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if device_pattern_matches(value)),
                    "device has an invalid value",
                    &mut errors,
                );
                scalar_matches(
                    &tun,
                    "stack",
                    |node| matches!(node, Node::Scalar(ScalarNode { value: ScalarValue::Str(value), .. }) if STACKS.contains(&value.as_str())),
                    "stack has an invalid value",
                    &mut errors,
                );
                match tun.iter().find(|(seen, _)| *seen == "dns-hijack") {
                    None => errors.push("missing tun key: dns-hijack".to_string()),
                    Some((_, hijack)) => match hijack {
                        Node::Sequence { items, .. } if !items.is_empty() => {
                            for item in items {
                                let Some(text) = scalar_text(item) else {
                                    errors.push("invalid tun.dns-hijack entry: ".to_string());
                                    continue;
                                };
                                if !is_valid_dns_hijack_entry(text) {
                                    errors.push(format!("invalid tun.dns-hijack entry: {text}"));
                                }
                            }
                        }
                        _ => errors.push("tun.dns-hijack must be a non-empty sequence".to_string()),
                    },
                }
                if let Some((_, mtu)) = tun.iter().find(|(seen, _)| *seen == "mtu") {
                    if !is_int_in(mtu, 576, 65535) {
                        errors.push("mtu must be an integer between 576 and 65535".to_string());
                    }
                }
                if let Some((_, list)) = tun.iter().find(|(seen, _)| *seen == "route-address") {
                    validate_route_list(list, "route-address", &mut errors);
                }
                if let Some((_, list)) = tun.iter().find(|(seen, _)| *seen == "route-exclude-address") {
                    validate_route_list(list, "route-exclude-address", &mut errors);
                }
            }
        }
    }

    let dns_node = root_map.iter().find(|(seen, _)| *seen == "dns").map(|(_, node)| *node);
    match dns_node {
        None => errors.push("dns must be a mapping".to_string()),
        Some(dns_node) => {
            if !matches!(dns_node, Node::Mapping { .. }) {
                errors.push("dns must be a mapping".to_string());
            } else {
                let dns = mapping(dns_node, &DNS_KEYS, "dns", &mut errors);
                require_exact_keys(&dns, &DNS_KEYS, "dns", &mut errors);
                scalar_matches(&dns, "enable", |node| is_bool_value(node, true), "enable must equal true", &mut errors);
                scalar_equals_str(&dns, "enhanced-mode", "fake-ip", &mut errors);
                scalar_equals_str(&dns, "fake-ip-range", "198.18.0.1/16", &mut errors);
                match dns.iter().find(|(seen, _)| *seen == "fake-ip-filter") {
                    Some((_, Node::Sequence { items, .. })) if !items.is_empty() => {
                        for item in items {
                            let Some(text) = scalar_text(item) else {
                                errors.push("dns.fake-ip-filter entries must be non-empty strings".to_string());
                                continue;
                            };
                            if text.is_empty() {
                                errors.push("dns.fake-ip-filter entries must be non-empty strings".to_string());
                            }
                        }
                    }
                    _ => errors.push("dns.fake-ip-filter must be a non-empty sequence".to_string()),
                }
                if let Some((_, nameserver)) = dns.iter().find(|(seen, _)| *seen == "nameserver") {
                    sequence_equals(nameserver, &["system"], "dns.nameserver", &mut errors);
                } else {
                    errors.push("dns.nameserver must contain exactly [system]".to_string());
                }
            }
        }
    }

    if let Some((_, rules)) = root_map.iter().find(|(seen, _)| *seen == "rules") {
        sequence_equals(rules, &["MATCH,DIRECT"], "rules", &mut errors);
    }
    dedupe(errors)
}

/// Throwing form of `mihomo_tun_config_errors`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn assert_mihomo_tun_config(text: &str) -> Result<(), IpcError> {
    let errors = mihomo_tun_config_errors(text);
    if errors.is_empty() {
        return Ok(());
    }
    Err(invalid(format!("unsafe TUN config: {}", errors.join("; "))))
}

/* -------------------------------------------------------------------------- */
/* Proxied TUN profile (real subscription content)                             */
/* -------------------------------------------------------------------------- */

/// Confine a provider `path` to the state directory. An absolute path or a
/// `..` escape would be an arbitrary file write performed by a
/// SYSTEM-privileged process. Returns None when the path is acceptable.
fn provider_path_error(path: &Value) -> Option<&'static str> {
    let Some(path) = path.as_str() else {
        return Some("must be a non-empty string");
    };
    if path.trim().is_empty() {
        return Some("must be a non-empty string");
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Some("must be relative to the state directory");
    }
    let drive = path.as_bytes();
    if drive.len() >= 2 && drive[1] == b':' && drive[0].is_ascii_alphabetic() {
        return Some("must be relative to the state directory");
    }
    if path.contains(':') {
        return Some("must not name a drive or alternate stream");
    }
    if path.replace('\\', "/").split('/').any(|segment| segment == "..") {
        return Some("must not traverse outside the state directory");
    }
    None
}

/// Collapse a provider name into a single safe filename component.
fn safe_provider_file_name(name: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    while cleaned.starts_with('.') {
        cleaned.remove(0);
    }
    if cleaned.is_empty() {
        return "provider".to_string();
    }
    cleaned.chars().take(64).collect()
}

/// Add literal proxy endpoint IPs to mihomo's TUN route exclusions: a proxy
/// tunnel cannot carry the socket used to establish itself. Literal endpoints
/// are protected; hostname endpoints and provider-managed nodes stay untouched.
fn exclude_literal_proxy_servers(data: &mut Map<String, Value>, tun_block: &mut Map<String, Value>) {
    let Some(proxies) = data.get("proxies").and_then(Value::as_array).cloned() else {
        return;
    };
    let mut existing: Vec<String> = tun_block
        .get("route-exclude-address")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let mut normalized: std::collections::HashSet<String> =
        existing.iter().map(|entry| entry.trim().to_lowercase()).collect();
    let mut changed = false;

    for proxy in &proxies {
        let Some(server) = proxy.get("server").map(|server| match server {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }) else {
            continue;
        };
        let host = server.trim().trim_start_matches('[').trim_end_matches(']').to_lowercase();
        let is_v4 = crate::net_validators::is_valid_ip(&host) && !host.contains(':');
        let is_v6 = crate::net_validators::is_valid_ip(&host) && host.contains(':');
        if !is_v4 && !is_v6 {
            continue;
        }
        let cidr = format!("{host}/{}", if is_v4 { 32 } else { 128 });
        if normalized.contains(&host) || normalized.contains(&cidr) {
            continue;
        }
        existing.push(cidr.clone());
        normalized.insert(cidr);
        changed = true;
    }

    if changed {
        tun_block.insert("route-exclude-address".into(), json!(existing));
    }
}

/// Build a TUN profile that actually proxies: the user's proxies, groups,
/// providers and rules are preserved and mihomo owns the adapter. The safety
/// transform is NOT reimplemented here — `build_profile_kernel_config` is
/// reused verbatim; the only deliberate divergence is the `tun:` block.
pub fn generate_proxied_tun_config(options: &Value) -> Result<String, IpcError> {
    let mixed_port = options["mixedPort"].as_i64().unwrap_or(0);
    let controller_port = options["controllerPort"].as_i64().unwrap_or(0);
    let secret = options["secret"].as_str().unwrap_or_default();
    let model = options.get("tunConfig").filter(|model| model.is_object());

    assert_port(mixed_port, "mixed-port")?;
    assert_port(controller_port, "external-controller port")?;
    if mixed_port == controller_port {
        return Err(invalid("controller and mixed ports must differ"));
    }
    if !crate::kernel_process::is_valid_secret(secret) {
        return Err(invalid("secret must be a 64-character lowercase hex string"));
    }
    let device = resolve_device(model, options["device"].as_str().unwrap_or_default());
    if !device_pattern_matches(&device) {
        return Err(invalid("device contains unsupported characters or length"));
    }
    let stack = model
        .and_then(|model| model["stack"].as_str())
        .or_else(|| options["stack"].as_str())
        .unwrap_or("mixed");
    if !STACKS.contains(&stack) {
        return Err(invalid(format!("unsupported TUN stack: {stack}")));
    }

    // Reuse the main-kernel safety pass (content preserved, host-network
    // mutation neutralised, app-critical listener/auth keys forced).
    let document = options["document"].as_str().unwrap_or_default();
    let safe_text = crate::inspection::build_profile_kernel_config(document, options)?;

    // Staged: merge keys are not resolved (see module doc).
    let mut data = crate::override_apply::parse_yaml_to_object(&safe_text)
        .ok_or_else(|| invalid("配置解析失败：安全转换后的配置无法解析"))?;

    // Strip rather than reject: `build_profile_kernel_config` has already
    // replaced subscription-provided external UI values with the optional
    // managed panel. The remaining forbidden keys are capabilities that must
    // never reach the privileged child.
    for key in FORBIDDEN_TOP_KEYS {
        data.remove(key);
    }

    // A provider `path` is only a cache location, but mihomo WRITES downloaded
    // content there as SYSTEM, so an unsafe one is rewritten to a deterministic
    // contained location rather than rejecting the whole subscription.
    for section in PROVIDER_SECTIONS {
        let Some(raw) = data.get_mut(section).and_then(Value::as_object_mut).map(|m| m.clone()) else {
            continue;
        };
        for (name, entry) in raw {
            let Some(record) = entry.as_object() else {
                continue;
            };
            let mut record = record.clone();
            let vehicle = record["type"].as_str().unwrap_or_default().to_lowercase();
            if vehicle == "inline" {
                continue;
            }
            if record.get("path").map(provider_path_error).unwrap_or(None).is_some() || record.get("path").is_none() {
                let format = record["format"].as_str().unwrap_or_default().to_lowercase();
                let extension = match format.as_str() {
                    "mrs" => "mrs",
                    "text" => "txt",
                    _ => "yaml",
                };
                record.insert(
                    "path".into(),
                    json!(format!("./{section}/{}.{extension}", safe_provider_file_name(&name))),
                );
            }
            if let Some(section_map) = data.get_mut(section).and_then(Value::as_object_mut) {
                section_map.insert(name, Value::Object(record));
            }
        }
    }

    // `tun` is re-added on top of the transform that intentionally removed it.
    let tun_enabled = options["tunEnabled"].as_bool().unwrap_or(true);
    let mut tun_block: Map<String, Value> = match model {
        Some(model) => {
            let mut model_value = model.clone();
            model_value["device"] = json!(device);
            model_value["stack"] = json!(stack);
            let mut block = crate::enhancements::build_tun_block(&model_value)
                .as_object()
                .cloned()
                .unwrap_or_default();
            block.shift_insert(0, "enable".into(), json!(tun_enabled));
            block
        }
        None => {
            let mut block = Map::new();
            block.insert("enable".into(), json!(tun_enabled));
            block.insert("device".into(), json!(device));
            block.insert("stack".into(), json!(stack));
            block.insert("auto-route".into(), json!(true));
            block.insert("auto-detect-interface".into(), json!(true));
            block.insert("strict-route".into(), json!(false));
            block.insert("dns-hijack".into(), json!(["any:53"]));
            block
        }
    };
    exclude_literal_proxy_servers(&mut data, &mut tun_block);
    data.insert("tun".into(), Value::Object(tun_block.clone()));

    // DNS takeover follows clash-party's `controlDns=false` default: the
    // profile is authoritative and this pass never force-enables the DNS
    // module. Port-53 hijacking is cleared when no live DNS module can answer
    // the hijacked queries; when the module IS enabled only the fake-ip
    // defaults the profile omitted are filled in.
    let existing_dns = data.get("dns").cloned();
    let mut dns: Map<String, Value> = match existing_dns {
        Some(ref dns) if dns.is_object() => dns.as_object().cloned().unwrap_or_default(),
        _ => Map::new(),
    };
    if dns.get("enable") != Some(&Value::Bool(true)) && existing_dns.is_none() {
        // "DNS override off" means the profile is authoritative, but a profile
        // with no dns block still needs a safe runtime fallback while TUN owns
        // port 53. Keeping this baseline enabled also keeps both the TUN prefix
        // and its dns-hijack config byte-identical when the override is toggled,
        // allowing mihomo's ReCreateTun equality guard to preserve the Windows
        // adapter.
        let mut baseline = Map::new();
        baseline.insert("enable".into(), json!(true));
        baseline.insert("enhanced-mode".into(), json!("fake-ip"));
        baseline.insert("fake-ip-range".into(), json!("198.18.0.1/16"));
        baseline.insert("fake-ip-filter".into(), json!(TUN_DEFAULT_FAKE_IP_FILTER));
        baseline.insert("nameserver".into(), json!(["system"]));
        data.insert("dns".into(), Value::Object(baseline));
    } else if dns.get("enable") != Some(&Value::Bool(true)) {
        // An explicit profile dns.enable=false remains authoritative. Port-53
        // hijacking must be removed, even though this uncommon transition
        // requires TUN to rebuild.
        tun_block.insert("dns-hijack".into(), json!([]));
        // Smart cores derive the TUN IPv4 prefix from dns.fake-ip-range even
        // while DNS is explicitly disabled, so retain a stable prefix in that
        // case too.
        dns.insert("enable".into(), json!(false));
        if !dns.contains_key("fake-ip-range") {
            dns.insert("fake-ip-range".into(), json!("198.18.0.1/16"));
        }
        data.insert("dns".into(), Value::Object(dns));
    } else {
        if !dns.contains_key("enhanced-mode") {
            dns.insert("enhanced-mode".into(), json!("fake-ip"));
        }
        let nameserver_empty = dns
            .get("nameserver")
            .and_then(Value::as_array)
            .map(|entries| entries.is_empty())
            .unwrap_or(true);
        if nameserver_empty {
            dns.insert("nameserver".into(), json!(["system"]));
        }
        let fake_ip_mode = dns.get("enhanced-mode").and_then(Value::as_str) == Some("fake-ip");
        if fake_ip_mode && !dns.contains_key("fake-ip-range") {
            dns.insert("fake-ip-range".into(), json!("198.18.0.1/16"));
        }
        if fake_ip_mode && !dns.contains_key("fake-ip-filter") {
            dns.insert("fake-ip-filter".into(), json!(TUN_DEFAULT_FAKE_IP_FILTER));
        }
        data.insert("dns".into(), Value::Object(dns));
    }
    data.insert("tun".into(), Value::Object(tun_block));

    let text = crate::override_apply::stringify_yaml(Value::Object(data));
    let errors = proxied_tun_config_errors(&text);
    if !errors.is_empty() {
        return Err(invalid(format!("generated TUN config failed validation: {}", errors.join("; "))));
    }
    let bytes = text.len();
    if bytes > TUN_PROFILE_MAX_BYTES {
        return Err(invalid(format!(
            "TUN 配置为 {bytes} 字节，超过特权服务的 {TUN_PROFILE_MAX_BYTES} 字节上限。请改用 rule-providers/proxy-providers 引用规则集，而不要将其内联进配置。"
        )));
    }
    Ok(text)
}

/// Validate a proxied TUN profile against the NON-NEGOTIABLE invariants only.
/// Deliberately weaker than `mihomo_tun_config_errors`: proxies, groups,
/// providers, rules and a full `dns` block are legitimate content here.
pub fn proxied_tun_config_errors(text: &str) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let root = match parse_first_document(text) {
        Ok(node) => node,
        Err(mut parse_errors) => {
            errors.append(&mut parse_errors);
            errors.push("config must be a YAML mapping".to_string());
            return dedupe(errors);
        }
    };
    scan_unsafe_nodes(&root, &mut errors);
    let Node::Mapping { .. } = root else {
        errors.push("config must be a YAML mapping".to_string());
        return dedupe(errors);
    };

    // Convert to an ordered JSON map for the data-driven checks (the TS toJS
    // equivalent; merge keys stay literal — see the module doc).
    let data = match crate::override_apply::parse_yaml_to_object(text) {
        Some(data) => data,
        None => {
            errors.push("config could not be resolved: merge resolution is unavailable in this build".to_string());
            return dedupe(errors);
        }
    };

    for key in FORBIDDEN_TOP_KEYS {
        if data.contains_key(key) {
            errors.push(format!("forbidden key for a privileged profile: {key}"));
        }
    }
    // Provider paths are WRITE targets for a SYSTEM-privileged process.
    for section in PROVIDER_SECTIONS {
        let Some(raw) = data.get(section) else {
            continue;
        };
        let Some(entries) = raw.as_object() else {
            errors.push(format!("{section} must be a mapping"));
            continue;
        };
        for (name, entry) in entries {
            let Some(record) = entry.as_object() else {
                errors.push(format!("{section}.{name} must be a mapping"));
                continue;
            };
            let Some(path) = record.get("path") else {
                continue;
            };
            if let Some(problem) = provider_path_error(path) {
                errors.push(format!("{section}.{name}.path {problem}"));
            }
        }
    }
    match data.get("allow-lan") {
        Some(Value::Bool(_)) => {}
        _ => errors.push("allow-lan must be a boolean".to_string()),
    }
    let controller_ok = data
        .get("external-controller")
        .and_then(Value::as_str)
        .map(|value| regex::Regex::new(r"^(?:127\.0\.0\.1|0\.0\.0\.0):(?:[1-9]\d*)$").expect("controller pattern").is_match(value))
        .unwrap_or(false);
    if !controller_ok {
        errors.push("external-controller must use a supported listen address".to_string());
    }
    let has_ui = ["external-ui", "external-ui-name", "external-ui-url"].iter().any(|key| data.contains_key(*key));
    if has_ui
        && (data.get("external-ui").and_then(Value::as_str) != Some("ui")
            || data.get("external-ui-name").and_then(Value::as_str) != Some("metacubexd")
            || data.get("external-ui-url").and_then(Value::as_str)
                != Some("https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"))
    {
        errors.push("external-ui settings must use the managed dashboard".to_string());
    }
    match data.get("secret").and_then(Value::as_str) {
        Some(secret) if regex::Regex::new(SECRET_PATTERN).expect("secret pattern").is_match(secret) => {}
        _ => errors.push("secret must be a 64-character lowercase hex string".to_string()),
    }
    let mixed_port = data.get("mixed-port").and_then(Value::as_i64);
    let mut listener_ports: Vec<i64> = Vec::new();
    match mixed_port {
        Some(port) if (PORT_MIN..=PORT_MAX).contains(&port) => listener_ports.push(port),
        _ => errors.push("mixed-port is outside the allowed range".to_string()),
    }
    for key in ["port", "socks-port"] {
        let Some(port) = data.get(key) else {
            continue;
        };
        match port.as_i64() {
            Some(port) if (PORT_MIN..=PORT_MAX).contains(&port) => listener_ports.push(port),
            _ => errors.push(format!("{key} is outside the allowed range")),
        }
    }
    if let Some(controller) = data.get("external-controller").and_then(Value::as_str) {
        if let Some((_full, port)) = regex::Regex::new(r"^(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)$")
            .expect("controller port pattern")
            .captures(controller)
            .map(|captures| (captures.get(0).map(|m| m.as_str()).unwrap_or_default().to_string(), captures[1].to_string()))
        {
            if let Ok(port) = port.parse::<i64>() {
                listener_ports.push(port);
            }
        }
    }
    if !listener_ports.is_empty() {
        let unique: std::collections::HashSet<i64> = listener_ports.iter().copied().collect();
        if unique.len() != listener_ports.len() {
            errors.push("listener ports must differ".to_string());
        }
    }

    let Some(tun) = data.get("tun").cloned() else {
        errors.push("tun must be a mapping".to_string());
        return dedupe(errors);
    };
    let Some(block) = tun.as_object() else {
        errors.push("tun must be a mapping".to_string());
        return dedupe(errors);
    };
    if !matches!(block.get("enable"), Some(Value::Bool(_))) {
        errors.push("tun.enable must be a boolean".to_string());
    }
    match block.get("device").and_then(Value::as_str) {
        Some(device) if device_pattern_matches(device) => {}
        _ => errors.push("tun.device is invalid".to_string()),
    }
    match block.get("stack").and_then(Value::as_str) {
        Some(stack) if STACKS.contains(&stack) => {}
        _ => errors.push("tun.stack is invalid".to_string()),
    }
    if let Some(mtu) = block.get("mtu") {
        match mtu.as_i64() {
            Some(mtu) if is_valid_tun_mtu(mtu) => {}
            _ => errors.push("tun.mtu must be an integer between 576 and 65535".to_string()),
        }
    }
    let hijack_empty_allowed;
    match block.get("dns-hijack") {
        Some(Value::Array(entries)) => {
            for entry in entries {
                match entry.as_str() {
                    Some(entry) if is_valid_dns_hijack_entry(entry) => {}
                    other => errors.push(format!("invalid tun.dns-hijack entry: {}", other.map(str::to_string).unwrap_or_default())),
                }
            }
            // clash-party parity: port-53 hijacking only exists when a live DNS
            // module can answer the hijacked queries.
            let dns_enabled = data
                .get("dns")
                .and_then(|dns| dns.get("enable"))
                .map(|enable| enable == &Value::Bool(true))
                .unwrap_or(false);
            hijack_empty_allowed = entries.is_empty();
            if !entries.is_empty() && !dns_enabled {
                errors.push("tun.dns-hijack must be empty when dns.enable is not true".to_string());
            }
        }
        _ => {
            errors.push("tun.dns-hijack must be a sequence".to_string());
            hijack_empty_allowed = false;
        }
    }
    let _ = hijack_empty_allowed;
    for (key, label) in [("route-address", "tun.route-address"), ("route-exclude-address", "tun.route-exclude-address")] {
        let Some(list) = block.get(key) else {
            continue;
        };
        match list.as_array() {
            Some(entries) if !entries.is_empty() => {
                for entry in entries {
                    match entry.as_str() {
                        Some(entry) if is_valid_tun_route_address(entry) => {}
                        other => errors.push(format!("invalid {label} entry: {}", other.map(str::to_string).unwrap_or_default())),
                    }
                }
            }
            _ => errors.push(format!("{label} must be a non-empty sequence")),
        }
    }
    // A TUN device without auto-route and without explicit routes is a silent
    // traffic black hole: refuse the combination up front.
    if block.get("auto-route") == Some(&Value::Bool(false))
        && block.get("auto-detect-interface") == Some(&Value::Bool(false))
    {
        let has_routes = block
            .get("route-address")
            .and_then(Value::as_array)
            .map(|entries| !entries.is_empty())
            .unwrap_or(false);
        if !has_routes {
            errors.push(
                "tun.route-address is required when both auto-route and auto-detect-interface are disabled"
                    .to_string(),
            );
        }
    }

    match data.get("dns") {
        // A profile without a dns block is legitimate — mihomo runs its
        // internal resolver and TUN must not hijack port 53.
        None => {}
        Some(dns) if !dns.is_object() => errors.push("dns must be a mapping".to_string()),
        Some(dns) => {
            let block = dns.as_object().expect("checked object");
            // The DNS module may stay off; only an ENABLED module is held to
            // the mode constraint.
            if block.get("enable") == Some(&Value::Bool(true)) {
                match block.get("enhanced-mode").and_then(Value::as_str) {
                    Some("fake-ip") | Some("redir-host") => {}
                    _ => errors.push("dns.enhanced-mode must equal fake-ip or redir-host".to_string()),
                }
            }
            if block.contains_key("listen") {
                errors.push("forbidden key for a privileged profile: dns.listen".to_string());
            }
            if let Some(filter) = block.get("fake-ip-filter") {
                match filter.as_array() {
                    Some(entries) => {
                        for entry in entries {
                            match entry.as_str() {
                                Some(entry) if !entry.is_empty() => {}
                                _ => errors.push("dns.fake-ip-filter entries must be non-empty strings".to_string()),
                            }
                        }
                    }
                    None => errors.push("dns.fake-ip-filter must be a sequence".to_string()),
                }
            }
        }
    }

    dedupe(errors)
}

/// Throwing form of `proxied_tun_config_errors`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn assert_proxied_tun_config(text: &str) -> Result<(), IpcError> {
    let errors = proxied_tun_config_errors(text);
    if errors.is_empty() {
        return Ok(());
    }
    Err(invalid(format!("unsafe TUN config: {}", errors.join("; "))))
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

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn secret() -> String {
        "a".repeat(64)
    }

    fn base_options() -> Value {
        json!({
            "mixedPort": 21000,
            "controllerPort": 20001,
            "secret": secret(),
            "device": "Murge TUN"
        })
    }

    // -- bootstrap profile ------------------------------------------------------

    #[test]
    fn generates_a_bootstrap_profile_that_validates_clean() {
        let text = generate_mihomo_tun_config(&base_options()).unwrap();
        assert!(mihomo_tun_config_errors(&text).is_empty(), "{text}");
        assert!(text.contains("mode: direct"), "{text}");
        assert!(text.contains("device: Murge TUN"), "{text}");
        assert!(text.contains("stack: mixed"), "{text}");
        assert!(text.contains("enable: true"), "{text}");
        assert!(text.contains("- \"*\""), "{text}");
        assert!(text.contains("- MATCH,DIRECT"), "{text}");
    }

    #[test]
    fn folds_the_tun_model_into_the_block() {
        let mut options = base_options();
        options["tunConfig"] = json!({
            "stack": "system",
            "device": "Mihomo", // the stock default: NOT user-customized
            "mtu": 1500,
            "strictRoute": true,
            "autoRoute": false,
            "autoDetectInterface": true,
            "dnsHijack": ["any:53", "8.8.8.8:53"],
            "routeAddress": ["10.0.0.0/8"],
            "routeExcludeAddress": []
        });
        let text = generate_mihomo_tun_config(&options).unwrap();
        assert!(text.contains("device: Murge TUN"), "{text}");
        assert!(text.contains("stack: system"), "{text}");
        assert!(text.contains("mtu: 1500"), "{text}");
        assert!(text.contains("strict-route: true"), "{text}");
        assert!(text.contains("route-address:"), "{text}");
        assert!(text.contains("- 10.0.0.0/8"), "{text}");
        assert!(mihomo_tun_config_errors(&text).is_empty(), "{text}");
    }

    #[test]
    fn rejects_port_and_secret_violations() {
        let mut options = base_options();
        options["mixedPort"] = json!(80);
        assert!(generate_mihomo_tun_config(&options).is_err());
        let mut options = base_options();
        options["controllerPort"] = json!(21000);
        assert!(generate_mihomo_tun_config(&options).is_err());
        let mut options = base_options();
        options["secret"] = json!("nothex");
        assert!(generate_mihomo_tun_config(&options).is_err());
        let mut options = base_options();
        options["device"] = json!("bad device //");
        assert!(generate_mihomo_tun_config(&options).is_err());
        let mut options = base_options();
        options["logLevel"] = json!("verbose");
        assert!(generate_mihomo_tun_config(&options).is_err());
    }

    #[test]
    fn strict_validator_reports_real_violations() {
        let text = generate_mihomo_tun_config(&base_options()).unwrap();
        // An alias is rejected (the generator quotes the filter, so replace
        // the quoted form to produce a bare alias node).
        let aliased = text.replace("    - \"*\"", "    - *anchor-ref");
        assert!(mihomo_tun_config_errors(&aliased).iter().any(|e| e.contains("alias")), "{aliased}");
        // A mode change is rejected.
        let mutated = text.replace("mode: direct", "mode: rule");
        assert!(mihomo_tun_config_errors(&mutated).iter().any(|e| e.contains("mode")), "{mutated}");
        // A missing tun key is rejected.
        let mutated = text.replace("  dns-hijack:\n", "");
        assert!(mihomo_tun_config_errors(&mutated).iter().any(|e| e.contains("missing tun key")), "{mutated}");
        // An unknown top-level key is rejected.
        let mutated = format!("ntp:\n  enabled: true\n{text}");
        assert!(mihomo_tun_config_errors(&mutated).iter().any(|e| e.contains("unknown config key")), "{mutated}");
        // assert form.
        assert!(assert_mihomo_tun_config(&text).is_ok());
        assert!(assert_mihomo_tun_config(&mutated).is_err());
    }

    // -- proxied profile --------------------------------------------------------

    fn proxied_options(document: &str) -> Value {
        json!({
            "document": document,
            "mixedPort": 21000,
            "controllerPort": 20001,
            "secret": secret(),
            "device": "Murge TUN",
            "core": {},
            "geodata": {}
        })
    }

    fn proxied_document() -> &'static str {
        "proxies:\n  - name: a\n    type: ss\n    server: 198.51.100.7\n    port: 8388\n    cipher: aes-128-gcm\n    password: pw\nproxy-groups:\n  - name: G\n    type: select\n    proxies: [a]\nrules:\n  - MATCH,G\n"
    }

    #[test]
    fn proxied_profile_preserves_content_and_enables_tun() {
        let text = generate_proxied_tun_config(&proxied_options(proxied_document())).unwrap();
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");
        assert!(text.contains("name: a"), "{text}");
        assert!(text.contains("MATCH,G"), "{text}");
        assert!(text.contains("enable: true"), "{text}");
        assert!(text.contains("device: Murge TUN"), "{text}");
        assert!(text.contains("mixed-port: 21000"), "{text}");
        assert!(text.contains("secret:"), "{text}");
    }

    #[test]
    fn proxied_profile_excludes_literal_proxy_servers() {
        let text = generate_proxied_tun_config(&proxied_options(proxied_document())).unwrap();
        assert!(text.contains("198.51.100.7/32"), "{text}");
    }

    #[test]
    fn dns_without_a_live_module_follows_the_authority_contract() {
        // A document with NO dns block gets the baseline enabled fake-ip DNS
        // while TUN owns port 53 (byte-identical prefix + hijack across the
        // override toggle, so mihomo's ReCreateTun guard keeps the adapter).
        let text = generate_proxied_tun_config(&proxied_options(proxied_document())).unwrap();
        let dns_hijack = text
            .lines()
            .skip_while(|line| !line.starts_with("tun:"))
            .take_while(|line| !line.starts_with("rules:") && !line.starts_with("dns:"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(dns_hijack.contains("dns-hijack:"), "{dns_hijack}");
        assert!(!dns_hijack.contains("dns-hijack: []"), "{dns_hijack}");
        assert!(text.contains("dns:"), "{text}");
        assert!(text.contains("enhanced-mode: fake-ip"), "{text}");
        assert!(text.contains("fake-ip-range: 198.18.0.1/16"), "{text}");
        assert!(text.contains("nameserver:"), "{text}");
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");

        // An EXPLICIT dns.enable=false stays authoritative: port-53 hijacking
        // is cleared and the fake-ip prefix is retained for smart cores.
        let disabled = format!("dns:\n  enable: false\n{}", proxied_document());
        let text = generate_proxied_tun_config(&proxied_options(&disabled)).unwrap();
        let dns_hijack = text
            .lines()
            .skip_while(|line| !line.starts_with("tun:"))
            .take_while(|line| !line.starts_with("rules:") && !line.starts_with("dns:"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(dns_hijack.contains("dns-hijack: []"), "{dns_hijack}");
        assert!(text.contains("enable: false"), "{text}");
        assert!(text.contains("fake-ip-range: 198.18.0.1/16"), "{text}");
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");

        // With an enabled dns block (fake-ip, no filter) the defaults are filled.
        let with_dns = format!("dns:\n  enable: true\n  enhanced-mode: fake-ip\n{}", proxied_document());
        let text = generate_proxied_tun_config(&proxied_options(&with_dns)).unwrap();
        assert!(text.contains("fake-ip-range: 198.18.0.1/16"), "{text}");
        assert!(text.contains("nameserver:"), "{text}");
        assert!(text.contains("fake-ip-filter:"), "{text}");
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");
    }

    #[test]
    fn proxied_profile_strips_forbidden_keys_and_confines_provider_paths() {
        let document = "listeners:\n  - name: x\nntp:\n  enabled: true\nss-config: '{}'\nproxy-providers:\n  sub:\n    type: http\n    url: http://x/y\n    path: /etc/murge/escape.yaml\n    format: yaml\nrules:\n  - MATCH,DIRECT\n";
        let text = generate_proxied_tun_config(&proxied_options(document)).unwrap();
        assert!(!text.contains("listeners:"), "{text}");
        assert!(!text.contains("ntp:"), "{text}");
        assert!(!text.contains("ss-config"), "{text}");
        assert!(text.contains("./proxy-providers/sub.yaml"), "{text}");
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");
    }

    #[test]
    fn proxied_validator_enforces_the_non_negotiables() {
        let text = generate_proxied_tun_config(&proxied_options(proxied_document())).unwrap();
        // A non-loopback controller host is rejected.
        let mutated = regex::Regex::new(r#"external-controller: "?127\.0\.0\.1:\d+"?"#)
            .unwrap()
            .replace(&text, "external-controller: example.invalid:20001")
            .to_string();
        assert!(
            proxied_tun_config_errors(&mutated)
                .iter()
                .any(|error| error.contains("external-controller")),
            "{mutated}"
        );
        // An unauthenticated controller variant is rejected.
        let mutated = format!("external-controller-pipe: /tmp/x\n{text}");
        assert!(
            proxied_tun_config_errors(&mutated)
                .iter()
                .any(|error| error.contains("forbidden key")),
            "{mutated}"
        );
        // An escaping provider path is rejected.
        let mutated = format!("proxy-providers:\n  sub:\n    type: http\n    path: ../../etc/passwd\n{text}");
        assert!(
            proxied_tun_config_errors(&mutated)
                .iter()
                .any(|error| error.contains("proxy-providers.sub.path")),
            "{mutated}"
        );
        // dns.listen is rejected (use a document WITH a dns block: without
        // one the final config has no dns section at all).
        let with_dns = format!("dns:\n  enable: true\n  enhanced-mode: fake-ip\n{}", proxied_document());
        let text_with_dns = generate_proxied_tun_config(&proxied_options(&with_dns)).unwrap();
        let mutated = text_with_dns.replace("  enable: true\n  enhanced-mode: fake-ip", "  enable: true\n  enhanced-mode: fake-ip\n  listen: 0.0.0.0:53");
        assert!(
            proxied_tun_config_errors(&mutated)
                .iter()
                .any(|error| error.contains("dns.listen")),
            "{mutated}"
        );
        // assert form.
        assert!(assert_proxied_tun_config(&text).is_ok());
        assert!(assert_proxied_tun_config(&mutated).is_err());
    }

    #[test]
    fn proxied_validator_holds_the_blackhole_rule() {
        let text = generate_proxied_tun_config(&proxied_options(proxied_document())).unwrap();
        let mutated = text
            .replace("auto-route: true", "auto-route: false")
            .replace("auto-detect-interface: true", "auto-detect-interface: false");
        assert!(
            proxied_tun_config_errors(&mutated)
                .iter()
                .any(|error| error.contains("tun.route-address is required")),
            "{mutated}"
        );
        // With explicit routes the combination is accepted.
        // With explicit routes the combination is accepted (a coerced model
        // always carries mtu/dnsHijack — mirror that here).
        let mut options = proxied_options(proxied_document());
        options["tunConfig"] = json!({
            "device": "Mihomo",
            "mtu": 1500,
            "dnsHijack": ["any:53"],
            "autoRoute": false,
            "autoDetectInterface": false,
            "routeAddress": ["10.0.0.0/8"]
        });
        let text = generate_proxied_tun_config(&options).unwrap();
        assert!(proxied_tun_config_errors(&text).is_empty(), "{text}");
    }

    #[test]
    fn provider_path_error_matches_the_service_contract() {
        assert_eq!(provider_path_error(&json!("cache/p.yaml")), None);
        assert_eq!(provider_path_error(&json!("/etc/passwd")), Some("must be relative to the state directory"));
        assert_eq!(provider_path_error(&json!("C:\\x\\y.yaml")), Some("must be relative to the state directory"));
        assert_eq!(provider_path_error(&json!("a\\..\\b")), Some("must not traverse outside the state directory"));
        // A single letter followed by a colon matches the drive rule first
        // (TS `/^[A-Za-z]:/` runs before the includes(':') check).
        assert_eq!(provider_path_error(&json!("a:b")), Some("must be relative to the state directory"));
        assert_eq!(provider_path_error(&json!("cache/b:c")), Some("must not name a drive or alternate stream"));
        assert_eq!(provider_path_error(&json!("  ")), Some("must be a non-empty string"));
    }

    #[test]
    fn safe_provider_file_name_collapses_hostile_names() {
        // TS keeps dots and only strips LEADING ones: the result is a single
        // filename component, so embedded ".." stays (not a traversal).
        assert_eq!(safe_provider_file_name("sub/../../etc"), "sub_.._.._etc");
        assert_eq!(safe_provider_file_name("..."), "provider");
        assert_eq!(safe_provider_file_name(""), "provider");
        let long = safe_provider_file_name(&"x".repeat(100));
        assert_eq!(long.chars().count(), 64);
    }
}
