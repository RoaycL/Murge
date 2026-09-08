//! Ownership-aware system-proxy controller — the Rust mirror of
//! `src/main/system-proxy/*` and the `system-proxy:*` IPC surface.
//!
//! The controller owns the first backup it writes and refuses to overwrite a
//! value that was modified externally after it took ownership. The Windows
//! registry mechanics live behind an injectable adapter (the production
//! adapter is only constructed on `win32`, exactly like the TS factory; every
//! other platform gets the fail-closed disabled adapter and the `unsupported`
//! phase), so the full decision machine is unit-testable on Linux CI.

use crate::error::{code, IpcError};
use crate::events::EventHub;
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Shared contract (src/shared/system-proxy.ts + src/shared/proxy-bypass.ts)
// ---------------------------------------------------------------------------

/// Sentinel host the system proxy may only ever point at.
pub const SYSTEM_PROXY_LOOPBACK_HOST: &str = "127.0.0.1";

/// Mandatory local/private destinations that are never proxied (always first
/// in the written `ProxyOverride`, insertion order exactly like the TS Set).
pub const DEFAULT_LOCAL_BYPASS_ENTRIES: [&str; 21] = [
    "<local>",
    "localhost",
    "127.*",
    "10.*",
    "172.16.*",
    "172.17.*",
    "172.18.*",
    "172.19.*",
    "172.20.*",
    "172.21.*",
    "172.22.*",
    "172.23.*",
    "172.24.*",
    "172.25.*",
    "172.26.*",
    "172.27.*",
    "172.28.*",
    "172.29.*",
    "172.30.*",
    "172.31.*",
    "192.168.*",
];

/// Hard caps on user-authored bypass entries.
pub const MAX_CUSTOM_BYPASS_ENTRIES: usize = 200;
pub const MAX_CUSTOM_BYPASS_ENTRY_LENGTH: usize = 255;

/// The controlled model for the written `ProxyOverride`: when `enabled` the app
/// is authoritative for the custom list; when disabled the OS's existing
/// bypass is preserved (never dropped) and restored verbatim on disable.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ProxyBypassPolicy {
    pub enabled: bool,
    #[serde(rename = "customEntries")]
    pub custom_entries: Vec<String>,
}

impl ProxyBypassPolicy {
    pub fn empty() -> Self {
        ProxyBypassPolicy { enabled: false, custom_entries: Vec::new() }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("bypass policy serializes")
    }
}

/// Lifecycle phase + verified read-back of the app-owned system proxy.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyStatus {
    pub supported: bool,
    pub phase: String,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub proxy_override: Option<String>,
    pub error_message: Option<String>,
    pub conflict_detail: Option<String>,
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Registry model (system-proxy/types.ts)
// ---------------------------------------------------------------------------

/// A registry value as reported/read back, preserving the EXACT registry type
/// (`REG_SZ` vs `REG_EXPAND_SZ` vs `REG_BINARY` never collapse into one bucket;
/// `none` is the absent sentinel).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RegistryValue {
    pub exists: bool,
    #[serde(rename = "type")]
    pub kind: String,
    /// DWORD/QWORD → number; SZ/EXPAND_SZ/MULTI_SZ/BINARY → string; none → null.
    pub value: Value,
}

impl Default for RegistryValue {
    fn default() -> Self {
        RegistryValue::absent()
    }
}

impl RegistryValue {
    pub fn absent() -> Self {
        RegistryValue { exists: false, kind: "none".to_string(), value: Value::Null }
    }

    pub fn dword(value: u64) -> Self {
        RegistryValue { exists: true, kind: "REG_DWORD".to_string(), value: json!(value) }
    }

    pub fn string(value: impl Into<String>) -> Self {
        RegistryValue { exists: true, kind: "REG_SZ".to_string(), value: Value::String(value.into()) }
    }
}

/// The three HKCU Internet Settings values the feature owns.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryState {
    pub proxy_enable: RegistryValue,
    pub proxy_server: RegistryValue,
    pub proxy_override: RegistryValue,
}

/// The value set the app writes while a proxy is enabled.
pub type WrittenState = RegistryState;

/// The listener the system proxy may be pointed at (always the loopback mixed port).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// Point-in-time record of an owned proxy, persisted for crash recovery.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemProxyBackup {
    pub instance_id: String,
    pub created_at: String,
    pub target: Target,
    pub previous: RegistryState,
    pub written: RegistryState,
}

// ---------------------------------------------------------------------------
// Policy — the pure decision helpers (system-proxy/policy.ts)
// ---------------------------------------------------------------------------

/// Format a target as `host:port` (the WinINet ProxyServer form; scheme-less).
pub fn format_address(target: &Target) -> String {
    format!("{}:{}", target.host, target.port)
}

pub fn build_proxy_server_value(target: &Target) -> String {
    format_address(target)
}

/// Insertion-ordered dedup merge: the mandatory local entries stay first, the
/// given entries are trimmed, de-duplicated and appended (the TS Set order).
fn merge_bypass_entries(entries: &[String]) -> String {
    let mut merged: Vec<String> =
        DEFAULT_LOCAL_BYPASS_ENTRIES.iter().map(|entry| entry.to_string()).collect();
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !merged.iter().any(|existing| existing == trimmed) {
            merged.push(trimmed.to_string());
        }
    }
    merged.join(";")
}

/// Build the `ProxyOverride` we write from whatever the OS already had.
pub fn merge_proxy_override(original: Option<&str>) -> String {
    let entries: Vec<String> =
        original.unwrap_or("").split(';').map(|entry| entry.to_string()).collect();
    merge_bypass_entries(&entries)
}

/// Build the `ProxyOverride` from an authoritative user policy.
pub fn merge_local_bypass(custom_entries: &[String]) -> String {
    merge_bypass_entries(custom_entries)
}

/// Resolve the `ProxyOverride` given the controlled policy and the OS value: an
/// `enabled` policy is authoritative for the custom section; a disabled policy
/// preserves whatever the OS already had (local + existing).
pub fn resolve_proxy_override(policy: &ProxyBypassPolicy, original: Option<&str>) -> String {
    if policy.enabled {
        merge_local_bypass(&policy.custom_entries)
    } else {
        merge_proxy_override(original)
    }
}

/// Build the value set the app owns while the system proxy is enabled.
pub fn build_written_state(
    target: &Target,
    observed: &RegistryState,
    policy: &ProxyBypassPolicy,
) -> WrittenState {
    RegistryState {
        proxy_enable: RegistryValue::dword(1),
        proxy_server: RegistryValue::string(build_proxy_server_value(target)),
        proxy_override: RegistryValue::string(resolve_proxy_override(
            policy,
            observed.proxy_override.value.as_str(),
        )),
    }
}

/// Strict registry-value equality: both `exists`, the LITERAL registry type and
/// the value must all agree (an `REG_SZ` can never masquerade as
/// `REG_EXPAND_SZ`).
pub fn same_registry_value(a: &RegistryValue, b: &RegistryValue) -> bool {
    if a.exists != b.exists {
        return false;
    }
    if !a.exists {
        return a.kind == "none" && b.kind == "none" && a.value.is_null() && b.value.is_null();
    }
    a.kind == b.kind && a.value == b.value
}

/// The set of proxy keys whose observed value differs from what the app wrote.
pub fn differing_keys(observed: &RegistryState, written: &WrittenState) -> Vec<&'static str> {
    let mut differing = Vec::new();
    if !same_registry_value(&observed.proxy_enable, &written.proxy_enable) {
        differing.push("ProxyEnable");
    }
    if !same_registry_value(&observed.proxy_server, &written.proxy_server) {
        differing.push("ProxyServer");
    }
    if !same_registry_value(&observed.proxy_override, &written.proxy_override) {
        differing.push("ProxyOverride");
    }
    differing
}

/// Whether the current registry exactly matches what the app wrote.
pub fn is_owned(observed: &RegistryState, written: &WrittenState) -> bool {
    differing_keys(observed, written).is_empty()
}

/// Whether the current registry exactly matches the pre-enable snapshot.
pub fn matches_previous(observed: &RegistryState, previous: &RegistryState) -> bool {
    is_owned(observed, previous)
}

/// A short human readable summary of which keys were mutated externally.
pub fn conflict_detail(observed: &RegistryState, written: &WrittenState) -> String {
    let keys = differing_keys(observed, written);
    if keys.is_empty() {
        String::new()
    } else {
        format!("注册表项被外部修改：{}", keys.join("、"))
    }
}

/// Refuse to enable BEFORE any registry write when the pre-enable state holds a
/// value we cannot faithfully restore (or a structurally inconsistent one).
pub fn validate_restorable(previous: &RegistryState) -> Result<(), IpcError> {
    fn is_restorable(kind: &str) -> bool {
        matches!(kind, "REG_DWORD" | "REG_SZ" | "REG_EXPAND_SZ" | "REG_BINARY")
    }
    let entries = [
        ("ProxyEnable", &previous.proxy_enable),
        ("ProxyServer", &previous.proxy_server),
        ("ProxyOverride", &previous.proxy_override),
    ];
    for (name, value) in entries {
        if !value.exists {
            if value.kind != "none" || !value.value.is_null() {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_ENABLE_FAILED,
                    format!("系统代理项 {name} 的备份状态不一致，已拒绝启用"),
                ));
            }
            continue;
        }
        if !is_restorable(&value.kind) {
            return Err(IpcError::code(
                code::SYSTEM_PROXY_ENABLE_FAILED,
                format!("系统代理项 {name} 的类型 {} 无法安全还原，已拒绝启用", value.kind),
            ));
        }
        if value.kind == "REG_DWORD" || value.kind == "REG_QWORD" {
            // The TS check: a non-negative integer payload.
            let valid = match &value.value {
                Value::Number(number) => {
                    let as_f64 = number.as_f64().unwrap_or(f64::NAN);
                    as_f64.is_finite() && as_f64.fract() == 0.0 && as_f64 >= 0.0
                }
                _ => false,
            };
            if !valid {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_ENABLE_FAILED,
                    format!("系统代理项 {name} 的数值无效"),
                ));
            }
        } else if value.value.as_str().is_none() {
            return Err(IpcError::code(
                code::SYSTEM_PROXY_ENABLE_FAILED,
                format!("系统代理项 {name} 的字符串值无效"),
            ));
        }
    }
    Ok(())
}

/// Hard validation of a target. Throws for a bad host/port.
pub fn validate_target(target: &Target) -> Result<(), IpcError> {
    if target.host != SYSTEM_PROXY_LOOPBACK_HOST {
        return Err(IpcError::code(
            code::SYSTEM_PROXY_ENABLE_FAILED,
            format!("系统代理必须指向回环地址，收到 {}", target.host),
        ));
    }
    if target.port == 0 {
        return Err(IpcError::code(
            code::SYSTEM_PROXY_ENABLE_FAILED,
            format!("无效的混合端口 {}", target.port),
        ));
    }
    Ok(())
}

/// Shared recovery decision for enable, disable, init and kernel shutdown: the
/// observed state matches what we wrote, matches our pre-enable snapshot, or
/// still aims at our server value.
pub fn can_restore_backup(observed: &RegistryState, backup: &SystemProxyBackup) -> bool {
    is_owned(observed, &backup.written)
        || matches_previous(observed, &backup.previous)
        || (observed.proxy_server.exists
            && observed
                .proxy_server
                .value
                .as_str()
                .map(|value| value == build_proxy_server_value(&backup.target))
                .unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Controlled proxy-bypass policy coercion (src/shared/proxy-bypass.ts)
// ---------------------------------------------------------------------------

/// Coerce arbitrary input (IPC payloads, a read-back from disk) into a valid
/// `ProxyBypassPolicy`. Every field falls back independently — a corrupt or
/// partial value never throws.
pub fn coerce_proxy_bypass_policy(input: &Value) -> ProxyBypassPolicy {
    let Some(object) = input.as_object() else {
        return ProxyBypassPolicy::empty();
    };
    ProxyBypassPolicy {
        enabled: object.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        custom_entries: normalize_entries(object.get("customEntries")),
    }
}

/// Normalize a customEntries input into a clean, de-duplicated, bounded list.
fn normalize_entries(input: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = input else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        let Some(raw) = item.as_str() else { continue };
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.chars().count() > MAX_CUSTOM_BYPASS_ENTRY_LENGTH {
            continue;
        }
        if seen.iter().any(|existing| existing == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
        if seen.len() >= MAX_CUSTOM_BYPASS_ENTRIES {
            break;
        }
    }
    seen
}

/// Strict parse (the TS parseProxyBypassPolicy zod schema): an invalid shape is
/// an INVALID_ARGUMENT carrying the zod default message copy, never silent
/// coercion.
pub fn parse_proxy_bypass_policy(input: Option<&Value>) -> Result<ProxyBypassPolicy, IpcError> {
    let kind_of = |value: &Value| match value {
        Value::Null => "null".to_string(),
        Value::Bool(_) => "boolean".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(_) => "string".to_string(),
        Value::Array(_) => "array".to_string(),
        Value::Object(_) => "object".to_string(),
    };
    let invalid = |path: &str, message: String| {
        Err(IpcError::invalid_argument(format!(
            "invalid proxy bypass policy at {path}: {message}"
        )))
    };
    let Value::Object(object) = input.unwrap_or(&Value::Null) else {
        return Err(IpcError::invalid_argument("proxy bypass policy must be an object"));
    };
    let enabled = match object.get("enabled") {
        Some(Value::Bool(value)) => *value,
        Some(value) => {
            return invalid("enabled", format!("Expected boolean, received {}", kind_of(value)))
        }
        None => return invalid("enabled", "Required".to_string()),
    };
    let custom_entries = match object.get("customEntries") {
        Some(Value::Array(items)) => {
            if items.len() > MAX_CUSTOM_BYPASS_ENTRIES {
                return invalid(
                    "customEntries",
                    format!("Array must contain at most {MAX_CUSTOM_BYPASS_ENTRIES} element(s)"),
                );
            }
            let mut entries = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let Some(raw) = item.as_str() else {
                    return invalid(
                        &format!("customEntries.{index}"),
                        format!("Expected string, received {}", kind_of(item)),
                    );
                };
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return invalid(
                        &format!("customEntries.{index}"),
                        "String must contain at least 1 character(s)".to_string(),
                    );
                }
                if trimmed.chars().count() > MAX_CUSTOM_BYPASS_ENTRY_LENGTH {
                    return invalid(
                        &format!("customEntries.{index}"),
                        format!(
                            "String must contain at most {MAX_CUSTOM_BYPASS_ENTRY_LENGTH} character(s)"
                        ),
                    );
                }
                entries.push(trimmed.to_string());
            }
            entries
        }
        Some(value) => {
            return invalid("customEntries", format!("Expected array, received {}", kind_of(value)))
        }
        None => return invalid("customEntries", "Required".to_string()),
    };
    Ok(ProxyBypassPolicy { enabled, custom_entries })
}

// ---------------------------------------------------------------------------
// Backup schema (system-proxy/backup-schema.ts) — strict zod analog
// ---------------------------------------------------------------------------

pub const SYSTEM_PROXY_BACKUP_SCHEMA_VERSION: u32 = 1;

const REGISTRY_VALUE_TYPES: [&str; 7] = [
    "REG_DWORD",
    "REG_SZ",
    "REG_EXPAND_SZ",
    "REG_MULTI_SZ",
    "REG_BINARY",
    "REG_QWORD",
    "none",
];

/// `true` when the registry value carries a numeric (DWORD/QWORD) payload.
pub fn is_numeric_registry_type(kind: &str) -> bool {
    kind == "REG_DWORD" || kind == "REG_QWORD"
}

/// zod `datetime({ offset: true })`: an ISO-8601 W3C date-time that REQUIRES a
/// timezone designator (`Z` or ±HH:MM).
fn is_iso_offset_datetime(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || bytes[10] != b'T' {
        return false;
    }
    let date_ok = bytes[..10].iter().enumerate().all(|(index, byte)| match index {
        0..=3 | 5..=6 | 8..=9 => byte.is_ascii_digit(),
        4 | 7 => *byte == b'-',
        _ => false,
    });
    if !date_ok {
        return false;
    }
    let rest = &raw[11..];
    // The zone designator anchors the END: `Z`, or ±HH:MM.
    let (clock, zone) = if rest.ends_with('Z') {
        (&rest[..rest.len() - 1], "Z")
    } else if rest.len() > 6 {
        let (middle, zone) = rest.split_at(rest.len() - 6);
        (middle, zone)
    } else {
        return false;
    };
    let zone_ok = zone == "Z" || {
        let zone_bytes = zone.as_bytes();
        zone.len() == 6
            && (zone_bytes[0] == b'+' || zone_bytes[0] == b'-')
            && zone_bytes[1].is_ascii_digit()
            && zone_bytes[2].is_ascii_digit()
            && zone_bytes[3] == b':'
            && zone_bytes[4].is_ascii_digit()
            && zone_bytes[5].is_ascii_digit()
    };
    if !zone_ok {
        return false;
    }
    // The clock is HH:MM:SS with an optional fractional part (`.` + digits),
    // which zod's datetime accepts.
    let (seconds_part, fraction) = match clock.split_once('.') {
        Some((head, fraction)) => (head, Some(fraction)),
        None => (clock, None),
    };
    let seconds_ok = seconds_part.as_bytes().iter().enumerate().all(|(index, byte)| match index {
        0..=1 | 3..=4 | 6..=7 => byte.is_ascii_digit(),
        2 | 5 => *byte == b':',
        _ => false,
    }) && seconds_part.len() == 8;
    let fraction_ok = fraction.map(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).unwrap_or(true);
    seconds_ok && fraction_ok
}

/// Validate an unknown backup payload strictly — the single source of truth for
/// what a backup may look like. Every persisted object is strict, so an unknown
/// key anywhere rejects the bundle; validation fails closed so a corrupt or
/// inconsistent backup is never trusted enough to write back to the registry.
pub fn parse_system_proxy_backup(input: &Value) -> Result<SystemProxyBackup, IpcError> {
    const BUNDLE_KEYS: [&str; 6] = ["schemaVersion", "instanceId", "createdAt", "target", "previous", "written"];
    let reject = || IpcError::internal("系统代理备份无效");
    let object = input.as_object().ok_or_else(reject)?;
    if !exact_keys(object, &BUNDLE_KEYS) {
        return Err(reject());
    }
    if object.get("schemaVersion").and_then(Value::as_i64) != Some(SYSTEM_PROXY_BACKUP_SCHEMA_VERSION as i64) {
        return Err(reject());
    }
    let instance_id = object.get("instanceId").and_then(Value::as_str).unwrap_or_default();
    if instance_id.is_empty() {
        return Err(reject());
    }
    let created_at = object.get("createdAt").and_then(Value::as_str).unwrap_or_default();
    if !is_iso_offset_datetime(created_at) {
        return Err(reject());
    }
    let target_object = object.get("target").and_then(Value::as_object).ok_or_else(reject)?;
    if !exact_keys(target_object, &["host", "port"]) {
        return Err(reject());
    }
    let host = target_object.get("host").and_then(Value::as_str).unwrap_or_default();
    if host != SYSTEM_PROXY_LOOPBACK_HOST {
        return Err(reject());
    }
    let port = target_object.get("port").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=65535).contains(&port) {
        return Err(reject());
    }
    let previous = parse_state_strict(object.get("previous").unwrap_or(&Value::Null)).map_err(|_| reject())?;
    let written = parse_state_strict(object.get("written").unwrap_or(&Value::Null)).map_err(|_| reject())?;
    Ok(SystemProxyBackup {
        instance_id: instance_id.to_string(),
        created_at: created_at.to_string(),
        target: Target { host: host.to_string(), port: port as u16 },
        previous,
        written,
    })
}

/// Exactly the allowed keys: no unknown key, every allowed key present.
fn exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.len() == allowed.len() && allowed.iter().all(|key| object.contains_key(*key))
}

fn parse_state_strict(input: &Value) -> Result<RegistryState, IpcError> {
    const STATE_KEYS: [&str; 3] = ["proxyEnable", "proxyServer", "proxyOverride"];
    let reject = || IpcError::internal("系统代理备份无效");
    let object = input.as_object().ok_or_else(reject)?;
    if !exact_keys(object, &STATE_KEYS) {
        return Err(reject());
    }
    let value_for = |name: &str| -> Result<RegistryValue, IpcError> {
        let raw = object.get(name).and_then(Value::as_object).ok_or_else(reject)?;
        if !exact_keys(raw, &["exists", "type", "value"]) {
            return Err(reject());
        }
        let exists = raw.get("exists").and_then(Value::as_bool).ok_or_else(reject)?;
        if !exists {
            // An absent value must be exactly { type: "none", value: null }.
            let kind = raw.get("type").and_then(Value::as_str).unwrap_or("");
            let value_null = raw.get("value").map(Value::is_null).unwrap_or(false);
            if kind != "none" || !value_null {
                return Err(reject());
            }
            return Ok(RegistryValue::absent());
        }
        let kind = raw.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "none" || !REGISTRY_VALUE_TYPES.contains(&kind) {
            return Err(reject());
        }
        let value = raw.get("value").cloned().unwrap_or(Value::Null);
        if is_numeric_registry_type(kind) {
            // A numeric payload must be a non-negative safe integer.
            let Some(number) = value.as_u64() else {
                return Err(reject());
            };
            if number > (1u64 << 53) - 1 {
                return Err(reject());
            }
            return Ok(RegistryValue { exists: true, kind: kind.to_string(), value: json!(number) });
        }
        let Some(string) = value.as_str() else {
            return Err(reject());
        };
        Ok(RegistryValue {
            exists: true,
            kind: kind.to_string(),
            value: Value::String(string.to_string()),
        })
    };
    Ok(RegistryState {
        proxy_enable: value_for("proxyEnable")?,
        proxy_server: value_for("proxyServer")?,
        proxy_override: value_for("proxyOverride")?,
    })
}

/// Serialize a validated backup into the persisted shape.
pub fn backup_to_value(backup: &SystemProxyBackup) -> Value {
    json!({
        "schemaVersion": SYSTEM_PROXY_BACKUP_SCHEMA_VERSION,
        "instanceId": backup.instance_id,
        "createdAt": backup.created_at,
        "target": { "host": backup.target.host, "port": backup.target.port },
        "previous": backup.previous,
        "written": backup.written,
    })
}

// ---------------------------------------------------------------------------
// Stores (backup-store.ts + proxy-bypass-store.ts)
// ---------------------------------------------------------------------------

pub const SYSTEM_PROXY_BACKUP_SUBDIR: &str = "system-proxy";
pub const SYSTEM_PROXY_BACKUP_FILE: &str = "owned-backup.json";
pub const SYSTEM_PROXY_BYPASS_FILE: &str = "proxy-bypass-policy.json";

pub type BoxResult<'a, T> = BoxFuture<'a, Result<T, String>>;
pub type BoxUnit<'a> = BoxFuture<'a, Result<(), String>>;

/// Owned-backup persistence. The service writes the backup before applying so a
/// crash mid-apply is recoverable on next startup.
pub trait BackupStore: Send + Sync {
    fn read(&self) -> BoxResult<'_, Option<Value>>;
    fn write(&self, backup: &Value) -> BoxUnit<'_>;
    fn delete(&self) -> BoxUnit<'_>;
}

/// The file-backed store (atomic tmp+rename; a corrupt file reads as an Err so
/// the service fails closed instead of guessing).
pub struct FileSystemBackupStore {
    path: std::path::PathBuf,
}

impl FileSystemBackupStore {
    pub fn for_base_dir(base: &std::path::Path) -> Self {
        FileSystemBackupStore {
            path: base.join(SYSTEM_PROXY_BACKUP_SUBDIR).join(SYSTEM_PROXY_BACKUP_FILE),
        }
    }
}

impl BackupStore for FileSystemBackupStore {
    fn read(&self) -> BoxResult<'_, Option<Value>> {
        let path = self.path.clone();
        Box::pin(async move {
            let Ok(raw) = std::fs::read(&path) else {
                return Ok(None);
            };
            serde_json::from_slice::<Value>(&raw).map(Some).map_err(|error| format!("备份文件无效：{error}"))
        })
    }

    fn write(&self, backup: &Value) -> BoxUnit<'_> {
        let path = self.path.clone();
        let body = serde_json::to_vec_pretty(backup).expect("backup serializes");
        Box::pin(async move {
            write_atomic(&path, &body).map_err(|error| format!("备份写入失败：{error}"))
        })
    }

    fn delete(&self) -> BoxUnit<'_> {
        let path = self.path.clone();
        Box::pin(async move {
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("备份删除失败：{error}")),
            }
        })
    }
}

/// In-memory store for the dev build and unit tests.
pub struct InMemoryBackupStore {
    value: Mutex<Option<Value>>,
}

impl InMemoryBackupStore {
    pub fn new() -> Self {
        InMemoryBackupStore { value: Mutex::new(None) }
    }
}

impl Default for InMemoryBackupStore {
    fn default() -> Self {
        Self::new()
    }
}

impl BackupStore for InMemoryBackupStore {
    fn read(&self) -> BoxResult<'_, Option<Value>> {
        Box::pin(async move { Ok(self.value.lock().expect("backup memory poisoned").clone()) })
    }

    fn write(&self, backup: &Value) -> BoxUnit<'_> {
        let backup = backup.clone();
        Box::pin(async move {
            *self.value.lock().expect("backup memory poisoned") = Some(backup);
            Ok(())
        })
    }

    fn delete(&self) -> BoxUnit<'_> {
        Box::pin(async move {
            *self.value.lock().expect("backup memory poisoned") = None;
            Ok(())
        })
    }
}

/// Controlled proxy-bypass policy persistence.
pub trait ProxyBypassStore: Send + Sync {
    fn read(&self) -> BoxFuture<'_, ProxyBypassPolicy>;
    fn write(&self, policy: ProxyBypassPolicy) -> BoxResult<'_, ()>;
}

/// File-backed policy store; a missing / corrupt file falls back to the empty
/// policy (the TS read path), never a crash.
pub struct FileSystemBypassStore {
    path: std::path::PathBuf,
}

impl FileSystemBypassStore {
    pub fn for_base_dir(base: &std::path::Path) -> Self {
        FileSystemBypassStore {
            path: base.join(SYSTEM_PROXY_BACKUP_SUBDIR).join(SYSTEM_PROXY_BYPASS_FILE),
        }
    }
}

impl ProxyBypassStore for FileSystemBypassStore {
    fn read(&self) -> BoxFuture<'_, ProxyBypassPolicy> {
        let path = self.path.clone();
        Box::pin(async move {
            let Ok(raw) = std::fs::read(&path) else {
                return ProxyBypassPolicy::empty();
            };
            match serde_json::from_slice::<Value>(&raw) {
                Ok(parsed) => coerce_proxy_bypass_policy(&parsed),
                Err(_) => ProxyBypassPolicy::empty(),
            }
        })
    }

    fn write(&self, policy: ProxyBypassPolicy) -> BoxResult<'_, ()> {
        let path = self.path.clone();
        let body = serde_json::to_vec_pretty(&policy).expect("policy serializes");
        Box::pin(async move {
            write_atomic(&path, &body).map_err(|error| format!("策略写入失败：{error}"))
        })
    }
}

/// In-memory store for the dev build and unit tests.
pub struct InMemoryBypassStore {
    value: Mutex<ProxyBypassPolicy>,
}

impl InMemoryBypassStore {
    pub fn new() -> Self {
        InMemoryBypassStore { value: Mutex::new(ProxyBypassPolicy::empty()) }
    }
}

impl Default for InMemoryBypassStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyBypassStore for InMemoryBypassStore {
    fn read(&self) -> BoxFuture<'_, ProxyBypassPolicy> {
        Box::pin(async move { self.value.lock().expect("bypass memory poisoned").clone() })
    }

    fn write(&self, policy: ProxyBypassPolicy) -> BoxResult<'_, ()> {
        Box::pin(async move {
            *self.value.lock().expect("bypass memory poisoned") = policy;
            Ok(())
        })
    }
}

fn write_atomic(path: &std::path::Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("目录创建失败：{error}"))?;
    }
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", new_uuid()));
    std::fs::write(&tmp, body).map_err(|error| format!("写入失败：{error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败：{error}")
    })
}

// ---------------------------------------------------------------------------
// Platform adapter boundary (system-proxy/types.ts SystemProxyAdapter)
// ---------------------------------------------------------------------------

pub type BoxFut<'a, T> = BoxFuture<'a, Result<T, IpcError>>;
pub type BoxFutUnit<'a> = BoxFuture<'a, Result<(), IpcError>>;

/// Platform adapter boundary: the decision logic lives in the service; an
/// adapter only reads/applies/restores the platform values on one OS.
pub trait SystemProxyAdapter: Send + Sync {
    /// Human readable platform label, e.g. `win32` (parity with the TS trait;
    /// consumed by diagnostics and the disabled-adapter phase).
    #[allow(dead_code)] // parity API; exercised by adapters + tests
    fn platform(&self) -> &'static str {
        "unknown"
    }
    /// Whether this adapter can own the system proxy on the running platform.
    fn supported(&self) -> bool;
    fn read(&self) -> BoxFut<'_, RegistryState>;
    fn apply(&self, written: &WrittenState) -> BoxFutUnit<'_>;
    fn restore(&self, previous: &RegistryState) -> BoxFutUnit<'_>;
    /// Notify the OS so running apps pick up the change (WinINet refresh).
    fn refresh(&self) -> BoxFutUnit<'_>;
}

/// Fail-closed adapter: the phase becomes `unsupported` and every operation
/// errors with the not-supported copy (the TS DisabledSystemProxyAdapter).
pub struct DisabledSystemProxyAdapter {
    #[allow(dead_code)] // read through the trait's platform() label
    platform: &'static str,
}

impl DisabledSystemProxyAdapter {
    pub fn new(platform: &'static str) -> Self {
        DisabledSystemProxyAdapter { platform }
    }

    fn unsupported_error(&self) -> IpcError {
        IpcError::code(code::SYSTEM_PROXY_UNSUPPORTED, NOT_SUPPORTED_MSG)
    }
}

impl SystemProxyAdapter for DisabledSystemProxyAdapter {
    fn platform(&self) -> &'static str {
        self.platform
    }
    // platform() carries the label; nothing else reads the field today.

    fn supported(&self) -> bool {
        false
    }

    fn read(&self) -> BoxFut<'_, RegistryState> {
        let error = self.unsupported_error();
        Box::pin(async move { Err(error) })
    }

    fn apply(&self, _written: &WrittenState) -> BoxFutUnit<'_> {
        let error = self.unsupported_error();
        Box::pin(async move { Err(error) })
    }

    fn restore(&self, _previous: &RegistryState) -> BoxFutUnit<'_> {
        let error = self.unsupported_error();
        Box::pin(async move { Err(error) })
    }

    fn refresh(&self) -> BoxFutUnit<'_> {
        let error = self.unsupported_error();
        Box::pin(async move { Err(error) })
    }
}

/// In-memory adapter for the dev build and unit tests, with injectable
/// apply/restore failure modes and a refresh counter (the TS fake adapter).
pub struct FakeSystemProxyAdapter {
    registry: Mutex<RegistryState>,
    apply_error: AtomicBool,
    restore_error: AtomicBool,
    refresh_count: std::sync::atomic::AtomicUsize,
}

// The driver methods are the test surface; the lib never calls them directly.
#[allow(dead_code)]
impl FakeSystemProxyAdapter {
    pub fn new() -> Self {
        FakeSystemProxyAdapter {
            registry: Mutex::new(RegistryState {
                proxy_enable: RegistryValue::absent(),
                proxy_server: RegistryValue::absent(),
                proxy_override: RegistryValue::absent(),
            }),
            apply_error: AtomicBool::new(false),
            restore_error: AtomicBool::new(false),
            refresh_count: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn set_registry(&self, state: RegistryState) {
        *self.registry.lock().expect("fake registry poisoned") = state;
    }

    pub fn fail_apply(&self, enabled: bool) {
        self.apply_error.store(enabled, Ordering::SeqCst);
    }

    pub fn fail_restore(&self, enabled: bool) {
        self.restore_error.store(enabled, Ordering::SeqCst);
    }

    pub fn refresh_count(&self) -> usize {
        self.refresh_count.load(Ordering::SeqCst)
    }
}

impl Default for FakeSystemProxyAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemProxyAdapter for FakeSystemProxyAdapter {
    fn platform(&self) -> &'static str {
        "fake"
    }

    fn supported(&self) -> bool {
        true
    }

    fn read(&self) -> BoxFut<'_, RegistryState> {
        Box::pin(async move { Ok(self.registry.lock().expect("fake registry poisoned").clone()) })
    }

    fn apply(&self, written: &WrittenState) -> BoxFutUnit<'_> {
        let written = written.clone();
        Box::pin(async move {
            if self.apply_error.load(Ordering::SeqCst) {
                return Err(IpcError::code(code::SYSTEM_PROXY_ENABLE_FAILED, "fake apply failure"));
            }
            *self.registry.lock().expect("fake registry poisoned") = written;
            Ok(())
        })
    }

    fn restore(&self, previous: &RegistryState) -> BoxFutUnit<'_> {
        let previous = previous.clone();
        Box::pin(async move {
            if self.restore_error.load(Ordering::SeqCst) {
                return Err(IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "fake restore failure"));
            }
            *self.registry.lock().expect("fake registry poisoned") = previous;
            Ok(())
        })
    }

    fn refresh(&self) -> BoxFutUnit<'_> {
        Box::pin(async move {
            self.refresh_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Kernel readiness probe (system-proxy/probe.ts)
// ---------------------------------------------------------------------------

pub const PROBE_TIMEOUT_MS: u64 = 2500;
const PROBE_HOST: &str = SYSTEM_PROXY_LOOPBACK_HOST;
const HTTP_CONNECT_REQUEST: &[u8] =
    b"CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUser-Agent: system-proxy-probe\r\n\r\n";

/// The kernel readiness probe: the proxy may only be enabled once the kernel is
/// running, authenticated, and advertising a live mixed-port.
pub type ProbeFn = Arc<dyn Fn() -> BoxFuture<'static, Result<Target, IpcError>> + Send + Sync>;

/// A probe that always returns a fixed target — used in dev and in unit tests.
pub fn static_probe(target: Target) -> ProbeFn {
    Arc::new(move || {
        let target = target.clone();
        Box::pin(async move { Ok(target) })
    })
}

/// Open a TCP connection to the candidate proxy port (fails fast on a dead port).
async fn open_tcp(port: u16) -> Result<tokio::net::TcpStream, String> {
    let connect = tokio::net::TcpStream::connect((PROBE_HOST, port));
    match tokio::time::timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS), connect).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(format!("TCP connect to {PROBE_HOST}:{port} failed: {error}")),
        Err(_) => Err(format!("TCP connect to {PROBE_HOST}:{port} timed out")),
    }
}

/// Probe the SOCKS5 layer: send a no-auth greeting and require `05 00` back.
/// The reply is accumulated across data chunks (a healthy mixed-port commonly
/// splits the 2 bytes), validated once at least 2 bytes have arrived.
pub async fn probe_socks(port: u16) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = open_tcp(port).await?;
    let exchange = tokio::time::timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS), async {
        stream.write_all(&[0x05, 0x01, 0x00]).await.map_err(|error| format!("{error}"))?;
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0u8; 64];
            let read = stream.read(&mut chunk).await.map_err(|error| format!("{error}"))?;
            if read == 0 {
                return Err("SOCKS5 closed without a greeting reply".to_string());
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() >= 2 {
                if buffer[0] == 0x05 && buffer[1] == 0x00 {
                    return Ok(());
                }
                return Err(format!("unexpected SOCKS5 greeting reply: {}", hex(&buffer[..2])));
            }
        }
    })
    .await;
    match exchange {
        Ok(inner) => inner,
        Err(_) => Err("SOCKS5 greeting timed out".to_string()),
    }
}

/// Probe the HTTP-proxy layer: a CONNECT must be answered with an HTTP status
/// line. The target is ALWAYS the loopback literal `127.0.0.1:1` so a
/// misbehaving proxy can never trigger a real external CONNECT (P2-2).
pub async fn probe_http(port: u16) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = open_tcp(port).await?;
    let exchange = tokio::time::timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS), async {
        stream.write_all(HTTP_CONNECT_REQUEST).await.map_err(|error| format!("{error}"))?;
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0u8; 256];
            let read = stream.read(&mut chunk).await.map_err(|error| format!("{error}"))?;
            if read == 0 {
                return Err("HTTP CONNECT closed without a status line".to_string());
            }
            buffer.extend_from_slice(&chunk[..read]);
            if matches_http_status_line(&buffer) {
                return Ok(());
            }
        }
    })
    .await;
    match exchange {
        Ok(inner) => inner,
        Err(_) => Err("HTTP CONNECT response timed out".to_string()),
    }
}

/// `^(?:HTTP\/\d(?:\.\d)?)\s+\d{3}` over the accumulated bytes.
fn matches_http_status_line(buffer: &[u8]) -> bool {
    let Some(rest) = buffer.strip_prefix(b"HTTP/") else {
        return false;
    };
    let major = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    if major == 0 {
        return false;
    }
    let mut rest = &rest[major..];
    if rest.first() == Some(&b'.') {
        rest = &rest[1..];
        let minor = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
        if minor == 0 {
            return false;
        }
        rest = &rest[minor..];
    }
    let Some(space) = rest.first().copied() else {
        return false;
    };
    if !space.is_ascii_whitespace() {
        return false;
    }
    let after_space = &rest[rest.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(rest.len())..];
    after_space.len() >= 3 && after_space[..3].iter().all(|byte| byte.is_ascii_digit())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn probe_error_suffix(results: [Result<(), String>; 2]) -> Option<String> {
    let errors: Vec<String> = results.into_iter().filter_map(|result| result.err()).collect();
    if errors.is_empty() {
        None
    } else {
        Some(errors.join("；"))
    }
}

/// The production probe (the TS `LiveSystemProxyKernelProbe`): kernel running →
/// authenticated controller → a live mixed-port read from `/configs`, then BOTH
/// the HTTP and SOCKS layers socket-probed before the registry may point at it.
pub fn live_probe(
    kernel_phase: impl Fn() -> String + Send + Sync + 'static,
    controller: impl Fn() -> Result<crate::mihomo::MihomoClient, IpcError> + Send + Sync + 'static,
) -> ProbeFn {
    Arc::new(move || {
        if kernel_phase() != "running" {
            return Box::pin(async move {
                Err(IpcError::code(
                    code::SYSTEM_PROXY_KERNEL_REQUIRED,
                    "内核未运行，无法启用系统代理",
                ))
            }) as BoxFuture<'static, Result<Target, IpcError>>;
        }
        let client = controller();
        Box::pin(async move {
            let Ok(client) = client else {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_KERNEL_REQUIRED,
                    "内核控制器未就绪，无法启用系统代理",
                ));
            };
            if client.get_version().await.is_err() {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_KERNEL_REQUIRED,
                    "内核控制器未就绪，无法启用系统代理",
                ));
            }
            let config = client.get_config().await.map_err(|_| {
                IpcError::code(code::SYSTEM_PROXY_KERNEL_REQUIRED, "内核控制器未就绪，无法启用系统代理")
            })?;
            let mixed_port = config["mixed-port"].as_i64().unwrap_or(0);
            if !(1..=65535).contains(&mixed_port) {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_KERNEL_REQUIRED,
                    "内核未提供有效的混合端口，无法启用系统代理",
                ));
            }
            let port = mixed_port as u16;
            // Parallel HTTP + SOCKS probes; a single failure means the port is
            // not a live mixed-port listener.
            let (http, socks) = tokio::join!(probe_http(port), probe_socks(port));
            if let Some(detail) = probe_error_suffix([http, socks]) {
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_KERNEL_REQUIRED,
                    format!("内核混合端口未就绪（{mixed_port}）：{detail}"),
                ));
            }
            Ok(Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port })
        }) as BoxFuture<'static, Result<Target, IpcError>>
    })
}

// ---------------------------------------------------------------------------
// Service (system-proxy/service.ts)
// ---------------------------------------------------------------------------

pub const NOT_SUPPORTED_MSG: &str = "当前平台不支持系统代理";
const CONFLICT_MSG: &str = "系统代理已被外部修改，未执行还原";

/// The ownership-aware controller. It owns the FIRST backup it writes, refuses
/// to overwrite externally-mutated values, and reuses one strict restore path
/// (restore → refresh → read-back verify → delete-on-success) for disable,
/// rollback, recovery and the network handlers. Every public operation is
/// serialized through one tokio queue (the TS promise-chain `serialize`).
pub struct SystemProxyService {
    adapter: Arc<dyn SystemProxyAdapter>,
    probe: ProbeFn,
    backup: Arc<dyn BackupStore>,
    bypass: Arc<dyn ProxyBypassStore>,
    instance_id: String,
    current: Mutex<SystemProxyStatus>,
    pub listeners: EventHub,
    queue: tokio::sync::Mutex<()>,
    /// Latched by the network detector (3D slice); read by handle_network_up.
    #[allow(dead_code)]
    network_resume_pending: AtomicBool,
}

// init/verify_integrity/network handlers/restore_before_kernel_unavailable
// are invoked by startup, the 30s guard, the network detector and the kernel
// shutdown path (3D wiring; the dispatch arms cover enable/disable/bypass).
#[allow(dead_code)]
impl SystemProxyService {
    pub fn new(
        adapter: Arc<dyn SystemProxyAdapter>,
        probe: ProbeFn,
        backup: Arc<dyn BackupStore>,
        bypass: Arc<dyn ProxyBypassStore>,
        instance_id: String,
    ) -> Self {
        let supported = adapter.supported();
        SystemProxyService {
            adapter,
            probe,
            backup,
            bypass,
            instance_id,
            current: Mutex::new(SystemProxyStatus {
                supported,
                phase: if supported { "disabled" } else { "unsupported" }.to_string(),
                updated_at: Some(now_iso()),
                ..Default::default()
            }),
            listeners: EventHub::new(),
            queue: tokio::sync::Mutex::new(()),
            network_resume_pending: AtomicBool::new(false),
        }
    }

    pub fn get_status(&self) -> SystemProxyStatus {
        self.current.lock().expect("system-proxy status poisoned").clone()
    }

    pub fn get_status_value(&self) -> Value {
        serde_json::to_value(self.get_status()).expect("status serializes")
    }

    fn transition(&self, phase: &str, mut extra: SystemProxyStatus) -> SystemProxyStatus {
        extra.supported = self.adapter.supported();
        extra.phase = phase.to_string();
        extra.updated_at = Some(now_iso());
        *self.current.lock().expect("system-proxy status mutex poisoned") = extra.clone();
        let value = serde_json::to_value(&extra).expect("status serializes");
        self.listeners.emit(&value);
        extra
    }

    fn fail(
        &self,
        phase: &str,
        error_code: &'static str,
        message: &str,
        conflict_detail: Option<String>,
    ) -> IpcError {
        self.transition(
            phase,
            SystemProxyStatus {
                error_message: Some(message.to_string()),
                conflict_detail,
                ..Default::default()
            },
        );
        IpcError::code(error_code, message)
    }

    /// Recover any orphan bundle left by a previous crash. Called once at
    /// startup before IPC is exposed. A corrupt / schema-mismatched backup
    /// cannot be trusted to restore the original values — fail closed: refuse
    /// to guess and do not touch the registry.
    pub async fn init(&self) -> SystemProxyStatus {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() {
            return self.transition("unsupported", SystemProxyStatus::default());
        }
        let backup = match self.backup.read().await {
            Ok(backup) => backup,
            Err(_) => {
                return self.transition("disabled", error_status("系统代理备份无效，请手动恢复"))
            }
        };
        let Some(backup_value) = backup else {
            return self.transition("disabled", SystemProxyStatus::default());
        };
        let backup = match parse_system_proxy_backup(&backup_value) {
            Ok(backup) => backup,
            Err(_) => {
                return self.transition("disabled", error_status("系统代理备份无效，请手动恢复"))
            }
        };
        let observed = match self.adapter.read().await {
            Ok(observed) => observed,
            Err(_) => {
                return self.transition("disabled", error_status("系统代理注册表读取失败，请手动检查"))
            }
        };
        if !can_restore_backup(&observed, &backup) {
            return self.transition(
                "conflict",
                status_extra(CONFLICT_MSG, Some(conflict_detail(&observed, &backup.written))),
            );
        }
        self.transition("restoring", SystemProxyStatus::default());
        self.restore_backup(backup).await
    }

    /// Enable (serialized): kernel gate → owned-bundle reconciliation → fresh
    /// enable with read-back verification.
    pub async fn enable(&self) -> Result<SystemProxyStatus, IpcError> {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() {
            return Err(self.fail("unsupported", code::SYSTEM_PROXY_UNSUPPORTED, NOT_SUPPORTED_MSG, None));
        }

        // Kernel / controller gate — the proxy may only point at a live listener.
        let target = match (self.probe)().await {
            Ok(target) => target,
            Err(error) => {
                let (error_code, _) = error.parts();
                if error_code == code::SYSTEM_PROXY_KERNEL_REQUIRED {
                    self.transition("disabled", error_status("请先启动内核"));
                    return Err(IpcError::code(
                        code::SYSTEM_PROXY_KERNEL_REQUIRED,
                        "请先启动内核后再启用系统代理",
                    ));
                }
                return Err(error);
            }
        };
        validate_target(&target)?;

        // An existing owned bundle: either we are already enabled (idempotent),
        // we own a stale bundle from a previous session, or the OS values were
        // mutated externally (conflict — never overwrite).
        let existing_backup = self.read_backup_for_ownership().await?;
        if let Some(backup) = existing_backup {
            let observed = self.adapter.read().await?;
            let same_target = backup.target == target;
            if is_owned(&observed, &backup.written) && same_target {
                return Ok(self.transition(
                    "enabled",
                    enabled_status(
                        format_address(&backup.target),
                        backup.target.port,
                        backup.written.proxy_override.value.as_str().unwrap_or_default().to_string(),
                    ),
                ));
            }
            // A stale bundle means the previous session ended inside the crash
            // window. The registry then shows one of three SELF-owned shapes —
            // each a self-recovery, never an external edit to fight. What is
            // genuinely EXTERNAL is a different proxy server (another tool's
            // takeover) — that alone surfaces a conflict, fail-closed.
            if can_restore_backup(&observed, &backup) {
                self.transition("restoring", SystemProxyStatus::default());
                self.restore_backup_strict(&backup).await?;
            } else {
                let detail = conflict_detail(&observed, &backup.written);
                return Err(self.fail("conflict", code::SYSTEM_PROXY_STATE_CONFLICT, CONFLICT_MSG, Some(detail)));
            }
        }

        // Fresh enable: snapshot the pre-enable registry, persist the owned
        // bundle BEFORE applying so a crash mid-apply is recoverable next
        // launch. Refuse up front if the pre-enable state holds a value we
        // could not faithfully restore — never enable on an un-restorable state.
        let observed = self.adapter.read().await?;
        validate_restorable(&observed)?;
        let policy = self.bypass.read().await;
        let written = build_written_state(&target, &observed, &policy);
        let bundle = SystemProxyBackup {
            instance_id: self.instance_id.clone(),
            created_at: now_iso(),
            target,
            previous: observed,
            written: written.clone(),
        };
        if self.backup.write(&backup_to_value(&bundle)).await.is_err() {
            return Err(self.fail(
                "disabled",
                code::SYSTEM_PROXY_ENABLE_FAILED,
                "无法写入系统代理备份，未应用更改",
                None,
            ));
        }

        self.transition("enabling", SystemProxyStatus::default());
        if let Err(_apply_error) = self.apply_and_verify(&written).await {
            // `apply` may have written a subset before failing (a `reg add`
            // sequence that dies part-way), so always attempt a CONFIRMED
            // restore. A rollback failure is surfaced as restore-failed, never
            // swallowed into `disabled`.
            if self.restore_backup_strict(&bundle).await.is_err() {
                return Err(self.fail(
                    "restore-failed",
                    code::SYSTEM_PROXY_RESTORE_FAILED,
                    "系统代理启用失败且无法还原，已保留备份",
                    None,
                ));
            }
            return Err(self.fail(
                "disabled",
                code::SYSTEM_PROXY_ENABLE_FAILED,
                "系统代理启用失败，已还原",
                None,
            ));
        }

        Ok(self.transition(
            "enabled",
            enabled_status(
                format_address(&bundle.target),
                bundle.target.port,
                written.proxy_override.value.as_str().unwrap_or_default().to_string(),
            ),
        ))
    }

    /// Disable (safe, non-throwing restore): the exact-restore guarantee — the
    /// original values go back verbatim, including absence.
    pub async fn disable(&self) -> Result<SystemProxyStatus, IpcError> {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() {
            return Err(self.fail("unsupported", code::SYSTEM_PROXY_UNSUPPORTED, NOT_SUPPORTED_MSG, None));
        }
        let backup = self
            .backup
            .read()
            .await
            .map_err(|_| IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "系统代理备份无效"))?;
        let Some(backup_value) = backup else {
            return Ok(self.transition("disabled", SystemProxyStatus::default()));
        };
        let backup = parse_system_proxy_backup(&backup_value)
            .map_err(|_| IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "系统代理备份无效"))?;
        self.transition("restoring", SystemProxyStatus::default());
        self.restore_backup(backup).await;
        Ok(self.get_status())
    }

    pub async fn get_proxy_bypass(&self) -> Value {
        let _guard = self.queue.lock().await;
        self.bypass.read().await.to_value()
    }

    pub async fn preview_proxy_bypass(&self, input: &ProxyBypassPolicy) -> String {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() {
            return resolve_proxy_override(input, None);
        }
        let observed = match self.adapter.read().await {
            Ok(observed) => observed,
            // We cannot read the current override, so fall back to a preview
            // that only reflects the policy + local entries.
            Err(_) => return resolve_proxy_override(input, None),
        };
        resolve_proxy_override(input, observed.proxy_override.value.as_str())
    }

    pub async fn set_proxy_bypass(&self, policy: ProxyBypassPolicy) -> Result<Value, IpcError> {
        let _guard = self.queue.lock().await;
        self.bypass
            .write(policy.clone())
            .await
            .map_err(|_| IpcError::internal("无法写入系统代理策略，请重试"))?;
        // If the system proxy is currently enabled and we still own it,
        // re-apply the new ProxyOverride live so the edit takes effect
        // immediately; a conflict is treated as safe (the OS value is no longer
        // ours) and never overwritten.
        if self.adapter.supported() && self.get_status().phase == "enabled" {
            if let Some(backup) = self.read_backup_for_ownership().await? {
                let observed = self.adapter.read().await?;
                if !is_owned(&observed, &backup.written) {
                    let detail = conflict_detail(&observed, &backup.written);
                    let mut extra = status_extra(CONFLICT_MSG, Some(detail));
                    extra.proxy_override =
                        observed.proxy_override.value.as_str().map(str::to_string);
                    self.transition("conflict", extra);
                    return Ok(policy.to_value());
                }
                let written = build_written_state(&backup.target, &observed, &policy);
                // Best-effort live application: a failure leaves the disk
                // policy authoritative for the next enable.
                let _ = self.adapter.apply(&written).await;
                let _ = self.adapter.refresh().await;
            }
        }
        Ok(policy.to_value())
    }

    /// The 30s runtime guard: sweep re-applies our exact written values;
    /// anything we do not own is left untouched (an external takeover must
    /// never be fought). Best-effort by contract: never throws.
    pub async fn verify_integrity(&self) -> &'static str {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() || self.get_status().phase != "enabled" {
            return "idle";
        }
        let backup = match self.read_backup_for_ownership().await {
            Ok(backup) => backup,
            Err(_) => return "conflict",
        };
        let Some(backup) = backup else {
            return "idle";
        };
        let observed = match self.adapter.read().await {
            Ok(observed) => observed,
            Err(_) => return "repair-failed",
        };
        let written = &backup.written;
        if observed.proxy_enable.value == written.proxy_enable.value
            && observed.proxy_server.value == written.proxy_server.value
            && observed.proxy_override.value == written.proxy_override.value
        {
            return "ok";
        }
        // Degradation (ProxyServer still aims at OUR listener) is exactly the
        // breakage the guard exists to repair. Takeover (a different proxy
        // server was written) is another tool's ownership — never fought.
        let still_aiming_at_us = observed.proxy_server.value == written.proxy_server.value;
        if !still_aiming_at_us {
            self.transition(
                "conflict",
                status_extra(CONFLICT_MSG, Some(conflict_detail(&observed, written))),
            );
            return "conflict";
        }
        match self.apply_and_verify(written).await {
            Ok(()) => "repaired",
            Err(_) => "repair-failed",
        }
    }

    /// Network went down (detector): turn off an owned proxy so the OS stops
    /// routing HTTP into a listener that cannot reach anywhere, and latch the
    /// intent so {@link handle_network_up} re-enables it.
    pub async fn handle_network_down(&self) -> &'static str {
        let _guard = self.queue.lock().await;
        let phase = self.get_status().phase;
        if !self.adapter.supported() || (phase != "enabled" && phase != "restore-failed") {
            return "idle";
        }
        let backup = match self.backup.read().await {
            Ok(backup) => backup,
            Err(_) => return "failed",
        };
        let Some(backup_value) = backup else {
            return "idle";
        };
        let Ok(backup) = parse_system_proxy_backup(&backup_value) else {
            return "failed";
        };
        // Latch the user's pre-outage intent before the first restore attempt.
        self.network_resume_pending.store(true, Ordering::SeqCst);
        self.transition("restoring", SystemProxyStatus::default());
        if self.restore_backup_strict(&backup).await.is_err() {
            self.transition("restore-failed", error_status("系统代理还原失败"));
            return "failed";
        }
        self.transition("disabled", SystemProxyStatus::default());
        "disabled"
    }

    /// Network came back (detector): re-enable the proxy
    /// {@link handle_network_down} turned off. Deliberately NOT inside the
    /// serialized queue — `enable` serializes itself and must enqueue after
    /// this check, so the pending flag flip and the re-enable never deadlock.
    pub async fn handle_network_up(&self) -> &'static str {
        if !self.network_resume_pending.swap(false, Ordering::SeqCst) {
            return "idle";
        }
        match self.enable().await {
            Ok(_) => "reenabled",
            Err(_) => {
                // The re-enable can legitimately fail while the kernel is still
                // coming back up. Keep the pending flag so the next detector
                // tick retries instead of giving up after one early attempt.
                self.network_resume_pending.store(true, Ordering::SeqCst);
                "failed"
            }
        }
    }

    /// Restore the owned bundle in preparation for the kernel becoming
    /// unavailable (a user stop, app shutdown, or a crash). A conflict is
    /// treated as safe — the proxy no longer points at us — while a genuine
    /// restore failure is surfaced so the caller never silently stops the
    /// kernel and leaves a dead-port proxy.
    pub async fn restore_before_kernel_unavailable(&self) -> Result<(), IpcError> {
        let _guard = self.queue.lock().await;
        if !self.adapter.supported() {
            return Ok(());
        }
        let backup = match self.backup.read().await {
            Ok(backup) => backup,
            Err(_) => {
                self.transition("conflict", error_status("系统代理备份无效，请手动恢复"));
                return Err(IpcError::code(
                    code::SYSTEM_PROXY_RESTORE_FAILED,
                    "系统代理备份无效，无法安全停止内核",
                ));
            }
        };
        let Some(backup_value) = backup else {
            return Ok(());
        };
        let backup = parse_system_proxy_backup(&backup_value).map_err(|_| {
            IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "系统代理备份无效，无法安全停止内核")
        })?;
        let observed = self.adapter.read().await?;
        if !can_restore_backup(&observed, &backup) {
            // Another server took over. Never fought; reported as a conflict.
            self.transition(
                "conflict",
                status_extra(CONFLICT_MSG, Some(conflict_detail(&observed, &backup.written))),
            );
            return Ok(());
        }
        self.transition("restoring", SystemProxyStatus::default());
        if self.restore_backup_strict(&backup).await.is_err() {
            self.transition("restore-failed", error_status("系统代理还原失败"));
            return Err(IpcError::code(
                code::SYSTEM_PROXY_RESTORE_FAILED,
                "系统代理还原失败，内核停止已中止",
            ));
        }
        self.transition("disabled", SystemProxyStatus::default());
        Ok(())
    }

    // ---- internals ---------------------------------------------------------

    /// Strict restore: restore → refresh → read-back verify → delete-on-success.
    /// A verify mismatch KEEPS the bundle so a later retry / crash recovery
    /// still has the original values.
    async fn restore_backup_strict(&self, backup: &SystemProxyBackup) -> Result<(), IpcError> {
        self.adapter.restore(&backup.previous).await?;
        self.adapter.refresh().await?;
        let readback = self.adapter.read().await?;
        if !matches_previous(&readback, &backup.previous) {
            return Err(IpcError::internal("restore read-back mismatch"));
        }
        let _ = self.backup.delete().await;
        Ok(())
    }

    /// Safe (non-throwing) variant used by init.
    async fn restore_backup(&self, backup: SystemProxyBackup) -> SystemProxyStatus {
        match self.restore_backup_strict(&backup).await {
            Ok(()) => self.transition("disabled", SystemProxyStatus::default()),
            Err(_) => self.transition("restore-failed", error_status("系统代理还原失败")),
        }
    }

    /// Apply → refresh → read-back ownership verification.
    async fn apply_and_verify(&self, written: &WrittenState) -> Result<(), IpcError> {
        self.adapter.apply(written).await?;
        self.adapter.refresh().await?;
        let readback = self.adapter.read().await?;
        if !is_owned(&readback, written) {
            return Err(IpcError::internal("read-back mismatch after apply"));
        }
        Ok(())
    }

    async fn read_backup_for_ownership(&self) -> Result<Option<SystemProxyBackup>, IpcError> {
        // A corrupt backup on enable fails closed (can't guarantee restore),
        // rather than enabling on top of an un-restorable state.
        let backup = self
            .backup
            .read()
            .await
            .map_err(|_| IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "系统代理备份无效，无法启用"))?;
        match backup {
            Some(value) => parse_system_proxy_backup(&value)
                .map(Some)
                .map_err(|_| IpcError::code(code::SYSTEM_PROXY_RESTORE_FAILED, "系统代理备份无效，无法启用")),
            None => Ok(None),
        }
    }
}

fn enabled_status(address: String, port: u16, proxy_override: String) -> SystemProxyStatus {
    SystemProxyStatus {
        address: Some(address),
        port: Some(port),
        proxy_override: Some(proxy_override),
        ..Default::default()
    }
}

fn status_extra(error_message: &str, conflict_detail: Option<String>) -> SystemProxyStatus {
    SystemProxyStatus {
        error_message: Some(error_message.to_string()),
        conflict_detail,
        ..Default::default()
    }
}

fn error_status(message: &str) -> SystemProxyStatus {
    SystemProxyStatus { error_message: Some(message.to_string()), ..Default::default() }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// UTC now as `YYYY-MM-DDTHH:MM:SS.mmmZ` (the JS `new Date().toISOString()`).
pub fn now_iso() -> String {
    let duration =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let millis_total = duration.as_millis() as i64;
    let secs = millis_total.div_euclid(1000);
    let millis = millis_total.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let seconds_of_day = secs.rem_euclid(86400);
    // Howard Hinnant's civil_from_days: days-since-epoch → (y, m, d).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60
    )
}

// ---------------------------------------------------------------------------
// Windows adapter helpers (system-proxy/adapters/windows-helpers.ts)
// ---------------------------------------------------------------------------

pub const WIN_INTERNET_SETTINGS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
pub const PROXY_ENABLE_VALUE: &str = "ProxyEnable";
pub const PROXY_SERVER_VALUE: &str = "ProxyServer";
pub const PROXY_OVERRIDE_VALUE: &str = "ProxyOverride";
const REGISTRY_READ_ATTEMPTS: u32 = 3;
const REGISTRY_READ_RETRY_MS: u64 = 75;

/// `reg` argv for restoring one value at its EXACT original type (`reg add` per
/// type, or `reg delete` when the pre-enable state had the value absent).
pub fn reg_add_args_for(value_name: &str, value: &RegistryValue) -> Result<Vec<String>, IpcError> {
    if !value.exists {
        return Ok(vec![
            "delete".to_string(),
            WIN_INTERNET_SETTINGS_KEY.to_string(),
            "/v".to_string(),
            value_name.to_string(),
            "/f".to_string(),
        ]);
    }
    let kind = value.kind.as_str();
    let type_label = match kind {
        "REG_DWORD" | "REG_SZ" | "REG_EXPAND_SZ" | "REG_BINARY" => kind,
        // A type we cannot faithfully restore should never reach this point:
        // the controller validates restorability before it writes anything.
        // Guard so a future caller cannot silently corrupt a value.
        _ => {
            return Err(IpcError::internal(format!(
                "unsupported registry type for restore: {kind}"
            )))
        }
    };
    let data = match &value.value {
        Value::Number(number) => number.to_string(),
        Value::String(string) => string.clone(),
        _ => return Err(IpcError::internal(format!("invalid {kind} payload"))),
    };
    Ok(vec![
        "add".to_string(),
        WIN_INTERNET_SETTINGS_KEY.to_string(),
        "/v".to_string(),
        value_name.to_string(),
        "/t".to_string(),
        type_label.to_string(),
        "/d".to_string(),
        data,
        "/f".to_string(),
    ])
}

/// The canonical .NET registry-read script, byte-for-byte from
/// `REGISTRY_READ_SCRIPT` (shared with the standalone recovery helper): reads
/// the three HKCU values a single time via `[Microsoft.Win32.Registry]`, never
/// expands environment names, and emits one JSON object on stdout.
pub const REGISTRY_READ_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$keyPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$names = @('ProxyEnable', 'ProxyServer', 'ProxyOverride')
$subKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
if ($null -eq $subKey) {
  [Console]::Error.WriteLine('could not open the Internet Settings subkey: ' + $keyPath)
  exit 3
}
$presentNames = @($subKey.GetValueNames())
$snapshot = [ordered]@{}
foreach ($name in $names) {
  if ($presentNames -notcontains $name) {
    $snapshot[$name] = @{ exists = $false; type = 'none'; value = $null }
    continue
  }
  $kind = $subKey.GetValueKind($name)
  $type = switch ([string]$kind) {
    'String'       { 'REG_SZ' }
    'ExpandString' { 'REG_EXPAND_SZ' }
    'MultiString'  { 'REG_MULTI_SZ' }
    'Binary'       { 'REG_BINARY' }
    'DWord'        { 'REG_DWORD' }
    'QWord'        { 'REG_QWORD' }
    default        { throw ('unknown registry value kind: ' + [string]$kind + ' for ' + $name) }
  }
  $raw = $subKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $raw) {
    $value = ''
  } else {
    $value = switch ($type) {
      'REG_DWORD'    { [int64]$raw }
      'REG_QWORD'    { [int64]$raw }
      'REG_BINARY'   { ([System.BitConverter]::ToString([byte[]]$raw) -replace '-', '') }
      'REG_MULTI_SZ' { ([string[]]$raw) -join ';' }
      default        { [string]$raw }
    }
  }
  $snapshot[$name] = @{ exists = $true; type = $type; value = $value }
}
$snapshot | ConvertTo-Json -Depth 5 -Compress
"#;

/// The canonical WinINet refresh script (byte-for-byte): `InternetSetOption`
/// SETTINGS_CHANGED (39) then REFRESH (37), each failure exiting non-zero so the
/// adapter treats the refresh as failed and can trigger a rollback.
pub const WIN_INET_REFRESH_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
if (-not ('SystemProxy.WinInet' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace SystemProxy {
  public static class WinInet {
    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
  }
}
'@
}
$b1 = [SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
if (-not $b1) {
  $e1 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error ('InternetSetOption(INTERNET_OPTION_SETTINGS_CHANGED) failed; last-error={0}' -f $e1)
  exit 2
}
$b2 = [SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
if (-not $b2) {
  $e2 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error ('InternetSetOption(INTERNET_OPTION_REFRESH) failed; last-error={0}' -f $e2)
  exit 2
}
exit 0
"#;

/// Strictly coerce the registry-read script's JSON stdout. Fail-closed (P1-1):
/// a malformed or structurally inconsistent entry is a read failure, never
/// silently coerced to a phantom value.
pub fn coerce_registry_snapshot(stdout: &str) -> Result<RegistryState, String> {
    let parsed: Value =
        serde_json::from_str(stdout).map_err(|error| format!("注册表快照不是有效 JSON：{error}"))?;
    let object = parsed.as_object().ok_or_else(|| "注册表快照不是 JSON 对象".to_string())?;
    Ok(RegistryState {
        proxy_enable: coerce_registry_value(object.get("ProxyEnable").unwrap_or(&Value::Null), "ProxyEnable")?,
        proxy_server: coerce_registry_value(object.get("ProxyServer").unwrap_or(&Value::Null), "ProxyServer")?,
        proxy_override: coerce_registry_value(
            object.get("ProxyOverride").unwrap_or(&Value::Null),
            "ProxyOverride",
        )?,
    })
}

fn coerce_registry_value(raw: &Value, name: &str) -> Result<RegistryValue, String> {
    let Some(object) = raw.as_object() else {
        return Err(format!("注册表快照缺少 {name}"));
    };
    let Some(exists) = object.get("exists").and_then(Value::as_bool) else {
        return Err(format!("注册表快照 {name}.exists 无效"));
    };
    if !exists {
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        let value_null = object.get("value").map(Value::is_null).unwrap_or(false);
        if kind != "none" || !value_null {
            return Err(format!("注册表快照 {name} 缺失但内容不一致"));
        }
        return Ok(RegistryValue::absent());
    }
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return Err(format!("注册表快照 {name}.type 无效"));
    };
    if kind == "none" || !REGISTRY_VALUE_TYPES.contains(&kind) {
        return Err(format!("注册表快照 {name}.type 无效"));
    }
    let value = object.get("value").cloned().unwrap_or(Value::Null);
    if is_numeric_registry_type(kind) {
        if value.as_f64().is_none() {
            return Err(format!("注册表快照 {name} 不是有效的 {kind} 数值"));
        }
        return Ok(RegistryValue { exists: true, kind: kind.to_string(), value });
    }
    if value.as_str().is_none() {
        return Err(format!("注册表快照 {name} 不是有效的 {kind} 字符串"));
    }
    Ok(RegistryValue { exists: true, kind: kind.to_string(), value })
}

/// The command runner result (the TS `RunResult`).
#[derive(Debug, Clone)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub type WindowsRunner = Arc<dyn Fn(&'static str, Vec<String>) -> BoxFuture<'static, Result<RunResult, String>> + Send + Sync>;

/// Unreachable off-windows: the factory never composes the Windows adapter on
/// a non-win32 host (the disabled adapter owns those platforms).
#[cfg(not(windows))]
pub fn real_command_runner() -> WindowsRunner {
    Arc::new(move |_command: &'static str, _args: Vec<String>| {
        Box::pin(async move { Err("reg.exe is only available on Windows".to_string()) })
    })
}

/// The production runner (the TS defaultRunner): `execFile`-equivalent with a
/// 5s timeout and CREATE_NO_WINDOW. Transport failures (command not found /
/// timeout) surface as Err so the caller sees a typed error instead of a
/// phantom "value absent"; non-zero exits return Ok with the exit code.
#[cfg(windows)]
pub fn real_command_runner() -> WindowsRunner {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DEFAULT_TIMEOUT_MS: u64 = 5000;
    Arc::new(move |command: &'static str, args: Vec<String>| {
        Box::pin(async move {
            let mut cmd = std::process::Command::new(command);
            cmd.args(&args).creation_flags(CREATE_NO_WINDOW);
            let output = tokio::time::timeout(
                std::time::Duration::from_millis(DEFAULT_TIMEOUT_MS),
                cmd.output(),
            )
            .await
            .map_err(|_| "command timed out".to_string())?
            .map_err(|error| format!("{error}"))?;
            Ok(RunResult {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                code: output.status.code().unwrap_or(0),
            })
        })
    })
}

/// The Windows system-proxy adapter: owns the three HKCU Internet Settings
/// values on the current user via `reg.exe`, then tells WinINet to re-read
/// them. Only ever instantiated on `win32` production builds; the runner is
/// injectable so the argv/script layer is testable on any platform.
pub struct WindowsSystemProxyAdapter {
    run: WindowsRunner,
}

impl WindowsSystemProxyAdapter {
    pub fn with_runner(run: WindowsRunner) -> Self {
        WindowsSystemProxyAdapter { run }
    }

    /// Run a command and surface a non-zero exit / transport error as a typed error.
    async fn run_checked(
        &self,
        command: &'static str,
        args: Vec<String>,
        error_code: &'static str,
        message: &str,
    ) -> Result<RunResult, IpcError> {
        let result = self
            .run
            .clone()(command, args)
            .await
            .map_err(|transport| IpcError::code(error_code, format!("{message}：{transport}")))?;
        if result.code != 0 {
            let detail = if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                format!("exit {}", result.code)
            };
            return Err(IpcError::code(error_code, format!("{message}：{detail}")));
        }
        Ok(result)
    }

    async fn read_registry_snapshot(&self) -> Result<RegistryState, IpcError> {
        let mut diagnostics: Vec<String> = Vec::new();
        for attempt in 1..=REGISTRY_READ_ATTEMPTS {
            let result = self
                .run_checked(
                    "powershell",
                    vec![
                        "-NoProfile".to_string(),
                        "-NonInteractive".to_string(),
                        "-Command".to_string(),
                        REGISTRY_READ_SCRIPT.to_string(),
                    ],
                    code::SYSTEM_PROXY_ENABLE_FAILED,
                    "解析系统代理注册表快照失败",
                )
                .await;
            match result {
                Ok(result) => match coerce_registry_snapshot(&result.stdout) {
                    Ok(snapshot) => return Ok(snapshot),
                    Err(message) => diagnostics.push(message),
                },
                Err(error) => diagnostics.push(error.0),
            }
            if attempt < REGISTRY_READ_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(
                    REGISTRY_READ_RETRY_MS * attempt as u64,
                ))
                .await;
            }
        }
        Err(IpcError::code(
            code::SYSTEM_PROXY_ENABLE_FAILED,
            format!(
                "解析系统代理注册表快照失败（已重试 {REGISTRY_READ_ATTEMPTS} 次）：{}",
                diagnostics.join("；")
            ),
        ))
    }

    async fn restore_value(&self, value_name: &str, value: &RegistryValue) -> Result<(), IpcError> {
        let args = reg_add_args_for(value_name, value)?;
        self.run_checked(
            "reg.exe",
            args,
            code::SYSTEM_PROXY_RESTORE_FAILED,
            &format!("还原注册表项 {value_name} 失败"),
        )
        .await
        .map(|_| ())
    }
}

impl SystemProxyAdapter for WindowsSystemProxyAdapter {
    fn platform(&self) -> &'static str {
        "win32"
    }

    fn supported(&self) -> bool {
        true
    }

    fn read(&self) -> BoxFut<'_, RegistryState> {
        Box::pin(self.read_registry_snapshot())
    }

    fn apply(&self, written: &WrittenState) -> BoxFutUnit<'_> {
        let server = written.proxy_server.value.as_str().unwrap_or_default().to_string();
        let override_value = written.proxy_override.value.as_str().unwrap_or_default().to_string();
        let run = self.run.clone();
        Box::pin(async move {
            if server.is_empty() {
                return Err(IpcError::code(code::SYSTEM_PROXY_ENABLE_FAILED, "系统代理目标值无效"));
            }
            let reg_add = |value_name: &str, kind: &str, data: String| vec![
                "add".to_string(),
                WIN_INTERNET_SETTINGS_KEY.to_string(),
                "/v".to_string(),
                value_name.to_string(),
                "/t".to_string(),
                kind.to_string(),
                "/d".to_string(),
                data,
                "/f".to_string(),
            ];
            // The TS apply order: ProxyEnable → ProxyServer → ProxyOverride.
            let enable = run(
                "reg.exe",
                reg_add(PROXY_ENABLE_VALUE, "REG_DWORD", "1".to_string()),
            )
            .await
            .and_then(verify_exit);
            let enable = match enable {
                Ok(()) => (),
                Err(message) => return Err(IpcError::code(code::SYSTEM_PROXY_ENABLE_FAILED, format!("写入 ProxyEnable 失败：{message}"))),
            };
            let _ = enable;
            let server_result = run(
                "reg.exe",
                reg_add(PROXY_SERVER_VALUE, "REG_SZ", server),
            )
            .await
            .and_then(verify_exit);
            if let Err(message) = server_result {
                return Err(IpcError::code(code::SYSTEM_PROXY_ENABLE_FAILED, format!("写入 ProxyServer 失败：{message}")));
            }
            let override_result = run(
                "reg.exe",
                reg_add(PROXY_OVERRIDE_VALUE, "REG_SZ", override_value),
            )
            .await
            .and_then(verify_exit);
            if let Err(message) = override_result {
                return Err(IpcError::code(code::SYSTEM_PROXY_ENABLE_FAILED, format!("写入 ProxyOverride 失败：{message}")));
            }
            Ok(())
        })
    }

    fn restore(&self, previous: &RegistryState) -> BoxFutUnit<'_> {
        let proxy_enable = previous.proxy_enable.clone();
        let proxy_server = previous.proxy_server.clone();
        let proxy_override = previous.proxy_override.clone();
        Box::pin(async move {
            self.restore_value(PROXY_ENABLE_VALUE, &proxy_enable).await?;
            self.restore_value(PROXY_SERVER_VALUE, &proxy_server).await?;
            self.restore_value(PROXY_OVERRIDE_VALUE, &proxy_override).await?;
            Ok(())
        })
    }

    fn refresh(&self) -> BoxFutUnit<'_> {
        // The script exits non-zero (or throws) when either InternetSetOption
        // call failed, so a WinINet failure is surfaced and can trigger a rollback.
        Box::pin(async move {
            self.run_checked(
                "powershell",
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    WIN_INET_REFRESH_SCRIPT.to_string(),
                ],
                code::SYSTEM_PROXY_RESTORE_FAILED,
                "刷新 WinINet 代理设置失败",
            )
            .await
            .map(|_| ())
        })
    }
}

/// One exit-code check shared by the runner-backed apply steps: the caller
/// prefixes the typed message exactly once.
fn verify_exit(result: RunResult) -> Result<(), String> {
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim().to_string()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim().to_string()
        } else {
            format!("exit {}", result.code)
        };
        return Err(detail);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_with(
        adapter: Arc<dyn SystemProxyAdapter>,
        probe: ProbeFn,
    ) -> (SystemProxyService, Arc<FakeSystemProxyAdapter>) {
        let fake = if adapter.supported() {
            // The caller may pass the real fake; recover it for assertions by
            // building a fresh one for the shared handle below.
            Arc::new(FakeSystemProxyAdapter::new())
        } else {
            Arc::new(FakeSystemProxyAdapter::new())
        };
        let _ = adapter;
        let shared = fake.clone();
        let service = SystemProxyService::new(
            fake.clone(),
            probe,
            Arc::new(InMemoryBackupStore::new()),
            Arc::new(InMemoryBypassStore::new()),
            "test-instance".to_string(),
        );
        (service, shared)
    }

    fn test_service() -> (SystemProxyService, Arc<FakeSystemProxyAdapter>) {
        service_with(
            Arc::new(FakeSystemProxyAdapter::new()),
            static_probe(Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }),
        )
    }

    fn owned_state(target: &Target, proxy_override: &str) -> RegistryState {
        RegistryState {
            proxy_enable: RegistryValue::dword(1),
            proxy_server: RegistryValue::string(format_address(target)),
            proxy_override: RegistryValue::string(proxy_override),
        }
    }

    #[test]
    fn merge_proxy_override_preserves_dedups_and_local_first() {
        let original = "localhost;*.example.com;localhost;corp.internal";
        let merged = merge_proxy_override(Some(original));
        let entries: Vec<&str> = merged.split(';').collect();
        // Local entries first, OS entries preserved + de-duplicated.
        assert!(entries.starts_with(&["<local>", "localhost", "127.*"]));
        assert_eq!(entries.iter().filter(|e| **e == "localhost").count(), 1);
        assert!(entries.contains(&"*.example.com"));
        assert!(entries.contains(&"corp.internal"));
    }

    #[test]
    fn merge_local_bypass_appends_authoritative_customs() {
        let merged = merge_local_bypass(&["*.example.com".to_string(), "localhost".to_string()]);
        let entries: Vec<&str> = merged.split(';').collect();
        assert!(entries.starts_with(&["<local>", "localhost", "127.*"]));
        assert!(entries.contains(&"*.example.com"));
        assert_eq!(entries.iter().filter(|e| **e == "localhost").count(), 1);
    }

    #[test]
    fn resolve_proxy_override_by_policy_mode() {
        let enabled = ProxyBypassPolicy { enabled: true, custom_entries: vec!["*.corp".to_string()] };
        assert!(resolve_proxy_override(&enabled, Some("old.host")).contains("*.corp"));
        // Disabled policy preserves the OS value (never drops user entries).
        let disabled = ProxyBypassPolicy::empty();
        let resolved = resolve_proxy_override(&disabled, Some("old.host;extra"));
        assert!(resolved.contains("old.host") && resolved.contains("extra"));
        // No original → the mandatory list only.
        assert_eq!(resolve_proxy_override(&ProxyBypassPolicy::empty(), None), DEFAULT_LOCAL_BYPASS_ENTRIES.join(";"));
    }

    #[test]
    fn build_written_state_writes_dword_server_and_override() {
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7897 };
        let observed = RegistryState {
            proxy_enable: RegistryValue::absent(),
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::string("legacy.host"),
        };
        let policy = ProxyBypassPolicy { enabled: true, custom_entries: vec!["*.corp".to_string()] };
        let written = build_written_state(&target, &observed, &policy);
        assert_eq!(written.proxy_enable.kind, "REG_DWORD");
        assert_eq!(written.proxy_enable.value, json!(1));
        assert_eq!(written.proxy_server.kind, "REG_SZ");
        assert_eq!(written.proxy_server.value, json!("127.0.0.1:7897"));
        let override_value = written.proxy_override.value.as_str().unwrap();
        assert!(override_value.starts_with(DEFAULT_LOCAL_BYPASS_ENTRIES[0]));
        assert!(override_value.contains("*.corp"));
    }

    #[test]
    fn same_registry_value_is_type_strict() {
        assert!(same_registry_value(&RegistryValue::string("a"), &RegistryValue::string("a")));
        assert!(!same_registry_value(&RegistryValue::string("a"), &RegistryValue { kind: "REG_EXPAND_SZ".to_string(), ..RegistryValue::string("a") }));
        assert!(!same_registry_value(&RegistryValue::string("a"), &RegistryValue::absent()));
        assert!(same_registry_value(&RegistryValue::absent(), &RegistryValue::absent()));
        assert!(!same_registry_value(&RegistryValue::dword(1), &RegistryValue::string("1")));
    }

    #[test]
    fn differing_keys_and_conflict_detail_name_mutated_keys() {
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let written = owned_state(&target, DEFAULT_LOCAL_BYPASS_ENTRIES.join(";").as_str());
        let mut observed = written.clone();
        observed.proxy_enable = RegistryValue::dword(0);
        observed.proxy_override = RegistryValue::string("someone.else");
        let keys = differing_keys(&observed, &written);
        assert_eq!(keys, vec!["ProxyEnable", "ProxyOverride"]);
        assert!(!is_owned(&observed, &written));
        assert_eq!(conflict_detail(&observed, &written), "注册表项被外部修改：ProxyEnable、ProxyOverride");
        assert_eq!(conflict_detail(&written, &written), "");
    }

    #[test]
    fn validate_restorable_rejects_unrestorable_and_inconsistent() {
        let inconsistent = RegistryState {
            proxy_enable: RegistryValue { exists: false, kind: "REG_SZ".to_string(), value: json!("x") },
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::absent(),
        };
        assert!(validate_restorable(&inconsistent).is_err());
        let unrestorable = RegistryState {
            proxy_enable: RegistryValue { exists: true, kind: "REG_MULTI_SZ".to_string(), value: json!("a;b") },
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::absent(),
        };
        let message = validate_restorable(&unrestorable).unwrap_err().0;
        assert!(message.contains("REG_MULTI_SZ 无法安全还原"));
        assert!(message.contains("系统代理项 ProxyEnable"));
        let negative_dword = RegistryState {
            proxy_enable: RegistryValue { exists: true, kind: "REG_DWORD".to_string(), value: json!(-1) },
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::absent(),
        };
        assert_eq!(validate_restorable(&negative_dword).unwrap_err().0, "PROTOCOL_ERROR:SYSTEM_PROXY_ENABLE_FAILED::系统代理项 ProxyEnable 的数值无效");
        let string_dword = RegistryState {
            proxy_enable: RegistryValue { exists: true, kind: "REG_SZ".to_string(), value: json!(1) },
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::absent(),
        };
        assert!(validate_restorable(&string_dword).is_err());
    }

    #[test]
    fn validate_target_requires_loopback_and_valid_port() {
        assert!(validate_target(&Target { host: "0.0.0.0".to_string(), port: 7890 }).is_err());
        assert!(validate_target(&Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 0 }).is_err());
        assert!(validate_target(&Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 65535 }).is_ok());
    }

    #[test]
    fn can_restore_backup_accepts_all_self_owned_shapes() {
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let previous = RegistryState {
            proxy_enable: RegistryValue::absent(),
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::string("old.override"),
        };
        let written = owned_state(&target, DEFAULT_LOCAL_BYPASS_ENTRIES.join(";").as_str());
        let backup = SystemProxyBackup {
            instance_id: "i".to_string(),
            created_at: now_iso(),
            target: target.clone(),
            previous: previous.clone(),
            written: written.clone(),
        };
        // a) still aiming at OUR bundle target (enable on).
        assert!(can_restore_backup(&written, &backup));
        // b) already back at OUR pre-enable snapshot.
        assert!(can_restore_backup(&previous, &backup));
        // c) our server value with pieces flipped off inside our envelope.
        let degraded = RegistryState { proxy_enable: RegistryValue::dword(0), ..written.clone() };
        assert!(can_restore_backup(&degraded, &backup));
        // d) an external takeover is NOT restorable.
        let takeover = RegistryState {
            proxy_enable: RegistryValue::absent(),
            proxy_server: RegistryValue::string("8.8.8.8:3128"),
            proxy_override: RegistryValue::absent(),
        };
        assert!(!can_restore_backup(&takeover, &backup));
    }

    #[test]
    fn parse_proxy_bypass_policy_is_strict_with_zod_copies() {
        assert!(parse_proxy_bypass_policy(Some(&json!(null))).is_err());
        assert_eq!(
            parse_proxy_bypass_policy(Some(&json!(null))).unwrap_err().0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::proxy bypass policy must be an object"
        );
        let missing = json!({});
        assert!(parse_proxy_bypass_policy(Some(&missing)).unwrap_err().0.contains("at enabled: Required"));
        let no_entries = json!({ "enabled": true });
        assert!(parse_proxy_bypass_policy(Some(&no_entries)).unwrap_err().0.contains("at customEntries: Required"));
        let empty_entry = json!({ "enabled": true, "customEntries": ["   "] });
        assert!(parse_proxy_bypass_policy(Some(&empty_entry)).unwrap_err().0.contains("String must contain at least 1 character(s)"));
        let too_long = json!({ "enabled": true, "customEntries": ["x".repeat(256)] });
        assert!(parse_proxy_bypass_policy(Some(&too_long)).unwrap_err().0.contains("String must contain at most 255 character(s)"));
        let too_many = json!({ "enabled": true, "customEntries": (0..201).map(|i| format!("e{i}")).collect::<Vec<_>>() });
        assert!(parse_proxy_bypass_policy(Some(&too_many)).unwrap_err().0.contains("Array must contain at most 200 element(s)"));
        let good = json!({ "enabled": true, "customEntries": ["*.corp", " *.corp "] });
        let parsed = parse_proxy_bypass_policy(Some(&good)).unwrap();
        assert_eq!(parsed.custom_entries, vec!["*.corp", "*.corp"]);
    }

    #[test]
    fn coerce_proxy_bypass_policy_falls_back_field_independently() {
        let coerced = coerce_proxy_bypass_policy(&json!({ "enabled": "yes", "customEntries": [1, " keep ", "", {"x": 1}] }));
        assert!(!coerced.enabled);
        assert_eq!(coerced.custom_entries, vec!["keep"]);
        assert_eq!(coerce_proxy_bypass_policy(&json!("junk")), ProxyBypassPolicy::empty());
    }

    #[test]
    fn backup_schema_strictness() {
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let previous = RegistryState {
            proxy_enable: RegistryValue::absent(),
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::string("old"),
        };
        let backup = SystemProxyBackup {
            instance_id: "instance".to_string(),
            created_at: "2026-02-05T10:00:00.000Z".to_string(),
            target: target.clone(),
            previous: previous.clone(),
            written: owned_state(&target, "override"),
        };
        let value = backup_to_value(&backup);
        assert!(parse_system_proxy_backup(&value).is_ok());
        // Unknown top-level keys reject (zod .strict()).
        let mut unknown = value.clone();
        unknown["extra"] = json!(1);
        assert!(parse_system_proxy_backup(&unknown).is_err());
        // schemaVersion literal 1.
        let mut wrong_version = value.clone();
        wrong_version["schemaVersion"] = json!(2);
        assert!(parse_system_proxy_backup(&wrong_version).is_err());
        // createdAt must be an offset ISO datetime.
        let mut naive = value.clone();
        naive["createdAt"] = json!("2026-02-05T10:00:00");
        assert!(parse_system_proxy_backup(&naive).is_err());
        // Non-loopback host rejects.
        let mut foreign = value.clone();
        foreign["target"]["host"] = json!("192.168.1.1");
        assert!(parse_system_proxy_backup(&foreign).is_err());
        // Absent value must be exactly { none, null }.
        let mut inconsistent = value.clone();
        inconsistent["previous"]["proxyEnable"] = json!({ "exists": false, "type": "REG_SZ", "value": null });
        assert!(parse_system_proxy_backup(&inconsistent).is_err());
        // Present values may not be type none.
        let mut none_present = value.clone();
        none_present["previous"]["proxyEnable"] = json!({ "exists": true, "type": "none", "value": null });
        assert!(parse_system_proxy_backup(&none_present).is_err());
        // Numeric payloads must be non-negative safe integers.
        let mut huge = value.clone();
        huge["written"]["proxyEnable"]["value"] = json!(9_007_199_254_740_993u64);
        assert!(parse_system_proxy_backup(&huge).is_err());
        let mut float = value.clone();
        float["written"]["proxyEnable"]["value"] = json!(1.5);
        assert!(parse_system_proxy_backup(&float).is_err());
    }

    #[test]
    fn backup_store_round_trip_and_corrupt_rejection() {
        let dir = std::env::temp_dir().join(format!("murge-sysproxy-store-{}", std::process::id()));
        let store = FileSystemBackupStore::for_base_dir(&dir);
        // Missing file reads as None.
        let _ = std::fs::remove_dir_all(&dir);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            assert!(store.read().await.unwrap().is_none());
            let value = json!({ "schemaVersion": 1 });
            store.write(&value).await.unwrap();
            assert_eq!(store.read().await.unwrap(), Some(value));
            store.delete().await.unwrap();
            assert!(store.read().await.unwrap().is_none());
            // A corrupt file is an Err, never a phantom None.
            std::fs::create_dir_all(dir.join("system-proxy")).unwrap();
            std::fs::write(dir.join("system-proxy").join("owned-backup.json"), b"{nope").unwrap();
            assert!(store.read().await.is_err());
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_snapshot_coercion_strictness() {
        let valid = r#"{"ProxyEnable":{"exists":true,"type":"REG_DWORD","value":1},"ProxyServer":{"exists":true,"type":"REG_SZ","value":"127.0.0.1:7890"},"ProxyOverride":{"exists":false,"type":"none","value":null}}"#;
        let snapshot = coerce_registry_snapshot(valid).unwrap();
        assert_eq!(snapshot.proxy_enable.value, json!(1));
        assert!(!snapshot.proxy_override.exists);
        assert!(coerce_registry_snapshot("not json").is_err());
        assert!(coerce_registry_snapshot("{}").is_err().then(|| ()).is_some());
        let missing_exists = r#"{"ProxyEnable":{"type":"none","value":null},"ProxyServer":{"exists":false,"type":"none","value":null},"ProxyOverride":{"exists":false,"type":"none","value":null}}"#;
        assert!(coerce_registry_snapshot(missing_exists).is_err());
        let inconsistent_absent = r#"{"ProxyEnable":{"exists":false,"type":"REG_SZ","value":"x"},"ProxyServer":{"exists":false,"type":"none","value":null},"ProxyOverride":{"exists":false,"type":"none","value":null}}"#;
        assert!(coerce_registry_snapshot(inconsistent_absent).is_err());
    }

    #[test]
    fn iso_now_shape_matches_js_to_string() {
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
        assert!(is_iso_offset_datetime(&now));
    }

    #[tokio::test]
    async fn enable_happy_path_writes_backup_and_registry() {
        let (service, adapter) = test_service();
        let status = service.enable().await.unwrap();
        assert_eq!(status.phase, "enabled");
        assert_eq!(status.address.as_deref(), Some("127.0.0.1:7890"));
        assert_eq!(status.port, Some(7890));
        assert!(status.proxy_override.as_deref().unwrap().contains("<local>"));
        // The backup was persisted and the fake registry matches it.
        assert!(service.backup.read().await.unwrap().is_some());
        let observed = adapter.read().await.unwrap();
        assert!(is_owned(&observed, &owned_state(&Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }, status.proxy_override.as_deref().unwrap())));
        // Idempotent enable with the same target stays enabled.
        let again = service.enable().await.unwrap();
        assert_eq!(again.phase, "enabled");
    }

    #[tokio::test]
    async fn enable_kernel_required_transitions_disabled_with_message() {
        let (service, _adapter) = service_with(
            Arc::new(FakeSystemProxyAdapter::new()),
            Arc::new(|| {
                Box::pin(async move {
                    Err(IpcError::code(code::SYSTEM_PROXY_KERNEL_REQUIRED, "内核未运行，无法启用系统代理"))
                        as Result<Target, IpcError>
                })
            }),
        );
        let error = service.enable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_KERNEL_REQUIRED::请先启动内核后再启用系统代理");
        assert_eq!(service.get_status().phase, "disabled");
        assert_eq!(service.get_status().error_message.as_deref(), Some("请先启动内核"));
    }

    #[tokio::test]
    async fn enable_external_takeover_conflicts_fail_closed() {
        let (service, adapter) = test_service();
        // Pre-seed a backup whose written state points at another port, while
        // the registry holds a DIFFERENT tool's server (external takeover).
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let bundle = SystemProxyBackup {
            instance_id: service.instance_id.clone(),
            created_at: now_iso(),
            target: target.clone(),
            previous: RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::absent() },
            written: owned_state(&target, "ours"),
        };
        service.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(RegistryState {
            proxy_enable: RegistryValue::dword(1),
            proxy_server: RegistryValue::string("10.0.0.1:3128"),
            proxy_override: RegistryValue::string("ours"),
        });
        let error = service.enable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_STATE_CONFLICT::系统代理已被外部修改，未执行还原");
        assert_eq!(service.get_status().phase, "conflict");
        assert_eq!(
            service.get_status().conflict_detail.as_deref(),
            Some("注册表项被外部修改：ProxyServer")
        );
    }

    #[tokio::test]
    async fn stale_bundle_with_owned_shapes_self_recovers() {
        let (service, adapter) = test_service();
        let stale = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 17890 };
        let bundle = SystemProxyBackup {
            instance_id: service.instance_id.clone(),
            created_at: now_iso(),
            target: stale.clone(),
            previous: RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::string("old") },
            written: owned_state(&stale, "stale-override"),
        };
        service.backup.write(&backup_to_value(&bundle)).await.unwrap();
        // Shape (b): the restore finished but the delete was lost.
        adapter.set_registry(RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::string("old") });
        let status = service.enable().await.unwrap();
        assert_eq!(status.phase, "enabled");
        // The proxy now aims at the LIVE target, not the stale one.
        assert_eq!(status.address.as_deref(), Some("127.0.0.1:7890"));
        assert!(service.backup.read().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn enable_apply_failure_rolls_back_to_previous() {
        let (service, adapter) = test_service();
        adapter.fail_apply(true);
        let error = service.enable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_ENABLE_FAILED::系统代理启用失败，已还原");
        assert_eq!(service.get_status().phase, "disabled");
        // The rollback restored the pre-enable (absent) state and deleted the bundle.
        assert!(adapter.read().await.unwrap().proxy_server.kind == "none");
        assert!(service.backup.read().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn enable_rollback_failure_surfaces_restore_failed() {
        let (service, adapter) = test_service();
        adapter.fail_apply(true);
        adapter.fail_restore(true);
        let error = service.enable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_RESTORE_FAILED::系统代理启用失败且无法还原，已保留备份");
        assert_eq!(service.get_status().phase, "restore-failed");
        // The bundle survives for a later retry / crash recovery.
        assert!(service.backup.read().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn disable_restores_previous_and_deletes_bundle() {
        let (service, adapter) = test_service();
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let previous = RegistryState {
            proxy_enable: RegistryValue::absent(),
            proxy_server: RegistryValue::string("127.0.0.1:7899"),
            proxy_override: RegistryValue::string("user.entries"),
        };
        let bundle = SystemProxyBackup {
            instance_id: service.instance_id.clone(),
            created_at: now_iso(),
            target: target.clone(),
            previous: previous.clone(),
            written: owned_state(&target, DEFAULT_LOCAL_BYPASS_ENTRIES.join(";").as_str()),
        };
        service.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(owned_state(&target, DEFAULT_LOCAL_BYPASS_ENTRIES.join(";").as_str()));
        let status = service.disable().await.unwrap();
        assert_eq!(status.phase, "disabled");
        // The EXACT original values came back, including the old server.
        assert!(matches_previous(&adapter.read().await.unwrap(), &previous));
        assert!(service.backup.read().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn disable_without_bundle_is_cleanly_disabled() {
        let (service, _adapter) = test_service();
        let status = service.disable().await.unwrap();
        assert_eq!(status.phase, "disabled");
    }

    #[tokio::test]
    async fn unsupported_adapter_reports_the_phase() {
        let service = SystemProxyService::new(
            Arc::new(DisabledSystemProxyAdapter::new("linux")),
            static_probe(Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }),
            Arc::new(InMemoryBackupStore::new()),
            Arc::new(InMemoryBypassStore::new()),
            "i".to_string(),
        );
        let error = service.enable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_UNSUPPORTED::当前平台不支持系统代理");
        assert_eq!(service.get_status().phase, "unsupported");
        assert!(!service.get_status().supported);
        // Disable mirrors the same fail-closed path.
        let disable_error = service.disable().await.unwrap_err();
        assert_eq!(disable_error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_UNSUPPORTED::当前平台不支持系统代理");
        // init transitions to unsupported without touching anything.
        assert_eq!(service.init().await.phase, "unsupported");
        // Bypass reads still work (policy-only) and preview ignores the OS.
        assert_eq!(service.preview_proxy_bypass(&ProxyBypassPolicy::empty()).await, DEFAULT_LOCAL_BYPASS_ENTRIES.join(";"));
    }

    #[tokio::test]
    async fn init_recovers_owned_bundles_and_flags_conflicts() {
        // No bundle → disabled.
        let (clean, _) = test_service();
        assert_eq!(clean.init().await.phase, "disabled");
        // Corrupt backup → disabled + the manual-recovery message, registry untouched.
        let corrupt = SystemProxyService::new(
            Arc::new(FakeSystemProxyAdapter::new()),
            static_probe(Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }),
            Arc::new(CorruptBackupStore),
            Arc::new(InMemoryBypassStore::new()),
            "i".to_string(),
        );
        let status = corrupt.init().await;
        assert_eq!(status.phase, "disabled");
        assert_eq!(status.error_message.as_deref(), Some("系统代理备份无效，请手动恢复"));
        // External takeover while we held a bundle → conflict.
        let (conflicted, adapter) = test_service();
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let bundle = SystemProxyBackup {
            instance_id: "i".to_string(),
            created_at: now_iso(),
            target: target.clone(),
            previous: RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::absent() },
            written: owned_state(&target, "ours"),
        };
        conflicted.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(RegistryState {
            proxy_enable: RegistryValue::dword(1),
            proxy_server: RegistryValue::string("10.9.8.7:3128"),
            proxy_override: RegistryValue::string("ours"),
        });
        let status = conflicted.init().await;
        assert_eq!(status.phase, "conflict");
        assert_eq!(status.conflict_detail.as_deref(), Some("注册表项被外部修改：ProxyServer"));
        // Owned degradation → restored to the pre-enable snapshot, bundle deleted.
        let (recoverable, adapter) = test_service();
        let previous = RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::string("old") };
        let bundle = SystemProxyBackup {
            instance_id: "i".to_string(),
            created_at: now_iso(),
            target: Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 },
            previous: previous.clone(),
            written: owned_state(&target, "ours"),
        };
        recoverable.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(owned_state(&target, "ours"));
        let status = recoverable.init().await;
        assert_eq!(status.phase, "disabled");
        assert!(matches_previous(&adapter.read().await.unwrap(), &previous));
        assert!(recoverable.backup.read().await.unwrap().is_none());
    }

    struct CorruptBackupStore;

    impl BackupStore for CorruptBackupStore {
        fn read(&self) -> BoxResult<'_, Option<Value>> {
            Box::pin(async move { Err("corrupt".to_string()) })
        }
        fn write(&self, _backup: &Value) -> BoxUnit<'_> {
            Box::pin(async move { Err("corrupt".to_string()) })
        }
        fn delete(&self) -> BoxUnit<'_> {
            Box::pin(async move { Ok(()) })
        }
    }

    #[tokio::test]
    async fn bypass_round_trip_and_conflict_safe_set() {
        let (service, adapter) = test_service();
        // Read starts at the empty policy.
        assert_eq!(service.get_proxy_bypass().await, serde_json::to_value(ProxyBypassPolicy::empty()).unwrap());
        service.set_proxy_bypass(ProxyBypassPolicy { enabled: true, custom_entries: vec!["*.corp".to_string()] }).await.unwrap();
        assert_eq!(service.get_proxy_bypass().await["customEntries"][0], json!("*.corp"));
        // Enable, then a set while still owned re-applies the override live.
        service.enable().await.unwrap();
        let before = adapter.refresh_count();
        service.set_proxy_bypass(ProxyBypassPolicy { enabled: true, custom_entries: vec!["*.corp2".to_string()] }).await.unwrap();
        let observed = adapter.read().await.unwrap();
        assert!(observed.proxy_override.value.as_str().unwrap().contains("*.corp2"));
        assert!(adapter.refresh_count() > before);
        // A conflict (external edit) is treated as safe: policy persisted, phase flips.
        adapter.set_registry(RegistryState {
            proxy_enable: RegistryValue::dword(1),
            proxy_server: RegistryValue::string("10.0.0.1:3128"),
            proxy_override: RegistryValue::absent(),
        });
        let value = service.set_proxy_bypass(ProxyBypassPolicy { enabled: false, custom_entries: Vec::new() }).await.unwrap();
        assert_eq!(value["enabled"], json!(false));
        assert_eq!(service.get_status().phase, "conflict");
    }

    #[tokio::test]
    async fn verify_integrity_repairs_degradation_never_takeover() {
        let (service, adapter) = test_service();
        assert_eq!(service.verify_integrity().await, "idle");
        service.enable().await.unwrap();
        // Untouched → ok.
        assert_eq!(service.verify_integrity().await, "ok");
        // Degradation: proxy flipped off while OUR server stays → repaired.
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let owned = owned_state(&target, service.get_status().proxy_override.as_deref().unwrap());
        adapter.set_registry(RegistryState { proxy_enable: RegistryValue::dword(0), ..owned.clone() });
        assert_eq!(service.verify_integrity().await, "repaired");
        assert!(is_owned(&adapter.read().await.unwrap(), &owned));
        // Takeover: a different server → conflict, never fought.
        adapter.set_registry(RegistryState { proxy_enable: RegistryValue::dword(1), proxy_server: RegistryValue::string("9.9.9.9:3128"), proxy_override: RegistryValue::absent() });
        assert_eq!(service.verify_integrity().await, "conflict");
        assert_eq!(service.get_status().phase, "conflict");
    }

    #[tokio::test]
    async fn network_down_up_latches_and_restores() {
        let (service, adapter) = test_service();
        service.enable().await.unwrap();
        assert_eq!(service.handle_network_down().await, "disabled");
        assert_eq!(adapter.read().await.unwrap().proxy_enable.kind, "none");
        assert_eq!(service.get_status().phase, "disabled");
        // Up: re-enable succeeds with the kernel probe returning a live target.
        assert_eq!(service.handle_network_up().await, "reenabled");
        assert_eq!(service.get_status().phase, "enabled");
        // Up without a pending latch is idle.
        assert_eq!(service.handle_network_up().await, "idle");
        // Down with nothing owned is idle.
        let (fresh, _) = test_service();
        assert_eq!(fresh.handle_network_down().await, "idle");
    }

    #[tokio::test]
    async fn restore_before_kernel_unavailable_contract() {
        let (service, adapter) = test_service();
        service.enable().await.unwrap();
        service.restore_before_kernel_unavailable().await.unwrap();
        assert_eq!(service.get_status().phase, "disabled");
        assert!(adapter.read().await.unwrap().proxy_enable.kind == "none");
        // A conflict is safe (proxy no longer points at us): no error.
        let (conflicted, adapter) = test_service();
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let bundle = SystemProxyBackup {
            instance_id: "i".to_string(),
            created_at: now_iso(),
            target: target.clone(),
            previous: RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::absent() },
            written: owned_state(&target, "ours"),
        };
        conflicted.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(RegistryState { proxy_enable: RegistryValue::dword(1), proxy_server: RegistryValue::string("7.7.7.7:3128"), proxy_override: RegistryValue::absent() });
        conflicted.restore_before_kernel_unavailable().await.unwrap();
        assert_eq!(conflicted.get_status().phase, "conflict");
        // A genuine restore failure aborts the kernel stop with the copy.
        let (failing, adapter) = test_service();
        adapter.fail_restore(true);
        let bundle = SystemProxyBackup {
            instance_id: "i".to_string(),
            created_at: now_iso(),
            target,
            previous: RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::absent(), proxy_override: RegistryValue::absent() },
            written: owned_state(&Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }, "ours"),
        };
        failing.backup.write(&backup_to_value(&bundle)).await.unwrap();
        adapter.set_registry(owned_state(&Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 }, "ours"));
        let error = failing.restore_before_kernel_unavailable().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_RESTORE_FAILED::系统代理还原失败，内核停止已中止");
        assert_eq!(failing.get_status().phase, "restore-failed");
    }

    #[tokio::test]
    async fn status_events_fan_out_to_listeners() {
        let (service, _adapter) = test_service();
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        service.listeners.subscribe(Arc::new(move |value| {
            sink.lock().unwrap().push(value["phase"].as_str().unwrap_or_default().to_string());
        }));
        let _ = service.enable().await;
        let phases = events.lock().unwrap().clone();
        // The serialized enable passes through enabling → enabled.
        assert_eq!(phases, vec!["enabling".to_string(), "enabled".to_string()]);
    }

    #[tokio::test]
    async fn live_probe_rejects_when_kernel_or_port_not_ready() {
        // Kernel not running.
        let probe = live_probe(
            || "stopped".to_string(),
            || Err(IpcError::code(code::SYSTEM_PROXY_KERNEL_REQUIRED, "内核控制器未就绪，无法启用系统代理")),
        );
        let error = probe().await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:SYSTEM_PROXY_KERNEL_REQUIRED::内核未运行，无法启用系统代理");
        // Kernel running but the controller is dead.
        let probe = live_probe(
            || "running".to_string(),
            || Err(IpcError::code(code::SYSTEM_PROXY_KERNEL_REQUIRED, "内核控制器未就绪，无法启用系统代理")),
        );
        assert_eq!(
            probe().await.unwrap_err().0,
            "PROTOCOL_ERROR:SYSTEM_PROXY_KERNEL_REQUIRED::内核控制器未就绪，无法启用系统代理"
        );
        // Kernel running, controller live, but /configs is unreachable (the
        // client targets a dead port) → the controller-not-ready copy.
        // MihomoClient::new already returns Result<MihomoClient, IpcError>.
        let probe = live_probe(
            || "running".to_string(),
            || crate::mihomo::MihomoClient::new(1, ""),
        );
        // The dead controller port fails the version/config round trip.
        assert!(probe().await.is_err());
    }

    #[tokio::test]
    async fn socket_probes_validate_mixed_port_protocol_layers() {
        // A bare TCP listener speaks neither HTTP-proxy nor SOCKS5.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = dead.local_addr().unwrap().port();
        std::mem::forget(dead);
        assert!(probe_socks(port).await.is_err());
        assert!(probe_http(port).await.is_err());
        // A real SOCKS5+HTTP answering listener passes BOTH probes.
        let live = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = live.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in live.incoming() {
                let mut stream = stream.unwrap();
                std::thread::spawn(move || {
                    use std::io::{Read, Write};
                    let mut buffer = [0u8; 128];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    if read >= 3 && buffer[0] == 0x05 {
                        let _ = stream.write_all(&[0x05, 0x00]);
                        return;
                    }
                    if read > 0 && buffer.starts_with(b"CONNECT") {
                        let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
                    }
                    let _ = stream.flush();
                });
            }
        });
        assert_eq!(probe_socks(port).await, Ok(()));
        assert_eq!(probe_http(port).await, Ok(()));
    }

    #[test]
    fn http_status_line_matcher_matches_the_ts_regex() {
        assert!(matches_http_status_line(b"HTTP/1.1 200"));
        assert!(matches_http_status_line(b"HTTP/2 502"));
        assert!(matches_http_status_line(b"HTTP/1.0 403 rest"));
        assert!(matches_http_status_line(b"HTTP/1.1  502")); // \s+ allows several spaces
        assert!(!matches_http_status_line(b"HTT"));
        assert!(!matches_http_status_line(b"HTTP/x 502"));
        assert!(!matches_http_status_line(b"HTTP/1. 502"));
        assert!(!matches_http_status_line(b"HTTP/1.1x502"));
        assert!(!matches_http_status_line(b"HTTP/1.1 5"));
    }

    #[test]
    fn windows_adapter_argv_and_scripts_port_verbatim() {
        // reg add per original type; reg delete for an absent value.
        assert_eq!(
            reg_add_args_for("ProxyEnable", &RegistryValue::dword(1)).unwrap(),
            vec!["add", WIN_INTERNET_SETTINGS_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]
        );
        assert_eq!(
            reg_add_args_for("ProxyServer", &RegistryValue::string("127.0.0.1:7890")).unwrap(),
            vec!["add", WIN_INTERNET_SETTINGS_KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "127.0.0.1:7890", "/f"]
        );
        let expand = RegistryValue { exists: true, kind: "REG_EXPAND_SZ".to_string(), value: json!("%VAR%") };
        assert_eq!(
            reg_add_args_for("ProxyOverride", &expand).unwrap(),
            vec!["add", WIN_INTERNET_SETTINGS_KEY, "/v", "ProxyOverride", "/t", "REG_EXPAND_SZ", "/d", "%VAR%", "/f"]
        );
        assert_eq!(
            reg_add_args_for("ProxyServer", &RegistryValue::absent()).unwrap(),
            vec!["delete", WIN_INTERNET_SETTINGS_KEY, "/v", "ProxyServer", "/f"]
        );
        // MULTI_SZ can never be restored — the guard throws instead of corrupting.
        let multi = RegistryValue { exists: true, kind: "REG_MULTI_SZ".to_string(), value: json!("a;b") };
        assert!(reg_add_args_for("ProxyServer", &multi).is_err());
        // Scripts keep their exact anchors.
        assert!(REGISTRY_READ_SCRIPT.contains("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)"));
        assert!(REGISTRY_READ_SCRIPT.contains("DoNotExpandEnvironmentNames"));
        assert!(REGISTRY_READ_SCRIPT.contains("ConvertTo-Json -Depth 5 -Compress"));
        assert!(WIN_INET_REFRESH_SCRIPT.contains("InternetSetOption([IntPtr]::Zero, 39"));
        assert!(WIN_INET_REFRESH_SCRIPT.contains("InternetSetOption([IntPtr]::Zero, 37"));
    }

    #[tokio::test]
    async fn windows_adapter_applies_restores_and_parses_via_injected_runner() {
        use std::sync::atomic::AtomicUsize;
        let commands: Arc<Mutex<Vec<(String, Vec<String>)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = commands.clone();
        let snapshot = r#"{"ProxyEnable":{"exists":true,"type":"REG_DWORD","value":1},"ProxyServer":{"exists":true,"type":"REG_SZ","value":"127.0.0.1:7890"},"ProxyOverride":{"exists":false,"type":"none","value":null}}"#;
        let reads = Arc::new(AtomicUsize::new(0));
        let reads_sink = reads.clone();
        let snapshot_owned = snapshot.to_string();
        let run: WindowsRunner = Arc::new(move |command: &'static str, args: Vec<String>| {
            let sink = sink.clone();
            let reads = reads_sink.clone();
            let snapshot = snapshot_owned.clone();
            Box::pin(async move {
                sink.lock().unwrap().push((command.to_string(), args.clone()));
                if command == "powershell" {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok(RunResult { stdout: snapshot, stderr: String::new(), code: 0 })
                } else {
                    Ok(RunResult { stdout: String::new(), stderr: String::new(), code: 0 })
                }
            })
        });
        let adapter = WindowsSystemProxyAdapter::with_runner(run);
        let target = Target { host: SYSTEM_PROXY_LOOPBACK_HOST.to_string(), port: 7890 };
        let written = owned_state(&target, "override");
        adapter.apply(&written).await.unwrap();
        adapter.refresh().await.unwrap();
        let observed = adapter.read().await.unwrap();
        assert_eq!(observed.proxy_enable.value, json!(1));
        assert_eq!(observed.proxy_server.value, json!("127.0.0.1:7890"));
        // Apply order: enable → server → override, then the WinINet refresh.
        let commands_log = commands.lock().unwrap();
        assert_eq!(commands_log[0].0, "reg.exe");
        let value_names: Vec<&str> = commands_log
            .iter()
            .filter(|(command, _)| command == "reg.exe")
            .map(|(_, args)| args[3].as_str())
            .collect();
        assert_eq!(value_names, vec!["ProxyEnable", "ProxyServer", "ProxyOverride"]);
        assert_eq!(commands_log[3].0, "powershell");
        drop(commands_log);
        // Restore: the exact original types go back (delete for absent).
        adapter.restore(&RegistryState { proxy_enable: RegistryValue::absent(), proxy_server: RegistryValue::string("old:1"), proxy_override: RegistryValue::absent() }).await.unwrap();
        let all = commands.lock().unwrap();
        // The log: 3 apply reg adds, refresh powershell, read powershell, then
        // the 3 restore reg ops. Filter to the reg.exe ops after the apply.
        let restore_kinds: Vec<&str> = all
            .iter()
            .filter(|(command, _)| command == "reg.exe")
            .skip(3)
            .map(|(_, args)| if args[0] == "delete" { "delete" } else { args[5].as_str() })
            .collect();
        assert_eq!(restore_kinds, vec!["delete", "REG_SZ", "delete"]);
        // A non-zero reg.exe exit carries the typed failure copy.
        let failing: WindowsRunner = Arc::new(|_command: &'static str, _args: Vec<String>| {
            Box::pin(async move { Ok(RunResult { stdout: String::new(), stderr: "access denied".to_string(), code: 1 }) })
        });
        let failing_adapter = WindowsSystemProxyAdapter::with_runner(failing);
        let error = failing_adapter.apply(&written).await.unwrap_err();
        assert_eq!(
            error.0,
            "PROTOCOL_ERROR:SYSTEM_PROXY_ENABLE_FAILED::写入 ProxyEnable 失败：access denied"
        );
    }

    #[test]
    fn probe_error_suffix_joins_with_the_semicolon_copy() {
        assert!(probe_error_suffix([Ok(()), Ok(())]).is_none());
        assert_eq!(
            probe_error_suffix([Err("a".to_string()), Err("b".to_string())]),
            Some("a；b".to_string())
        );
    }
}
