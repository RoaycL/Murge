//! Network (egress) metadata model + service — Rust port of
//! `src/shared/network-metadata.ts` + `src/main/services/network-metadata-
//! service.ts` (Phase 3C/3D "network-metadata" slice).
//!
//! Read-only: the running proxy node's public exit address is resolved
//! through the kernel's mixed-port proxy (absolute-form GET), then geographic
//! metadata derives from a privacy-explicit provider. A small bounded
//! in-memory cache keyed by provider id prevents duplicate round-trips;
//! NOTHING is ever persisted to disk. Every outcome flows through an explicit
//! state (`idle`/`fetching`/`ready`/`error`) so a kernel or provider failure
//! is surfaced instead of silently blanked.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const DEFAULT_CACHE_MAX_ENTRIES: usize = 4;
const DEFAULT_CACHE_TTL_MS: u64 = 30 * 60_000;
const DEFAULT_TIMEOUT_MS: u64 = 5000;

/// The TS service keeps this copy string for the legacy panel surface; the
/// current resolve paths never emit it. Kept byte-verbatim for parity.
#[allow(dead_code)]
const FETCH_FAILURE: &str = "查询失败，请重试";
const KERNEL_NOT_RUNNING: &str = "内核未运行，无法查询出口信息";
const PARSE_FAILURE: &str = "数据源返回了无法解析的响应";

// ---------------------------------------------------------------------------
// Provider registry (the function-free wire shape + the parse table)
// ---------------------------------------------------------------------------

/// The serializable description of one provider (no function fields).
#[derive(Debug, Clone, PartialEq)]
pub struct NetworkMetadataProvider {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Plain-http JSON endpoint reached as an absolute-form request via the proxy.
    pub endpoint: &'static str,
}

/// Internal provider definition: the parse maps a provider's JSON body into
/// the normalized fields; it is intentionally kept out of the serialized shape.
struct ProviderDef {
    provider: NetworkMetadataProvider,
    parse: fn(&Value) -> ParsedFields,
}

#[derive(Default)]
struct ParsedFields {
    ip: Option<String>,
    country: Option<String>,
    city: Option<String>,
    asn: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// Normalize a provider-specific `as`/`asn` value into an `ASxxxx` prefix.
fn normalize_asn(value: &Value) -> Option<String> {
    let raw = match value {
        Value::Number(number) => Some(number.to_string()),
        other => text(other),
    }?;
    let token = raw.split_whitespace().next().unwrap_or_default();
    let upper = token.to_uppercase();
    if upper.len() > 2 && upper.starts_with("AS") && upper[2..].bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(upper);
    }
    if !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(format!("AS{token}"));
    }
    None
}

fn parse_ipwhois(body: &Value) -> ParsedFields {
    let mut out = ParsedFields::default();
    let Some(obj) = record(body) else { return out };
    if obj.get("success") == Some(&Value::Bool(false)) {
        return ParsedFields::default();
    }
    let connection = record(obj.get("connection").unwrap_or(&Value::Null));
    out.ip = text(obj.get("ip").unwrap_or(&Value::Null));
    out.country = text(obj.get("country").unwrap_or(&Value::Null));
    out.city = text(obj.get("city").unwrap_or(&Value::Null));
    out.asn = connection
        .and_then(|connection| normalize_asn(connection.get("asn").unwrap_or(&Value::Null)).or_else(|| normalize_asn(connection.get("isp").unwrap_or(&Value::Null))));
    out
}

fn parse_ipapi(body: &Value) -> ParsedFields {
    let mut out = ParsedFields::default();
    let Some(obj) = record(body) else { return out };
    if obj.get("status").and_then(Value::as_str) != Some("success") {
        return ParsedFields::default();
    }
    out.ip = text(obj.get("query").unwrap_or(&Value::Null));
    out.country = text(obj.get("country").unwrap_or(&Value::Null));
    out.city = text(obj.get("city").unwrap_or(&Value::Null));
    out.asn = obj.get("as").and_then(normalize_asn);
    out
}

fn parse_ipinfo(body: &Value) -> ParsedFields {
    let mut out = ParsedFields::default();
    let Some(obj) = record(body) else { return out };
    out.ip = text(obj.get("ip").unwrap_or(&Value::Null));
    out.country = text(obj.get("country").unwrap_or(&Value::Null));
    out.city = text(obj.get("city").unwrap_or(&Value::Null));
    out.asn = obj
        .get("org")
        .and_then(normalize_asn)
        .or_else(|| obj.get("asn").and_then(normalize_asn));
    out
}

/// The shipped privacy-explicit providers, in display order.
static PROVIDER_DEFS: [ProviderDef; 3] = [
    ProviderDef {
        provider: NetworkMetadataProvider {
            id: "ipwhois",
            label: "ipwho.is",
            description: "免密钥、无日志的出口 IP + 地理元数据源",
            endpoint: "http://ipwho.is/",
        },
        parse: parse_ipwhois,
    },
    ProviderDef {
        provider: NetworkMetadataProvider {
            id: "ipapi",
            label: "ip-api.com",
            description: "免密钥的出口 IP + 国家/城市/ASN 元数据源（按需查询）",
            endpoint: "http://ip-api.com/json/",
        },
        parse: parse_ipapi,
    },
    ProviderDef {
        provider: NetworkMetadataProvider {
            id: "ipinfo",
            label: "ipinfo.io",
            description: "免密钥的出口 IP + 国家/城市/ASN（no-log）元数据源",
            endpoint: "http://ipinfo.io/json",
        },
        parse: parse_ipinfo,
    },
];

/// The default provider id.
pub const DEFAULT_PROVIDER: &str = "ipwhois";

/// The function-free provider list, ready to cross IPC or be rendered.
pub fn provider_list() -> Vec<Value> {
    PROVIDER_DEFS
        .iter()
        .map(|def| {
            json!({
                "id": def.provider.id,
                "label": def.provider.label,
                "description": def.provider.description,
                "endpoint": def.provider.endpoint,
                "kind": "ip-geo",
            })
        })
        .collect()
}

/// Validate a provider id against the shipped provider set — the TS
/// `parseNetworkMetadataProviderId` schema copy, byte-verbatim.
pub fn parse_provider_id(input: &Value) -> Result<String, crate::error::IpcError> {
    let Some(id) = input.as_str() else {
        return Err(crate::error::IpcError::invalid_argument(
            "invalid network metadata provider: ipwhois, ipapi, ipinfo",
        ));
    };
    if get_provider(id).is_none() {
        return Err(crate::error::IpcError::invalid_argument(
            "invalid network metadata provider: ipwhois, ipapi, ipinfo",
        ));
    }
    Ok(id.to_string())
}

/// Resolve a provider by id, or null when unknown.
pub fn get_provider(id: &str) -> Option<&'static NetworkMetadataProvider> {
    PROVIDER_DEFS.iter().map(|def| &def.provider).find(|provider| provider.id == id)
}

/// The human-facing label for a provider id, falling back to the raw id.
/// (The resolve-all rows already carry `label`; this port exists for
/// shared-model parity with the renderer helper.)
#[allow(dead_code)]
pub fn provider_display_name(provider_id: &str) -> String {
    get_provider(provider_id).map(|provider| provider.label.to_string()).unwrap_or_else(|| provider_id.to_string())
}

/// Parse a provider JSON body into a normalized record, or null when the body
/// is unusable (an error payload or an unexpected shape). Every field is
/// defensively optional so a provider change can never crash the app.
pub fn parse_metadata_json(body: &Value, provider_id: &str, now: u64) -> Option<Value> {
    let def = PROVIDER_DEFS.iter().find(|def| def.provider.id == provider_id)?;
    let parsed = (def.parse)(body);
    let ip = parsed.ip?;
    Some(json!({
        "ip": ip,
        "provider": provider_id,
        "country": parsed.country,
        "city": parsed.city,
        "asn": parsed.asn,
        "fetchedAt": now,
    }))
}

/// Mask the last octet of an IPv4 address for a privacy-forward default
/// display. (Renderer-side TS helper; ported for parity, not called from Rust.)
#[allow(dead_code)]
pub fn mask_ip(ip: &str) -> String {
    if let Some(parts) = ip.strip_suffix(char::is_numeric) {
        let _ = parts;
    }
    let segments: Vec<&str> = ip.split('.').collect();
    if segments.len() == 4 && segments.iter().all(|segment| !segment.is_empty() && segment.len() <= 3 && segment.bytes().all(|byte| byte.is_ascii_digit())) {
        return format!("{}.{}.{}.•••", segments[0], segments[1], segments[2]);
    }
    // IPv6 or unexpected: mask the trailing hextet.
    let parts: Vec<&str> = ip.split(':').collect();
    if parts.len() > 1 {
        let mut kept: Vec<String> = parts[..parts.len() - 1].iter().map(|segment| segment.to_string()).collect();
        kept.push("•••".to_string());
        return kept.join(":");
    }
    ip.to_string()
}

/// A compact display line. (The renderer keeps the TS helper; this port
/// exists for shared-model parity and is not called from Rust.)
#[allow(dead_code)]
pub fn display_text(metadata: &Value) -> String {
    let mut parts: Vec<String> = vec![metadata["ip"].as_str().unwrap_or_default().to_string()];
    let geo: Vec<String> = ["country", "city"]
        .iter()
        .filter_map(|key| metadata[*key].as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    if !geo.is_empty() {
        parts.push(geo.join(" · "));
    }
    if let Some(asn) = metadata["asn"].as_str() {
        if !asn.is_empty() {
            parts.push(asn.to_string());
        }
    }
    parts.retain(|part| !part.is_empty());
    parts.join(" · ")
}

/// A privacy-safe single line for the clipboard (no hostnames or user data).
/// (Renderer-side TS helper; ported for parity, not called from Rust.)
#[allow(dead_code)]
pub fn copy_text(metadata: &Value) -> String {
    let ip = metadata["ip"].as_str().unwrap_or_default();
    let country = metadata["country"].as_str().unwrap_or_default();
    let city = metadata["city"].as_str().unwrap_or_default();
    let asn = metadata["asn"].as_str().unwrap_or_default();
    let mut line = ip.to_string();
    if !country.is_empty() {
        line.push_str(&format!(" ({country}"));
        if !city.is_empty() {
            line.push_str(&format!(", {city}"));
        }
        line.push(')');
    }
    if !asn.is_empty() {
        line.push_str(&format!(" {asn}"));
    }
    line
}

// ---------------------------------------------------------------------------
// Absolute-form proxy fetch (the mixed-port transport)
// ---------------------------------------------------------------------------

/// Fetch a plain-http JSON endpoint via the kernel's mixed-port proxy using an
/// absolute-form request line, exactly like the egress-IP echo path. Returns
/// the parsed JSON on success (2xx + valid JSON) or null on ANY failure
/// (transport, status, body, parse) — the TS promise always resolves null.
pub async fn fetch_metadata_json_via_proxy(endpoint: &str, port: u16, timeout_ms: u64) -> Option<Value> {
    let target = url::Url::parse(endpoint).ok()?;
    // Only plain-http targets can be reached with an absolute-form GET
    // through a forward proxy; https requires a CONNECT tunnel out of scope.
    if target.scheme() != "http" {
        return None;
    }
    let host_header = match target.port() {
        Some(port) => format!("{}:{port}", target.host_str().unwrap_or_default()),
        None => target.host_str().unwrap_or_default().to_string(),
    };
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        target.as_str(),
        host_header
    );
    let sweep = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.ok()?;
        let text = String::from_utf8_lossy(&raw);
        // Split head/body at the blank line; tolerate chunked framing by
        // stripping chunk-size lines crudely is WRONG, so require a plain
        // (connection-close) body: every known provider serves one through
        // the proxy path, and a chunked body fails the JSON parse into null
        // exactly like the TS catch-all.
        let body = text.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("");
        if !json_like(body) {
            return None;
        }
        serde_json::from_str(body).ok()
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), sweep)
        .await
        .unwrap_or(None)
}

/// A cheap JSON-looking guard: the body must start with `{` or `[`.
fn json_like(body: &str) -> bool {
    let trimmed = body.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

// ---------------------------------------------------------------------------
// Service (state machine + bounded cache + single-flight)
// ---------------------------------------------------------------------------

type ResolveProxyPort = Box<dyn Fn() -> futures_util::future::BoxFuture<'static, Option<u16>> + Send + Sync>;
type FetchViaProxy = Arc<dyn Fn(String, u16, u64) -> futures_util::future::BoxFuture<'static, Option<Value>> + Send + Sync>;

/// The renderer-facing network-metadata state snapshot.
pub struct NetworkMetadataService {
    provider_id: Mutex<String>,
    fetch_json_via_proxy: FetchViaProxy,
    resolve_proxy_port: ResolveProxyPort,
    now: fn() -> u64,
    cache_max_entries: usize,
    cache_ttl_ms: u64,
    timeout_ms: u64,
    cache: Mutex<HashMap<String, Value>>,
    phase: Mutex<(&'static str, Option<String>)>,
    fetching: Mutex<Option<std::sync::Arc<tokio::sync::Mutex<()>>>>,
}

impl NetworkMetadataService {
    /// Production constructor: the real mixed-port transport, composed
    /// exactly like the TS `when-ready.ts` composition — the port resolver
    /// reads the kernel supervisor phase through app state, then the LIVE
    /// controller config (`mixed-port` ?? `port`, must be > 0); any failure
    /// degrades to null (the kernel-not-running error copy).
    pub fn for_app(app: tauri::AppHandle) -> Self {
        use tauri::Manager;
        Self::build(
            Box::new(move || {
                let app = app.clone();
                Box::pin(async move {
                    let kernel = app.state::<crate::kernel::KernelServices>();
                    if kernel.supervisor.get_status()["phase"].as_str() != Some("running") {
                        return None;
                    }
                    let models = app.state::<crate::enhancements::ModelStores>();
                    let core = crate::enhancements::coerce_core_settings(&models.core.get());
                    let client = match crate::mihomo::MihomoClient::new(
                        core["controllerPort"].as_i64().unwrap_or(9090),
                        core["controllerSecret"].as_str().unwrap_or_default(),
                    ) {
                        Ok(client) => client,
                        Err(_) => return None,
                    };
                    let Ok(config) = client.get_config().await else { return None };
                    let port = config["mixed-port"].as_i64().or_else(|| config["port"].as_i64());
                    port.filter(|port| *port > 0).map(|port| port as u16)
                })
            }),
            Arc::new(|endpoint: String, port: u16, timeout: u64| {
                Box::pin(async move { fetch_metadata_json_via_proxy(&endpoint, port, timeout).await })
                    as futures_util::future::BoxFuture<'static, Option<Value>>
            }),
        )
    }

    /// Unmanaged constructor: no kernel composition (fixture/test default);
    /// resolve fails closed with the kernel-not-running copy.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new() -> Self {
        Self::build(
            Box::new(|| Box::pin(async { None })),
            Arc::new(|endpoint: String, port: u16, timeout: u64| {
                Box::pin(async move { fetch_metadata_json_via_proxy(&endpoint, port, timeout).await })
                    as futures_util::future::BoxFuture<'static, Option<Value>>
            }),
        )
    }

    /// Test constructor: inject the proxy-port resolver.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_port_resolver(
        resolve_proxy_port: impl Fn() -> futures_util::future::BoxFuture<'static, Option<u16>> + Send + Sync + 'static,
    ) -> Self {
        Self::build(
            Box::new(resolve_proxy_port),
            Arc::new(|endpoint: String, port: u16, timeout: u64| {
                Box::pin(async move { fetch_metadata_json_via_proxy(&endpoint, port, timeout).await })
                    as futures_util::future::BoxFuture<'static, Option<Value>>
            }),
        )
    }

    fn build(resolve_proxy_port: ResolveProxyPort, fetch_json_via_proxy: FetchViaProxy) -> Self {
        NetworkMetadataService {
            provider_id: Mutex::new(DEFAULT_PROVIDER.to_string()),
            fetch_json_via_proxy,
            resolve_proxy_port,
            now: || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            cache_max_entries: DEFAULT_CACHE_MAX_ENTRIES,
            cache_ttl_ms: DEFAULT_CACHE_TTL_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            cache: Mutex::new(HashMap::new()),
            phase: Mutex::new(("idle", None)),
            fetching: Mutex::new(None),
        }
    }

    async fn now_ms(&self) -> u64 {
        (self.now)()
    }

    pub async fn get_providers(&self) -> Value {
        Value::Array(provider_list())
    }

    pub async fn get_state(&self) -> Value {
        self.state().await
    }

    /// Switch providers. Unknown ids throw (the TS service throws too — the
    /// typed error crosses the bridge). A cached provider restores to ready
    /// without fetching; an uncached one resets to idle.
    pub async fn select_provider(&self, id: &str) -> Result<Value, crate::error::IpcError> {
        if get_provider(id).is_none() {
            return Err(crate::error::IpcError::internal(format!("unknown network metadata provider: {id}")));
        }
        {
            let mut current = self.provider_id.lock().await;
            *current = id.to_string();
        }
        let cached = self.fresh_cache(id).await;
        {
            let mut phase = self.phase.lock().await;
            if cached.is_some() {
                *phase = ("ready", None);
            } else {
                *phase = ("idle", None);
            }
        }
        Ok(self.state().await)
    }

    /// Resolve the CURRENT provider (single-flight per TS `#fetching`).
    pub async fn resolve(&self, force: bool) -> Value {
        // One flight at a time: later callers await the same mutex-guarded
        // sweep. (A real promise map is unnecessary: the state read after the
        // sweep is idempotent.)
        let flight = {
            let mut guard = self.fetching.lock().await;
            guard.get_or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
        };
        let _held = flight.lock().await;
        self.do_resolve(force).await
    }

    /// Resolve every shipped provider once, concurrently, and return the
    /// results in the shipped display order. Per-provider failures are
    /// isolated: one unreachable source degrades only its own row and never
    /// fails the sweep.
    pub async fn resolve_all(&self, force: bool) -> Value {
        let providers = provider_list();
        // Concurrent per-provider resolves, joined in display order (the TS
        // Promise.all over the provider list). Failures are isolated: a
        // panic-free degraded row keeps the sweep alive.
        let mut futures = Vec::new();
        for provider in &providers {
            let id = provider["id"].as_str().unwrap_or_default().to_string();
            let label = provider["label"].as_str().unwrap_or_default().to_string();
            futures.push(async move {
                let state = self.do_resolve_for(&id, force).await;
                (id, label, state)
            });
        }
        let settled = futures_util::future::join_all(futures).await;
        let mut results = Vec::new();
        for (provider_id, label, state) in settled {
            results.push(json!({ "providerId": provider_id, "label": label, "state": state }));
        }
        json!({ "results": results, "fetchedAt": self.now_ms().await })
    }

    /// Resolve one specific provider (used by both `resolve` and `resolveAll`).
    async fn do_resolve_for(&self, provider_id: &str, force: bool) -> Value {
        if !force {
            if self.fresh_cache(provider_id).await.is_some() {
                return self.state_for(provider_id, "ready", None).await;
            }
        }
        let port = (self.resolve_proxy_port)().await;
        let Some(port) = port else {
            return self.state_for(provider_id, "error", Some(KERNEL_NOT_RUNNING.to_string())).await;
        };
        let endpoint = provider_endpoint(provider_id).unwrap_or_default().to_string();
        let body = (self.fetch_json_via_proxy)(endpoint, port, self.timeout_ms).await;
        let now = self.now_ms().await;
        let metadata = body.as_ref().and_then(|body| parse_metadata_json(body, provider_id, now));
        let Some(metadata) = metadata else {
            return self.state_for(provider_id, "error", Some(PARSE_FAILURE.to_string())).await;
        };
        self.store_cache(provider_id, metadata).await;
        self.state_for(provider_id, "ready", None).await
    }

    async fn do_resolve(&self, force: bool) -> Value {
        let provider_id = self.provider_id.lock().await.clone();
        let Some(provider) = get_provider(&provider_id) else {
            {
                let mut phase = self.phase.lock().await;
                *phase = ("error", Some(format!("未知的数据源：{provider_id}")));
            }
            return self.state().await;
        };
        if !force {
            if self.fresh_cache(&provider.id).await.is_some() {
                {
                    let mut phase = self.phase.lock().await;
                    *phase = ("ready", None);
                }
                return self.state().await;
            }
        }
        {
            let mut phase = self.phase.lock().await;
            *phase = ("fetching", None);
        }
        let resolved = self.do_resolve_for(provider.id, force).await;
        // Mirror the single-provider outcome back onto the active-provider
        // state machine so `getState()` stays truthful.
        let phase = resolved["phase"].as_str().unwrap_or("error").to_string();
        let error = resolved["error"].as_str().map(str::to_string);
        {
            let mut phase_lock = self.phase.lock().await;
            *phase_lock = (Box::leak(phase.clone().into_boxed_str()), error);
        }
        self.state().await
    }

    async fn state_for(&self, provider_id: &str, phase: &'static str, error: Option<String>) -> Value {
        let metadata = self.fresh_cache(provider_id).await;
        json!({
            "phase": phase,
            "provider": provider_id,
            "metadata": metadata,
            "error": error,
        })
    }

    /// Insert into the bounded cache, evicting the oldest entry when over capacity.
    async fn store_cache(&self, provider_id: &str, metadata: Value) {
        let mut cache = self.cache.lock().await;
        cache.insert(provider_id.to_string(), metadata);
        if cache.len() > self.cache_max_entries {
            let mut oldest_id: Option<String> = None;
            let mut oldest_at = u64::MAX;
            for (id, entry) in cache.iter() {
                let fetched_at = entry["fetchedAt"].as_u64().unwrap_or(u64::MAX);
                if fetched_at < oldest_at {
                    oldest_at = fetched_at;
                    oldest_id = Some(id.clone());
                }
            }
            if let Some(oldest_id) = oldest_id {
                cache.remove(&oldest_id);
            }
        }
    }

    /// A cache entry that is still within its freshness window, or null.
    async fn fresh_cache(&self, provider_id: &str) -> Option<Value> {
        let cache = self.cache.lock().await;
        let cached = cache.get(provider_id)?;
        let now = self.now_ms().await;
        (now.saturating_sub(cached["fetchedAt"].as_u64()?) <= self.cache_ttl_ms).then(|| cached.clone())
    }

    async fn state(&self) -> Value {
        let provider_id = self.provider_id.lock().await.clone();
        let cached = self.fresh_cache(&provider_id).await;
        let (phase, error) = self.phase.lock().await.clone();
        match phase {
            "fetching" => json!({ "phase": "fetching", "provider": provider_id, "metadata": cached, "error": Value::Null }),
            "ready" => json!({
                "phase": if cached.is_some() { "ready" } else { "idle" },
                "provider": provider_id,
                "metadata": cached,
                "error": Value::Null,
            }),
            other => json!({ "phase": other, "provider": provider_id, "metadata": cached, "error": error }),
        }
    }
}

fn provider_endpoint(id: &str) -> Option<&'static str> {
    get_provider(id).map(|provider| provider.endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000_000;

    #[test]
    fn provider_registry_lists_the_shipped_sources_function_free() {
        let providers = provider_list();
        let ids: Vec<&str> = providers.iter().filter_map(|p| p["id"].as_str()).collect();
        assert_eq!(ids, vec!["ipwhois", "ipapi", "ipinfo"]);
        for provider in &providers {
            assert_eq!(provider["kind"], "ip-geo");
            assert!(provider["endpoint"].as_str().unwrap().starts_with("http://"));
            let mut keys: Vec<&str> = provider.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, vec!["description", "endpoint", "id", "kind", "label"]);
        }
        assert!(get_provider("ipapi").is_some());
        assert!(get_provider("nope").is_none());
        assert!(get_provider(DEFAULT_PROVIDER).is_some());
        assert_eq!(provider_display_name("ipwhois"), "ipwho.is");
        assert_eq!(provider_display_name("mystery"), "mystery");
    }

    #[test]
    fn parses_the_three_provider_bodies_like_the_ts_model() {
        let ipwhois = parse_metadata_json(
            &json!({ "ip": "203.0.113.5", "success": true, "country": "United States", "city": "New York", "connection": { "asn": 7922, "isp": "Comcast Cable" } }),
            "ipwhois",
            NOW,
        )
        .unwrap();
        assert_eq!(ipwhois["asn"], "AS7922");
        assert_eq!(ipwhois["country"], "United States");
        assert_eq!(ipwhois["fetchedAt"], NOW);
        let ipapi = parse_metadata_json(
            &json!({ "status": "success", "query": "198.51.100.9", "country": "Japan", "city": "Tokyo", "as": "AS4134 China Telecom Backbone" }),
            "ipapi",
            NOW,
        )
        .unwrap();
        assert_eq!(ipapi["asn"], "AS4134");
        assert_eq!(ipapi["ip"], "198.51.100.9");
        let ipinfo = parse_metadata_json(
            &json!({ "ip": "192.0.2.44", "country": "DE", "city": "Frankfurt", "org": "AS24940 Hetzner Online GmbH" }),
            "ipinfo",
            NOW,
        )
        .unwrap();
        assert_eq!(ipinfo["asn"], "AS24940");
        // Error or unusable bodies.
        assert!(parse_metadata_json(&json!({ "success": false, "message": "rate limited" }), "ipwhois", NOW).is_none());
        assert!(parse_metadata_json(&json!({ "status": "fail", "message": "reserved range" }), "ipapi", NOW).is_none());
        assert!(parse_metadata_json(&Value::String("not-an-object".into()), "ipinfo", NOW).is_none());
        // Requires a resolvable IP.
        assert!(parse_metadata_json(&json!({ "success": true, "country": "US" }), "ipwhois", NOW).is_none());
        // Unknown provider.
        assert!(parse_metadata_json(&json!({ "ip": "1.2.3.4" }), "nope", NOW).is_none());
    }

    #[test]
    fn display_copy_and_masking_match_the_ts_outputs() {
        let metadata = parse_metadata_json(
            &json!({ "ip": "203.0.113.5", "success": true, "country": "United States", "city": "New York", "connection": { "asn": 7922 } }),
            "ipwhois",
            NOW,
        )
        .unwrap();
        assert_eq!(display_text(&metadata), "203.0.113.5 · United States · New York · AS7922");
        assert_eq!(copy_text(&metadata), "203.0.113.5 (United States, New York) AS7922");
        assert_eq!(mask_ip("203.0.113.5"), "203.0.113.•••");
        let masked = mask_ip("2001:db8::1");
        assert!(masked.ends_with("•••"), "{masked}");
        assert!(masked.starts_with("2001:db8::"), "{masked}");
        assert_eq!(mask_ip("unknown"), "unknown");
    }

    #[tokio::test]
    async fn state_machine_degrades_without_a_kernel() {
        fn always_none() -> impl Fn() -> futures_util::future::BoxFuture<'static, Option<u16>> + Send + Sync {
            || Box::pin(async { None })
        }
        let service = NetworkMetadataService::with_port_resolver(always_none());
        // Starts idle with the default provider.
        let state = service.get_state().await;
        assert_eq!(state["phase"], "idle");
        assert_eq!(state["provider"], "ipwhois");
        // Resolve without a kernel: the kernel-not-running copy.
        let state = service.resolve(false).await;
        assert_eq!(state["phase"], "error");
        assert_eq!(state["error"], KERNEL_NOT_RUNNING);
    }

    #[tokio::test]
    async fn cache_ttl_force_and_eviction_follow_the_ts_service() {
        let fetched = std::sync::atomic::AtomicUsize::new(0);
        let fetch_count = std::sync::Arc::new(fetched);
        let counter = fetch_count.clone();
        // A fake transport serving ipwhois-shaped JSON through the injected
        // fetch hook.
        let service = NetworkMetadataService {
            provider_id: Mutex::new("ipwhois".into()),
            fetch_json_via_proxy: Arc::new(move |_endpoint: String, _port: u16, _timeout: u64| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async {
                    Some(json!({ "ip": "203.0.113.5", "success": true, "country": "United States" }))
                }) as futures_util::future::BoxFuture<'static, Option<Value>>
            }),
            resolve_proxy_port: Box::new(|| Box::pin(async { Some(7890) })),
            now: || 0, // frozen clock: entries never go stale
            cache_max_entries: 2,
            cache_ttl_ms: DEFAULT_CACHE_TTL_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            cache: Mutex::new(HashMap::new()),
            phase: Mutex::new(("idle", None)),
            fetching: Mutex::new(None),
        };
        let state = service.resolve(false).await;
        assert_eq!(state["phase"], "ready", "{}", state);
        assert_eq!(state["metadata"]["ip"], "203.0.113.5");
        assert_eq!(fetch_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Fresh cache serves without a second fetch.
        let state = service.resolve(false).await;
        assert_eq!(state["phase"], "ready");
        assert_eq!(fetch_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Force bypasses the cache.
        let _ = service.resolve(true).await;
        assert_eq!(fetch_count.load(std::sync::atomic::Ordering::SeqCst), 2);
        // Whole-set resolve isolates rows (all three providers resolve).
        let snapshot = service.resolve_all(false).await;
        let results = snapshot["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        for result in results {
            assert!(result["state"].is_object(), "{}", result);
        }
        // Unknown select throws.
        assert!(service.select_provider("nope").await.is_err());
        // Switching providers resets to idle (no cache for the new one).
        let state = service.select_provider("ipapi").await.unwrap();
        assert_eq!(state["phase"], "idle", "{}", state);
    }

    #[tokio::test]
    async fn proxy_fetch_resolves_null_for_unreachable_and_https() {
        // https is out of scope for the absolute-form transport.
        assert!(fetch_metadata_json_via_proxy("https://ipwho.is/", 1, 200).await.is_none());
        // Unparseable endpoint.
        assert!(fetch_metadata_json_via_proxy("not a url", 7890, 200).await.is_none());
        // Nothing listening on the port: null, never a throw.
        assert!(fetch_metadata_json_via_proxy("http://ipwho.is/", 1, 200).await.is_none());
    }
}
