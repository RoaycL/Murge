//! 本地节点与规则 — the Surge/Loon-style local layer on top of a remote
//! subscription.
//!
//! The subscription document is never rewritten. Instead the user's own
//! changes live in `<app-data>/local/local.json` and are re-applied every time
//! a kernel config is composed, so they survive subscription updates:
//!
//! - **nodes**: extra proxies (WireGuard, Tailscale or any mihomo proxy map),
//!   optionally added to existing policy groups;
//! - **rules**: extra rule lines, placed before every subscription rule;
//! - **profile edits**: per-subscription changes to the subscription's own
//!   rules (disable / change policy / replace), matched by content so they
//!   keep working when the subscription re-orders its rules;
//! - **Tailscale coexistence**: when the official Tailscale client is running,
//!   tailnet traffic and `*.ts.net` lookups are handed to its adapter instead
//!   of being captured by TUN.
//!
//! Two composition hooks:
//! - [`apply_global`] (inside `OverrideService::apply_for_profile`, so every
//!   consumer of the overridden document sees local nodes and rules);
//! - [`apply_runtime_global`] (after DNS/sniffer enhancement, which may
//!   replace the `dns` block) for DNS policy and the coexistence routing.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::IpcError;
use crate::override_apply::{parse_yaml_to_object, stringify_yaml};

const SETTINGS_DIR: &str = "local";
const SETTINGS_FILE: &str = "local.json";
const NODE_LIMIT: usize = 256;
const RULE_LIMIT: usize = 4096;

/// The direct outbound bound to the official Tailscale adapter.
pub const TAILSCALE_DIRECT_NAME: &str = "Murge-Tailscale";
/// Tailscale's CGNAT and ULA ranges, plus MagicDNS.
pub const TAILNET_V4: &str = "100.64.0.0/10";
pub const TAILNET_V6: &str = "fd7a:115c:a1e0::/48";
pub const TAILNET_DOMAIN: &str = "ts.net";
const MAGIC_DNS: &str = "100.100.100.100";

/// Policies every config can target without defining them.
const BUILTIN_TARGETS: [&str; 6] = [
    "DIRECT",
    "REJECT",
    "REJECT-DROP",
    "PASS",
    "COMPATIBLE",
    "GLOBAL",
];

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalNode {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// The mihomo proxy map (`name`, `type`, ...), passed through verbatim.
    pub config: Value,
    /// Existing policy groups this node is appended to.
    pub groups: Vec<String>,
    /// Tailscale only: route `*.ts.net` + the tailnet ranges to this node.
    #[serde(default = "default_true")]
    pub tailnet_rules: bool,
}

impl Default for LocalNode {
    fn default() -> Self {
        LocalNode {
            id: String::new(),
            enabled: true,
            config: Value::Null,
            groups: Vec::new(),
            tailnet_rules: true,
        }
    }
}

impl LocalNode {
    pub fn name(&self) -> &str {
        self.config
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
    fn kind(&self) -> String {
        self.config
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// A full mihomo rule line, e.g. `DOMAIN-SUFFIX,example.com,Proxy`.
    pub rule: String,
}

impl Default for LocalRule {
    fn default() -> Self {
        LocalRule {
            id: String::new(),
            enabled: true,
            rule: String::new(),
        }
    }
}

/// A change to one of the subscription's own rules. The rule is identified
/// the way the 规则 page shows it (`/rules`: type, payload, policy), so the
/// edit keeps matching when the subscription moves the rule around.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleEdit {
    pub id: String,
    /// mihomo's rule type, either the config keyword (`DOMAIN-SUFFIX`) or the
    /// controller spelling (`DomainSuffix`).
    pub rule_type: String,
    pub payload: String,
    pub target: String,
    /// `disable`, `retarget` (keep the rule, change its policy) or `replace`.
    pub action: String,
    /// `retarget`: the new policy.
    pub new_target: Option<String>,
    /// `replace`: the full replacement rule line.
    pub replacement: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalSettings {
    pub nodes: Vec<LocalNode>,
    pub rules: Vec<LocalRule>,
    /// Subscription rule edits, by profile id.
    pub profile_edits: BTreeMap<String, Vec<RuleEdit>>,
    /// Hand tailnet traffic to the official Tailscale client when it runs.
    #[serde(default = "default_true")]
    pub tailscale_coexist: bool,
}

impl Default for LocalSettings {
    fn default() -> Self {
        LocalSettings {
            nodes: Vec::new(),
            rules: Vec::new(),
            profile_edits: BTreeMap::new(),
            tailscale_coexist: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Rule line parsing
// ---------------------------------------------------------------------------

/// Split a rule line on top-level commas (commas inside `(...)` belong to a
/// logic rule's payload).
pub fn split_rule(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in line.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth <= 0 => {
                fields.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// `(type, payload, target index)` of a rule line.
fn rule_parts(fields: &[String]) -> Option<(String, String, usize)> {
    let kind = fields.first()?.to_uppercase();
    if kind == "MATCH" || kind == "FINAL" {
        return (fields.len() >= 2).then(|| (kind, String::new(), 1));
    }
    (fields.len() >= 3).then(|| (kind, fields[1].clone(), 2))
}

/// The policy a rule line sends traffic to.
pub fn rule_target(line: &str) -> Option<String> {
    let fields = split_rule(line);
    let (_, _, index) = rule_parts(&fields)?;
    fields.get(index).cloned()
}

/// Config keyword and controller spelling compare equal: `DOMAIN-SUFFIX` ==
/// `DomainSuffix`, `IP-CIDR6` == `IPCIDR` (mihomo reports both as IPCIDR).
fn normalize_type(kind: &str) -> String {
    let flat: String = kind
        .chars()
        .filter(|ch| *ch != '-' && *ch != '_')
        .collect::<String>()
        .to_uppercase();
    match flat.as_str() {
        "IPCIDR6" => "IPCIDR".into(),
        "SRCIPCIDR6" => "SRCIPCIDR".into(),
        "FINAL" => "MATCH".into(),
        "SUBRULE" => "SUBRULES".into(),
        _ => flat,
    }
}

fn normalize_payload(kind: &str, payload: &str) -> String {
    let trimmed = payload.trim();
    if matches!(kind, "IPCIDR" | "SRCIPCIDR") {
        if let Some((addr, len)) = trimmed.split_once('/') {
            if let Ok(ip) = addr.parse::<std::net::IpAddr>() {
                return format!("{ip}/{}", len.trim());
            }
        }
    }
    trimmed.to_lowercase()
}

fn edit_matches(edit: &RuleEdit, fields: &[String]) -> bool {
    let Some((kind, payload, index)) = rule_parts(fields) else {
        return false;
    };
    let kind = normalize_type(&kind);
    let target = fields.get(index).map(String::as_str).unwrap_or_default();
    kind == normalize_type(&edit.rule_type)
        && normalize_payload(&kind, &payload) == normalize_payload(&kind, &edit.payload)
        && target == edit.target.trim()
}

// ---------------------------------------------------------------------------
// Document application
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ApplyReport {
    pub warnings: Vec<String>,
    /// Ids of profile edits that matched no subscription rule.
    pub stale_edits: Vec<String>,
    /// Ids of local nodes skipped (name collision / invalid).
    pub skipped_nodes: Vec<String>,
    /// Ids of local rules skipped (unknown policy / invalid).
    pub skipped_rules: Vec<String>,
}

fn names_of(config: &Map<String, Value>, section: &str) -> Vec<String> {
    config
        .get(section)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A Tailscale node's DNS server is `ts://<name>`: the name has to survive URL
/// parsing as a host.
pub fn tailscale_dns_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.chars().any(|ch| {
            ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '@' | ':' | '%' | '[' | ']')
        })
}

fn safe_state_dir(id: &str) -> String {
    let clean: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(64)
        .collect();
    format!(
        "tailscale/{}",
        if clean.is_empty() { "default" } else { &clean }
    )
}

/// The tailnet rules a Tailscale node gets.
pub fn tailnet_rules_for(name: &str) -> Vec<String> {
    vec![
        format!("DOMAIN-SUFFIX,{TAILNET_DOMAIN},{name}"),
        format!("IP-CIDR,{TAILNET_V4},{name},no-resolve"),
        format!("IP-CIDR6,{TAILNET_V6},{name},no-resolve"),
    ]
}

/// Apply local nodes, rules and the profile's edits to a parsed config.
pub fn apply_to_config(
    config: &mut Map<String, Value>,
    settings: &LocalSettings,
    profile_id: Option<&str>,
) -> ApplyReport {
    let mut report = ApplyReport::default();
    let edits: &[RuleEdit] = profile_id
        .and_then(|id| settings.profile_edits.get(id))
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    // 1. Local nodes.
    let mut proxies: Vec<Value> = config
        .get("proxies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let group_names = names_of(config, "proxy-groups");
    let mut taken: HashSet<String> = names_of(config, "proxies").into_iter().collect();
    taken.extend(group_names.iter().cloned());
    taken.extend(BUILTIN_TARGETS.iter().map(|name| name.to_string()));
    let mut added: Vec<&LocalNode> = Vec::new();
    for node in settings.nodes.iter().filter(|node| node.enabled) {
        let name = node.name().trim().to_string();
        let Some(map) = node.config.as_object() else {
            report.skipped_nodes.push(node.id.clone());
            continue;
        };
        if name.is_empty() || node.kind().is_empty() {
            report.skipped_nodes.push(node.id.clone());
            report
                .warnings
                .push("本地节点缺少名称或类型，已跳过".into());
            continue;
        }
        if taken.contains(&name) {
            report.skipped_nodes.push(node.id.clone());
            report.warnings.push(format!(
                "本地节点「{name}」与订阅中的节点或策略组重名，已跳过"
            ));
            continue;
        }
        let mut map = map.clone();
        map.insert("name".into(), json!(name));
        let kind = node.kind();
        if matches!(kind.as_str(), "wireguard" | "tailscale") && !map.contains_key("udp") {
            map.insert("udp".into(), json!(true));
        }
        if kind == "tailscale" && !map.contains_key("state-dir") {
            map.insert("state-dir".into(), json!(safe_state_dir(&node.id)));
        }
        taken.insert(name);
        proxies.push(Value::Object(map));
        added.push(node);
    }
    if !added.is_empty() {
        config.insert("proxies".into(), Value::Array(proxies));
    }

    // 2. Group membership.
    if let Some(groups) = config.get_mut("proxy-groups").and_then(Value::as_array_mut) {
        for group in groups.iter_mut() {
            let Some(group) = group.as_object_mut() else {
                continue;
            };
            let group_name = group
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let joining: Vec<String> = added
                .iter()
                .filter(|node| node.groups.iter().any(|g| g == &group_name))
                .map(|node| node.name().trim().to_string())
                .collect();
            if joining.is_empty() {
                continue;
            }
            let mut members: Vec<Value> = group
                .get("proxies")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for name in joining {
                if !members.iter().any(|m| m.as_str() == Some(name.as_str())) {
                    members.push(json!(name));
                }
            }
            group.insert("proxies".into(), Value::Array(members));
        }
    }

    // 3. Rules: local rules, tailnet rules, then the (edited) subscription.
    let known: HashSet<String> = taken;
    let target_ok = |line: &str| -> bool {
        rule_target(line)
            .map(|target| known.contains(target.trim()))
            .unwrap_or(false)
    };
    let mut rules: Vec<Value> = Vec::new();
    for rule in settings.rules.iter().filter(|rule| rule.enabled) {
        let line = rule.rule.trim();
        if line.is_empty() {
            continue;
        }
        if !target_ok(line) {
            report.skipped_rules.push(rule.id.clone());
            report.warnings.push(format!(
                "本地规则「{line}」的策略在当前配置中不存在，已跳过"
            ));
            continue;
        }
        rules.push(json!(line));
    }
    for node in &added {
        if node.kind() == "tailscale" && node.tailnet_rules {
            for line in tailnet_rules_for(node.name().trim()) {
                rules.push(json!(line));
            }
        }
    }

    let mut matched: HashSet<&str> = HashSet::new();
    let existing = config
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for entry in existing {
        let Some(line) = entry.as_str() else {
            rules.push(entry);
            continue;
        };
        let fields = split_rule(line);
        let Some(edit) = edits.iter().find(|edit| edit_matches(edit, &fields)) else {
            rules.push(entry);
            continue;
        };
        matched.insert(edit.id.as_str());
        match edit.action.as_str() {
            "disable" => {}
            "retarget" => {
                let next = edit.new_target.as_deref().unwrap_or_default().trim();
                let index = rule_parts(&fields).map(|(_, _, index)| index);
                match index {
                    Some(index) if known.contains(next) => {
                        let mut fields = fields.clone();
                        fields[index] = next.to_string();
                        rules.push(json!(fields.join(",")));
                    }
                    _ => {
                        report.warnings.push(format!(
                            "规则「{line}」要改用的策略「{next}」不存在，保留原规则"
                        ));
                        rules.push(entry);
                    }
                }
            }
            "replace" => {
                let next = edit.replacement.as_deref().unwrap_or_default().trim();
                if !next.is_empty() && target_ok(next) {
                    rules.push(json!(next));
                } else {
                    report
                        .warnings
                        .push(format!("规则「{line}」的替换内容无效，保留原规则"));
                    rules.push(entry);
                }
            }
            _ => rules.push(entry),
        }
    }
    for edit in edits {
        if !matched.contains(edit.id.as_str()) {
            report.stale_edits.push(edit.id.clone());
        }
    }
    let touched = !rules.is_empty() || config.contains_key("rules");
    if touched {
        config.insert("rules".into(), Value::Array(rules));
    }
    report
}

/// Pure document form of [`apply_to_config`]. An unparseable document is
/// returned untouched.
pub fn apply_to_document(
    document: &str,
    settings: &LocalSettings,
    profile_id: Option<&str>,
) -> (String, ApplyReport) {
    if settings.nodes.is_empty()
        && settings.rules.is_empty()
        && profile_id
            .and_then(|id| settings.profile_edits.get(id))
            .map(Vec::is_empty)
            .unwrap_or(true)
    {
        return (document.to_string(), ApplyReport::default());
    }
    let Some(mut config) = parse_yaml_to_object(document) else {
        return (document.to_string(), ApplyReport::default());
    };
    let report = apply_to_config(&mut config, settings, profile_id);
    (stringify_yaml(Value::Object(config)), report)
}

fn has_rule_line(rules: &[Value], line: &str) -> bool {
    rules.iter().any(|rule| rule.as_str() == Some(line))
}

/// Runtime pass (after DNS/sniffer enhancement): Tailscale DNS policy and
/// the coexistence routing. `adapter` is the official client's interface.
pub fn apply_runtime_to_config(
    config: &mut Map<String, Value>,
    settings: &LocalSettings,
    adapter: Option<&str>,
) {
    let mut policies: Vec<(String, String)> = Vec::new();
    let proxy_names: HashSet<String> = names_of(config, "proxies").into_iter().collect();
    for node in settings
        .nodes
        .iter()
        .filter(|node| node.enabled && node.tailnet_rules)
    {
        let name = node.name().trim();
        if node.kind() == "tailscale" && proxy_names.contains(name) && tailscale_dns_safe_name(name)
        {
            policies.push((format!("+.{TAILNET_DOMAIN}"), format!("ts://{name}")));
            break;
        }
    }

    if let (true, Some(adapter)) = (settings.tailscale_coexist, adapter) {
        let mut proxies: Vec<Value> = config
            .get("proxies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.get("name").and_then(Value::as_str) != Some(TAILSCALE_DIRECT_NAME))
            .collect();
        proxies.push(json!({
            "name": TAILSCALE_DIRECT_NAME,
            "type": "direct",
            "udp": true,
            "interface-name": adapter,
        }));
        config.insert("proxies".into(), Value::Array(proxies));
        let existing: Vec<Value> = config
            .get("rules")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut rules: Vec<Value> = tailnet_rules_for(TAILSCALE_DIRECT_NAME)
            .into_iter()
            .filter(|line| !has_rule_line(&existing, line))
            .map(Value::String)
            .collect();
        rules.extend(existing);
        config.insert("rules".into(), Value::Array(rules));
        // The official client wins over a built-in node for MagicDNS.
        policies.retain(|(key, _)| key != &format!("+.{TAILNET_DOMAIN}"));
        policies.push((
            format!("+.{TAILNET_DOMAIN}"),
            format!("{MAGIC_DNS}#{TAILSCALE_DIRECT_NAME}"),
        ));
    }

    if policies.is_empty() {
        return;
    }
    let Some(dns) = config.get_mut("dns").and_then(Value::as_object_mut) else {
        return;
    };
    if dns.get("enable") != Some(&Value::Bool(true)) {
        return;
    }
    let mut policy = dns
        .get("nameserver-policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, server) in &policies {
        // The user's own policy for the tailnet domain stays authoritative.
        if !policy.contains_key(key) {
            policy.insert(key.clone(), json!(server));
        }
    }
    dns.insert("nameserver-policy".into(), Value::Object(policy));
    if adapter.is_some()
        && settings.tailscale_coexist
        && dns.get("enhanced-mode").and_then(Value::as_str) == Some("fake-ip")
    {
        let mut filter: Vec<Value> = match dns.get("fake-ip-filter").and_then(Value::as_array) {
            Some(list) => list.clone(),
            None => crate::tun_profile::default_fake_ip_filter()
                .into_iter()
                .map(Value::String)
                .collect(),
        };
        let entry = format!("+.{TAILNET_DOMAIN}");
        if !filter
            .iter()
            .any(|item| item.as_str() == Some(entry.as_str()))
        {
            filter.push(json!(entry));
        }
        dns.insert("fake-ip-filter".into(), Value::Array(filter));
    }
}

// ---------------------------------------------------------------------------
// Official Tailscale client detection
// ---------------------------------------------------------------------------

fn in_tailnet_v4(ip: &std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0xC0) == 64
}

/// The interface name of a running official Tailscale client: an adapter
/// named like Tailscale that holds a tailnet (100.64.0.0/10) address.
pub fn detect_tailscale_adapter() -> Option<String> {
    #[cfg(test)]
    if let Some(forced) = DETECT_OVERRIDE.lock().expect("detect").clone() {
        return forced;
    }
    let interfaces = if_addrs::get_if_addrs().ok()?;
    interfaces.into_iter().find_map(|iface| {
        let named = iface.name.to_lowercase().contains("tailscale");
        let tailnet = matches!(iface.addr.ip(), std::net::IpAddr::V4(ip) if in_tailnet_v4(&ip));
        (named && tailnet).then_some(iface.name)
    })
}

#[cfg(test)]
static DETECT_OVERRIDE: Mutex<Option<Option<String>>> = Mutex::new(None);

#[cfg(test)]
pub fn force_detect_for_test(value: Option<Option<String>>) {
    *DETECT_OVERRIDE.lock().expect("detect") = value;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct LocalService {
    dir: Option<PathBuf>,
    settings: Mutex<LocalSettings>,
}

static SERVICE: OnceCell<Arc<LocalService>> = OnceCell::new();

pub fn global() -> Option<Arc<LocalService>> {
    SERVICE.get().cloned()
}

pub fn initialize(app_data_root: Option<PathBuf>) {
    let dir = app_data_root.map(|root| root.join(SETTINGS_DIR));
    let _ = SERVICE.set(Arc::new(LocalService::new(dir)));
}

/// The document hook used by `OverrideService::apply_for_profile`.
pub fn apply_global(document: &str, profile_id: Option<&str>) -> String {
    match global() {
        Some(service) => apply_to_document(document, &service.settings(), profile_id).0,
        None => document.to_string(),
    }
}

/// The runtime hook used by `live_config::resolve_enhanced_document`.
pub fn apply_runtime_global(document: &str) -> String {
    let Some(service) = global() else {
        return document.to_string();
    };
    let settings = service.settings();
    let adapter = if settings.tailscale_coexist {
        detect_tailscale_adapter()
    } else {
        None
    };
    let has_ts_node = settings
        .nodes
        .iter()
        .any(|node| node.enabled && node.kind() == "tailscale");
    if adapter.is_none() && !has_ts_node {
        return document.to_string();
    }
    let Some(mut config) = parse_yaml_to_object(document) else {
        return document.to_string();
    };
    apply_runtime_to_config(&mut config, &settings, adapter.as_deref());
    stringify_yaml(Value::Object(config))
}

/// TUN route exclusions for the official Tailscale client, when it runs.
pub fn tailscale_route_excludes() -> Vec<String> {
    let active = global()
        .map(|service| service.settings().tailscale_coexist)
        .unwrap_or(false);
    if active && detect_tailscale_adapter().is_some() {
        vec![TAILNET_V4.to_string(), TAILNET_V6.to_string()]
    } else {
        Vec::new()
    }
}

/// Append [`tailscale_route_excludes`] to a mihomo `tun` block.
pub fn extend_tun_excludes(tun: &mut Map<String, Value>) {
    let extra = tailscale_route_excludes();
    if extra.is_empty() {
        return;
    }
    let mut list: Vec<Value> = tun
        .get("route-exclude-address")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for cidr in extra {
        if !list.iter().any(|item| item.as_str() == Some(cidr.as_str())) {
            list.push(json!(cidr));
        }
    }
    tun.insert("route-exclude-address".into(), Value::Array(list));
}

fn validate_settings(settings: &LocalSettings) -> Result<(), IpcError> {
    if settings.nodes.len() > NODE_LIMIT {
        return Err(IpcError::invalid_argument("本地节点数量超出上限"));
    }
    if settings.rules.len() > RULE_LIMIT {
        return Err(IpcError::invalid_argument("本地规则数量超出上限"));
    }
    let mut names = HashSet::new();
    for node in &settings.nodes {
        if !node.config.is_object() {
            return Err(IpcError::invalid_argument("本地节点配置必须是对象"));
        }
        let name = node.name().trim();
        if name.is_empty() {
            return Err(IpcError::invalid_argument("本地节点缺少名称"));
        }
        if node.kind().is_empty() {
            return Err(IpcError::invalid_argument(format!(
                "本地节点「{name}」缺少类型"
            )));
        }
        if !names.insert(name.to_string()) {
            return Err(IpcError::invalid_argument(format!(
                "本地节点「{name}」重名"
            )));
        }
    }
    for rule in &settings.rules {
        if rule.rule.contains('\n') {
            return Err(IpcError::invalid_argument("本地规则不能包含换行"));
        }
        if !rule.rule.trim().is_empty() && rule_target(&rule.rule).is_none() {
            return Err(IpcError::invalid_argument(format!(
                "规则「{}」格式不正确，应为 类型,值,策略",
                rule.rule.trim()
            )));
        }
    }
    for edits in settings.profile_edits.values() {
        for edit in edits {
            if !matches!(edit.action.as_str(), "disable" | "retarget" | "replace") {
                return Err(IpcError::invalid_argument("未知的规则修改方式"));
            }
        }
    }
    Ok(())
}

fn fill_ids(settings: &mut LocalSettings) {
    for node in &mut settings.nodes {
        if node.id.trim().is_empty() {
            node.id = uuid::Uuid::new_v4().to_string();
        }
    }
    for rule in &mut settings.rules {
        if rule.id.trim().is_empty() {
            rule.id = uuid::Uuid::new_v4().to_string();
        }
    }
    for edits in settings.profile_edits.values_mut() {
        for edit in edits.iter_mut() {
            if edit.id.trim().is_empty() {
                edit.id = uuid::Uuid::new_v4().to_string();
            }
        }
    }
    settings.profile_edits.retain(|_, edits| !edits.is_empty());
}

impl LocalService {
    pub fn new(dir: Option<PathBuf>) -> Self {
        let settings = dir
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok())
            .and_then(|text| serde_json::from_str::<LocalSettings>(&text).ok())
            .unwrap_or_default();
        LocalService {
            dir,
            settings: Mutex::new(settings),
        }
    }

    pub fn settings(&self) -> LocalSettings {
        self.settings.lock().expect("local settings").clone()
    }

    fn persist(&self, settings: &LocalSettings) -> Result<(), IpcError> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|e| IpcError::internal(e.to_string()))?;
        let text = serde_json::to_string_pretty(settings)
            .map_err(|e| IpcError::internal(e.to_string()))?
            + "\n";
        let tmp = dir.join(format!(".{SETTINGS_FILE}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, text).map_err(|e| IpcError::internal(e.to_string()))?;
        std::fs::rename(&tmp, dir.join(SETTINGS_FILE))
            .map_err(|e| IpcError::internal(e.to_string()))
    }

    /// Replace the whole settings object. Returns whether anything changed.
    pub fn save(&self, mut next: LocalSettings) -> Result<bool, IpcError> {
        fill_ids(&mut next);
        validate_settings(&next)?;
        let mut guard = self.settings.lock().expect("local settings");
        if *guard == next {
            return Ok(false);
        }
        self.persist(&next)?;
        *guard = next;
        Ok(true)
    }

    /// The renderer snapshot: settings plus what they do to the active
    /// subscription (`document` is the profile after overrides, before this
    /// layer).
    pub fn snapshot(&self, active: Option<(&str, Option<&str>, Option<&str>)>) -> Value {
        let settings = self.settings();
        let adapter = detect_tailscale_adapter();
        let mut targets: Vec<String> = BUILTIN_TARGETS
            .iter()
            .filter(|name| **name != "GLOBAL")
            .map(|name| name.to_string())
            .collect();
        let mut groups: Vec<Value> = Vec::new();
        let mut report = ApplyReport::default();
        let mut profile = Value::Null;
        if let Some((document, profile_id, profile_name)) = active {
            if let Some(mut config) = parse_yaml_to_object(document) {
                for entry in config
                    .get("proxy-groups")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    if let Some(name) = entry.get("name").and_then(Value::as_str) {
                        groups.push(json!({
                            "name": name,
                            "type": entry.get("type").and_then(Value::as_str).unwrap_or_default(),
                        }));
                        targets.push(name.to_string());
                    }
                }
                report = apply_to_config(&mut config, &settings, profile_id);
                targets.extend(names_of(&config, "proxies"));
            }
            profile = json!({ "id": profile_id, "name": profile_name });
        } else {
            for node in settings.nodes.iter().filter(|node| node.enabled) {
                targets.push(node.name().to_string());
            }
        }
        let mut seen = HashSet::new();
        targets.retain(|name| !name.is_empty() && seen.insert(name.clone()));
        json!({
            "settings": settings,
            "profile": profile,
            "targets": targets,
            "groups": groups,
            "warnings": report.warnings,
            "staleEdits": report.stale_edits,
            "skippedNodes": report.skipped_nodes,
            "skippedRules": report.skipped_rules,
            "tailscale": {
                "detected": adapter.is_some(),
                "interface": adapter,
                "active": adapter.is_some() && settings.tailscale_coexist,
            },
        })
    }
}

fn active_document(
    profiles: &Arc<crate::profile_service::ProfilesService>,
    overrides: &crate::override_service::OverrideService,
) -> Option<(String, String, Option<String>)> {
    let profile = profiles.get_active().ok()?;
    if profile.is_null() {
        return None;
    }
    let document = profile["document"].as_str().unwrap_or_default().to_string();
    let id = profile["meta"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let name = profile["meta"]["name"].as_str().map(str::to_string);
    let overridden = overrides
        .apply_overrides_only(&document, (!id.is_empty()).then_some(id.as_str()))
        .unwrap_or(document);
    Some((overridden, id, name))
}

/// `local:*` channels.
pub async fn dispatch(
    channel: &str,
    payload: &Value,
    kernel: &crate::kernel::KernelServices,
    models: &crate::enhancements::ModelStores,
    profiles: &Arc<crate::profile_service::ProfilesService>,
    overrides: &crate::override_service::OverrideService,
) -> Result<Value, IpcError> {
    let service = global().ok_or_else(|| IpcError::unsupported("本地节点服务未启动"))?;
    let snapshot = |service: &LocalService| {
        let active = active_document(profiles, overrides);
        service.snapshot(active.as_ref().map(|(document, id, name)| {
            (
                document.as_str(),
                (!id.is_empty()).then_some(id.as_str()),
                name.as_deref(),
            )
        }))
    };
    match channel {
        "local:get-state" => Ok(snapshot(&service)),
        "local:save" => {
            let next: LocalSettings =
                serde_json::from_value(payload.get(0).cloned().unwrap_or(Value::Null))
                    .map_err(|e| IpcError::invalid_argument(format!("本地设置格式错误：{e}")))?;
            if service.save(next)? {
                // A failed hot reload must not hide the saved change; the
                // next kernel start composes the same document anyway.
                if let Ok(reloader) = crate::live_config::LiveConfigReloader::from_ipc(
                    kernel, models, profiles, overrides,
                ) {
                    let _ = reloader.reload_if_running().await;
                }
            }
            Ok(snapshot(&service))
        }
        _ => Err(IpcError::unsupported_channel(channel)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, kind: &str, groups: &[&str]) -> LocalNode {
        LocalNode {
            id: format!("id-{name}"),
            config: json!({ "name": name, "type": kind, "server": "1.2.3.4", "port": 51820 }),
            groups: groups.iter().map(|g| g.to_string()).collect(),
            ..LocalNode::default()
        }
    }

    fn rule(line: &str) -> LocalRule {
        LocalRule {
            id: format!("r-{line}"),
            enabled: true,
            rule: line.into(),
        }
    }

    const DOC: &str = "proxies:\n  - {name: HK, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: x}\nproxy-groups:\n  - {name: Proxy, type: select, proxies: [HK]}\n  - {name: Auto, type: url-test, use: [sub]}\nrules:\n  - DOMAIN-SUFFIX,google.com,Proxy\n  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve\n  - AND,((NETWORK,UDP),(DST-PORT,443)),REJECT\n  - MATCH,Proxy\n";

    fn apply(settings: &LocalSettings, profile: Option<&str>) -> (Map<String, Value>, ApplyReport) {
        let mut config = parse_yaml_to_object(DOC).unwrap();
        let report = apply_to_config(&mut config, settings, profile);
        (config, report)
    }

    fn rules_of(config: &Map<String, Value>) -> Vec<String> {
        config["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn split_keeps_logic_payloads_together() {
        assert_eq!(
            split_rule("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT"),
            vec!["AND", "((NETWORK,UDP),(DST-PORT,443))", "REJECT"]
        );
        assert_eq!(rule_target("MATCH,Proxy").as_deref(), Some("Proxy"));
        assert_eq!(
            rule_target("IP-CIDR,1.0.0.0/8,DIRECT,no-resolve").as_deref(),
            Some("DIRECT")
        );
        assert_eq!(rule_target("garbage"), None);
    }

    #[test]
    fn nodes_join_groups_and_rules_go_first() {
        let settings = LocalSettings {
            nodes: vec![node("家里WG", "wireguard", &["Proxy", "Auto", "Missing"])],
            rules: vec![
                rule("DOMAIN-SUFFIX,home.lan,家里WG"),
                rule("DOMAIN,x.com,Nope"),
            ],
            ..LocalSettings::default()
        };
        let (config, report) = apply(&settings, None);
        let proxies = config["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 2);
        assert_eq!(proxies[1]["udp"], json!(true));
        let groups = config["proxy-groups"].as_array().unwrap();
        assert_eq!(groups[0]["proxies"], json!(["HK", "家里WG"]));
        assert_eq!(groups[1]["proxies"], json!(["家里WG"]));
        assert_eq!(groups[1]["use"], json!(["sub"]));
        let rules = rules_of(&config);
        assert_eq!(rules[0], "DOMAIN-SUFFIX,home.lan,家里WG");
        assert_eq!(rules.len(), 5);
        assert_eq!(report.skipped_rules, vec!["r-DOMAIN,x.com,Nope"]);
    }

    #[test]
    fn colliding_node_is_skipped() {
        let settings = LocalSettings {
            nodes: vec![
                node("HK", "wireguard", &[]),
                node("Proxy", "wireguard", &[]),
            ],
            ..LocalSettings::default()
        };
        let (config, report) = apply(&settings, None);
        assert_eq!(config["proxies"].as_array().unwrap().len(), 1);
        assert_eq!(report.skipped_nodes, vec!["id-HK", "id-Proxy"]);
    }

    #[test]
    fn tailscale_node_gets_state_dir_and_tailnet_rules() {
        let mut ts = node("Tailnet", "tailscale", &[]);
        ts.config = json!({ "name": "Tailnet", "type": "tailscale", "auth-key": "tskey" });
        let settings = LocalSettings {
            nodes: vec![ts],
            ..LocalSettings::default()
        };
        let (config, _) = apply(&settings, None);
        assert_eq!(
            config["proxies"][1]["state-dir"],
            json!("tailscale/id-Tailnet")
        );
        let rules = rules_of(&config);
        assert_eq!(rules[0], "DOMAIN-SUFFIX,ts.net,Tailnet");
        assert_eq!(rules[1], "IP-CIDR,100.64.0.0/10,Tailnet,no-resolve");
        assert_eq!(rules[2], "IP-CIDR6,fd7a:115c:a1e0::/48,Tailnet,no-resolve");
    }

    #[test]
    fn profile_edits_match_controller_spelling() {
        let edits = vec![
            RuleEdit {
                id: "e1".into(),
                rule_type: "DomainSuffix".into(),
                payload: "Google.com".into(),
                target: "Proxy".into(),
                action: "retarget".into(),
                new_target: Some("DIRECT".into()),
                ..RuleEdit::default()
            },
            RuleEdit {
                id: "e2".into(),
                rule_type: "IPCIDR".into(),
                payload: "10.0.0.0/8".into(),
                target: "DIRECT".into(),
                action: "disable".into(),
                ..RuleEdit::default()
            },
            RuleEdit {
                id: "e3".into(),
                rule_type: "Domain".into(),
                payload: "gone.com".into(),
                target: "Proxy".into(),
                action: "disable".into(),
                ..RuleEdit::default()
            },
            RuleEdit {
                id: "e4".into(),
                rule_type: "Match".into(),
                payload: "".into(),
                target: "Proxy".into(),
                action: "replace".into(),
                replacement: Some("MATCH,DIRECT".into()),
                ..RuleEdit::default()
            },
        ];
        let mut settings = LocalSettings::default();
        settings.profile_edits.insert("p1".into(), edits);
        let (config, report) = apply(&settings, Some("p1"));
        assert_eq!(
            rules_of(&config),
            vec![
                "DOMAIN-SUFFIX,google.com,DIRECT",
                "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT",
                "MATCH,DIRECT"
            ]
        );
        assert_eq!(report.stale_edits, vec!["e3"]);
        // Another profile is untouched.
        let (config, _) = apply(&settings, Some("p2"));
        assert_eq!(rules_of(&config).len(), 4);
    }

    #[test]
    fn retarget_to_missing_policy_keeps_rule() {
        let mut settings = LocalSettings::default();
        settings.profile_edits.insert(
            "p1".into(),
            vec![RuleEdit {
                id: "e".into(),
                rule_type: "MATCH".into(),
                target: "Proxy".into(),
                action: "retarget".into(),
                new_target: Some("Nope".into()),
                ..RuleEdit::default()
            }],
        );
        let (config, report) = apply(&settings, Some("p1"));
        assert_eq!(rules_of(&config)[3], "MATCH,Proxy");
        assert_eq!(report.warnings.len(), 1);
    }

    #[test]
    fn ipcidr6_payloads_compare_canonically() {
        let fields = split_rule("IP-CIDR6,FD00:0:0::1/64,DIRECT");
        let edit = RuleEdit {
            rule_type: "IPCIDR".into(),
            payload: "fd00::1/64".into(),
            target: "DIRECT".into(),
            action: "disable".into(),
            ..RuleEdit::default()
        };
        assert!(edit_matches(&edit, &fields));
    }

    #[test]
    fn coexistence_routes_tailnet_to_adapter() {
        let doc = "proxies: []\ndns:\n  enable: true\n  enhanced-mode: fake-ip\nrules:\n  - MATCH,DIRECT\n";
        let mut config = parse_yaml_to_object(doc).unwrap();
        apply_runtime_to_config(&mut config, &LocalSettings::default(), Some("Tailscale"));
        assert_eq!(
            config["proxies"][0],
            json!({"name": "Murge-Tailscale", "type": "direct", "udp": true, "interface-name": "Tailscale"})
        );
        let rules = rules_of(&config);
        assert_eq!(rules[0], "DOMAIN-SUFFIX,ts.net,Murge-Tailscale");
        assert_eq!(rules[3], "MATCH,DIRECT");
        assert_eq!(
            config["dns"]["nameserver-policy"]["+.ts.net"],
            json!("100.100.100.100#Murge-Tailscale")
        );
        let filter = config["dns"]["fake-ip-filter"].as_array().unwrap();
        assert!(filter.contains(&json!("+.ts.net")));
        assert!(filter.contains(&json!("+.lan")));
        // Idempotent.
        apply_runtime_to_config(&mut config, &LocalSettings::default(), Some("Tailscale"));
        assert_eq!(rules_of(&config).len(), 4);
        assert_eq!(config["proxies"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn coexistence_off_or_absent_changes_nothing() {
        let doc = "proxies: []\nrules:\n  - MATCH,DIRECT\n";
        let mut config = parse_yaml_to_object(doc).unwrap();
        let before = config.clone();
        apply_runtime_to_config(&mut config, &LocalSettings::default(), None);
        assert_eq!(config, before);
        let settings = LocalSettings {
            tailscale_coexist: false,
            ..LocalSettings::default()
        };
        apply_runtime_to_config(&mut config, &settings, Some("Tailscale"));
        assert_eq!(config, before);
    }

    #[test]
    fn builtin_tailscale_node_sets_magicdns_policy() {
        let doc = "proxies:\n  - {name: Tailnet, type: tailscale}\ndns:\n  enable: true\n  nameserver-policy:\n    '+.corp': 10.0.0.1\n";
        let mut config = parse_yaml_to_object(doc).unwrap();
        let settings = LocalSettings {
            nodes: vec![node("Tailnet", "tailscale", &[])],
            ..LocalSettings::default()
        };
        apply_runtime_to_config(&mut config, &settings, None);
        assert_eq!(
            config["dns"]["nameserver-policy"]["+.ts.net"],
            json!("ts://Tailnet")
        );
        assert_eq!(
            config["dns"]["nameserver-policy"]["+.corp"],
            json!("10.0.0.1")
        );
    }

    #[test]
    fn tun_excludes_follow_detection() {
        let mut tun = Map::new();
        force_detect_for_test(Some(None));
        extend_tun_excludes(&mut tun);
        assert!(tun.is_empty());
        force_detect_for_test(None);
    }

    #[test]
    fn save_validates_and_fills_ids() {
        let dir = std::env::temp_dir().join(format!("murge-local-{}", uuid::Uuid::new_v4()));
        let service = LocalService::new(Some(dir.clone()));
        let mut settings = LocalSettings {
            nodes: vec![LocalNode {
                config: json!({"name": "A", "type": "wireguard"}),
                ..LocalNode::default()
            }],
            rules: vec![LocalRule {
                rule: "DOMAIN,a.com,A".into(),
                ..LocalRule::default()
            }],
            ..LocalSettings::default()
        };
        assert!(service.save(settings.clone()).unwrap());
        let saved = service.settings();
        assert!(!saved.nodes[0].id.is_empty());
        assert!(!saved.rules[0].id.is_empty());
        let reloaded = LocalService::new(Some(dir.clone()));
        assert_eq!(reloaded.settings(), saved);
        assert!(!service.save(saved).unwrap());
        settings.rules[0].rule = "bad".into();
        assert!(service.save(settings.clone()).is_err());
        settings.rules.clear();
        settings.nodes.push(settings.nodes[0].clone());
        assert!(service.save(settings).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `MURGE_E2E_MIHOMO=<mihomo binary> cargo test --lib local_edits::tests::mihomo_accepts`
    /// runs `mihomo -t` on a document carrying every local-layer feature.
    #[test]
    fn mihomo_accepts_the_local_layer() {
        let Some(binary) = std::env::var_os("MURGE_E2E_MIHOMO") else {
            return;
        };
        let mut ts = node("Tailnet", "tailscale", &["Proxy"]);
        ts.config = json!({ "name": "Tailnet", "type": "tailscale", "auth-key": "tskey-auth-test", "accept-routes": true });
        let mut wg = node("家里WG", "wireguard", &["Proxy"]);
        wg.config = json!({
            "name": "家里WG", "type": "wireguard", "server": "203.0.113.1", "port": 51820,
            "ip": "10.8.0.2/32", "private-key": "eCtXsJZ27+4PbhDkHnB923tkUn2Gj59wZw5wFA75MnU=",
            "public-key": "Cr8hWlKvtDt7nrvf+f0brNQQzabAqrjfBvas9pmowjo=", "allowed-ips": ["0.0.0.0/0"],
            "remote-dns-resolve": true, "dns": ["1.1.1.1"]
        });
        let mut settings = LocalSettings {
            nodes: vec![wg, ts],
            rules: vec![rule("DOMAIN-SUFFIX,home.lan,家里WG")],
            ..LocalSettings::default()
        };
        settings.profile_edits.insert(
            "p".into(),
            vec![RuleEdit {
                id: "e".into(),
                rule_type: "DomainSuffix".into(),
                payload: "google.com".into(),
                target: "Proxy".into(),
                action: "retarget".into(),
                new_target: Some("家里WG".into()),
                ..RuleEdit::default()
            }],
        );
        let doc = "proxies:\n  - {name: HK, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: x}\nproxy-groups:\n  - {name: Proxy, type: select, proxies: [HK]}\ndns:\n  enable: true\n  enhanced-mode: fake-ip\n  nameserver: [223.5.5.5]\nrules:\n  - DOMAIN-SUFFIX,google.com,Proxy\n  - MATCH,Proxy\n";
        let (text, report) = apply_to_document(doc, &settings, Some("p"));
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        let mut config = parse_yaml_to_object(&text).unwrap();
        apply_runtime_to_config(&mut config, &settings, Some("lo"));
        let text = stringify_yaml(Value::Object(config));
        let dir = std::env::temp_dir().join(format!("murge-local-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.yaml"), &text).unwrap();
        let output = std::process::Command::new(binary)
            .arg("-d")
            .arg(&dir)
            .arg("-t")
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(output.status.success(), "{log}\n---\n{text}");
        assert!(log.contains("test is successful"), "{log}");
    }

    #[test]
    fn empty_settings_leave_document_untouched() {
        let (text, report) = apply_to_document(DOC, &LocalSettings::default(), Some("p"));
        assert_eq!(text, DOC);
        assert_eq!(report, ApplyReport::default());
    }
}
