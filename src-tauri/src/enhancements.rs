//! Typed configuration models — Rust ports of the shared models behind the
//! DNS/sniffer/core/geodata/TUN-config services (Phase 3A slices 4):
//! `shared/dns.ts`, `shared/sniffer.ts`, `shared/core-settings.ts`,
//! `shared/geodata.ts`, `shared/tun-config.ts` and their service wrappers
//! (`dns-enhancement-service.ts`, `sniffer-enhancement-service.ts`,
//! `core-settings-service.ts`, `geodata-settings-service.ts`,
//! `tun-config-service.ts`).
//!
//! Contract preserved exactly, per model:
//! - File in the app-data namespace, 2-space pretty JSON + trailing newline,
//!   temp `.<file>.<epoch-ms>.tmp` + atomic rename, lazy load, corrupt ->
//!   defaults (model re-coerced from the envelope), serial mutations.
//! - get returns the TS envelope shape (`{ enhancement }` /
//!   `{ config }` / the raw model for core + geodata); set coerces; preview
//!   renders the block a model would produce (never writes).
//! - Migrations ride the load path: core-settings v2 with the v0.9.0
//!   mixed/http default-swap tuple fix; TUN legacy 9000 MTU -> 1500.
//!
//! Preview text formatting follows the Rust YAML emitter (documented in
//! docs/tauri/phase3/README.md — semantically neutral for mihomo).

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::error::IpcError;
use crate::net_validators::{is_valid_address_or_cidr, is_valid_hostname, is_valid_ip};

// ---------------------------------------------------------------------------
// Generic single-model store (the shared service pattern of all five models)
// ---------------------------------------------------------------------------

pub struct ModelStore {
    file_path: Option<PathBuf>,
    file_name: String,
    /// Envelope key: Some("enhancement")/Some("config") wraps the model;
    /// None stores the model at the top level (core/geodata).
    envelope_key: Option<&'static str>,
    /// Extra normalization on the RAW parsed document before coercion
    /// (core storage-version migration, TUN legacy MTU migration).
    migrate: Option<Box<dyn Fn(Value) -> Value + Send + Sync>>,
    cache: Mutex<Option<Value>>,
}

impl ModelStore {
    pub fn new(
        app_data_base: Option<PathBuf>,
        file_name: &str,
        envelope_key: Option<&'static str>,
        migrate: Option<Box<dyn Fn(Value) -> Value + Send + Sync>>,
    ) -> Self {
        ModelStore {
            file_path: app_data_base.map(|base| base.join(file_name)),
            file_name: file_name.to_string(),
            envelope_key,
            migrate,
            cache: Mutex::new(None),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Option<Value>> {
        self.cache.lock().expect("model store mutex poisoned")
    }

    /// Raw document before envelope unwrapping (core's migration needs it).
    fn load_raw(&self) -> Option<Value> {
        let raw = fs::read_to_string(self.file_path.as_ref()?).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// The persisted envelope shape for a model value (write path).
    fn wrap(&self, model: Value) -> Value {
        match self.envelope_key {
            Some(key) => {
                let mut object = Map::new();
                object.insert(key.to_string(), model);
                Value::Object(object)
            }
            None => model,
        }
    }

    /// The model value inside a parsed document (read path).
    fn unwrap_model(&self, document: &Value) -> Value {
        match self.envelope_key {
            Some(key) => document.get(key).cloned().unwrap_or(Value::Null),
            None => document.clone(),
        }
    }

    /// Load-through cache mirroring the TS `ensureLoaded()`.
    pub fn get(&self) -> Value {
        let mut cached = self.guard();
        if let Some(model) = cached.as_ref() {
            return model.clone();
        }
        let model = match self.load_raw() {
            Some(raw) => {
                let migrated = match &self.migrate {
                    Some(migrate) => migrate(raw),
                    None => raw,
                };
                self.unwrap_model(&migrated)
            }
            None => Value::Null,
        };
        *cached = Some(model.clone());
        model
    }

    /// Coerce + persist (the TS `set()` shape; the caller supplies the coerce).
    pub fn set(&self, input: &Value, coerce: impl Fn(&Value) -> Value) -> Result<Value, IpcError> {
        let model = coerce(input);
        let mut cached = self.guard();
        self.persist(&model)?;
        *cached = Some(model.clone());
        Ok(model)
    }

    fn persist(&self, model: &Value) -> Result<(), IpcError> {
        let Some(path) = self.file_path.as_ref() else {
            return Ok(()); // dev: memory-only
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| IpcError::internal(format!("unable to create app-data directory: {error}")))?;
        }
        let document = self.wrap(model.clone());
        let mut body = serde_json::to_string_pretty(&document).expect("model serializes");
        body.push('\n');
        // Temp name matches the TS services: `.<file>.<epoch-ms>.tmp`.
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let tmp = path.with_file_name(format!(".{}.{}.tmp", self.file_name, epoch_ms));
        let write = fs::write(&tmp, body).and_then(|()| fs::rename(&tmp, path));
        match write {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                Err(IpcError::internal(format!("unable to persist {file}: {error}", file = self.file_name)))
            }
        }
    }
}

/// The five single-model stores, constructed once at startup and shared with
/// the IPC dispatch (the TS `when-ready.ts` service composition).
pub struct ModelStores {
    pub core: ModelStore,
    pub geodata: ModelStore,
    pub dns: ModelStore,
    pub sniffer: ModelStore,
    pub tun_config: ModelStore,
}

impl ModelStores {
    pub fn new(app_data_root: Option<PathBuf>) -> Self {
        ModelStores {
            core: ModelStore::new(
                app_data_root.clone(),
                CORE_SETTINGS_FILE,
                None,
                Some(Box::new(migrate_core_settings)),
            ),
            geodata: ModelStore::new(app_data_root.clone(), GEODATA_SETTINGS_FILE, None, None),
            dns: ModelStore::new(app_data_root.clone(), DNS_ENHANCEMENT_FILE, Some("enhancement"), None),
            sniffer: ModelStore::new(app_data_root.clone(), SNIFFER_ENHANCEMENT_FILE, Some("enhancement"), None),
            tun_config: ModelStore::new(
                app_data_root,
                TUN_CONFIG_FILE,
                Some("config"),
                Some(Box::new(migrate_tun_config)),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON helpers shared by the models
// ---------------------------------------------------------------------------

fn get<'a>(source: &'a Value, key: &str) -> Option<&'a Value> {
    source.get(key)
}

fn as_bool(source: &Value, key: &str, fallback: bool) -> bool {
    get(source, key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn as_bool_defaulting(source: &Value, key: &str, default_value: &Value) -> bool {
    get(source, key)
        .and_then(Value::as_bool)
        .unwrap_or_else(|| default_value.get(key).and_then(Value::as_bool).unwrap_or(false))
}

fn as_string(source: &Value, key: &str, fallback: &str) -> String {
    get(source, key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn as_string_list_defaulting(source: &Value, key: &str, default_value: &Value) -> Vec<String> {
    match get(source, key).and_then(Value::as_array) {
        Some(items) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        None => default_value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
    }
}

fn is_integer_number(value: &Value) -> Option<i64> {
    if value.is_i64() || value.is_u64() {
        return value.as_i64();
    }
    // Non-integer floats are not integers.
    match value.as_f64() {
        Some(f) if f.fract() == 0.0 => Some(f as i64),
        _ => None,
    }
}

fn set_object(model: &mut Map<String, Value>, key: &str, value: Value) {
    model.insert(key.to_string(), value);
}

fn yaml_stringify(block: Value) -> String {
    crate::override_apply::stringify_yaml(block)
}

// ---------------------------------------------------------------------------
// Core settings (controlled mihomo core keys)
// ---------------------------------------------------------------------------

pub const CORE_SETTINGS_FILE: &str = "core-settings.json";
const CORE_SETTINGS_STORAGE_VERSION: i64 = 2;
const LOG_LEVELS: [&str; 5] = ["silent", "error", "warning", "info", "debug"];
const FIND_PROCESS_MODES: [&str; 3] = ["off", "strict", "always"];

fn core_defaults() -> Value {
    json!({
        "enabled": false,
        "logLevel": "info",
        "ipv6": false,
        "tcpConcurrent": false,
        "unifiedDelay": false,
        "storeSelected": true,
        "storeFakeIp": true,
        "findProcessMode": "off",
        "interfaceName": "",
        "mixedPort": 7890,
        "socksPort": 7891,
        "httpPort": 7892,
        "controllerHost": "127.0.0.1",
        "controllerPort": 9090,
        "controllerSecret": "",
        "controllerPanel": false,
        "allowLan": false
    })
}

/// The v0.9.0 default-swap migration: only that exact tuple from an
/// unversioned file is fixed; custom combinations stay untouched.
pub fn migrate_core_settings(raw: Value) -> Value {
    if !raw.is_object() {
        return raw;
    }
    let versioned = get(&raw, "storageVersion").and_then(Value::as_i64) == Some(CORE_SETTINGS_STORAGE_VERSION);
    if versioned {
        return raw;
    }
    let is_legacy_tuple = get(&raw, "mixedPort").and_then(Value::as_i64) == Some(7892)
        && get(&raw, "socksPort").and_then(Value::as_i64) == Some(7891)
        && get(&raw, "httpPort").and_then(Value::as_i64) == Some(7890);
    if !is_legacy_tuple {
        return raw;
    }
    let mut fixed = raw.clone();
    if let Some(object) = fixed.as_object_mut() {
        object.insert("mixedPort".into(), json!(7890));
        object.insert("httpPort".into(), json!(7892));
    }
    fixed
}

pub fn coerce_core_settings(input: &Value) -> Value {
    let defaults = core_defaults();
    let source = if input.is_object() { input } else { &Value::Null };
    let as_enum = |key: &str, allowed: &[&str]| -> String {
        let candidate = get(source, key).and_then(Value::as_str).unwrap_or("");
        if allowed.contains(&candidate) {
            candidate.to_string()
        } else {
            defaults[key].as_str().unwrap_or_default().to_string()
        }
    };
    let as_port = |key: &str| -> i64 {
        match get(source, key).and_then(is_integer_number) {
            Some(port) if (1024..=65535).contains(&port) => port,
            _ => defaults[key].as_i64().unwrap_or(0),
        }
    };
    let mut model = Map::new();
    set_object(&mut model, "enabled", json!(as_bool_defaulting(source, "enabled", &defaults)));
    set_object(&mut model, "logLevel", json!(as_enum("logLevel", &LOG_LEVELS)));
    set_object(&mut model, "ipv6", json!(as_bool_defaulting(source, "ipv6", &defaults)));
    set_object(&mut model, "tcpConcurrent", json!(as_bool_defaulting(source, "tcpConcurrent", &defaults)));
    set_object(&mut model, "unifiedDelay", json!(as_bool_defaulting(source, "unifiedDelay", &defaults)));
    set_object(&mut model, "storeSelected", json!(as_bool_defaulting(source, "storeSelected", &defaults)));
    set_object(&mut model, "storeFakeIp", json!(as_bool_defaulting(source, "storeFakeIp", &defaults)));
    set_object(&mut model, "findProcessMode", json!(as_enum("findProcessMode", &FIND_PROCESS_MODES)));
    set_object(
        &mut model,
        "interfaceName",
        json!(get(source, "interfaceName")
            .and_then(Value::as_str)
            .map(|s| s.trim().chars().take(255).collect::<String>())
            .unwrap_or_default()),
    );
    set_object(&mut model, "mixedPort", json!(as_port("mixedPort")));
    set_object(&mut model, "socksPort", json!(as_port("socksPort")));
    set_object(&mut model, "httpPort", json!(as_port("httpPort")));
    set_object(
        &mut model,
        "controllerHost",
        json!(if get(source, "controllerHost").and_then(Value::as_str) == Some("0.0.0.0") {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }),
    );
    set_object(&mut model, "controllerPort", json!(as_port("controllerPort")));
    let secret_valid = get(source, "controllerSecret")
        .and_then(Value::as_str)
        .map(|secret| secret.is_empty() || regex::Regex::new("^[0-9a-f]{64}$").expect("secret regex").is_match(secret))
        .unwrap_or(false);
    set_object(
        &mut model,
        "controllerSecret",
        json!(if secret_valid { get(source, "controllerSecret").and_then(Value::as_str).unwrap_or("") } else { "" }),
    );
    set_object(&mut model, "controllerPanel", json!(as_bool_defaulting(source, "controllerPanel", &defaults)));
    set_object(&mut model, "allowLan", json!(as_bool_defaulting(source, "allowLan", &defaults)));

    // Duplicate active ports reset all four (the TS conflict handling).
    let ports: Vec<i64> = ["mixedPort", "socksPort", "httpPort", "controllerPort"]
        .iter()
        .filter_map(|key| model[*key].as_i64())
        .collect();
    let unique: std::collections::HashSet<i64> = ports.iter().copied().collect();
    if unique.len() != ports.len() {
        for key in ["mixedPort", "socksPort", "httpPort", "controllerPort"] {
            set_object(&mut model, key, defaults[key].clone());
        }
    }
    Value::Object(model)
}

/// The mihomo core keys block (allowlisted; emitted when enabled).
pub fn build_core_settings_block(settings: &Value) -> Value {
    let mut block = Map::new();
    set_object(&mut block, "log-level", settings["logLevel"].clone());
    set_object(&mut block, "ipv6", settings["ipv6"].clone());
    set_object(&mut block, "tcp-concurrent", settings["tcpConcurrent"].clone());
    set_object(&mut block, "unified-delay", settings["unifiedDelay"].clone());
    set_object(
        &mut block,
        "profile",
        json!({
            "store-selected": settings["storeSelected"],
            "store-fake-ip": settings["storeFakeIp"]
        }),
    );
    set_object(&mut block, "find-process-mode", settings["findProcessMode"].clone());
    // interface-name only when set (an empty value keeps automatic route
    // selection, exactly like the TS conditional spread).
    if !settings["interfaceName"].as_str().map(str::is_empty).unwrap_or(true) {
        set_object(&mut block, "interface-name", settings["interfaceName"].clone());
    }
    Value::Object(block)
}

/// The core preview: the app-owned listener/auth keys plus the core block
/// when the enhancement is enabled (the TS preview layout verbatim).
pub fn core_preview_text(input: &Value) -> String {
    let settings = coerce_core_settings(input);
    let mut block = Map::new();
    set_object(&mut block, "mixed-port", settings["mixedPort"].clone());
    set_object(&mut block, "socks-port", settings["socksPort"].clone());
    set_object(&mut block, "port", settings["httpPort"].clone());
    set_object(
        &mut block,
        "external-controller",
        json!(format!(
            "{}:{}",
            settings["controllerHost"].as_str().unwrap_or("127.0.0.1"),
            settings["controllerPort"].as_i64().unwrap_or(9090)
        )),
    );
    set_object(
        &mut block,
        "secret",
        json!(match settings["controllerSecret"].as_str().unwrap_or("") {
            "" => "（下次启动时自动生成）",
            secret => secret,
        }),
    );
    set_object(&mut block, "allow-lan", settings["allowLan"].clone());
    set_object(
        &mut block,
        "bind-address",
        json!(if settings["allowLan"].as_bool() == Some(true) { "*" } else { "127.0.0.1" }),
    );
    if settings["controllerPanel"].as_bool() == Some(true) {
        set_object(&mut block, "external-ui", json!("ui"));
        set_object(&mut block, "external-ui-name", json!("metacubexd"));
        set_object(
            &mut block,
            "external-ui-url",
            json!("https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"),
        );
    }
    if settings["enabled"].as_bool() == Some(true) {
        if let Some(extra) = build_core_settings_block(&settings).as_object() {
            for (key, value) in extra {
                set_object(&mut block, key, value.clone());
            }
        }
    }
    yaml_stringify(Value::Object(block))
}

// ---------------------------------------------------------------------------
// Geodata settings
// ---------------------------------------------------------------------------

pub const GEODATA_SETTINGS_FILE: &str = "geodata-settings.json";
const GEOIP_MODES: [&str; 2] = ["memconservative", "standard"];
const MIN_UPDATE_INTERVAL_HOURS: i64 = 1;
const MAX_UPDATE_INTERVAL_HOURS: i64 = 168;
const DEFAULT_UPDATE_INTERVAL_HOURS: i64 = 24;

fn default_geox_urls() -> Value {
    json!({
        "geoip": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
        "mmdb": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
        "geosite": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
        "asn": "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb"
    })
}

fn geodata_defaults() -> Value {
    json!({
        "enabled": false,
        "geodataMode": false,
        "geoipMode": "standard",
        "autoUpdate": false,
        "updateIntervalHours": DEFAULT_UPDATE_INTERVAL_HOURS,
        "geoxUrl": "",
        "geoxUrls": default_geox_urls()
    })
}

fn is_valid_source_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true; // empty means "keep the profile's own source"
    }
    match url::Url::parse(trimmed) {
        Ok(parsed) => matches!(parsed.scheme(), "https" | "http"),
        Err(_) => false,
    }
}

pub fn coerce_geodata_settings(input: &Value) -> Value {
    let defaults = geodata_defaults();
    let source = if input.is_object() { input } else { &Value::Null };
    let as_interval = || -> i64 {
        match get(source, "updateIntervalHours").and_then(is_integer_number) {
            Some(hours) if (MIN_UPDATE_INTERVAL_HOURS..=MAX_UPDATE_INTERVAL_HOURS).contains(&hours) => hours,
            _ => DEFAULT_UPDATE_INTERVAL_HOURS,
        }
    };
    let as_url = || -> String {
        match get(source, "geoxUrl").and_then(Value::as_str) {
            Some(raw) => {
                let trimmed = raw.trim();
                if is_valid_source_url(trimmed) {
                    trimmed.to_string()
                } else {
                    String::new()
                }
            }
            None => String::new(),
        }
    };
    let geox_urls = get(source, "geoxUrls")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let urls = Map::from_iter(
        default_geox_urls()
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, fallback)| {
                let candidate = geox_urls.get(key).and_then(Value::as_str).unwrap_or("");
                (
                    key.clone(),
                    json!(if is_valid_source_url(candidate) && !candidate.trim().is_empty() {
                        candidate.trim().to_string()
                    } else {
                        fallback.as_str().unwrap_or_default().to_string()
                    }),
                )
            }),
    );
    let mut model = Map::new();
    set_object(&mut model, "enabled", json!(as_bool_defaulting(source, "enabled", &defaults)));
    set_object(&mut model, "geodataMode", json!(as_bool_defaulting(source, "geodataMode", &defaults)));
    set_object(&mut model, "geoipMode", json!(if GEOIP_MODES.contains(&get(source, "geoipMode").and_then(Value::as_str).unwrap_or("")) {
        get(source, "geoipMode").and_then(Value::as_str).unwrap()
    } else {
        "standard"
    }));
    set_object(&mut model, "autoUpdate", json!(as_bool_defaulting(source, "autoUpdate", &defaults)));
    set_object(&mut model, "updateIntervalHours", json!(as_interval()));
    set_object(&mut model, "geoxUrl", json!(as_url()));
    set_object(&mut model, "geoxUrls", Value::Object(urls));
    Value::Object(model)
}

pub fn build_geodata_block(settings: &Value) -> Value {
    json!({
        "geodata-mode": settings["geodataMode"],
        "geodata-loader": settings["geoipMode"],
        "geo-auto-update": settings["autoUpdate"],
        "geo-update-interval": settings["updateIntervalHours"],
        "geox-url": settings["geoxUrls"]
    })
}

pub fn geodata_preview_text(input: &Value) -> String {
    yaml_stringify(build_geodata_block(&coerce_geodata_settings(input)))
}

// ---------------------------------------------------------------------------
// Sniffer enhancement
// ---------------------------------------------------------------------------

pub const SNIFFER_ENHANCEMENT_FILE: &str = "sniffer-enhancement.json";

fn sniffer_defaults() -> Value {
    json!({
        "enabled": false,
        "overrideDestination": false,
        "forceDnsMapping": true,
        "parsePureIp": true,
        "ports": { "http": ["80", "443"], "tls": ["443"], "quic": [] },
        "skipDomain": ["+.push.apple.com"],
        "forceDomain": [],
        "skipSrcAddress": [],
        "skipDstAddress": [
            "91.105.192.0/23", "91.108.4.0/22", "91.108.8.0/21", "91.108.16.0/21",
            "91.108.56.0/22", "95.161.64.0/20", "149.154.160.0/20", "185.76.151.0/24",
            "2001:67c:4e8::/48", "2001:b28:f23c::/47", "2001:b28:f23f::/48", "2a0a:f280:203::/48"
        ]
    })
}

#[allow(dead_code)]
/// A single mihomo sniffer port entry: a port, a port range or `*`. // the Electron zod IPC schema uses this to reject bad set payloads; the schema-validation slice (3B) consumes it
pub fn is_valid_port_token(value: &str) -> bool {
    let v = value.trim();
    if v == "*" {
        return true;
    }
    if let Some((from, to)) = v.split_once('-') {
        return from.parse::<u32>().is_ok()
            && to.parse::<u32>().is_ok()
            && (1..=65535).contains(&from.parse::<u32>().unwrap_or(0))
            && (1..=65535).contains(&to.parse::<u32>().unwrap_or(0))
            && from.parse::<u32>().unwrap_or(0) <= to.parse::<u32>().unwrap_or(0);
    }
    if v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty() && v.len() <= 5 {
        return (1..=65535).contains(&v.parse::<u32>().unwrap_or(0));
    }
    false
}

pub fn coerce_sniffer_enhancement(input: &Value) -> Value {
    let defaults = sniffer_defaults();
    let source = if input.is_object() { input } else { &Value::Null };
    let as_string_list = |key: &str| -> Vec<String> {
        as_string_list_defaulting(source, key, &defaults)
    };
    let ports_raw = get(source, "ports").cloned().unwrap_or(Value::Null);
    let as_ports = |key: &str| -> Vec<String> {
        ports_raw
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_else(|| {
                defaults["ports"][key]
                    .as_array()
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default()
            })
    };
    let mut model = Map::new();
    set_object(&mut model, "enabled", json!(as_bool_defaulting(source, "enabled", &defaults)));
    set_object(&mut model, "overrideDestination", json!(as_bool_defaulting(source, "overrideDestination", &defaults)));
    set_object(&mut model, "forceDnsMapping", json!(as_bool_defaulting(source, "forceDnsMapping", &defaults)));
    set_object(&mut model, "parsePureIp", json!(as_bool_defaulting(source, "parsePureIp", &defaults)));
    set_object(
        &mut model,
        "ports",
        json!({ "http": as_ports("http"), "tls": as_ports("tls"), "quic": as_ports("quic") }),
    );
    set_object(&mut model, "skipDomain", json!(as_string_list("skipDomain")));
    set_object(&mut model, "forceDomain", json!(as_string_list("forceDomain")));
    set_object(&mut model, "skipSrcAddress", json!(as_string_list("skipSrcAddress")));
    set_object(&mut model, "skipDstAddress", json!(as_string_list("skipDstAddress")));
    Value::Object(model)
}

pub fn build_sniffer_block(enhancement: &Value) -> Value {
    let mut block = Map::new();
    set_object(&mut block, "enable", enhancement["enabled"].clone());
    set_object(&mut block, "override-destination", enhancement["overrideDestination"].clone());
    set_object(&mut block, "force-dns-mapping", enhancement["forceDnsMapping"].clone());
    set_object(&mut block, "parse-pure-ip", enhancement["parsePureIp"].clone());
    let mut sniff = Map::new();
    for (key, label) in [("http", "HTTP"), ("tls", "TLS"), ("quic", "QUIC")] {
        let ports = &enhancement["ports"][key];
        if ports.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            sniff.insert(label.to_string(), json!({ "ports": ports }));
        }
    }
    if !sniff.is_empty() {
        set_object(&mut block, "sniff", Value::Object(sniff));
    }
    for (key, block_key) in [
        ("skipDomain", "skip-domain"),
        ("forceDomain", "force-domain"),
        ("skipSrcAddress", "skip-src-address"),
        ("skipDstAddress", "skip-dst-address"),
    ] {
        let list = &enhancement[key];
        if list.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            set_object(&mut block, block_key, list.clone());
        }
    }
    Value::Object(block)
}

pub fn sniffer_preview_text(input: &Value) -> String {
    yaml_stringify(json!({ "sniffer": build_sniffer_block(&coerce_sniffer_enhancement(input)) }))
}

// ---------------------------------------------------------------------------
// TUN configuration
// ---------------------------------------------------------------------------

pub const TUN_CONFIG_FILE: &str = "tun-config.json";
pub const LEGACY_TUN_MTU_DEFAULT: i64 = 9000;

fn tun_defaults() -> Value {
    json!({
        "stack": "mixed",
        "device": "Mihomo",
        "mtu": 1500,
        "strictRoute": false,
        "autoRoute": true,
        "autoDetectInterface": true,
        "dnsHijack": ["any:53"],
        "routeAddress": [],
        "routeExcludeAddress": []
    })
}

/// Persisted-but-uncustomized installs migrate off the legacy 9000 MTU.
pub fn migrate_tun_config(raw: Value) -> Value {
    let model = raw.get("config").cloned().unwrap_or(Value::Null);
    if model.get("mtu").and_then(Value::as_i64) == Some(LEGACY_TUN_MTU_DEFAULT) {
        let mut fixed = raw;
        if let Some(object) = fixed.get_mut("config").and_then(Value::as_object_mut) {
            object.insert("mtu".into(), json!(tun_defaults()["mtu"]));
        }
        fixed
    } else {
        raw
    }
}

fn is_valid_tun_stack(value: &Value) -> bool {
    matches!(value.as_str(), Some("mixed") | Some("system") | Some("gvisor"))
}

fn is_valid_tun_device(value: &str) -> bool {
    regex::Regex::new("^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
        .expect("device regex")
        .is_match(value)
}

fn is_valid_tun_mtu(value: i64) -> bool {
    (576..=65535).contains(&value)
}

fn is_single_port(value: &str) -> bool {
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let port: u32 = value.parse().unwrap_or(0);
    (1..=65535).contains(&port)
}

/// A mihomo `tun.dns-hijack` entry (`any`, `ip`, `host:port`, `[ipv6]:port`).
pub fn is_valid_dns_hijack_entry(value: &str) -> bool {
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
        if !is_valid_ip(host) {
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
        None => is_valid_ip(v) || is_valid_hostname(v),
        Some(idx) => {
            let host_part = &v[..idx];
            let port_part = &v[idx + 1..];
            if !is_single_port(port_part) {
                return false;
            }
            host_part == "any" || is_valid_ip(host_part) || is_valid_hostname(host_part)
        }
    }
}

pub fn coerce_tun_config(input: &Value) -> Value {
    let defaults = tun_defaults();
    let source = if input.is_object() { input } else { &Value::Null };
    let filter_list = |key: &str, validator: fn(&str) -> bool| -> Vec<String> {
        get(source, key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|item| validator(item))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let mtu = get(source, "mtu")
        .and_then(Value::as_i64)
        .filter(|mtu| is_valid_tun_mtu(*mtu))
        .unwrap_or_else(|| defaults["mtu"].as_i64().unwrap_or(1500));
    let mut model = Map::new();
    set_object(&mut model, "stack", json!(if is_valid_tun_stack(get(source, "stack").unwrap_or(&Value::Null)) {
        get(source, "stack").and_then(Value::as_str).unwrap()
    } else {
        "mixed"
    }));
    set_object(
        &mut model,
        "device",
        json!(match get(source, "device").and_then(Value::as_str) {
            Some(device) if is_valid_tun_device(device) => device.to_string(),
            _ => "Mihomo".to_string(),
        }),
    );
    set_object(&mut model, "mtu", json!(mtu));
    set_object(&mut model, "strictRoute", json!(as_bool(source, "strictRoute", false)));
    set_object(&mut model, "autoRoute", json!(as_bool(source, "autoRoute", true)));
    set_object(&mut model, "autoDetectInterface", json!(as_bool(source, "autoDetectInterface", true)));
    // Missing list fields fall back to the curated defaults for dnsHijack and
    // to empty for the route lists (a present list is filtered, not replaced).
    let dns_hijack = match get(source, "dnsHijack") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|item| is_valid_dns_hijack_entry(item))
            .map(str::to_string)
            .collect::<Vec<_>>(),
        _ => defaults["dnsHijack"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
    };
    set_object(&mut model, "dnsHijack", json!(dns_hijack));
    set_object(&mut model, "routeAddress", json!(filter_list("routeAddress", is_valid_address_or_cidr)));
    set_object(&mut model, "routeExcludeAddress", json!(filter_list("routeExcludeAddress", is_valid_address_or_cidr)));
    Value::Object(model)
}

/// Render the `tun:` sub-block a model would produce. List keys only when
/// non-empty (an intentionally-empty set never emits a bare sequence).
pub fn build_tun_block(config: &Value) -> Value {
    let mut block = Map::new();
    set_object(&mut block, "auto-route", config["autoRoute"].clone());
    set_object(&mut block, "auto-detect-interface", config["autoDetectInterface"].clone());
    set_object(&mut block, "strict-route", config["strictRoute"].clone());
    set_object(&mut block, "device", config["device"].clone());
    set_object(&mut block, "stack", config["stack"].clone());
    set_object(&mut block, "mtu", config["mtu"].clone());
    set_object(&mut block, "dns-hijack", config["dnsHijack"].clone());
    for (key, block_key) in [("routeAddress", "route-address"), ("routeExcludeAddress", "route-exclude-address")] {
        if config[key].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            set_object(&mut block, block_key, config[key].clone());
        }
    }
    Value::Object(block)
}

pub fn tun_config_preview_text(input: &Value) -> String {
    yaml_stringify(json!({ "tun": build_tun_block(&coerce_tun_config(input)) }))
}

// ---------------------------------------------------------------------------
// DNS enhancement
// ---------------------------------------------------------------------------

pub const DNS_ENHANCEMENT_FILE: &str = "dns-enhancement.json";

fn dns_defaults() -> Value {
    json!({
        "enabled": false,
        "enhancedMode": "fake-ip",
        "ipv6": false,
        "respectRules": false,
        "fakeIpRange": "198.18.0.1/16",
        "fakeIpFilterMode": "blacklist",
        "fakeIpFilter": ["*", "+.lan", "+.local", "time.*.com", "ntp.*.com", "+.market.xiaomi.com"],
        "useHosts": false,
        "hosts": [],
        "defaultNameserver": ["tls://223.5.5.5"],
        "proxyServerNameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
        "directNameserver": [],
        "nameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
        "fallback": [],
        "nameserverPolicy": []
    })
}

fn is_valid_dns_port(value: &str) -> bool {
    !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit()) && {
        let port: u32 = value.parse().unwrap_or(0);
        (1..=65535).contains(&port)
    }
}

/// A mihomo nameserver entry: `system`/`default`, an allowed scheme with a
/// host, a bare IP, or a plain hostname.
#[allow(dead_code)] // the Electron zod IPC schema uses this to reject bad set payloads; the schema-validation slice (3B) consumes it
pub fn is_valid_nameserver(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    if v == "system" || v == "default" {
        return true;
    }
    if v.to_lowercase().starts_with("dhcp://") {
        return true;
    }
    let Some((scheme, rest)) = v.split_once("://") else {
        return is_valid_ip(v) || is_valid_hostname(v);
    };
    if scheme.is_empty()
        || !scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
    {
        // Not a scheme match — fall back to the bare-host forms.
        return is_valid_ip(v) || is_valid_hostname(v);
    }
    if !["udp", "tcp", "tls", "https", "h3", "quic", "dhcp"].contains(&scheme.to_lowercase().as_str()) {
        return false;
    }
    if rest.is_empty() {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    // Strip userinfo, then brackets/port, then validate the remaining host.
    let mut host = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    if let Some(inner) = host.strip_prefix('[') {
        let Some(close) = inner.find(']') else {
            return false;
        };
        let inner_host = &inner[..close];
        let after = &inner[close + 1..];
        if !after.is_empty() && (!after.starts_with(':') || !is_valid_dns_port(&after[1..])) {
            return false;
        }
        return is_valid_ip(inner_host);
    }
    if let Some(colon) = host.rfind(':') {
        if host[colon + 1..].bytes().all(|b| b.is_ascii_digit()) && !host[colon + 1..].is_empty() {
            if !is_valid_dns_port(&host[colon + 1..]) {
                return false;
            }
            host = &host[..colon];
        }
    }
    is_valid_ip(host) || is_valid_hostname(host)
}

/// `default-nameserver` must resolve without the configured resolvers: a bare
/// IP or a DNS transport URI whose host is a literal IP.
#[allow(dead_code)] // the Electron zod IPC schema uses this; the schema-validation slice (3B) consumes it
pub fn is_valid_default_nameserver(value: &str) -> bool {
    let v = value.trim();
    if is_valid_ip(v) {
        return true;
    }
    let Some((scheme, rest)) = v.split_once("://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    let host = match host.rfind(':') {
        Some(colon) if host[colon + 1..].bytes().all(|b| b.is_ascii_digit()) && !host[colon + 1..].is_empty() => &host[..colon],
        _ => host,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    !scheme.is_empty() && is_valid_ip(host)
}

/// Mask credentials inside a nameserver string for preview rendering.
pub fn redact_server(value: &str) -> String {
    let at = value.rfind('@');
    let scheme = value.find("://");
    match (at, scheme) {
        (Some(at), Some(scheme)) if at > scheme => {
            format!("{}***{}", &value[..scheme + 3], &value[at..])
        }
        _ => value.to_string(),
    }
}

pub fn coerce_dns_enhancement(input: &Value) -> Value {
    let defaults = dns_defaults();
    let source = if input.is_object() { input } else { &Value::Null };
    let as_string_list = |key: &str| as_string_list_defaulting(source, key, &defaults);
    let as_pairs = |key: &str, server_key: &str| -> Vec<Value> {
        get(source, key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|entry| entry.is_object())
                    .map(|entry| json!({ "domain": entry.get("domain").cloned().unwrap_or(Value::Null), server_key: entry.get(server_key).cloned().unwrap_or(Value::Null) }))
                    .collect()
            })
            .unwrap_or_default()
    };
    let enhanced_mode = if get(source, "enhancedMode").and_then(Value::as_str) == Some("normal") {
        // Older builds exposed `normal`; migrate the real-IP intent.
        "redir-host".to_string()
    } else {
        match get(source, "enhancedMode").and_then(Value::as_str) {
            Some("fake-ip") | Some("redir-host") => get(source, "enhancedMode").and_then(Value::as_str).unwrap().to_string(),
            _ => "fake-ip".to_string(),
        }
    };
    let fake_ip_filter_mode = match get(source, "fakeIpFilterMode").and_then(Value::as_str) {
        Some("blacklist") | Some("whitelist") => get(source, "fakeIpFilterMode").and_then(Value::as_str).unwrap().to_string(),
        _ => "blacklist".to_string(),
    };
    let mut model = Map::new();
    set_object(&mut model, "enabled", json!(as_bool_defaulting(source, "enabled", &defaults)));
    set_object(&mut model, "enhancedMode", json!(enhanced_mode));
    set_object(&mut model, "ipv6", json!(as_bool_defaulting(source, "ipv6", &defaults)));
    set_object(&mut model, "respectRules", json!(as_bool_defaulting(source, "respectRules", &defaults)));
    set_object(&mut model, "fakeIpRange", json!(as_string(source, "fakeIpRange", "198.18.0.1/16")));
    set_object(&mut model, "fakeIpFilterMode", json!(fake_ip_filter_mode));
    set_object(&mut model, "fakeIpFilter", json!(as_string_list("fakeIpFilter")));
    set_object(&mut model, "useHosts", json!(as_bool_defaulting(source, "useHosts", &defaults)));
    set_object(&mut model, "hosts", json!(as_pairs("hosts", "address")));
    set_object(&mut model, "defaultNameserver", json!(as_string_list("defaultNameserver")));
    set_object(&mut model, "proxyServerNameserver", json!(as_string_list("proxyServerNameserver")));
    set_object(&mut model, "directNameserver", json!(as_string_list("directNameserver")));
    set_object(&mut model, "nameserver", json!(as_string_list("nameserver")));
    set_object(&mut model, "fallback", json!(as_string_list("fallback")));
    set_object(&mut model, "nameserverPolicy", json!(as_pairs("nameserverPolicy", "server")));

    // A stale persisted model must not create a DNS routing bootstrap loop.
    let proxy_servers = model["proxyServerNameserver"].as_array().cloned().unwrap_or_default();
    if model["respectRules"].as_bool() == Some(true) && proxy_servers.is_empty() {
        set_object(&mut model, "respectRules", json!(false));
    }
    Value::Object(model)
}

pub fn build_dns_block(enhancement: &Value) -> Value {
    let mut block = Map::new();
    set_object(&mut block, "enable", enhancement["enabled"].clone());
    set_object(&mut block, "enhanced-mode", enhancement["enhancedMode"].clone());
    set_object(&mut block, "ipv6", enhancement["ipv6"].clone());
    set_object(&mut block, "respect-rules", enhancement["respectRules"].clone());
    set_object(&mut block, "use-hosts", enhancement["useHosts"].clone());
    if enhancement["enhancedMode"] == json!("fake-ip") {
        set_object(&mut block, "fake-ip-range", enhancement["fakeIpRange"].clone());
        set_object(&mut block, "fake-ip-filter-mode", enhancement["fakeIpFilterMode"].clone());
        let filter = &enhancement["fakeIpFilter"];
        if filter.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            set_object(&mut block, "fake-ip-filter", filter.clone());
        }
    }
    let hosts = &enhancement["hosts"];
    if hosts.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        let mut host_map = Map::new();
        for entry in hosts.as_array().unwrap() {
            if let (Some(domain), Some(address)) = (entry["domain"].as_str(), entry["address"].as_str()) {
                host_map.insert(domain.to_string(), json!(address));
            }
        }
        set_object(&mut block, "hosts", Value::Object(host_map));
    }
    for (key, block_key) in [
        ("defaultNameserver", "default-nameserver"),
        ("proxyServerNameserver", "proxy-server-nameserver"),
        ("directNameserver", "direct-nameserver"),
        ("nameserver", "nameserver"),
        ("fallback", "fallback"),
    ] {
        let list = &enhancement[key];
        if list.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            set_object(&mut block, block_key, list.clone());
        }
    }
    let policy = &enhancement["nameserverPolicy"];
    if policy.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        let mut policy_map = Map::new();
        for entry in policy.as_array().unwrap() {
            if let (Some(domain), Some(server)) = (entry["domain"].as_str(), entry["server"].as_str()) {
                policy_map.insert(domain.to_string(), json!(server));
            }
        }
        set_object(&mut block, "nameserver-policy", Value::Object(policy_map));
    }
    Value::Object(block)
}

fn redact_dns_enhancement(enhancement: &Value) -> Value {
    let mut model = enhancement.clone();
    if let Some(object) = model.as_object_mut() {
        for key in ["defaultNameserver", "proxyServerNameserver", "directNameserver", "nameserver", "fallback"] {
            if let Some(list) = object.get_mut(key).and_then(Value::as_array_mut) {
                *list = list
                    .iter()
                    .map(|item| json!(redact_server(item.as_str().unwrap_or_default())))
                    .collect();
            }
        }
        if let Some(policy) = object.get_mut("nameserverPolicy").and_then(Value::as_array_mut) {
            *policy = policy
                .iter()
                .map(|entry| {
                    json!({
                        "domain": entry["domain"],
                        "server": redact_server(entry["server"].as_str().unwrap_or_default())
                    })
                })
                .collect();
        }
    }
    model
}

pub fn dns_preview_text(input: &Value) -> String {
    yaml_stringify(json!({ "dns": build_dns_block(&redact_dns_enhancement(&coerce_dns_enhancement(input))) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store_in(temp: &TempDir, file: &str, envelope: Option<&'static str>) -> ModelStore {
        ModelStore::new(Some(temp.path().to_path_buf()), file, envelope, None)
    }

    // --- core settings -------------------------------------------------------

    #[test]
    fn core_defaults_and_coercion() {
        let coerced = coerce_core_settings(&Value::Null);
        assert_eq!(coerced, core_defaults());
        let coerced = coerce_core_settings(&json!({
            "enabled": true, "logLevel": "debug", "findProcessMode": "always",
            "mixedPort": 7893, "interfaceName": "  eth0  ", "controllerSecret": "a".repeat(64)
        }));
        assert_eq!(coerced["enabled"], true);
        assert_eq!(coerced["logLevel"], "debug");
        assert_eq!(coerced["mixedPort"], 7893);
        assert_eq!(coerced["interfaceName"], "eth0");
        assert_eq!(coerced["controllerSecret"], "a".repeat(64));
    }

    #[test]
    fn core_rejects_bad_ports_and_duplicate_port_sets() {
        let coerced = coerce_core_settings(&json!({ "mixedPort": 80, "socksPort": "x" }));
        assert_eq!(coerced["mixedPort"], 7890);
        assert_eq!(coerced["socksPort"], 7891);
        let duplicated = coerce_core_settings(&json!({ "mixedPort": 9000, "socksPort": 9000, "httpPort": 9001, "controllerPort": 9002 }));
        assert_eq!(duplicated["mixedPort"], 7890);
        assert_eq!(duplicated["socksPort"], 7891);
        assert_eq!(duplicated["httpPort"], 7892);
        assert_eq!(duplicated["controllerPort"], 9090);
        let coerced = coerce_core_settings(&json!({ "controllerSecret": "nothex" }));
        assert_eq!(coerced["controllerSecret"], "");
    }

    #[test]
    fn core_v09_port_swap_migration() {
        let legacy = json!({ "mixedPort": 7892, "socksPort": 7891, "httpPort": 7890 });
        let migrated = migrate_core_settings(legacy);
        assert_eq!(migrated["mixedPort"], 7890);
        assert_eq!(migrated["httpPort"], 7892);
        // A custom combination is untouched.
        let custom = json!({ "mixedPort": 7892, "socksPort": 7891, "httpPort": 7890, "storageVersion": 2 });
        assert_eq!(migrate_core_settings(custom)["mixedPort"], 7892);
    }

    #[test]
    fn core_store_round_trip_with_envelope_free_shape() {
        let temp = TempDir::new().unwrap();
        let store = ModelStore::new(
            Some(temp.path().to_path_buf()),
            CORE_SETTINGS_FILE,
            None,
            Some(Box::new(migrate_core_settings)),
        );
        assert_eq!(store.get(), Value::Null, "empty file -> defaults at service layer");
        let model = store.set(&json!({ "enabled": true }), coerce_core_settings).unwrap();
        assert_eq!(model["enabled"], true);
        let raw = fs::read_to_string(temp.path().join(CORE_SETTINGS_FILE)).unwrap();
        assert!(raw.starts_with("{\n  \"enabled\": true"), "{}", raw);
        assert!(raw.ends_with("\n"));
        assert_eq!(store.get()["enabled"], true);
    }

    #[test]
    fn core_preview_includes_listener_keys_and_conditional_block() {
        let text = core_preview_text(&json!({ "enabled": true, "mixedPort": 7893, "allowLan": true, "interfaceName": "wlan0" }));
        assert!(text.contains("mixed-port: 7893"), "{text}");
        assert!(text.contains("external-controller: \"127.0.0.1:9090\""), "{text}");
        assert!(text.contains("bind-address: \"*\""), "{text}");
        assert!(text.contains("log-level: info"), "{text}");
        assert!(text.contains("interface-name: wlan0"), "{text}");
        // An empty secret always renders the placeholder (enabled or not).
        assert!(text.contains("secret: （下次启动时自动生成）"), "{text}");
        let text = core_preview_text(&json!({ "enabled": false }));
        assert!(text.contains("secret: （下次启动时自动生成）"), "{text}");
        assert!(!text.contains("log-level"), "{text}");
        let text = core_preview_text(&json!({ "enabled": true, "controllerSecret": "c".repeat(64) }));
        assert!(text.contains("log-level"), "{text}");
        assert!(!text.contains("（下次启动时自动生成）"), "{text}");
    }

    // --- geodata --------------------------------------------------------------

    #[test]
    fn geodata_defaults_and_url_validation() {
        let coerced = coerce_geodata_settings(&Value::Null);
        assert_eq!(coerced, geodata_defaults());
        let coerced = coerce_geodata_settings(&json!({
            "enabled": true, "geoipMode": "memconservative", "updateIntervalHours": 500,
            "geoxUrls": { "geoip": "ftp://bad", "mmdb": " https://ok.example.com/x " }
        }));
        assert_eq!(coerced["geoipMode"], "memconservative");
        assert_eq!(coerced["updateIntervalHours"], 24, "out-of-bounds interval falls back");
        assert_eq!(coerced["geoxUrls"]["geoip"], default_geox_urls()["geoip"], "invalid url falls back");
        assert_eq!(coerced["geoxUrls"]["mmdb"], "https://ok.example.com/x", "trimmed");
    }

    #[test]
    fn geodata_block_and_preview() {
        let block = build_geodata_block(&coerce_geodata_settings(&json!({ "enabled": true })));
        assert_eq!(block["geodata-mode"], false);
        assert_eq!(block["geodata-loader"], "standard");
        assert_eq!(block["geo-update-interval"], 24);
        assert!(block["geox-url"]["geoip"].as_str().unwrap().starts_with("https://"));
        let text = geodata_preview_text(&json!({ "updateIntervalHours": 48 }));
        assert!(text.contains("geo-update-interval: 48"), "{text}");
    }

    #[test]
    fn geodata_store_round_trip() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp, GEODATA_SETTINGS_FILE, None);
        store.set(&json!({ "enabled": true }), coerce_geodata_settings).unwrap();
        assert_eq!(store.get()["enabled"], true);
        let raw = fs::read_to_string(temp.path().join(GEODATA_SETTINGS_FILE)).unwrap();
        assert!(raw.contains("\"geoipMode\""), "{}", raw);
    }

    // --- sniffer --------------------------------------------------------------

    #[test]
    fn sniffer_defaults_are_party_parity() {
        let coerced = coerce_sniffer_enhancement(&Value::Null);
        assert_eq!(coerced, sniffer_defaults());
        assert_eq!(coerced["ports"]["http"], json!(["80", "443"]));
        assert_eq!(coerced["skipDomain"], json!(["+.push.apple.com"]));
    }

    #[test]
    fn sniffer_port_tokens() {
        assert!(is_valid_port_token("80"));
        assert!(is_valid_port_token("1000-2000"));
        assert!(is_valid_port_token("*"));
        assert!(!is_valid_port_token("0"));
        assert!(!is_valid_port_token("65536"));
        assert!(!is_valid_port_token("2000-1000"));
        assert!(!is_valid_port_token("80-"));
    }

    #[test]
    fn sniffer_block_omits_empty_lists_and_probes() {
        let block = build_sniffer_block(&coerce_sniffer_enhancement(&json!({
            "enabled": true, "ports": { "quic": ["443"] }
        })));
        assert_eq!(block["enable"], true);
        assert_eq!(block["sniff"]["QUIC"]["ports"], json!(["443"]));
        // Probe families absent from the input fall back to the curated
        // defaults (HTTP [80,443] / TLS [443]) and are emitted.
        assert_eq!(block["sniff"]["HTTP"]["ports"], json!(["80", "443"]));
        assert_eq!(block["sniff"]["TLS"]["ports"], json!(["443"]));
        assert_eq!(block["skip-domain"], json!(["+.push.apple.com"]));
        assert!(block.get("force-domain").is_none());
        let text = sniffer_preview_text(&json!({ "enabled": true }));
        assert!(text.contains("sniffer:"), "{text}");
        assert!(text.contains("enable: true"), "{text}");
        assert!(text.contains("skip-domain:"), "{text}");
    }

    #[test]
    fn sniffer_store_round_trip_with_envelope() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp, SNIFFER_ENHANCEMENT_FILE, Some("enhancement"));
        store.set(&json!({ "enabled": true }), coerce_sniffer_enhancement).unwrap();
        let raw = fs::read_to_string(temp.path().join(SNIFFER_ENHANCEMENT_FILE)).unwrap();
        assert!(raw.contains("\"enhancement\": {"), "{}", raw);
        assert_eq!(store.get()["enabled"], true);
    }

    // --- tun config -----------------------------------------------------------

    #[test]
    fn tun_defaults_and_coercion() {
        let coerced = coerce_tun_config(&Value::Null);
        assert_eq!(coerced, tun_defaults());
        assert_eq!(coerced["mtu"], 1500);
        let coerced = coerce_tun_config(&json!({
            "stack": "gvisor", "device": "My Murge", "mtu": 9000,
            "dnsHijack": ["any:53", "bad entry", "1.2.3.4:53", "[::1]:53"],
            "routeAddress": ["10.0.0.0/8", "not-a-cidr"]
        }));
        assert_eq!(coerced["stack"], "gvisor");
        assert_eq!(coerced["device"], "My Murge");
        assert_eq!(coerced["mtu"], 9000, "9000 is in-range on input; only the LOAD migration resets it");
        assert_eq!(coerced["dnsHijack"], json!(["any:53", "1.2.3.4:53", "[::1]:53"]));
        assert_eq!(coerced["routeAddress"], json!(["10.0.0.0/8"]));
    }

    #[test]
    fn tun_dns_hijack_forms() {
        assert!(is_valid_dns_hijack_entry("any"));
        assert!(is_valid_dns_hijack_entry("1.2.3.4:53"));
        assert!(is_valid_dns_hijack_entry("[::1]:53"));
        assert!(is_valid_dns_hijack_entry("[2001:db8::1]"));
        assert!(is_valid_dns_hijack_entry("host.example.com:53"));
        assert!(!is_valid_dns_hijack_entry(""));
        assert!(is_valid_dns_hijack_entry("no-port"), "a bare hostname is a legal host form");
        assert!(!is_valid_dns_hijack_entry("[::1]:70000"));
        assert!(!is_valid_dns_hijack_entry("[::1"));
        assert!(!is_valid_dns_hijack_entry("1.2.3.4:0"));
    }

    #[test]
    fn tun_legacy_mtu_migrates_on_load() {
        let legacy = json!({ "config": { "stack": "mixed", "mtu": 9000, "device": "Mihomo" } });
        let migrated = migrate_tun_config(legacy);
        assert_eq!(migrated["config"]["mtu"], 1500);
        let customized = json!({ "config": { "mtu": 1400 } });
        assert_eq!(migrate_tun_config(customized)["config"]["mtu"], 1400);
    }

    #[test]
    fn tun_block_omits_empty_routes_and_preview() {
        let block = build_tun_block(&coerce_tun_config(&Value::Null));
        assert_eq!(block["auto-route"], true);
        assert_eq!(block["dns-hijack"], json!(["any:53"]));
        assert!(block.get("route-address").is_none());
        let with_routes = build_tun_block(&coerce_tun_config(&json!({ "routeAddress": ["10.0.0.0/8"] })));
        assert_eq!(with_routes["route-address"], json!(["10.0.0.0/8"]));
        let text = tun_config_preview_text(&Value::Null);
        assert!(text.contains("tun:"), "{text}");
        assert!(text.contains("mtu: 1500"), "{text}");
    }

    // --- dns ------------------------------------------------------------------

    #[test]
    fn dns_defaults_are_party_parity() {
        let coerced = coerce_dns_enhancement(&Value::Null);
        assert_eq!(coerced, dns_defaults());
        assert_eq!(coerced["fakeIpFilter"][0], "*");
    }

    #[test]
    fn dns_nameserver_forms() {
        assert!(is_valid_nameserver("system"));
        assert!(is_valid_nameserver("default"));
        assert!(is_valid_nameserver("https://doh.pub/dns-query"));
        assert!(is_valid_nameserver("tls://223.5.5.5"));
        assert!(is_valid_nameserver("udp://1.1.1.1:53"));
        assert!(is_valid_nameserver("223.5.5.5"));
        assert!(is_valid_nameserver("DHCP://en0"));
        assert!(!is_valid_nameserver("ftp://bad"));
        assert!(!is_valid_nameserver("https://"));
        assert!(!is_valid_nameserver(""));
    }

    #[test]
    fn dns_respect_rules_needs_proxy_server_nameservers() {
        let coerced = coerce_dns_enhancement(&json!({ "respectRules": true, "proxyServerNameserver": [] }));
        assert_eq!(coerced["respectRules"], false, "no bootstrap loop from stale models");
        let coerced = coerce_dns_enhancement(&json!({ "respectRules": true, "proxyServerNameserver": ["tls://223.5.5.5"] }));
        assert_eq!(coerced["respectRules"], true);
    }

    #[test]
    fn dns_enhanced_mode_migrates_normal() {
        let coerced = coerce_dns_enhancement(&json!({ "enhancedMode": "normal" }));
        assert_eq!(coerced["enhancedMode"], "redir-host");
    }

    #[test]
    fn dns_block_fake_ip_keys_and_maps() {
        let block = build_dns_block(&coerce_dns_enhancement(&json!({
            "enabled": true,
            "hosts": [{ "domain": "a.com", "address": "1.2.3.4" }],
            "nameserverPolicy": [{ "domain": "+.b.com", "server": "tls://8.8.8.8" }],
            "nameserver": ["tls://223.5.5.5"]
        })));
        assert_eq!(block["enable"], true);
        assert_eq!(block["enhanced-mode"], "fake-ip");
        assert_eq!(block["fake-ip-filter-mode"], "blacklist");
        assert_eq!(block["hosts"]["a.com"], "1.2.3.4");
        assert_eq!(block["nameserver-policy"]["+.b.com"], "tls://8.8.8.8");
        assert_eq!(block["nameserver"], json!(["tls://223.5.5.5"]));
        assert!(block.get("fallback").is_none());
        // redir-host mode omits the fake-ip keys.
        let block = build_dns_block(&coerce_dns_enhancement(&json!({ "enhancedMode": "redir-host" })));
        assert!(block.get("fake-ip-range").is_none());
        assert!(block.get("fake-ip-filter").is_none());
    }

    #[test]
    fn dns_preview_redacts_server_credentials() {
        let text = dns_preview_text(&json!({
            "enabled": true,
            "nameserver": ["https://user:secret@doh.example.com/dns-query"]
        }));
        assert!(!text.contains("secret"), "{text}");
        assert!(text.contains("***"), "{text}");
        assert!(text.contains("dns:"), "{text}");
    }

    #[test]
    fn redact_server_only_masks_userinfo() {
        assert_eq!(redact_server("https://user:pass@host/x"), "https://***@host/x");
        assert_eq!(redact_server("tls://223.5.5.5"), "tls://223.5.5.5");
        assert_eq!(redact_server("223.5.5.5"), "223.5.5.5");
    }

    #[test]
    fn dns_store_round_trip_with_envelope() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp, DNS_ENHANCEMENT_FILE, Some("enhancement"));
        store.set(&json!({ "enabled": true }), coerce_dns_enhancement).unwrap();
        let raw = fs::read_to_string(temp.path().join(DNS_ENHANCEMENT_FILE)).unwrap();
        assert!(raw.contains("\"enhancement\": {"), "{}", raw);
        assert_eq!(store.get()["enabled"], true);
    }
}
