//! Mihomo external-controller REST client — Rust port of
//! `src/main/services/mihomo-client.ts` (requests + typed error mapping),
//! `src/shared/schemas/mihomo.ts` (payload validation), the argument
//! validators from `src/shared/schemas/ipc.ts` for the mihomo channels,
//! `src/main/services/log-buffer.ts`, `src/main/profiles/proxy-selection-store.ts`,
//! `src/main/services/proxy-selection-gateway.ts` (selection attribution) and
//! the delay-test resolution of `src/main/services/mihomo-service.ts`
//! (group test URLs + provider-owner fallback).
//!
//! Error mapping mirrors the TS `request` helper verbatim (transport ->
//! UPSTREAM_UNREACHABLE, timeout -> UPSTREAM_TIMEOUT, 401 -> UNAUTHORIZED,
//! 504 -> UPSTREAM_TIMEOUT, 503 -> UPSTREAM_TEST_FAILED, other non-2xx ->
//! UPSTREAM_HTTP_ERROR, invalid JSON -> INVALID_UPSTREAM).
//!
//! Known differences (documented in docs/tauri/phase3/README.md):
//! - the controller endpoint is read from the coerced core-settings model
//!   (Electron production wires the kernel's materialized config; the Rust
//!   shell rebinds at the Phase 3D kernel slice);
//! - provider/group caches are per-process like the TS service (1s TTL);
//! - YAML merge keys (`<<`) are resolved one level deep for `url`/`name`
//!   lookups (the TS parser merges natively).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::{code, IpcError};

/// The default connectivity probe (TS `DEFAULT_TEST_URL`): URLTest groups that
/// omit `url` measure member aliveness against THIS address, so per-node
/// probes must use the same destination to agree with the group.
pub const DEFAULT_TEST_URL: &str = "https://www.gstatic.com/generate_204";
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const PROVIDER_REFRESH_TIMEOUT_MS: u64 = 45_000;
pub const DEFAULT_DELAY_TIMEOUT_MS: u64 = 5_000;

const LOG_LEVELS: [&str; 5] = ["silent", "error", "warning", "info", "debug"];
const DNS_TYPES: [&str; 7] = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "HTTPS"];

/// `encodeURIComponent` parity: percent-encode everything except the JS
/// unreserved set (`A-Za-z0-9-_.!~*'()`), uppercase hex like the JS runtime.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let c = *byte;
        let keep = c.is_ascii_alphanumeric()
            || matches!(c, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::code(code::INVALID_ARGUMENT, message)
}

fn invalid_upstream(label: &str, message: impl std::fmt::Display) -> IpcError {
    IpcError::code(
        code::INVALID_UPSTREAM,
        format!("Invalid {label} payload: {message}"),
    )
}

/// First-issue zod-style message helper: `Required` / `Expected X, received Y`.
fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expect_string(label: &str, object: &Map<String, Value>, key: &str) -> Result<String, IpcError> {
    match object.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(other) => Err(invalid_upstream(
            label,
            format!("Expected string, received {}", type_of(other)),
        )),
        None => Err(invalid_upstream(label, "Required")),
    }
}

fn expect_number(label: &str, object: &Map<String, Value>, key: &str) -> Result<f64, IpcError> {
    match object.get(key) {
        Some(Value::Number(value)) => Ok(value.as_f64().unwrap_or_default()),
        Some(other) => Err(invalid_upstream(
            label,
            format!("Expected number, received {}", type_of(other)),
        )),
        None => Err(invalid_upstream(label, "Required")),
    }
}

fn expect_bool(label: &str, object: &Map<String, Value>, key: &str) -> Result<bool, IpcError> {
    match object.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(other) => Err(invalid_upstream(
            label,
            format!("Expected boolean, received {}", type_of(other)),
        )),
        None => Err(invalid_upstream(label, "Required")),
    }
}

fn expect_object<'a>(label: &str, value: &'a Value, key: &str) -> Result<&'a Map<String, Value>, IpcError> {
    match value.get(key) {
        Some(Value::Object(object)) => Ok(object),
        Some(other) => Err(invalid_upstream(
            label,
            format!("Expected object, received {}", type_of(other)),
        )),
        None => Err(invalid_upstream(label, "Required")),
    }
}

fn expect_array<'a>(label: &str, value: &'a Value, key: &str) -> Result<&'a Vec<Value>, IpcError> {
    match value.get(key) {
        Some(Value::Array(array)) => Ok(array),
        Some(other) => Err(invalid_upstream(
            label,
            format!("Expected array, received {}", type_of(other)),
        )),
        None => Err(invalid_upstream(label, "Required")),
    }
}

// ---------------------------------------------------------------------------
// Payload parsers (shared/schemas/mihomo.ts)
// ---------------------------------------------------------------------------

pub fn parse_mihomo_version(input: &Value) -> Result<Value, IpcError> {
    let object = input.as_object().ok_or_else(|| invalid_upstream("version", "Expected object, received null"))?;
    expect_bool("version", object, "meta")?;
    expect_string("version", object, "version")?;
    Ok(input.clone())
}

pub fn parse_mihomo_config(input: &Value) -> Result<Value, IpcError> {
    if !input.is_object() {
        return Err(invalid_upstream("configs", format!("Expected object, received {}", type_of(input))));
    }
    // Every field is optional; `mode` must be one of the three live modes.
    if let Some(mode) = input.get("mode") {
        let mode = mode.as_str().unwrap_or_default();
        if !matches!(mode, "rule" | "global" | "direct") {
            return Err(invalid_upstream(
                "configs",
                format!("Invalid enum value. Expected 'rule' | 'global' | 'direct', received '{mode}'"),
            ));
        }
    }
    Ok(input.clone())
}

fn validate_proxy(label: &str, proxy: &Value) -> Result<(), IpcError> {
    let object = proxy.as_object().ok_or_else(|| invalid_upstream(label, "Expected object, received null"))?;
    expect_string(label, object, "name")?;
    expect_string(label, object, "type")?;
    Ok(())
}

pub fn parse_mihomo_proxies(input: &Value) -> Result<Value, IpcError> {
    let proxies = expect_object("proxies", input, "proxies")?;
    for proxy in proxies.values() {
        validate_proxy("proxies", proxy)?;
    }
    Ok(input.clone())
}

pub fn parse_mihomo_rules(input: &Value) -> Result<Value, IpcError> {
    let rules = expect_array("rules", input, "rules")?;
    for rule in rules {
        let object = rule
            .as_object()
            .ok_or_else(|| invalid_upstream("rules", "Expected object, received null"))?;
        expect_number("rules", object, "index")?;
        expect_string("rules", object, "type")?;
        expect_string("rules", object, "payload")?;
        expect_string("rules", object, "proxy")?;
        expect_number("rules", object, "size")?;
    }
    Ok(input.clone())
}

fn validate_provider(label: &str, provider: &Value) -> Result<(), IpcError> {
    let object = provider
        .as_object()
        .ok_or_else(|| invalid_upstream(label, "Expected object, received null"))?;
    expect_string(label, object, "name")?;
    expect_string(label, object, "type")?;
    Ok(())
}

pub fn parse_mihomo_proxy_providers(input: &Value) -> Result<Value, IpcError> {
    let providers = expect_object("proxy-providers", input, "providers")?;
    for provider in providers.values() {
        validate_provider("proxy-providers", provider)?;
    }
    Ok(input.clone())
}

pub fn parse_mihomo_rule_providers(input: &Value) -> Result<Value, IpcError> {
    let providers = expect_object("rule-providers", input, "providers")?;
    for provider in providers.values() {
        validate_provider("rule-providers", provider)?;
    }
    Ok(input.clone())
}

pub fn parse_mihomo_delay_result(input: &Value) -> Result<Value, IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_upstream("delay-result", "Expected object, received null"))?;
    expect_number("delay-result", object, "delay")?;
    Ok(input.clone())
}

pub fn parse_mihomo_delay_map(input: &Value) -> Result<Value, IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_upstream("delay-map", "Expected object, received null"))?;
    for value in object.values() {
        if !value.is_number() {
            return Err(invalid_upstream(
                "delay-map",
                format!("Expected number, received {}", type_of(value)),
            ));
        }
    }
    Ok(input.clone())
}

pub fn parse_mihomo_dns_query(input: &Value) -> Result<Value, IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_upstream("dns-query", "Expected object, received null"))?;
    let status = expect_number("dns-query", object, "Status")?;
    if status < 0.0 || status.fract() != 0.0 {
        return Err(invalid_upstream("dns-query", "Expected number to be an integer"));
    }
    let questions = expect_array("dns-query", input, "Question")?;
    for question in questions {
        let object = question
            .as_object()
            .ok_or_else(|| invalid_upstream("dns-query", "Expected object, received null"))?;
        expect_string("dns-query", object, "name")?;
        let kind = expect_number("dns-query", object, "type")?;
        if kind < 0.0 || kind.fract() != 0.0 {
            return Err(invalid_upstream("dns-query", "Expected number to be an integer"));
        }
    }
    for flag in ["TC", "RD", "RA", "AD", "CD"] {
        expect_bool("dns-query", object, flag)?;
    }
    for section in ["Answer", "Authority", "Additional"] {
        if let Some(records) = object.get(section) {
            let records = records.as_array().ok_or_else(|| {
                invalid_upstream("dns-query", format!("Expected array, received {}", type_of(records)))
            })?;
            for record in records {
                let object = record
                    .as_object()
                    .ok_or_else(|| invalid_upstream("dns-query", "Expected object, received null"))?;
                expect_string("dns-query", object, "name")?;
                let kind = expect_number("dns-query", object, "type")?;
                if kind < 0.0 || kind.fract() != 0.0 {
                    return Err(invalid_upstream("dns-query", "Expected number to be an integer"));
                }
                let ttl = expect_number("dns-query", object, "TTL")?;
                if ttl < 0.0 || ttl.fract() != 0.0 {
                    return Err(invalid_upstream("dns-query", "Expected number to be an integer"));
                }
                expect_string("dns-query", object, "data")?;
            }
        }
    }
    Ok(input.clone())
}

pub fn parse_mihomo_connections(input: &Value) -> Result<Value, IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_upstream("connections", "Expected object, received null"))?;
    expect_number("connections", object, "downloadTotal")?;
    expect_number("connections", object, "uploadTotal")?;
    expect_number("connections", object, "memory")?;
    let mut parsed = input.clone();
    // mihomo may emit null while the tracker is empty/initializing; normalize
    // at the protocol boundary so every consumer sees an array.
    if parsed.get("connections").map(Value::is_null).unwrap_or(false) {
        parsed["connections"] = json!([]);
    }
    if !parsed.get("connections").map(Value::is_array).unwrap_or(false) {
        return Err(invalid_upstream(
            "connections",
            format!("Expected array, received {}", type_of(parsed.get("connections").unwrap_or(&Value::Null))),
        ));
    }
    Ok(parsed)
}

/// Traffic stream frame: `{ up, down, upTotal, downTotal }` + passthrough.
pub fn parse_mihomo_traffic(input: &Value) -> Result<Value, IpcError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_upstream("traffic", "Expected object, received null"))?;
    expect_number("traffic", object, "up")?;
    expect_number("traffic", object, "down")?;
    expect_number("traffic", object, "upTotal")?;
    expect_number("traffic", object, "downTotal")?;
    Ok(input.clone())
}

/// Log stream frame: every field optional; `type` restricted to the 4 levels.
pub fn parse_mihomo_log(input: &Value) -> Result<Value, IpcError> {
    if !input.is_object() {
        return Err(invalid_upstream("log", format!("Expected object, received {}", type_of(input))));
    }
    if let Some(kind) = input.get("type") {
        let kind = kind.as_str().unwrap_or_default();
        if !matches!(kind, "info" | "warning" | "error" | "debug") {
            return Err(invalid_upstream(
                "log",
                format!("Invalid enum value. Expected 'info' | 'warning' | 'error' | 'debug', received '{kind}'"),
            ));
        }
    }
    Ok(input.clone())
}

// ---------------------------------------------------------------------------
// Renderer-argument validators (shared/schemas/ipc.ts)
// ---------------------------------------------------------------------------

/// A non-empty string check that does NOT rewrite the value (exact identifiers).
fn non_empty_string(value: &str) -> Result<(), IpcError> {
    if value.trim().is_empty() {
        return Err(invalid("must be a non-empty string"));
    }
    Ok(())
}

pub fn parse_mihomo_name(name: &Value) -> Result<String, IpcError> {
    match name.as_str() {
        Some(name) if !name.trim().is_empty() => Ok(name.to_string()),
        _ => Err(invalid("name must be a non-empty string")),
    }
}

pub fn parse_proxy_selection(group: &Value, name: &Value) -> Result<(String, String), IpcError> {
    let group = group.as_str().ok_or_else(|| invalid("invalid proxy selection at group: must be a non-empty string"))?;
    let name = name.as_str().ok_or_else(|| invalid("invalid proxy selection at name: must be a non-empty string"))?;
    non_empty_string(group).map_err(|_| invalid("invalid proxy selection at group: must be a non-empty string"))?;
    non_empty_string(name).map_err(|_| invalid("invalid proxy selection at name: must be a non-empty string"))?;
    Ok((group.to_string(), name.to_string()))
}

pub fn parse_connection_id(id: &Value) -> Result<String, IpcError> {
    id.as_str()
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| invalid("connection id must be a non-empty string"))
}

/// `undefined` (a missing array slot) means the default; otherwise a strict
/// `{ timeout?: int 1000..30000 }` object — the probe URL is owned by the
/// trusted main process and a renderer-supplied `url` is rejected.
pub fn parse_delay_options(input: Option<&Value>) -> Result<Option<i64>, IpcError> {
    let input = match input {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(Value::Array(_)) => return Err(invalid("delay options must be an object")),
        Some(other) => {
            return Err(invalid(format!(
                "invalid delay options at options: Expected object, received {}",
                type_of(other)
            )))
        }
    };
    for key in input.keys() {
        if key != "timeout" {
            return Err(invalid(format!("invalid delay options at {key}: Unrecognized key: \"{key}\"")));
        }
    }
    match input.get("timeout") {
        None => Ok(None),
        Some(Value::Number(number)) => {
            let timeout = number.as_i64().ok_or_else(|| {
                invalid("invalid delay options at timeout: Expected number to be an integer")
            })?;
            if !(1000..=30000).contains(&timeout) {
                return Err(invalid(format!(
                    "invalid delay options at timeout: Number must be between 1000 and 30000"
                )));
            }
            Ok(Some(timeout))
        }
        Some(other) => Err(invalid(format!(
            "invalid delay options at timeout: Expected number, received {}",
            type_of(other)
        ))),
    }
}

/// The renderer-sent controller PATCH: allowlisted keys only (`tun` is
/// deliberately excluded), each value type/range-checked, unknown keys fail.
pub fn parse_config_patch(input: &Value) -> Result<Value, IpcError> {
    let object = match input {
        Value::Object(object) => object,
        Value::Array(_) => return Err(invalid("config patch must be an object")),
        other => {
            return Err(invalid(format!(
                "invalid config patch at patch: Expected object, received {}",
                type_of(other)
            )))
        }
    };
    let mut parsed = Map::new();
    for (key, value) in object {
        match key.as_str() {
            "port" | "socks-port" | "mixed-port" => {
                let port = value.as_i64().ok_or_else(|| {
                    invalid(format!(
                        "invalid config patch at {key}: Expected number, received {}",
                        type_of(value)
                    ))
                })?;
                if !(0..=65535).contains(&port) {
                    return Err(invalid(format!(
                        "invalid config patch at {key}: Number must be between 0 and 65535"
                    )));
                }
                parsed.insert(key.clone(), json!(port));
            }
            "mode" => {
                let mode = value.as_str().ok_or_else(|| {
                    invalid(format!(
                        "invalid config patch at mode: Expected string, received {}",
                        type_of(value)
                    ))
                })?;
                if !matches!(mode, "rule" | "global" | "direct") {
                    return Err(invalid(format!(
                        "invalid config patch at mode: Invalid enum value. Expected 'rule' | 'global' | 'direct', received '{mode}'"
                    )));
                }
                parsed.insert(key.clone(), json!(mode));
            }
            "log-level" => {
                let level = value.as_str().ok_or_else(|| {
                    invalid(format!(
                        "invalid config patch at log-level: Expected string, received {}",
                        type_of(value)
                    ))
                })?;
                if !LOG_LEVELS.contains(&level) {
                    return Err(invalid(format!(
                        "invalid config patch at log-level: Invalid enum value. Expected 'silent' | 'error' | 'warning' | 'info' | 'debug', received '{level}'"
                    )));
                }
                parsed.insert(key.clone(), json!(level));
            }
            "allow-lan" | "ipv6" => {
                let flag = value.as_bool().ok_or_else(|| {
                    invalid(format!(
                        "invalid config patch at {key}: Expected boolean, received {}",
                        type_of(value)
                    ))
                })?;
                parsed.insert(key.clone(), json!(flag));
            }
            other => {
                return Err(invalid(format!(
                    "invalid config patch at {other}: Unrecognized key: \"{other}\""
                )))
            }
        }
    }
    Ok(Value::Object(parsed))
}

const DNS_LABEL: &str = "DNS name must be a valid ASCII hostname";

/// Hostname validation mirroring the TS regex set, then one of the seven
/// supported query types.
pub fn parse_dns_query(name: &Value, kind: &Value) -> Result<(String, String), IpcError> {
    let label_is_valid = |label: &str| -> bool {
        (1..=63).contains(&label.len())
            && label.bytes().next().map(|b| b.is_ascii_alphanumeric()).unwrap_or(false)
            && label.bytes().last().map(|b| b.is_ascii_alphanumeric()).unwrap_or(false)
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let valid = match name.as_str() {
        Some(name) => {
            (1..=253).contains(&name.len())
                && name.split('.').all(label_is_valid)
        }
        None => false,
    };
    if !valid {
        return Err(invalid(DNS_LABEL));
    }
    match kind.as_str() {
        Some(kind) if DNS_TYPES.contains(&kind) => Ok((name.as_str().unwrap().to_string(), kind.to_string())),
        _ => Err(invalid("DNS query type is not supported")),
    }
}

/// Log-snapshot cursor: `undefined` -> 0, otherwise a non-negative safe integer.
pub fn parse_log_after_seq(value: Option<&Value>) -> Result<i64, IpcError> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(seq) if seq >= 0 && number.as_f64().map(|f| f.fract() == 0.0).unwrap_or(false) => Ok(seq),
            _ => Err(invalid("log snapshot cursor must be a non-negative integer")),
        },
        Some(_) => Err(invalid("log snapshot cursor must be a non-negative integer")),
    }
}

// ---------------------------------------------------------------------------
// Log buffer (main/services/log-buffer.ts)
// ---------------------------------------------------------------------------

/// Kernel log retention: `seq` is strictly monotonic for the service lifetime
/// (never reset, not even by clear) and eviction is FIFO once `capacity` is
/// reached. Capture is independent of who is subscribed.
pub struct MihomoLogBuffer {
    entries: Mutex<Vec<Value>>,
    next_seq: AtomicI64,
    capacity: usize,
}

impl MihomoLogBuffer {
    pub fn new() -> Self {
        MihomoLogBuffer { entries: Mutex::new(Vec::new()), next_seq: AtomicI64::new(0), capacity: 2000 }
    }

    /// Retain one message; the stored copy carries its `seq` so the snapshot
    /// and the live channel agree on ordering.
    pub fn append(&self, mut message: Value) -> i64 {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(object) = message.as_object_mut() {
            object.insert("seq".to_string(), json!(seq));
        }
        let mut entries = self.entries.lock().expect("log buffer mutex poisoned");
        entries.push(message);
        if entries.len() > self.capacity {
            let excess = entries.len() - self.capacity;
            entries.drain(0..excess);
        }
        seq
    }

    /// All retained messages with `seq > after_seq`, ascending.
    pub fn snapshot(&self, after_seq: i64) -> Vec<Value> {
        let entries = self.entries.lock().expect("log buffer mutex poisoned");
        if after_seq <= 0 {
            return entries.clone();
        }
        if entries.is_empty() {
            return Vec::new();
        }
        let first = entries[0].get("seq").and_then(Value::as_i64).unwrap_or(0);
        if first > after_seq {
            return entries.clone();
        }
        // Binary search the first entry past the cursor (TS loop parity).
        let mut lo = 0usize;
        let mut hi = entries.len() - 1;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if entries[mid].get("seq").and_then(Value::as_i64).unwrap_or(0) <= after_seq {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if entries[lo].get("seq").and_then(Value::as_i64).unwrap_or(0) > after_seq {
            entries[lo..].to_vec()
        } else {
            Vec::new()
        }
    }

    /// Highest sequence number handed out so far (0 = nothing retained yet).
    pub fn last_seq(&self) -> i64 {
        self.next_seq.load(Ordering::SeqCst)
    }

    /// Drop retained lines and return the atomic high-water mark that was
    /// cleared. Sequence numbering continues uninterrupted.
    pub fn clear(&self) -> i64 {
        self.entries.lock().expect("log buffer mutex poisoned").clear();
        self.next_seq.load(Ordering::SeqCst)
    }
}

impl Default for MihomoLogBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Proxy selection store (main/profiles/proxy-selection-store.ts)
// ---------------------------------------------------------------------------

pub const PROXY_SELECTIONS_FILE: &str = "proxy-selections.json";

/// Durable cache of the user's node pick per policy group, keyed by profile
/// id: `{ [profileId]: { [groupName]: nodeName } }`. Writes are atomic
/// (temp + rename) and serialized; reads fail open to `{}`.
pub struct ProxySelectionStore {
    app_data_base: Option<PathBuf>,
    queue: Mutex<()>,
}

impl ProxySelectionStore {
    pub fn new(app_data_base: Option<PathBuf>) -> Self {
        ProxySelectionStore { app_data_base, queue: Mutex::new(()) }
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.app_data_base.as_ref().map(|base| base.join(PROXY_SELECTIONS_FILE))
    }

    fn read_all(&self) -> Value {
        let Some(path) = self.file_path() else { return json!({}) };
        let Ok(raw) = std::fs::read_to_string(path) else { return json!({}) };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { return json!({}) };
        if !parsed.is_object() {
            return json!({});
        }
        // Coerce defensively: only string group -> node pairs survive.
        let mut out = Map::new();
        for (profile_id, groups) in parsed.as_object().unwrap() {
            let Some(groups) = groups.as_object() else { continue };
            let mut clean = Map::new();
            for (group, node) in groups {
                if let Some(node) = node.as_str().filter(|n| !n.is_empty()) {
                    clean.insert(group.clone(), json!(node));
                }
            }
            out.insert(profile_id.clone(), Value::Object(clean));
        }
        Value::Object(out)
    }

    fn write(&self, all: &Value) -> Result<(), IpcError> {
        let Some(path) = self.file_path() else { return Ok(()) };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| IpcError::internal(error.to_string()))?;
        }
        let tmp = path.with_file_name(format!(".{PROXY_SELECTIONS_FILE}.{}.tmp", Uuid::new_v4()));
        let body = format!("{}\n", serde_json::to_string_pretty(all).unwrap_or_default());
        std::fs::write(&tmp, body).map_err(|error| IpcError::internal(error.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|error| IpcError::internal(error.to_string()))?;
        Ok(())
    }

    /// All remembered selections for one profile ({} when none).
    pub fn get(&self, profile_id: &str) -> Value {
        let _serial = self.queue.lock().expect("selection queue mutex poisoned");
        self.read_all().get(profile_id).cloned().unwrap_or(json!({}))
    }

    /// Remember `node` for `group` under `profile_id`.
    pub fn set(&self, profile_id: &str, group: &str, node: &str) -> Result<(), IpcError> {
        let _serial = self.queue.lock().expect("selection queue mutex poisoned");
        let mut all = self.read_all();
        let entry = all
            .as_object_mut()
            .unwrap()
            .entry(profile_id.to_string())
            .or_insert_with(|| json!({}));
        entry[group] = json!(node);
        self.write(&all)
    }

    /// Drop every remembered selection for a deleted profile.
    pub fn delete_profile(&self, profile_id: &str) -> Result<(), IpcError> {
        let _serial = self.queue.lock().expect("selection queue mutex poisoned");
        let mut all = self.read_all();
        if !all.as_object().unwrap().contains_key(profile_id) {
            return Ok(());
        }
        all.as_object_mut().unwrap().remove(profile_id);
        self.write(&all)
    }
}

// ---------------------------------------------------------------------------
// Client (main/services/mihomo-client.ts)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct MihomoClient {
    http: reqwest::Client,
    /// `http://127.0.0.1:{port}` (the TS production wiring hardcodes the host).
    base_url: String,
    secret: String,
}

impl MihomoClient {
    pub fn new(port: i64, secret: &str) -> Result<Self, IpcError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|error| IpcError::internal(error.to_string()))?;
        Ok(MihomoClient { http, base_url: format!("http://127.0.0.1:{port}"), secret: secret.to_string() })
    }

    /// Perform a controller request and map every failure mode to a typed
    /// ProtocolError. Returns `None` for 204/`empty_204` responses.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout_ms: u64,
        empty_204: bool,
    ) -> Result<Option<Value>, IpcError> {
        let url = format!("{}{}", self.base_url, path);
        let mut request = self.http.request(reqwest::Method::from_bytes(method.as_bytes()).expect("valid method"), &url);
        if !self.secret.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", self.secret));
        }
        if let Some(body) = &body {
            request = request
                .header("Content-Type", "application/json")
                .body(serde_json::to_string(body).unwrap_or_default());
        }
        let response = match request.timeout(Duration::from_millis(timeout_ms)).send().await {
            Ok(response) => response,
            Err(error) if error.is_timeout() => {
                return Err(IpcError::code(
                    code::UPSTREAM_TIMEOUT,
                    format!("mihomo controller timed out after {timeout_ms}ms"),
                ))
            }
            Err(error) => {
                return Err(IpcError::code(
                    code::UPSTREAM_UNREACHABLE,
                    format!("mihomo controller unreachable: {error}"),
                ))
            }
        };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(match status {
                401 => IpcError::code(code::UNAUTHORIZED, "controller secret mismatch"),
                // 504: a group delay test reported every proxy as timed out; 503:
                // a single node test failed (unreachable or delay == 0).
                504 => IpcError::code(code::UPSTREAM_TIMEOUT, "mihomo delay test timed out with HTTP 504"),
                503 => IpcError::code(code::UPSTREAM_TEST_FAILED, "mihomo delay test failed: HTTP 503"),
                _ => IpcError::code(code::UPSTREAM_HTTP_ERROR, format!("mihomo request failed with HTTP {status}")),
            }
            );
        }
        if status == 204 || empty_204 {
            return Ok(None);
        }
        let raw = response.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|error| IpcError::code(code::INVALID_UPSTREAM, format!("mihomo returned invalid JSON: {error}")))?;
        Ok(Some(parsed))
    }

    pub async fn get_version(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/version", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_version(&raw.unwrap_or(Value::Null))
    }

    pub async fn get_config(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/configs", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_config(&raw.unwrap_or(Value::Null))
    }

    pub async fn patch_config(&self, patch: &Value) -> Result<Value, IpcError> {
        self.request("PATCH", "/configs", Some(patch.clone()), DEFAULT_TIMEOUT_MS, true)
            .await?;
        Ok(Value::Null)
    }

    /// Apply a complete runtime document without replacing the process.
    /// No `force=true`: mihomo keeps the already-bound listeners.
    pub async fn reload_config(&self, payload: &str) -> Result<Value, IpcError> {
        self.request("PUT", "/configs", Some(json!({ "payload": payload })), DEFAULT_TIMEOUT_MS, true)
            .await?;
        Ok(Value::Null)
    }

    pub async fn get_proxies(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/proxies", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_proxies(&raw.unwrap_or(Value::Null))
    }

    pub async fn select_proxy(&self, group: &str, name: &str) -> Result<Value, IpcError> {
        self.request(
            "PUT",
            &format!("/proxies/{}", encode_uri_component(group)),
            Some(json!({ "name": name })),
            DEFAULT_TIMEOUT_MS,
            true,
        )
        .await?;
        Ok(Value::Null)
    }

    pub async fn get_rules(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/rules", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_rules(&raw.unwrap_or(Value::Null))
    }

    pub async fn get_proxy_providers(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/providers/proxies", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_proxy_providers(&raw.unwrap_or(Value::Null))
    }

    /// A provider PUT includes the remote download inside mihomo; do not abort
    /// a healthy download with the normal 10s budget.
    pub async fn refresh_proxy_provider(&self, name: &str) -> Result<Value, IpcError> {
        self.request(
            "PUT",
            &format!("/providers/proxies/{}", encode_uri_component(name)),
            None,
            PROVIDER_REFRESH_TIMEOUT_MS,
            true,
        )
        .await?;
        Ok(Value::Null)
    }

    pub async fn health_check_proxy_provider(&self, name: &str) -> Result<Value, IpcError> {
        self.request(
            "GET",
            &format!("/providers/proxies/{}/healthcheck", encode_uri_component(name)),
            None,
            DEFAULT_TIMEOUT_MS,
            true,
        )
        .await?;
        Ok(Value::Null)
    }

    pub async fn get_rule_providers(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/providers/rules", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_rule_providers(&raw.unwrap_or(Value::Null))
    }

    pub async fn refresh_rule_provider(&self, name: &str) -> Result<Value, IpcError> {
        self.request(
            "PUT",
            &format!("/providers/rules/{}", encode_uri_component(name)),
            None,
            PROVIDER_REFRESH_TIMEOUT_MS,
            true,
        )
        .await?;
        Ok(Value::Null)
    }

    /// Reject any probe URL the controller must not be asked to fetch.
    fn assert_safe_test_url(url: &str) -> Result<(), IpcError> {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Ok(());
        }
        if url.parse::<url::Url>().is_err() {
            return Err(invalid(format!("invalid proxy test URL: {url}")));
        }
        Err(invalid("proxy test URL must be http or https"))
    }

    fn resolve_test_url(value: Option<&str>) -> String {
        match value.map(str::trim) {
            Some(url) if !url.is_empty() => url.to_string(),
            _ => DEFAULT_TEST_URL.to_string(),
        }
    }

    fn delay_timeout_ms(timeout: i64) -> u64 {
        (DEFAULT_TIMEOUT_MS as i64).max(timeout + 3000) as u64
    }

    pub async fn delay_test(&self, name: &str, url: Option<&str>, timeout: i64) -> Result<Value, IpcError> {
        let url = Self::resolve_test_url(url);
        Self::assert_safe_test_url(&url)?;
        let query = format!(
            "?timeout={}&url={}",
            encode_uri_component(&timeout.to_string()),
            encode_uri_component(&url)
        );
        let raw = self
            .request(
                "GET",
                &format!("/proxies/{}/delay{query}", encode_uri_component(name)),
                None,
                Self::delay_timeout_ms(timeout),
                false,
            )
            .await?;
        let mut parsed = parse_mihomo_delay_result(&raw.unwrap_or(Value::Null))?;
        parsed["url"] = json!(url);
        Ok(parsed)
    }

    /// Test a node through its proxy-provider endpoint so provider history is updated.
    pub async fn provider_delay_test(
        &self,
        provider: &str,
        name: &str,
        url: Option<&str>,
        timeout: i64,
    ) -> Result<Value, IpcError> {
        let url = Self::resolve_test_url(url);
        Self::assert_safe_test_url(&url)?;
        let query = format!(
            "?timeout={}&url={}",
            encode_uri_component(&timeout.to_string()),
            encode_uri_component(&url)
        );
        let raw = self
            .request(
                "GET",
                &format!(
                    "/providers/proxies/{}/{}/healthcheck{query}",
                    encode_uri_component(provider),
                    encode_uri_component(name)
                ),
                None,
                Self::delay_timeout_ms(timeout),
                false,
            )
            .await?;
        let mut parsed = parse_mihomo_delay_result(&raw.unwrap_or(Value::Null))?;
        parsed["url"] = json!(url);
        Ok(parsed)
    }

    pub async fn group_delay_test(&self, name: &str, url: Option<&str>, timeout: i64) -> Result<Value, IpcError> {
        let url = Self::resolve_test_url(url);
        Self::assert_safe_test_url(&url)?;
        let query = format!(
            "?timeout={}&url={}",
            encode_uri_component(&timeout.to_string()),
            encode_uri_component(&url)
        );
        let raw = self
            .request(
                "GET",
                &format!("/group/{}/delay{query}", encode_uri_component(name)),
                None,
                Self::delay_timeout_ms(timeout),
                false,
            )
            .await?;
        parse_mihomo_delay_map(&raw.unwrap_or(Value::Null))
    }

    pub async fn dns_query(&self, name: &str, kind: &str) -> Result<Value, IpcError> {
        let query = format!(
            "?name={}&type={}",
            encode_uri_component(name),
            encode_uri_component(kind)
        );
        let raw = self.request("GET", &format!("/dns/query{query}"), None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_dns_query(&raw.unwrap_or(Value::Null))
    }

    pub async fn flush_dns_cache(&self) -> Result<Value, IpcError> {
        self.request("POST", "/cache/dns/flush", None, DEFAULT_TIMEOUT_MS, true).await?;
        Ok(Value::Null)
    }

    pub async fn flush_fakeip_cache(&self) -> Result<Value, IpcError> {
        self.request("POST", "/cache/fakeip/flush", None, DEFAULT_TIMEOUT_MS, true).await?;
        Ok(Value::Null)
    }

    pub async fn get_connections(&self) -> Result<Value, IpcError> {
        let raw = self.request("GET", "/connections", None, DEFAULT_TIMEOUT_MS, false).await?;
        parse_mihomo_connections(&raw.unwrap_or(Value::Null))
    }

    pub async fn close_connection(&self, id: &str) -> Result<Value, IpcError> {
        self.request("DELETE", &format!("/connections/{}", encode_uri_component(id)), None, DEFAULT_TIMEOUT_MS, false)
            .await?;
        Ok(Value::Null)
    }
}

// ---------------------------------------------------------------------------
// Group test URLs (main/profiles/proxy-group-order.ts parseProxyGroupTestUrls)
// ---------------------------------------------------------------------------

/// Map every `proxy-groups` entry to its `url` (`null` when the group
/// intentionally omits one). Unparseable documents yield `{}`.
pub fn parse_proxy_group_test_urls(document: &str) -> Value {
    if document.trim().is_empty() {
        return json!({});
    }
    let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(document) else {
        return json!({});
    };
    let Some(root) = docs.first() else { return json!({}) };
    let Some(root_map) = root.as_hash() else { return json!({}) };
    let Some(groups) = root_map
        .get(&yaml_rust2::Yaml::String("proxy-groups".to_string()))
        .and_then(|value| value.as_vec())
    else {
        return json!({});
    };
    let mut urls = Map::new();
    for value in groups {
        let Some(entry) = value.as_hash() else { continue };
        let name = yaml_str(entry, "name").filter(|name| !name.is_empty());
        let Some(name) = name else { continue };
        let url = yaml_str(entry, "url").map(|url| url.trim().to_string()).filter(|url| !url.is_empty());
        urls.insert(name, url.map(|url| json!(url)).unwrap_or(Value::Null));
    }
    Value::Object(urls)
}

fn yaml_str(entry: &yaml_rust2::yaml::Hash, key: &str) -> Option<String> {
    entry
        .get(&yaml_rust2::Yaml::String(key.to_string()))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Service composition (main/services/mihomo-service.ts + selection gateway)
// ---------------------------------------------------------------------------

/// Group types whose `now` member the user can pick (mirrors the renderer).
const SELECTABLE_GROUP_TYPES: [&str; 3] = ["Selector", "URLTest", "Fallback"];

/// The service state the renderer-facing mihomo channels run through: the log
/// buffer, the durable selection store and the bounded provider/group caches.
pub struct MihomoServices {
    /// Shared with the push-stream pipeline (the /logs tap appends here).
    pub logs: Arc<MihomoLogBuffer>,
    pub selections: ProxySelectionStore,
    mutation: tokio::sync::Mutex<()>,
    provider_owners: Mutex<Option<(Instant, Value)>>,
    group_test_urls: Mutex<Option<(Instant, Value)>>,
}

impl MihomoServices {
    pub fn new(app_data_base: Option<PathBuf>) -> Self {
        MihomoServices {
            logs: Arc::new(MihomoLogBuffer::new()),
            selections: ProxySelectionStore::new(app_data_base),
            mutation: tokio::sync::Mutex::new(()),
            provider_owners: Mutex::new(None),
            group_test_urls: Mutex::new(None),
        }
    }

    /// `mihomo:logs-snapshot` — retained history past `after_seq` plus the
    /// high-water mark.
    pub fn logs_snapshot(&self, after_seq: i64) -> Value {
        let clamped = if after_seq > 0 { after_seq } else { 0 };
        json!({
            "entries": self.logs.snapshot(clamped),
            "lastSeq": self.logs.last_seq()
        })
    }

    /// `mihomo:clear-logs` — the atomic high-water mark that was cleared.
    pub fn clear_logs(&self) -> i64 {
        self.logs.clear()
    }

    /// Provider-name index: node name -> every provider that currently lists
    /// it (first-seen order; duplicates across subscriptions are routine).
    async fn get_provider_owners(&self, client: &MihomoClient) -> Result<Value, IpcError> {
        if let Some((at, cached)) = self.provider_owners.lock().expect("owners mutex poisoned").clone() {
            if at.elapsed() < Duration::from_millis(1000) {
                return Ok(cached);
            }
        }
        let providers = client.get_proxy_providers().await?;
        let mut owners: HashMap<String, Vec<Value>> = HashMap::new();
        if let Some(map) = providers.get("providers").and_then(Value::as_object) {
            for (provider_name, provider) in map {
                let test_url = provider.get("testUrl").and_then(Value::as_str).map(|s| s.trim().to_string());
                let test_url = test_url.filter(|s| !s.is_empty());
                if let Some(proxies) = provider.get("proxies").and_then(Value::as_array) {
                    for proxy in proxies {
                        let Some(name) = proxy.get("name").and_then(Value::as_str) else { continue };
                        let owner = json!({ "name": provider_name, "testUrl": test_url });
                        let list = owners.entry(name.to_string()).or_default();
                        if !list.iter().any(|candidate| candidate["name"] == *provider_name) {
                            list.push(owner);
                        }
                    }
                }
            }
        }
        let owners: Value = owners
            .into_iter()
            .map(|(name, list)| (name, Value::Array(list)))
            .collect::<serde_json::Map<String, Value>>()
            .into();
        *self.provider_owners.lock().expect("owners mutex poisoned") =
            Some((Instant::now(), owners.clone()));
        Ok(owners)
    }

    /// Group -> explicit probe URL from the ACTIVE profile document (bounded
    /// 1s cache; the resolver itself fails open to `{}`).
    fn get_group_test_urls(&self, resolver: impl FnOnce() -> Value) -> Value {
        if let Some((at, cached)) = self.group_test_urls.lock().expect("group urls mutex poisoned").clone() {
            if at.elapsed() < Duration::from_millis(1000) {
                return cached;
            }
        }
        let urls = resolver();
        *self.group_test_urls.lock().expect("group urls mutex poisoned") =
            Some((Instant::now(), urls.clone()));
        urls
    }

    /// Test one member of a group. The URL chain mirrors the TS service:
    /// global-scope setting wins; otherwise the profile's explicit group URL,
    /// then the owner group's testUrl, then the default probe. Leaf nodes are
    /// first probed through every provider that lists them (404 -> next
    /// candidate), nested groups through the plain proxy endpoint.
    pub async fn group_member_delay_test(
        &self,
        client: &MihomoClient,
        explicit_urls: &Value,
        global_scope: bool,
        global_url: Option<&str>,
        group: &str,
        name: &str,
        timeout: i64,
    ) -> Result<Value, IpcError> {
        let snapshot = client.get_proxies().await?;
        let proxies = snapshot.get("proxies").and_then(Value::as_object).cloned().unwrap_or_default();
        let owner = proxies.get(group);
        let owner_all = owner.and_then(|owner| owner.get("all")).and_then(Value::as_array).cloned();
        let Some(owner_all) = owner_all else {
            return Err(IpcError::code(code::NOT_FOUND, format!("策略组 {group} 中不存在成员 {name}")));
        };
        if !owner_all.iter().any(|member| member.as_str() == Some(name)) {
            return Err(IpcError::code(code::NOT_FOUND, format!("策略组 {group} 中不存在成员 {name}")));
        }

        let global_url = global_url.map(str::trim).filter(|url| !url.is_empty());
        let has_profile_entry = explicit_urls.get(group).is_some();
        let group_url = if has_profile_entry {
            explicit_urls[group].as_str().map(str::to_string)
        } else {
            owner
                .and_then(|owner| owner.get("testUrl"))
                .and_then(Value::as_str)
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty())
        };
        let member = proxies.get(name);
        let member_is_group = member.and_then(|member| member.get("all")).map(Value::is_array).unwrap_or(false);
        if !member_is_group {
            let candidates = match self.get_provider_owners(client).await {
                Ok(owners) => owners.get(name).and_then(Value::as_array).cloned().unwrap_or_default(),
                Err(error) => {
                    // A controller/provider-list failure must not make a globally
                    // resolvable node untestable; UNAUTHORIZED still propagates.
                    if error.0.contains("UNAUTHORIZED") {
                        return Err(error);
                    }
                    Vec::new()
                }
            };
            for candidate in candidates {
                let candidate_test_url = candidate["testUrl"].as_str();
                let candidate_url = if global_scope {
                    global_url
                } else {
                    group_url.as_deref().or(candidate_test_url).or(global_url)
                };
                let candidate_name = candidate["name"].as_str().unwrap_or_default().to_string();
                match client
                    .provider_delay_test(&candidate_name, name, candidate_url, timeout)
                    .await
                {
                    Ok(result) => return Ok(result),
                    Err(error) => {
                        // Only a real 404 means this provider no longer exposes
                        // the node; every other verdict surfaces immediately.
                        let is_not_found = error.0.contains("::NOT_FOUND::")
                            || (error.0.contains("UPSTREAM_HTTP_ERROR")
                                && error.0.contains("HTTP 404"));
                        if is_not_found {
                            continue;
                        }
                        return Err(error);
                    }
                }
            }
        }
        let resolved_url = if global_scope { global_url } else { group_url.as_deref().or(global_url) };
        client.delay_test(name, resolved_url, timeout).await
    }

    /// The selection gateway: resolve the active profile id BEFORE the
    /// controller switch, PUT the selection, then persist it attributed to
    /// that profile. The shared mutation boundary serializes concurrent
    /// selections (and, later, profile activation).
    pub async fn select_proxy(
        &self,
        client: &MihomoClient,
        active_profile_id: Option<String>,
        group: &str,
        name: &str,
    ) -> Result<Value, IpcError> {
        let _exclusive = self.mutation.lock().await;
        client.select_proxy(group, name).await?;
        if let Some(profile_id) = active_profile_id {
            // Storage remains best-effort: a cache failure never invalidates
            // an accepted controller switch.
            let _ = self.selections.set(&profile_id, group, name);
        }
        Ok(Value::Null)
    }

    /// Replay every remembered selection for the active profile onto a fresh
    /// kernel. Best-effort per group; returns the restore count.
    pub async fn restore_selections(
        &self,
        client: &MihomoClient,
        active_profile_id: Option<String>,
    ) -> Result<i64, IpcError> {
        let Some(profile_id) = active_profile_id else { return Ok(0) };
        let remembered = self.selections.get(&profile_id);
        let Some(groups) = remembered.as_object() else { return Ok(0) };
        if groups.is_empty() {
            return Ok(0);
        }
        let live = match client.get_proxies().await {
            Ok(proxies) => proxies.get("proxies").and_then(Value::as_object).cloned().unwrap_or_default(),
            Err(_) => return Ok(0),
        };
        let mut restored = 0i64;
        for (group, node) in groups {
            let Some(node) = node.as_str() else { continue };
            let Some(target) = live.get(group) else { continue };
            if !SELECTABLE_GROUP_TYPES.contains(&target.get("type").and_then(Value::as_str).unwrap_or_default()) {
                continue;
            }
            if !target.get("all").and_then(Value::as_array).map(|all| all.iter().any(|m| m.as_str() == Some(node))).unwrap_or(false) {
                continue;
            }
            let selected = match target.get("fixed").and_then(Value::as_str) {
                Some(fixed) if !fixed.is_empty() => fixed.to_string(),
                _ => target.get("now").and_then(Value::as_str).unwrap_or_default().to_string(),
            };
            if selected == node {
                continue;
            }
            if client.select_proxy(group, node).await.is_ok() {
                restored += 1;
            }
        }
        Ok(restored)
    }
}

impl Default for MihomoServices {
    fn default() -> Self {
        Self::new(None)
    }
}

/// Bounded 1s group-test-url cache wrapper for the dispatch layer.
pub fn get_group_test_urls_cached(services: &MihomoServices, resolver: impl FnOnce() -> Value) -> Value {
    services.get_group_test_urls(resolver)
}

/// The selection-gateway composition (ProxySelectionGateway::selectProxy):
/// resolve -> PUT -> record, under the shared mutation boundary.
pub async fn select_proxy_gateway(
    services: &MihomoServices,
    client: &MihomoClient,
    profile_id: Option<String>,
    group: &str,
    name: &str,
) -> Result<Value, IpcError> {
    services.select_proxy(client, profile_id, group, name).await
}

/// The service-layer member test (MihomoService::groupMemberDelayTest port).
#[allow(clippy::too_many_arguments)]
pub async fn group_member_delay_test_gateway(
    services: &MihomoServices,
    client: &MihomoClient,
    explicit_urls: &Value,
    global_scope: bool,
    global_url: Option<&str>,
    group: &str,
    name: &str,
    timeout: i64,
) -> Result<Value, IpcError> {
    services
        .group_member_delay_test(client, explicit_urls, global_scope, global_url, group, name, timeout)
        .await
}

/// Test-only mock controller shared with the dispatch tests (ipc.rs).
#[cfg(test)]
pub(crate) mod mock_controller {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A tiny HTTP/1.1 mock controller: one canned responder per route,
    /// Connection: close so each request is one connection.
    pub struct MockServer {
        pub port: i64,
        _handle: std::thread::JoinHandle<()>,
    }

    impl MockServer {
        pub fn start(secret: &'static str, handler: impl Fn(&str, &str, &str) -> (u16, String) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
            let port = listener.local_addr().unwrap().port() as i64;
            let handle = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let mut stream = stream.expect("accept");
                    let mut buffer = [0u8; 8192];
                    let mut raw = Vec::new();
                    loop {
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        raw.extend_from_slice(&buffer[..read]);
                        let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n");
                        if let Some(head_end) = head_end {
                            let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                            let length = head
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if raw.len() >= head_end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let mut parts = text.split("\r\n\r\n");
                    let head = parts.next().unwrap_or_default();
                    let body = parts.next().unwrap_or_default();
                    let mut head_lines = head.split_whitespace();
                    let method = head_lines.next().unwrap_or_default().to_string();
                    let path = head_lines.next().unwrap_or_default().to_string();
                    let auth_ok = !head
                        .lines()
                        .find_map(|line| line.strip_prefix("Authorization:"))
                        .map(|value| value.trim() != format!("Bearer {secret}"))
                        .unwrap_or(false)
                        || secret.is_empty();
                    let (status, payload) = if auth_ok {
                        handler(&method, &path, body)
                    } else {
                        (401, "Unauthorized".to_string())
                    };
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        401 => "Unauthorized",
                        404 => "Not Found",
                        503 => "Service Unavailable",
                        504 => "Gateway Timeout",
                        _ => "Error",
                    };
                    let response = if status == 204 {
                        format!("HTTP/1.1 204 {reason}\r\nConnection: close\r\n\r\n")
                    } else {
                        format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                            payload.len()
                        )
                    };
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            MockServer { port, _handle: handle }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_controller::MockServer;

    fn client(port: i64) -> MihomoClient {
        MihomoClient::new(port, "s3cret").unwrap()
    }

    #[tokio::test]
    async fn request_maps_success_paths_and_carries_the_secret() {
        let server = MockServer::start("s3cret", |method, path, _body| match path {
            "/version" if method == "GET" => (200, r#"{"meta":true,"version":"v1.19.30"}"#.to_string()),
            "/configs" if method == "GET" => (200, r#"{"mode":"rule","mixed-port":7890,"extra":1}"#.to_string()),
            "/cache/dns/flush" if method == "POST" => (204, String::new()),
            _ => (404, String::new()),
        });
        let client = client(server.port);
        let version = client.get_version().await.unwrap();
        assert_eq!(version["version"], "v1.19.30");
        let config = client.get_config().await.unwrap();
        assert_eq!(config["mode"], "rule");
        assert_eq!(config["extra"], 1, "passthrough keeps unknown fields");
        client.flush_dns_cache().await.unwrap();
    }

    #[tokio::test]
    async fn request_maps_error_statuses_to_typed_codes() {
        let server = MockServer::start("s3cret", |method, path, _body| match (method, path) {
            ("GET", "/configs") => (500, "boom".to_string()),
            ("GET", "/rules") => (503, String::new()),
            ("GET", "/proxies") => (504, String::new()),
            ("GET", "/providers/rules") => (401, String::new()),
            ("GET", "/version") => (200, "not json".to_string()),
            _ => (404, String::new()),
        });
        let client = client(server.port);
        let error = client.get_config().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:UPSTREAM_HTTP_ERROR::mihomo request failed with HTTP 500");
        let error = client.get_rules().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:UPSTREAM_TEST_FAILED::mihomo delay test failed: HTTP 503");
        let error = client.get_proxies().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:UPSTREAM_TIMEOUT::mihomo delay test timed out with HTTP 504");
        let error = client.get_rule_providers().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:UNAUTHORIZED::controller secret mismatch");
        let error = client.get_version().await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:INVALID_UPSTREAM::mihomo returned invalid JSON: "), "{}", error.0);
    }

    #[tokio::test]
    async fn request_reports_unreachable_controllers() {
        // Bind, learn the port, then drop the listener: nothing listens there.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port() as i64;
        drop(listener);
        let client = client(port);
        let error = client.get_config().await.unwrap_err();
        assert!(
            error.0.starts_with("PROTOCOL_ERROR:UPSTREAM_UNREACHABLE::mihomo controller unreachable: "),
            "{}",
            error.0
        );
    }

    #[tokio::test]
    async fn delay_tests_default_url_and_echo_it_back() {
        let server = MockServer::start("s3cret", |_method, path, _body| {
            assert!(path.starts_with("/proxies/%E9%A6%99%E6%B8%AF/delay?timeout=5000&url="), "{path}");
            (200, r#"{"delay":123}"#.to_string())
        });
        let client = client(server.port);
        let result = client.delay_test("香港", None, 5000).await.unwrap();
        assert_eq!(result["delay"], 123);
        assert_eq!(result["url"], DEFAULT_TEST_URL);
    }

    #[test]
    fn encode_uri_component_matches_the_js_set() {
        assert_eq!(encode_uri_component("香港"), "%E9%A6%99%E6%B8%AF");
        assert_eq!(encode_uri_component("auto-a_1.0!~*'()"), "auto-a_1.0!~*'()");
        assert_eq!(encode_uri_component("a b&c=d"), "a%20b%26c%3Dd");
    }

    #[test]
    fn arg_validators_mirror_the_ipc_schema() {
        assert_eq!(parse_mihomo_name(&json!("A")).unwrap(), "A");
        assert_eq!(
            parse_mihomo_name(&json!(" ")).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::name must be a non-empty string"
        );
        assert_eq!(
            parse_proxy_selection(&json!(""), &json!("x")).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::invalid proxy selection at group: must be a non-empty string"
        );
        assert_eq!(parse_proxy_selection(&json!("G"), &json!("N")).unwrap(), ("G".into(), "N".into()));
        assert_eq!(
            parse_connection_id(&json!(" ")).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::connection id must be a non-empty string"
        );
        assert_eq!(parse_delay_options(None).unwrap(), None);
        assert_eq!(parse_delay_options(Some(&json!({"timeout": 5000}))).unwrap(), Some(5000));
        assert_eq!(
            parse_delay_options(Some(&json!({"url": "http://x"}))).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::invalid delay options at url: Unrecognized key: \"url\""
        );
        assert_eq!(
            parse_delay_options(Some(&json!({"timeout": 999}))).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::invalid delay options at timeout: Number must be between 1000 and 30000"
        );
        assert!(parse_config_patch(&json!({"mixed-port": 7890, "allow-lan": true})).is_ok());
        assert_eq!(
            parse_config_patch(&json!({"tun": {}})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::invalid config patch at tun: Unrecognized key: \"tun\""
        );
        assert_eq!(
            parse_config_patch(&json!({"log-level": "loud"})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::invalid config patch at log-level: Invalid enum value. Expected 'silent' | 'error' | 'warning' | 'info' | 'debug', received 'loud'"
        );
        assert_eq!(parse_dns_query(&json!("a.b-c.example"), &json!("AAAA")).unwrap(), ("a.b-c.example".into(), "AAAA".into()));
        assert_eq!(
            parse_dns_query(&json!("-bad"), &json!("A")).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::DNS name must be a valid ASCII hostname"
        );
        assert_eq!(
            parse_dns_query(&json!("ok.example"), &json!("PTR")).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::DNS query type is not supported"
        );
        assert_eq!(parse_log_after_seq(None).unwrap(), 0);
        assert_eq!(
            parse_log_after_seq(Some(&json!(-1))).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::log snapshot cursor must be a non-negative integer"
        );
    }

    #[test]
    fn payload_parsers_validate_required_fields_and_passthrough() {
        assert!(parse_mihomo_version(&json!({"meta": true, "version": "v1"})).is_ok());
        assert_eq!(
            parse_mihomo_version(&json!({"meta": "yes", "version": "v1"})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_UPSTREAM::Invalid version payload: Expected boolean, received string"
        );
        assert!(parse_mihomo_proxies(&json!({"proxies": {"A": {"name": "A", "type": "ss"}}})).is_ok());
        assert_eq!(
            parse_mihomo_proxies(&json!({"proxies": {"A": {"name": 1}}})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_UPSTREAM::Invalid proxies payload: Expected string, received number"
        );
        assert!(parse_mihomo_rules(&json!({"rules": [{"index": 0, "type": "DOMAIN", "payload": "x", "proxy": "A", "size": 1}]})).is_ok());
        assert_eq!(
            parse_mihomo_rules(&json!({"rules": [{"index": 0}]})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_UPSTREAM::Invalid rules payload: Required"
        );
        assert_eq!(
            parse_mihomo_delay_map(&json!({"A": 120, "B": "x"})).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_UPSTREAM::Invalid delay-map payload: Expected number, received string"
        );
        let connections = parse_mihomo_connections(&json!({"downloadTotal": 1, "uploadTotal": 2, "memory": 3, "connections": null})).unwrap();
        assert_eq!(connections["connections"], json!([]), "null normalizes to []");
        assert!(parse_mihomo_dns_query(&json!({"Status": 0, "Question": [{"name": "a", "type": 1}], "TC": false, "RD": true, "RA": true, "AD": false, "CD": false})).is_ok());
    }

    #[test]
    fn log_buffer_keeps_monotonic_seqs_and_high_water_clears() {
        let buffer = MihomoLogBuffer::new();
        assert_eq!(buffer.append(json!({"payload": "a"})), 1);
        assert_eq!(buffer.append(json!({"payload": "b"})), 2);
        let entries = buffer.snapshot(0);
        assert_eq!(entries[0]["seq"], 1);
        assert_eq!(entries[1]["seq"], 2);
        assert_eq!(buffer.snapshot(1).len(), 1);
        assert_eq!(buffer.snapshot(2), Vec::<Value>::new());
        assert_eq!(buffer.clear(), 2, "high-water mark survives the clear");
        assert_eq!(buffer.snapshot(0), Vec::<Value>::new());
        assert_eq!(buffer.append(json!({"payload": "c"})), 3, "numbering never resets");
        assert_eq!(buffer.last_seq(), 3);
    }

    #[test]
    fn log_buffer_evicts_fifo_at_capacity() {
        let mut buffer = MihomoLogBuffer::new();
        buffer.capacity = 3;
        for index in 0..5 {
            buffer.append(json!({ "payload": index }));
        }
        let entries = buffer.snapshot(0);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["payload"], 2, "oldest evicted first");
    }

    #[test]
    fn selection_store_round_trips_and_fails_open() {
        let temp = tempfile::TempDir::new().unwrap();
        let base = temp.path().to_path_buf();
        let store = ProxySelectionStore::new(Some(base.clone()));
        assert_eq!(store.get("p1"), json!({}));
        store.set("p1", "香港", "Node-A").unwrap();
        store.set("p1", "美国", "Node-B").unwrap();
        store.set("p2", "全球", "Node-C").unwrap();
        assert_eq!(store.get("p1"), json!({"香港": "Node-A", "美国": "Node-B"}));
        store.delete_profile("p1").unwrap();
        assert_eq!(store.get("p1"), json!({}));
        assert_eq!(store.get("p2"), json!({"全球": "Node-C"}));
        // A corrupt cache fails open to {}.
        std::fs::write(base.join(PROXY_SELECTIONS_FILE), "not json").unwrap();
        assert_eq!(store.get("p2"), json!({}));
    }

    #[test]
    fn group_test_url_parser_reads_proxy_groups() {
        let document = "proxy-groups:\n  - name: 香港\n    url: https://a.example\n  - name: 美国\n  - name: ''\n";
        let urls = parse_proxy_group_test_urls(document);
        assert_eq!(urls["香港"], "https://a.example");
        assert_eq!(urls["美国"], Value::Null, "omitted url -> null");
        assert_eq!(urls.get(""), None, "unnamed groups skipped");
        assert_eq!(parse_proxy_group_test_urls(""), json!({}));
        assert_eq!(parse_proxy_group_test_urls("::: broken"), json!({}));
    }

    #[tokio::test]
    async fn group_member_test_rejects_missing_members_verbatim() {
        let server = MockServer::start(
            "s3cret",
            |_method, path, _body| {
                if path == "/proxies" {
                    (
                        200,
                        r#"{"proxies":{"香港":{"name":"香港","type":"Selector","all":["A","B"],"now":"A"}}}"#
                            .to_string(),
                    )
                } else {
                    (404, String::new())
                }
            },
        );
        let services = MihomoServices::new(None);
        let client = client(server.port);
        let error = services
            .group_member_delay_test(&client, &json!({}), false, None, "香港", "不存在", 5000)
            .await
            .unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:NOT_FOUND::策略组 香港 中不存在成员 不存在");
    }

    #[tokio::test]
    async fn group_member_test_prefers_provider_healthcheck_and_group_url() {
        let server = MockServer::start("s3cret", |method, path, _body| match path {
            "/proxies" => (
                200,
                r#"{"proxies":{
                    "香港":{"name":"香港","type":"Selector","all":["A"],"now":"A","testUrl":"https://group.example"},
                    "A":{"name":"A","type":"ss","history":[]}
                }}"#
                .to_string(),
            ),
            "/providers/proxies" if method == "GET" => (
                200,
                r#"{"providers":{"prov1":{"name":"prov1","type":"HTTP","proxies":[{"name":"A"}]}}}"#.to_string(),
            ),
            p if p.starts_with("/providers/proxies/prov1/") && method == "GET" => {
                assert!(p.contains("url=https%3A%2F%2Fgroup.example"), "{p}");
                (200, r#"{"delay":77}"#.to_string())
            }
            _ => (404, String::new()),
        });
        let services = MihomoServices::new(None);
        let client = client(server.port);
        let result = services
            .group_member_delay_test(&client, &json!({}), false, None, "香港", "A", 5000)
            .await
            .unwrap();
        assert_eq!(result["delay"], 77);
        assert_eq!(result["url"], "https://group.example", "owner testUrl fills in when the profile omits one");
    }

    #[tokio::test]
    async fn group_member_test_falls_through_404_providers_to_the_plain_endpoint() {
        let server = MockServer::start("s3cret", |method, path, _body| match (method, path) {
            ("GET", "/proxies") => (
                200,
                r#"{"proxies":{
                    "香港":{"name":"香港","type":"Selector","all":["A"],"now":"A"},
                    "A":{"name":"A","type":"ss"}
                }}"#
                .to_string(),
            ),
            (_, "/providers/proxies") => (
                200,
                r#"{"providers":{"prov1":{"name":"prov1","type":"HTTP","proxies":[{"name":"A"}]}}}"#.to_string(),
            ),
            (_, p) if p.starts_with("/providers/proxies/prov1/") && method == "GET" => (404, String::new()),
            (_, p) if p.starts_with("/proxies/A/delay") => (200, r#"{"delay":55}"#.to_string()),
            _ => (404, String::new()),
        });
        let services = MihomoServices::new(None);
        let client = client(server.port);
        let result = services
            .group_member_delay_test(&client, &json!({}), false, None, "香港", "A", 5000)
            .await
            .unwrap();
        assert_eq!(result["delay"], 55);
    }

    #[tokio::test]
    async fn nested_group_members_test_through_the_proxy_endpoint() {
        let server = MockServer::start("s3cret", |method, path, _body| match (method, path) {
            ("GET", "/proxies") => (
                200,
                r#"{"proxies":{
                    "香港":{"name":"香港","type":"Selector","all":["内层"],"now":"内层"},
                    "内层":{"name":"内层","type":"URLTest","all":["A"],"now":"A"}
                }}"#
                .to_string(),
            ),
            (_, p) if p.starts_with("/proxies/%E5%86%85%E5%B1%82/delay") => (200, r#"{"delay":88}"#.to_string()),
            _ => (404, String::new()),
        });
        let services = MihomoServices::new(None);
        let client = client(server.port);
        let result = services
            .group_member_delay_test(&client, &json!({}), false, None, "香港", "内层", 5000)
            .await
            .unwrap();
        assert_eq!(result["delay"], 88);
    }

    #[tokio::test]
    async fn select_proxy_records_the_attributed_selection() {
        let server = MockServer::start("s3cret", |method, path, body| match (method, path) {
            ("PUT", p) if p.starts_with("/proxies/%E9%A6%99%E6%B8%AF") => {
                assert!(body == r#"{"name":"Node-A"}"# || body == r#"{"name":"Node-B"}"#, "{body}");
                (204, String::new())
            }
            _ => (404, String::new()),
        });
        let temp = tempfile::TempDir::new().unwrap();
        let services = MihomoServices::new(Some(temp.path().to_path_buf()));
        let client = client(server.port);
        services.select_proxy(&client, Some("profile-1".to_string()), "香港", "Node-A").await.unwrap();
        assert_eq!(services.selections.get("profile-1"), json!({"香港": "Node-A"}));
        // Without an active profile the controller switch still happens.
        services.select_proxy(&client, None, "香港", "Node-B").await.unwrap();
        assert_eq!(services.selections.get("profile-1"), json!({"香港": "Node-A"}), "unattributed pick not recorded");
    }

    #[tokio::test]
    async fn restore_selections_replays_only_live_selectable_groups() {
        let server = MockServer::start("s3cret", |method, path, body| match (method, path) {
            ("GET", "/proxies") => (
                200,
                r#"{"proxies":{
                    "香港":{"name":"香港","type":"Selector","all":["Node-A","Node-B"],"now":"Node-B"},
                    "规则":{"name":"规则","type":"Rule","all":["Node-A"],"now":"Node-A"},
                    "消失":{"name":"消失","type":"Selector","all":["X"],"now":"X"}
                }}"#
                .to_string(),
            ),
            ("PUT", p) if p.starts_with("/proxies/%E9%A6%99%E6%B8%AF") => {
                assert!(body == r#"{"name":"Node-A"}"# || body == r#"{"name":"Node-B"}"#, "{body}");
                (204, String::new())
            }
            _ => (404, String::new()),
        });
        let temp = tempfile::TempDir::new().unwrap();
        let services = MihomoServices::new(Some(temp.path().to_path_buf()));
        services.selections.set("p", "香港", "Node-A").unwrap();
        services.selections.set("p", "规则", "Node-A").unwrap();
        services.selections.set("p", "消失", "Node-A").unwrap();
        services.selections.set("p", "香港", "Node-A").unwrap();
        // current now == Node-A would skip; make it differ via a second group
        let client = client(server.port);
        let restored = services.restore_selections(&client, Some("p".to_string())).await.unwrap();
        assert_eq!(restored, 1, "only the selectable, differing, still-live group is replayed");
    }
}
