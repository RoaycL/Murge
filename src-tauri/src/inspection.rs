//! Active-profile config inspection — Rust port of
//! `main/profiles/profile-config-inspection.ts` plus the effective-document
//! composition the Electron handler performs
//! (overrides → DNS enhancement → sniffer enhancement → `buildProfileKernelConfig`).
//!
//! The runtime knobs the Electron handler reads from its controller state
//! (production ports, TUN phase) are NOT available inside the Rust shell yet —
//! the caller passes the runtime block, so the TUN-on branch becomes live with
//! the Phase 3D privileged slice. `generateProxiedTunConfig` is staged there.

use serde_json::{json, Map, Value};

use crate::enhancements;
use crate::error::IpcError;
use crate::override_apply;
use crate::validate;

pub const SECRET_PATTERN: &str = "^[0-9a-f]{64}$";

const CORE_KEYS: [&str; 20] = [
    "mode",
    "log-level",
    "ipv6",
    "tcp-concurrent",
    "unified-delay",
    "find-process-mode",
    "interface-name",
    "mixed-port",
    "socks-port",
    "port",
    "redir-port",
    "tproxy-port",
    "listeners",
    "external-controller",
    "bind-address",
    "secret",
    "allow-lan",
    "external-ui",
    "external-ui-name",
    "external-ui-url",
];
const GEODATA_KEYS: [&str; 5] =
    ["geodata-mode", "geodata-loader", "geo-auto-update", "geo-update-interval", "geox-url"];

fn managed_keys() -> Value {
    json!({
        "core": [
            "mixed-port", "socks-port", "port", "redir-port", "tproxy-port", "listeners",
            "external-controller", "bind-address", "secret", "allow-lan", "controller panel"
        ],
        "dns": ["dns.listen（移除公开监听）"],
        "sniffer": [],
        "tun": ["tun.enable", "tun.device", "tun.stack", "路由、MTU 与 DNS 劫持"],
        "geodata": []
    })
}

fn pick(source: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let mut output = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            output.insert((*key).to_string(), value.clone());
        }
    }
    output
}

/// The section excerpt: masked secret, empty object renders 未配置.
fn excerpt(data: &Map<String, Value>) -> String {
    let mut safe = data.clone();
    if let Some(secret) = safe.get_mut("secret") {
        *secret = json!("********");
    }
    if safe.is_empty() {
        "（未配置）".to_string()
    } else {
        override_apply::stringify_yaml(Value::Object(safe)).trim().to_string()
    }
}

fn section_data(root: &Map<String, Value>, section: &str) -> Map<String, Value> {
    match section {
        "core" => pick(root, &CORE_KEYS),
        "geodata" => pick(root, &GEODATA_KEYS),
        _ => match root.get(section) {
            Some(value) if value.is_object() => {
                let mut wrapper = Map::new();
                wrapper.insert(section.to_string(), value.clone());
                wrapper
            }
            _ => Map::new(),
        },
    }
}

/// One section inspection (profileYaml/effectiveYaml/managedKeys/notes).
fn inspection(
    section: &str,
    profile: &Map<String, Value>,
    effective: &Map<String, Value>,
    notes: Vec<&str>,
) -> Value {
    let managed = managed_keys();
    json!({
        "profileYaml": excerpt(&section_data(profile, section)),
        "effectiveYaml": excerpt(&section_data(effective, section)),
        "managedKeys": managed[section],
        "notes": notes
    })
}

/// The read-only comparison view. `profile_name` is None for the no-active-
/// profile case; all notes copy the Electron strings verbatim.
pub fn inspect_active_profile_config(
    profile_name: Option<&str>,
    raw_document: &str,
    effective_document: &str,
    options: &Value,
) -> Value {
    let profile = override_apply::parse_yaml_to_object(raw_document).unwrap_or_default();
    let effective = override_apply::parse_yaml_to_object(effective_document).unwrap_or_default();
    let flag = |key: &str| options[key].as_bool() == Some(true);
    json!({
        "profileName": profile_name,
        "diagnostics": validate::profile_compatibility_diagnostics(raw_document),
        "sections": {
            "core": inspection("core", &profile, &effective, vec![
                "监听端口、控制器、访问密钥和局域网监听始终由应用接管。",
                if flag("coreOverride") {
                    "内核运行覆写已启用，其余受支持字段也以应用设置为准。"
                } else {
                    "内核运行覆写未启用，其余受支持字段沿用配置文件。"
                },
            ]),
            "dns": inspection("dns", &profile, &effective, vec![
                if flag("dnsOverride") {
                    "DNS 覆写已启用，应用字段优先，未知字段保留。"
                } else {
                    "DNS 覆写未启用，配置文件字段原样保留；公开 listen 会被移除。"
                },
            ]),
            "sniffer": inspection("sniffer", &profile, &effective, vec![
                if flag("snifferOverride") {
                    "嗅探覆写已启用，应用支持的字段优先。"
                } else {
                    "嗅探覆写未启用，使用配置文件中的嗅探设置。"
                },
            ]),
            "tun": inspection("tun", &profile, &effective, vec![
                format!("TUN 当前{}；启用状态和完整 TUN 参数由应用管理。", if flag("tunEnabled") { "已启用" } else { "未启用" }).as_str()
            ]),
            "geodata": inspection("geodata", &profile, &effective, vec![
                if flag("geodataOverride") {
                    "Geodata 覆写已启用，应用设置优先。"
                } else {
                    "Geodata 覆写未启用，使用配置文件中的设置。"
                },
            ]),
        }
    })
}

// ---------------------------------------------------------------------------
// Effective-document composition
// ---------------------------------------------------------------------------

/// Apply the typed DNS enhancement to a profile document (`apply-dns.ts`):
/// enabled -> the model's `dns:` block merges over the profile's own keys
/// (unknown keys preserved); disabled/unparseable -> base verbatim + warning.
pub fn apply_dns_to_document(base: &str, enhancement: &Value) -> (String, Vec<&'static str>) {
    if enhancement["enabled"].as_bool() != Some(true) {
        return (base.to_string(), Vec::new());
    }
    let Some(mut config) = override_apply::parse_yaml_to_object(base) else {
        return (base.to_string(), vec!["基础配置文件无法解析，已跳过 DNS 增强"]);
    };
    let block = enhancements::build_dns_block(enhancement);
    let block = block.as_object().cloned().unwrap_or_default();
    let existing = config
        .get("dns")
        .map(|value| value.as_object().cloned().unwrap_or_default())
        .unwrap_or_default();
    let mut merged = existing;
    for (key, value) in block {
        merged.insert(key, value);
    }
    config.insert("dns".into(), Value::Object(merged));
    (override_apply::stringify_yaml(Value::Object(config)), Vec::new())
}

/// Apply the typed sniffer enhancement (`apply-sniffer.ts`), same contract.
pub fn apply_sniffer_to_document(base: &str, enhancement: &Value) -> (String, Vec<&'static str>) {
    if enhancement["enabled"].as_bool() != Some(true) {
        return (base.to_string(), Vec::new());
    }
    let Some(mut config) = override_apply::parse_yaml_to_object(base) else {
        return (base.to_string(), vec!["基础配置文件无法解析，已跳过 Sniffer 增强"]);
    };
    let block = enhancements::build_sniffer_block(enhancement);
    let block = block.as_object().cloned().unwrap_or_default();
    let existing = config
        .get("sniffer")
        .map(|value| value.as_object().cloned().unwrap_or_default())
        .unwrap_or_default();
    let mut merged = existing;
    for (key, value) in block {
        merged.insert(key, value);
    }
    config.insert("sniffer".into(), Value::Object(merged));
    (override_apply::stringify_yaml(Value::Object(config)), Vec::new())
}

/// Turn the ACTIVE profile document into the app-owned runtime config
/// (`buildProfileKernelConfig`): content sections preserved, host-network
/// blocks neutralized, app-critical listener/auth keys forced, controlled
/// core/geodata models read back when enabled.
pub fn build_profile_kernel_config(document: &str, options: &Value) -> Result<String, IpcError> {
    let invalid = |message: String| IpcError::invalid_argument(message);
    let mixed_port = options["mixedPort"].as_i64().unwrap_or(0);
    let controller_port = options["controllerPort"].as_i64().unwrap_or(0);
    if !(1024..=65535).contains(&mixed_port) {
        return Err(invalid(format!("invalid mixed-port: {mixed_port}")));
    }
    if !(1024..=65535).contains(&controller_port) {
        return Err(invalid(format!("invalid controller-port: {controller_port}")));
    }
    if mixed_port == controller_port {
        return Err(invalid("mixed-port and external-controller port must differ".to_string()));
    }
    let optional_ports = [
        ("http", options["httpPort"].as_i64().unwrap_or(0)),
        ("socks", options["socksPort"].as_i64().unwrap_or(0)),
    ];
    for (label, port) in optional_ports {
        if port != 0 && !(1024..=65535).contains(&port) {
            return Err(invalid(format!("invalid {label} port: {port}")));
        }
    }
    let active_ports: Vec<i64> = [Some(mixed_port), Some(controller_port)]
        .into_iter()
        .chain(optional_ports.iter().map(|(_, port)| {
            if *port != 0 {
                Some(*port)
            } else {
                None
            }
        }))
        .flatten()
        .collect();
    let unique: std::collections::HashSet<i64> = active_ports.iter().copied().collect();
    if unique.len() != active_ports.len() {
        return Err(invalid("listener ports must differ".to_string()));
    }
    let secret = options["secret"].as_str().unwrap_or("");
    if !regex::Regex::new(SECRET_PATTERN).expect("secret pattern").is_match(secret) {
        return Err(invalid("secret must be a 64-character lowercase hex string".to_string()));
    }

    let mut config = override_apply::parse_yaml_to_object(document).ok_or_else(|| {
        invalid("配置解析失败：文档无法解析为 YAML 映射".to_string())
    })?;

    // --- Neutralize host-network mutation (loopback-only main kernel) ---
    for key in [
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
        "listeners",
        "tun",
        "ss-config",
        "vmess-config",
        "tuic-server",
    ] {
        config.remove(key);
    }
    for key in ["external-ui", "external-ui-url", "external-ui-name"] {
        config.remove(key);
    }
    for key in [
        "external-controller-unix",
        "external-controller-pipe",
        "external-controller-tls",
        "external-controller-routing-mark",
        "external-doh-server",
    ] {
        config.remove(key);
    }
    if let Some(dns) = config.get_mut("dns").and_then(Value::as_object_mut) {
        dns.remove("listen");
    }

    // --- Force the app-critical listener/auth keys ---
    let http_port = options["httpPort"].as_i64().unwrap_or(0);
    let socks_port = options["socksPort"].as_i64().unwrap_or(0);
    let allow_lan = options["allowLan"].as_bool() == Some(true);
    let controller_host = options["controllerHost"].as_str().unwrap_or("127.0.0.1");
    config.insert("mixed-port".into(), json!(mixed_port));
    if http_port != 0 {
        config.insert("port".into(), json!(http_port));
    }
    if socks_port != 0 {
        config.insert("socks-port".into(), json!(socks_port));
    }
    config.insert("external-controller".into(), json!(format!("{controller_host}:{controller_port}")));
    config.insert("allow-lan".into(), json!(allow_lan));
    config.insert("bind-address".into(), json!(if allow_lan { "*" } else { "127.0.0.1" }));
    config.insert("secret".into(), json!(secret));
    if options["controllerPanel"].as_bool() == Some(true) {
        config.insert("external-ui".into(), json!("ui"));
        config.insert("external-ui-name".into(), json!("metacubexd"));
        config.insert(
            "external-ui-url".into(),
            json!("https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"),
        );
    }
    config.insert(
        "mode".into(),
        json!(if config.get("mode").and_then(Value::as_str) == Some("rule") { "rule" } else { "rule" }),
    );

    // --- Controlled core settings (read-back + conflict handling) ---
    if options["core"]["enabled"].as_bool() == Some(true) {
        let core = &options["core"];
        let existing_profile = config
            .get("profile")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut block = enhancements::build_core_settings_block(core);
        let controlled_profile = block
            .as_object_mut()
            .expect("core block is an object")
            .remove("profile")
            .map(|value| value.as_object().cloned().unwrap_or_default())
            .unwrap_or_default();
        if let Some(block_map) = block.as_object() {
            for (key, value) in block_map {
                config.insert(key.clone(), value.clone());
            }
        }
        let mut profile_map = existing_profile;
        for (key, value) in controlled_profile {
            profile_map.insert(key, value);
        }
        config.insert("profile".into(), Value::Object(profile_map));
        if core["interfaceName"].as_str().map(str::is_empty).unwrap_or(true) {
            config.remove("interface-name");
        }
        // DNS AAAA behavior must agree with the top-level ipv6 switch.
        if let Some(dns) = config.get_mut("dns").and_then(Value::as_object_mut) {
            dns.insert("ipv6".into(), core["ipv6"].clone());
        }
    }

    // --- Controlled geodata settings (read-back + conflict handling) ---
    if options["geodata"]["enabled"].as_bool() == Some(true) {
        let block = enhancements::build_geodata_block(&options["geodata"]);
        if let Some(block_map) = block.as_object() {
            for (key, value) in block_map {
                config.insert(key.clone(), value.clone());
            }
        }
    }

    Ok(override_apply::stringify_yaml(Value::Object(config)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn runtime() -> Value {
        json!({
            "mixedPort": 7890, "controllerPort": 9090, "httpPort": 0, "socksPort": 0,
            "controllerHost": "127.0.0.1", "allowLan": false, "controllerPanel": false,
            "secret": "a".repeat(64)
        })
    }

    #[test]
    fn kernel_config_forces_app_keys_and_strips_hosts() {
        let document = "port: 80\nsocks-port: 1080\ntun:\n  enable: true\nlisteners:\n  - name: x\nmixed-port: 9999\nexternal-controller: 0.0.0.0:9091\nsecret: deadbeef\nallow-lan: true\nmode: rule\nproxies: []\nrules:\n  - MATCH,A\n";
        let effective = build_profile_kernel_config(document, &runtime()).unwrap();
        assert!(effective.contains("mixed-port: 7890"), "{effective}");
        assert!(effective.contains("external-controller: \"127.0.0.1:9090\""), "{effective}");
        assert!(effective.contains("secret: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "{effective}");
        assert!(effective.contains("bind-address: 127.0.0.1"), "{effective}");
        assert!(effective.contains("mode: rule"), "{effective}");
        assert!(effective.contains("MATCH,A"), "content sections preserved");
        assert!(!effective.contains("port: 80"), "{effective}");
        assert!(!effective.contains("socks-port: 1080"), "{effective}");
        assert!(!effective.contains("tun:"), "{effective}");
        assert!(!effective.contains("listeners:"), "{effective}");
    }

    #[test]
    fn kernel_config_keeps_content_and_dns_listen_removal() {
        let document = "dns:\n  listen: 0.0.0.0:53\n  enable: true\nproxies:\n  - name: a\nrules:\n  - MATCH,A\n";
        let effective = build_profile_kernel_config(document, &runtime()).unwrap();
        assert!(!effective.contains("0.0.0.0:53"), "public DNS listener removed: {effective}");
        assert!(effective.contains("enable: true"), "profile dns keys preserved");
    }

    #[test]
    fn kernel_config_core_model_readback() {
        let core = enhancements::coerce_core_settings(&json!({
            "enabled": true, "logLevel": "debug", "ipv6": true, "storeSelected": false
        }));
        let mut options = runtime();
        options["core"] = core;
        let document = "log-level: info\nprofile:\n  store-fake-ip: false\ndns:\n  ipv6: false\nproxies: []\nrules:\n  - MATCH,A\n";
        let effective = build_profile_kernel_config(document, &options).unwrap();
        assert!(effective.contains("log-level: debug"), "{effective}");
        assert!(effective.contains("tcp-concurrent: false"), "{effective}");
        assert!(effective.contains("store-selected: false"), "{effective}");
        assert!(effective.contains("store-fake-ip: true"), "controlled block wins the profile spread (TS spread order)");
        assert!(effective.contains("ipv6: true"), "dns ipv6 follows the core model");
    }

    #[test]
    fn kernel_config_geodata_model_readback_and_panel() {
        let geodata = enhancements::coerce_geodata_settings(&json!({ "enabled": true, "updateIntervalHours": 48 }));
        let mut options = runtime();
        options["geodata"] = geodata;
        options["controllerPanel"] = json!(true);
        let document = "proxies: []\nrules:\n  - MATCH,A\n";
        let effective = build_profile_kernel_config(document, &options).unwrap();
        assert!(effective.contains("geo-update-interval: 48"), "{effective}");
        assert!(effective.contains("external-ui-url: \"https://github.com/MetaCubeX"), "{effective}");
    }

    #[test]
    fn kernel_config_rejects_bad_options() {
        let mut options = runtime();
        options["mixedPort"] = json!(80);
        assert!(build_profile_kernel_config("proxies: []\n", &options).is_err());
        let mut options = runtime();
        options["controllerPort"] = json!(7890);
        assert!(build_profile_kernel_config("proxies: []\n", &options).is_err());
        let mut options = runtime();
        options["secret"] = json!("nothex");
        assert!(build_profile_kernel_config("proxies: []\n", &options).is_err());
        assert!(build_profile_kernel_config("", &runtime()).is_err());
    }

    #[test]
    fn dns_and_sniffer_enhancements_merge_and_fail_open() {
        let dns = enhancements::coerce_dns_enhancement(&json!({
            "enabled": true,
            "nameserver": ["tls://223.5.5.5"],
            "hosts": [{ "domain": "a.com", "address": "1.2.3.4" }]
        }));
        let (text, warnings) = apply_dns_to_document(
            "dns:\n  fallback-filter:\n    geoip: true\n  enable: false\nproxies: []\n",
            &dns,
        );
        assert!(warnings.is_empty());
        assert!(text.contains("tls://223.5.5.5"), "{text}");
        assert!(text.contains("fallback-filter"), "unknown dns keys preserved");
        assert!(text.contains("enable: true"), "model wins for owned keys");
        let (_, warnings) = apply_dns_to_document("a: [1, 2", &dns);
        assert_eq!(warnings, vec!["基础配置文件无法解析，已跳过 DNS 增强"]);
        let (text, warnings) = apply_dns_to_document("proxies: []\n", &dns);
        assert!(warnings.is_empty() && text.contains("dns:"), "disabled enhancement inserts the block");

        let sniffer = enhancements::coerce_sniffer_enhancement(&json!({ "enabled": true, "parsePureIp": false }));
        let (text, warnings) = apply_sniffer_to_document("sniffer:\n  port-black-list:\n    - 9000\nproxies: []\n", &sniffer);
        assert!(warnings.is_empty());
        assert!(text.contains("port-black-list"), "unknown sniffer keys preserved: {text}");
        assert!(text.contains("parse-pure-ip: false"), "{text}");
        let (_, warnings) = apply_sniffer_to_document("[[[", &sniffer);
        assert_eq!(warnings, vec!["基础配置文件无法解析，已跳过 Sniffer 增强"]);
    }

    #[test]
    fn disabled_enhancements_return_base_verbatim() {
        let disabled = serde_json::Value::Null;
        let (text, warnings) = apply_dns_to_document("port: 1\n", &disabled);
        assert_eq!(text, "port: 1\n");
        assert!(warnings.is_empty());
    }

    #[test]
    fn inspection_shapes_sections_and_notes() {
        let options = json!({
            "coreOverride": true, "dnsOverride": false, "snifferOverride": true,
            "geodataOverride": false, "tunEnabled": false
        });
        let inspection = inspect_active_profile_config(
            Some("Home"),
            "mixed-port: 1234\nsecret: topsecret\nproxies: []\nrules:\n  - MATCH,A\n",
            "mixed-port: 7890\nsecret: aaaa\nproxies: []\nrules:\n  - MATCH,A\n",
            &options,
        );
        assert_eq!(inspection["profileName"], "Home");
        assert_eq!(inspection["sections"]["core"]["profileYaml"], "mixed-port: 1234\nsecret: \"********\"");
        assert_eq!(inspection["sections"]["core"]["effectiveYaml"], "mixed-port: 7890\nsecret: \"********\"");
        let notes = inspection["sections"]["core"]["notes"].as_array().unwrap();
        assert!(notes[0].as_str().unwrap().contains("监听端口、控制器"), "{notes:?}");
        assert!(notes[1].as_str().unwrap().contains("内核运行覆写已启用"), "{notes:?}");
        assert!(inspection["sections"]["tun"]["notes"][0].as_str().unwrap().contains("未启用"));
        assert!(inspection["sections"]["sniffer"]["managedKeys"].as_array().unwrap().is_empty());
        assert_eq!(inspection["sections"]["dns"]["profileYaml"], "（未配置）");
    }

    #[test]
    fn inspection_empty_profile_name_and_no_sections() {
        let options = json!({
            "coreOverride": false, "dnsOverride": false, "snifferOverride": false,
            "geodataOverride": false, "tunEnabled": false
        });
        let inspection = inspect_active_profile_config(None, "", "", &options);
        assert_eq!(inspection["profileName"], Value::Null);
        assert_eq!(inspection["sections"]["core"]["profileYaml"], "（未配置）");
        assert!(inspection["diagnostics"].as_array().unwrap().is_empty());
    }
}
