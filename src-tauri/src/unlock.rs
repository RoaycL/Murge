//! Common-service unlock probes for the 网络诊断 drawer — Rust port of
//! `src/main/services/service-detectors.ts` (pure verdict logic) +
//! `service-unlock-service.ts` (the mixed-port transport), 参考
//! clash-verge-rev 的解锁测试页 (`clash-verge-media-unlock`).
//!
//! Every preset service (AI → streaming → others) is measured through the
//! kernel's LIVE mixed port so the verdict is about the SELECTED NODE's
//! egress, independent of whether the system proxy is on. The per-service
//! logic is PURE: every probe step is data + a decision over
//! {status, body, headers}, so the verdicts are unit-testable without a
//! real transport. A kernel-down port resolves to an UPSTREAM_UNREACHABLE
//! typed error (fail closed) instead of sampling DIRECT.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS: u64 = 8_000;
const MAX_BODY_BYTES: usize = 1_000_000;

// ---------------------------------------------------------------------------
// Probe model (the pure contract)
// ---------------------------------------------------------------------------

/// One HTTP step of a detector flow.
#[derive(Debug, Clone, Default)]
pub struct ProbeStep {
    pub url: String,
    pub method: Option<&'static str>,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl ProbeStep {
    fn get(url: &str) -> Self {
        ProbeStep { url: url.to_string(), ..Default::default() }
    }

    fn post(url: &str, content_type: &str, authorization: &str, body: String) -> Self {
        ProbeStep {
            url: url.to_string(),
            method: Some("POST"),
            headers: vec![
                ("authorization".to_string(), authorization.to_string()),
                ("content-type".to_string(), content_type.to_string()),
            ],
            body: Some(body),
        }
    }
}

/// One probe outcome: HTTP status (null when the request never completed),
/// the (capped) body, and the response headers.
#[derive(Debug, Clone, Default)]
pub struct ProbeResponse {
    pub status: Option<u16>,
    pub body: String,
    pub headers: Vec<(String, Value)>,
}

impl ProbeResponse {
    fn failed() -> Self {
        ProbeResponse::default()
    }

    #[cfg_attr(not(test), allow(dead_code))] // test fixture helper
    fn ok(status: u16, body: impl Into<String>) -> Self {
        ProbeResponse { status: Some(status), body: body.into(), headers: Vec::new() }
    }

    fn header(&self, key: &str) -> Option<&Value> {
        self.headers.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }
}

/// The injectable transport: one probe step → one outcome, never throwing.
pub type Probe = Arc<dyn Fn(ProbeStep) -> futures_util::future::BoxFuture<'static, ProbeResponse> + Send + Sync>;

/// One service's unlock verdict (`ServiceUnlockResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceUnlockResult {
    pub name: String,
    pub status: &'static str,
    pub region: Option<String>,
}

/// The preset services, in display order (AI → streaming → others).
pub const UNLOCK_SERVICES: [&str; 10] =
    ["ChatGPT", "Gemini", "Claude", "Grok", "Netflix", "Disney+", "TikTok", "YouTube", "GitHub", "Spotify"];

// ---------------------------------------------------------------------------
// Shared helpers (Verge semantics)
// ---------------------------------------------------------------------------

/// 403 / 451 mean the egress is actively blocked, not a transient failure.
pub fn classify_blocked_status(status: Option<u16>) -> Option<&'static str> {
    match status {
        Some(403 | 451) => Some("unsupported"),
        None => Some("error"),
        Some(status) if status < 200 || status >= 300 => Some("error"),
        Some(_) => None,
    }
}

/// Verge `get_trace_location`: value of the `loc=` line in a Cloudflare trace.
pub fn trace_location(body: &str) -> Option<String> {
    let line = body.lines().find(|candidate| candidate.starts_with("loc="))?;
    let value = line[4..].trim();
    (!value.is_empty()).then(|| value.to_uppercase())
}

/// Verge `extract_quoted_field`: first `"key":"value"` occurrence in a JSON-ish body.
pub fn extract_quoted_field(body: &str, key: &str) -> Option<String> {
    // Case-insensitive key match, exactly the TS `i` flag.
    let lower_key = key.to_lowercase();
    let mut rest = body;
    while let Some(start) = rest.find('"') {
        let after_open = &rest[start + 1..];
        let Some(close) = after_open.find('"') else { break };
        let candidate = &after_open[..close];
        if candidate.to_lowercase() == lower_key {
            let tail = &after_open[close + 1..];
            let trimmed = tail.trim_start();
            if let Some(value) = trimmed.strip_prefix(':') {
                let value = value.trim_start();
                if let Some(value) = value.strip_prefix('"') {
                    if let Some(end) = value.find('"') {
                        return Some(value[..end].to_string());
                    }
                }
            }
        }
        rest = &after_open[close + 1..];
    }
    None
}

fn normalize_region(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_uppercase();
    (!trimmed.is_empty()).then_some(trimmed)
}

const CLAUDE_BLOCKED: [&str; 10] = ["AF", "BY", "CN", "CU", "HK", "IR", "KP", "MO", "RU", "SY"];
const GEMINI_BLOCKED: [&str; 9] = ["CHN", "RUS", "BLR", "CUB", "IRN", "PRK", "SYR", "HKG", "MAC"];
// Grok (x.ai) publishes no machine-readable availability endpoint; its block
// list tracks the same sanctioned/unsupported regions as the other AI vendors.
// (Declared but unused in the TS detector too — kept for parity.)
#[allow(dead_code)]
const GROK_BLOCKED: [&str; 10] = ["AF", "BY", "CN", "CU", "HK", "IR", "KP", "MO", "RU", "SY"];

// ---------------------------------------------------------------------------
// Detectors (one fn per service, Verge verdict semantics)
// ---------------------------------------------------------------------------

/// ChatGPT — Verge chatgpt.rs: compliance endpoint body + optional trace region.
pub async fn chatgpt(probe: &Probe) -> ServiceUnlockResult {
    let trace = (probe)(ProbeStep::get("https://chat.openai.com/cdn-cgi/trace")).await;
    let region = normalize_region(trace_location(&trace.body));
    let compliance = (probe)(ProbeStep::get("https://api.openai.com/compliance/cookie_requirements")).await;
    if compliance.status.is_none() {
        return verdict("ChatGPT", "error", region);
    }
    if compliance.body.to_lowercase().contains("unsupported_country") {
        return verdict("ChatGPT", "unsupported", region);
    }
    verdict("ChatGPT", "supported", region)
}

/// Claude — Verge claude.rs: trace loc= against the blocked-country list.
pub async fn claude(probe: &Probe) -> ServiceUnlockResult {
    let trace = (probe)(ProbeStep::get("https://claude.ai/cdn-cgi/trace")).await;
    if trace.status.is_none() {
        return verdict("Claude", "error", None);
    }
    let Some(region) = normalize_region(trace_location(&trace.body)) else {
        return verdict("Claude", "error", None);
    };
    if CLAUDE_BLOCKED.contains(&region.as_str()) {
        return verdict("Claude", "unsupported", Some(region));
    }
    verdict("Claude", "supported", Some(region))
}

/// Gemini — Verge gemini.rs: alpha-3 marker after the hardcoded payload marker.
pub async fn gemini(probe: &Probe) -> ServiceUnlockResult {
    let page = (probe)(ProbeStep::get("https://gemini.google.com")).await;
    if page.status.is_none() {
        return verdict("Gemini", "error", None);
    }
    let marker = ",2,1,200,\"";
    let code = match page.body.find(marker) {
        Some(index) => &page.body[index + marker.len()..(index + marker.len() + 3).min(page.body.len())],
        None => "",
    };
    let valid = code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_uppercase());
    if !valid {
        return verdict("Gemini", "error", None);
    }
    if GEMINI_BLOCKED.contains(&code) {
        return verdict("Gemini", "unsupported", Some(code.to_string()));
    }
    verdict("Gemini", "supported", Some(code.to_string()))
}

/// Grok — authored for this app (Verge has no check): homepage gate + trace region.
pub async fn grok(probe: &Probe) -> ServiceUnlockResult {
    let trace = (probe)(ProbeStep::get("https://grok.com/cdn-cgi/trace")).await;
    let region = normalize_region(trace_location(&trace.body));
    let page = (probe)(ProbeStep::get("https://grok.com/")).await;
    if let Some(blocked) = classify_blocked_status(page.status) {
        return verdict("Grok", blocked, region);
    }
    if page.body.to_lowercase().contains("not available in your region") {
        return verdict("Grok", "unsupported", region);
    }
    verdict("Grok", "supported", region)
}

/// Netflix — Verge netflix.rs: fast.com CDN, then original/non-original titles.
pub async fn netflix(probe: &Probe) -> ServiceUnlockResult {
    let cdn = (probe)(ProbeStep::get(
        "https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5",
    ))
    .await;
    if cdn.status.is_none() {
        return verdict("Netflix", "error", None);
    }
    if cdn.status == Some(403) {
        return verdict("Netflix", "unsupported", None);
    }
    let cdn_region: Option<String> = serde_json::from_str::<Value>(&cdn.body)
        .ok()
        .and_then(|parsed| {
            let targets = parsed["targets"].as_array()?;
            let country = targets.first()?["location"]["country"].as_str()?;
            Some(country.to_string())
        })
        .map(Some)
        .and_then(normalize_region);
    let Some(cdn_region) = cdn_region else {
        return verdict("Netflix", "error", None);
    };
    let (self_produced, region_locked) = futures_util::future::join(
        (probe)(ProbeStep::get("https://www.netflix.com/title/81280792")),
        (probe)(ProbeStep::get("https://www.netflix.com/title/70143836")),
    )
    .await;
    if self_produced.status == Some(404) && region_locked.status == Some(404) {
        return verdict("Netflix", "unsupported", Some(cdn_region));
    }
    if self_produced.status == Some(403) || region_locked.status == Some(403) {
        return verdict("Netflix", "unsupported", Some(cdn_region));
    }
    let ok = |status: Option<u16>| status == Some(200) || status == Some(301);
    if !ok(self_produced.status) || !ok(region_locked.status) {
        return verdict("Netflix", "error", Some(cdn_region));
    }
    let region_probe = (probe)(ProbeStep::get("https://www.netflix.com/title/80018499")).await;
    // Stage-3 location header (absolute URL; 4th path segment, pre-dash).
    let segment = region_probe
        .header("location")
        .and_then(Value::as_str)
        .and_then(|location| location.split('/').nth(3))
        .map(str::to_string);
    let region = normalize_region(segment.and_then(|segment| segment.split('-').next().map(str::to_string)))
        .or(Some(cdn_region));
    verdict("Netflix", "supported", region)
}

const DISNEY_AUTH: &str = "Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84";

/// Disney+ — Verge disney_plus.rs: device-assertion → token → graphql country.
pub async fn disney_plus(probe: &Probe) -> ServiceUnlockResult {
    let assertion_step = (probe)(ProbeStep::post(
        "https://disney.api.edge.bamgrid.com/devices",
        "application/json",
        DISNEY_AUTH,
        json!({ "deviceFamily": "browser", "applicationRuntime": "chrome", "deviceProfile": "windows", "attributes": {} })
            .to_string(),
    ))
    .await;
    if assertion_step.status == Some(403) {
        return verdict("Disney+", "unsupported", None);
    }
    if assertion_step.status.is_none() {
        return verdict("Disney+", "error", None);
    }
    let assertion = serde_json::from_str::<Value>(&assertion_step.body)
        .ok()
        .and_then(|parsed| parsed["assertion"].as_str().map(str::to_string));
    let Some(assertion) = assertion else {
        return verdict("Disney+", "error", None);
    };
    let token_body = serde_urlencoded(&[
        ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
        ("latitude", "0"),
        ("longitude", "0"),
        ("platform", "browser"),
        ("subject_token", &assertion),
        ("subject_token_type", "urn:bamtech:params:oauth:token-type:device"),
    ]);
    let token_step = (probe)(ProbeStep::post(
        "https://disney.api.edge.bamgrid.com/token",
        "application/x-www-form-urlencoded",
        DISNEY_AUTH,
        token_body,
    ))
    .await;
    if token_step.status == Some(403)
        || token_step.body.contains("forbidden-location")
        || token_step.body.contains("403 ERROR")
    {
        return verdict("Disney+", "unsupported", None);
    }
    let refresh_token = serde_json::from_str::<Value>(&token_step.body)
        .ok()
        .and_then(|parsed| parsed["refresh_token"].as_str().map(str::to_string));
    let Some(refresh_token) = refresh_token else {
        return verdict("Disney+", "error", None);
    };
    let graph = (probe)(ProbeStep::post(
        "https://disney.api.edge.bamgrid.com/graph/v1/device/graphql",
        "application/json",
        DISNEY_AUTH,
        json!({
            "query": "mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }",
            "variables": { "input": { "refreshToken": refresh_token } }
        })
        .to_string(),
    ))
    .await;
    if graph.status.is_none() || graph.status.is_some_and(|status| status < 200 || status >= 300) {
        return verdict("Disney+", "error", None);
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&graph.body) else {
        return verdict("Disney+", "error", None);
    };
    let mut country: Option<String> = None;
    let mut in_supported: Option<bool> = None;
    walk_graphql(&parsed, &mut country, &mut in_supported);
    let Some(region) = normalize_region(country) else {
        return verdict("Disney+", "error", None);
    };
    if region == "JP" {
        return verdict("Disney+", "supported", Some(region));
    }
    if in_supported == Some(true) {
        return verdict("Disney+", "supported", Some(region));
    }
    if in_supported == Some(false) {
        return verdict("Disney+", "unsupported", Some(region));
    }
    verdict("Disney+", "error", Some(region))
}

/// First-match walk of the graphql tree for `countryCode` + `inSupportedLocation`.
fn walk_graphql(node: &Value, country: &mut Option<String>, in_supported: &mut Option<bool>) {
    if country.is_some() && in_supported.is_some() {
        return;
    }
    match node {
        Value::Array(items) => {
            for item in items {
                walk_graphql(item, country, in_supported);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                if key == "countryCode" && country.is_none() {
                    if let Some(text) = value.as_str() {
                        *country = Some(text.to_string());
                    }
                }
                if key == "inSupportedLocation" && in_supported.is_none() {
                    if let Some(flag) = value.as_bool() {
                        *in_supported = Some(flag);
                    }
                }
                walk_graphql(value, country, in_supported);
            }
        }
        _ => {}
    }
}

/// `application/x-www-form-urlencoded` body (the TS URLSearchParams copy).
fn serde_urlencoded(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
        .collect::<Vec<String>>()
        .join("&")
}

fn form_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => encoded.push(byte as char),
            b' ' => encoded.push('+'),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

/// TikTok — Verge tiktok.rs: homepage gate + trace/marker region.
pub async fn tiktok(probe: &Probe) -> ServiceUnlockResult {
    let trace = (probe)(ProbeStep::get("https://www.tiktok.com/cdn-cgi/trace")).await;
    let region = normalize_region(trace_location(&trace.body));
    let homepage = (probe)(ProbeStep::get("https://www.tiktok.com/")).await;
    match classify_blocked_status(homepage.status) {
        Some(blocked) => verdict("TikTok", blocked, region),
        None => {
            let text = homepage.body.to_lowercase();
            if text.contains("access denied") || text.contains("not available in your region") || text.contains("tiktok is not available") {
                return verdict("TikTok", "unsupported", region);
            }
            if let Some(status) = homepage.status {
                if (200..300).contains(&status) {
                    let marker = normalize_region(extract_quoted_field(&homepage.body, "region").and_then(|value| value.split('-').next().map(str::to_string)));
                    return verdict("TikTok", "supported", region.or(marker));
                }
            }
            verdict("TikTok", "error", region)
        }
    }
}

/// YouTube Premium — Verge youtube.rs: premium availability markers + GL region.
pub async fn youtube(probe: &Probe) -> ServiceUnlockResult {
    let page = (probe)(ProbeStep::get("https://www.youtube.com/premium?hl=en")).await;
    if page.status.is_none() {
        return verdict("YouTube", "error", None);
    }
    let region = normalize_region(
        extract_quoted_field(&page.body, "GL")
            .or_else(|| extract_quoted_field(&page.body, "countryCode"))
            .or_else(|| extract_quoted_field(&page.body, "country_code")),
    );
    let text = page.body.to_lowercase();
    if text.contains("premium is not available in your country") || text.contains("premium is not available in your region") {
        return verdict("YouTube", "unsupported", region);
    }
    if let Some(status) = page.status {
        if (200..300).contains(&status)
            && (text.contains("youtube premium") || text.contains("ad-free") || text.contains("\"browseid\":\"spunlimited\""))
        {
            return verdict("YouTube", "supported", region);
        }
    }
    verdict("YouTube", "error", region)
}

/// GitHub — authored for this app (Verge has no check): homepage gate + trace region.
pub async fn github(probe: &Probe) -> ServiceUnlockResult {
    let trace = (probe)(ProbeStep::get("https://github.com/cdn-cgi/trace")).await;
    let region = normalize_region(trace_location(&trace.body));
    let page = (probe)(ProbeStep::get("https://github.com/")).await;
    if let Some(blocked) = classify_blocked_status(page.status) {
        return verdict("GitHub", blocked, region);
    }
    verdict("GitHub", "supported", region)
}

/// Spotify — Verge spotify.rs: country-selector API gate + market region.
pub async fn spotify(probe: &Probe) -> ServiceUnlockResult {
    let selector = (probe)(ProbeStep::get(
        "https://www.spotify.com/api/content/v1/country-selector?platform=web&format=json",
    ))
    .await;
    if selector.status == Some(403) || selector.status == Some(451) {
        return verdict("Spotify", "unsupported", None);
    }
    match selector.status {
        None => return verdict("Spotify", "error", None),
        Some(status) if status < 200 || status >= 300 => return verdict("Spotify", "error", None),
        _ => {}
    }
    if selector.body.to_lowercase().contains("not available in your country") {
        return verdict("Spotify", "unsupported", None);
    }
    let region = normalize_region(extract_quoted_field(&selector.body, "countryCode"));
    verdict("Spotify", "supported", region)
}

fn verdict(name: &str, status: &'static str, region: Option<String>) -> ServiceUnlockResult {
    ServiceUnlockResult { name: name.to_string(), status, region }
}

// ---------------------------------------------------------------------------
// Registry + dispatch (the TS detectService contract)
// ---------------------------------------------------------------------------

type DetectorFn = fn(&Probe) -> futures_util::future::BoxFuture<'static, ServiceUnlockResult>;

macro_rules! detector {
    ($name:literal, $fn_name:ident) => {
        (
            $name,
            |probe: &Probe| {
                // The future must own the probe: clone the Arc in.
                let probe = probe.clone();
                Box::pin(async move { $fn_name(&probe).await })
                    as futures_util::future::BoxFuture<'static, ServiceUnlockResult>
            },
        )
    };
}

fn detector_registry() -> &'static [(&'static str, DetectorFn)] {
    &[
        detector!("ChatGPT", chatgpt),
        detector!("Gemini", gemini),
        detector!("Claude", claude),
        detector!("Grok", grok),
        detector!("Netflix", netflix),
        detector!("Disney+", disney_plus),
        detector!("TikTok", tiktok),
        detector!("YouTube", youtube),
        detector!("GitHub", github),
        detector!("Spotify", spotify),
    ]
}

/// Validate an unlock service name against the shipped set — the TS
/// `parseUnlockServiceName` copy, byte-verbatim.
pub fn parse_unlock_service_name(input: &Value) -> Result<String, crate::error::IpcError> {
    let name = input.as_str().unwrap_or_default();
    if UNLOCK_SERVICES.contains(&name) {
        return Ok(name.to_string());
    }
    Err(crate::error::IpcError::invalid_argument(format!(
        "invalid unlock service: {}",
        UNLOCK_SERVICES.join(", ")
    )))
}

/// Run one named detector. A probe resolves to `{status, body, headers}`;
/// every transport failure is the detector's `error` verdict, never a throw.
/// Unknown names resolve as an error row so a stale renderer cannot crash IPC.
pub async fn detect_service(name: &str, probe: Probe) -> ServiceUnlockResult {
    let Some((_, detector)) = detector_registry().iter().find(|(known, _)| *known == name) else {
        return ServiceUnlockResult { name: name.to_string(), status: "error", region: None };
    };
    detector(&probe).await
}

/// The wire shape (`{ name, status, region }`).
pub fn result_to_value(result: &ServiceUnlockResult) -> Value {
    json!({
        "name": result.name,
        "status": result.status,
        "region": result.region,
    })
}

/// Test every preset service concurrently, in display order.
pub async fn sample(probe_for: impl Fn(&str) -> Probe) -> Vec<Value> {
    let mut futures = Vec::new();
    for (name, _) in detector_registry() {
        futures.push(detect_service(name, probe_for(name)));
    }
    futures_util::future::join_all(futures)
        .await
        .iter()
        .map(result_to_value)
        .collect()
}

// ---------------------------------------------------------------------------
// The real transport (Electron `net` + probe session analog)
// ---------------------------------------------------------------------------

/// Build the real probe transport: redirect-following requests through the
/// kernel's LIVE mixed port, a Chrome UA, a session-scoped cookie jar (the
/// Disney+ flow needs it), a bounded per-request timeout, and a 1 MiB body
/// cap. Any transport failure degrades to `{status: null, body: '', headers: {}}`.
pub fn real_probe(mixed_port: u16) -> Probe {
    // One client per service test: the session-scoped cookie jar (Disney+
    // device→token→graphql) and the fixed mixed-port proxy are both bound at
    // build time, exactly the TS probe-session semantics.
    let client = std::sync::OnceLock::<reqwest::Client>::new();
    Arc::new(move |step: ProbeStep| {
        let client = client.get_or_init(|| {
            let builder = reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
                .cookie_store(true)
                .redirect(reqwest::redirect::Policy::default());
            match reqwest::Proxy::http(format!("http://127.0.0.1:{mixed_port}")) {
                Ok(proxy) => builder.proxy(proxy).build().unwrap_or_else(|_| reqwest::Client::new()),
                Err(_) => reqwest::Client::new(),
            }
        });
        let client = client.clone();
        Box::pin(async move {
            let mut request = match step.method {
                Some("POST") => client.post(&step.url),
                _ => client.get(&step.url),
            };
            for (key, value) in &step.headers {
                request = request.header(key, value);
            }
            if let Some(body) = step.body {
                request = request.body(body);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(_) => return ProbeResponse::failed(),
            };
            let status = response.status().as_u16();
            let mut headers = Vec::new();
            for (name, value) in response.headers() {
                if let Ok(text) = value.to_str() {
                    headers.push((name.as_str().to_string(), json!(text)));
                }
            }
            // Bounded body: at most 1 MiB is pulled (the TS cap drops later
            // chunks but still completes).
            let mut body = Vec::new();
            let mut stream = response;
            while body.len() < MAX_BODY_BYTES {
                match stream.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    _ => break,
                }
            }
            ProbeResponse {
                status: Some(status),
                body: String::from_utf8_lossy(&body).to_string(),
                headers,
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scripted(responses: Vec<ProbeResponse>) -> Probe {
        let queue = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(responses)));
        Arc::new(move |_step: ProbeStep| {
            let next = queue
                .lock()
                .expect("scripted queue")
                .pop_front()
                .unwrap_or_else(ProbeResponse::failed);
            Box::pin(async move { next })
        })
    }

    #[test]
    fn helpers_match_the_verge_semantics() {
        assert_eq!(trace_location("fl=1\nloc=US\ntls=1.3"), Some("US".to_string()));
        assert_eq!(trace_location("loc=de\n"), Some("DE".to_string()));
        assert_eq!(trace_location("no loc here"), None);
        assert_eq!(extract_quoted_field(r#"{"GL":"US"}"#, "gl"), Some("US".to_string()));
        assert_eq!(extract_quoted_field("noise", "GL"), None);
        assert_eq!(classify_blocked_status(Some(403)), Some("unsupported"));
        assert_eq!(classify_blocked_status(Some(451)), Some("unsupported"));
        assert_eq!(classify_blocked_status(None), Some("error"));
        assert_eq!(classify_blocked_status(Some(200)), None);
    }

    #[tokio::test]
    async fn chatgpt_claude_gemini_follow_the_verge_verdicts() {
        // ChatGPT: unsupported_country body marks 不支持; clean body marks 支持.
        let blocked = chatgpt(&scripted(vec![ProbeResponse::ok(200, "loc=US\n"), ProbeResponse::ok(200, "{\"unsupported_country_region_territory\":true}")])).await;
        assert_eq!(blocked.status, "unsupported");
        assert_eq!(blocked.region.as_deref(), Some("US"));
        let clean = chatgpt(&scripted(vec![ProbeResponse::ok(200, ""), ProbeResponse::ok(200, "{}")])).await;
        assert_eq!(clean.status, "supported");
        let dead = chatgpt(&scripted(vec![ProbeResponse::failed(), ProbeResponse::failed()])).await;
        assert_eq!(dead.status, "error");
        // Claude: blocked list → 不支持; missing trace → 测试失败.
        let blocked = claude(&scripted(vec![ProbeResponse::ok(200, "loc=HK\n")])).await;
        assert_eq!(blocked.status, "unsupported");
        let ok = claude(&scripted(vec![ProbeResponse::ok(200, "loc=SG\n")])).await;
        assert_eq!(ok.status, "supported");
        let dead = claude(&scripted(vec![ProbeResponse::failed()])).await;
        assert_eq!(dead.status, "error");
        let no_region = claude(&scripted(vec![ProbeResponse::ok(200, "fl=1\n")])).await;
        assert_eq!(no_region.status, "error");
        // Gemini: 3-char uppercase marker after the payload constant.
        let page = format!("{}{}{}", "payload ", ",2,1,200,\"", "CHN\" tail");
        let blocked = gemini(&scripted(vec![ProbeResponse::ok(200, page)])).await;
        assert_eq!(blocked.status, "unsupported");
        let ok = gemini(&scripted(vec![ProbeResponse::ok(200, format!("x,2,1,200,\"{}\"", "SGP"))])).await;
        assert_eq!(ok.status, "supported");
    }

    #[tokio::test]
    async fn grok_netflix_disney_follow_the_ts_fixtures() {
        // Grok: homepage gate + trace region.
        let blocked = grok(&scripted(vec![ProbeResponse::ok(200, "loc=CN\n"), ProbeResponse::ok(200, "not available in your region")])).await;
        assert_eq!(blocked.status, "unsupported");
        let ok = grok(&scripted(vec![ProbeResponse::ok(200, "loc=US\n"), ProbeResponse::ok(200, "home")])).await;
        assert_eq!(ok.status, "supported");
        // Netflix: fast.com CDN verdict, 403 → banned, titles gate → stage-3 region.
        let cdn_body = r#"{"targets":[{"location":{"country":"JP"}}]}"#;
        let banned = netflix(&scripted(vec![ProbeResponse { status: Some(403), ..Default::default() }])).await;
        assert_eq!(banned.status, "unsupported");
        let ok_case = netflix(&scripted(vec![
            ProbeResponse::ok(200, cdn_body),
            ProbeResponse::ok(200, "title page"),
            ProbeResponse::ok(200, "title page"),
        ]))
        .await;
        assert_eq!(ok_case.name, "Netflix");
        assert_eq!(ok_case.status, "supported");
        assert_eq!(ok_case.region.as_deref(), Some("JP"));
        let with_location = netflix(&scripted(vec![
            ProbeResponse::ok(200, cdn_body),
            ProbeResponse { status: Some(301), body: String::new(), headers: Vec::new() },
            ProbeResponse::ok(200, ""),
            ProbeResponse { status: Some(200), body: String::new(), headers: vec![("location".into(), json!("https://www.netflix.com/us/title/80018499"))] },
        ]))
        .await;
        assert_eq!(with_location.region.as_deref(), Some("US"));
        let no_region = netflix(&scripted(vec![ProbeResponse::ok(200, r#"{"targets":[]}"#)])).await;
        assert_eq!(no_region.status, "error");
        // Disney+: JP short-circuits to 支持; inSupportedLocation false → 不支持.
        let assertion = r#"{"assertion":"A1"}"#;
        let token = r#"{"refresh_token":"R1"}"#;
        let graph = |country: &str, supported: bool| {
            json!({ "data": { "activeSession": { "countryCode": country, "inSupportedLocation": supported } } }).to_string()
        };
        let jp = disney_plus(&scripted(vec![
            ProbeResponse::ok(200, assertion),
            ProbeResponse::ok(200, token),
            ProbeResponse::ok(200, graph("JP", false)),
        ]))
        .await;
        assert_eq!(jp.status, "supported");
        assert_eq!(jp.region.as_deref(), Some("JP"));
        let banned = disney_plus(&scripted(vec![ProbeResponse { status: Some(403), ..Default::default() }])).await;
        assert_eq!(banned.status, "unsupported");
        let soon = disney_plus(&scripted(vec![
            ProbeResponse::ok(200, assertion),
            ProbeResponse::ok(200, token),
            ProbeResponse::ok(200, graph("TR", false)),
        ]))
        .await;
        assert_eq!(soon.status, "unsupported");
        let supported = disney_plus(&scripted(vec![
            ProbeResponse::ok(200, assertion),
            ProbeResponse::ok(200, token),
            ProbeResponse::ok(200, graph("SG", true)),
        ]))
        .await;
        assert_eq!(supported.status, "supported");
        assert_eq!(supported.region.as_deref(), Some("SG"));
    }

    #[tokio::test]
    async fn tiktok_youtube_github_spotify_follow_the_ts_fixtures() {
        // TikTok: keyword blocklist → 不支持; trace region wins, homepage marker fallback.
        let blocked = tiktok(&scripted(vec![ProbeResponse::ok(200, "loc=SG"), ProbeResponse::ok(200, "Access Denied")])).await;
        assert_eq!(blocked.status, "unsupported");
        let with_trace = tiktok(&scripted(vec![ProbeResponse::ok(200, "loc=SG"), ProbeResponse::ok(200, r#"{"region":"ALISG-1"}"#)])).await;
        assert_eq!(with_trace.name, "TikTok");
        assert_eq!(with_trace.status, "supported");
        assert_eq!(with_trace.region.as_deref(), Some("SG"));
        let fallback = tiktok(&scripted(vec![ProbeResponse::ok(200, ""), ProbeResponse::ok(200, r#"{"region":"ALISG-1"}"#)])).await;
        assert_eq!(fallback.region.as_deref(), Some("ALISG"));
        // YouTube Premium: availability keywords + GL region.
        let ok = youtube(&scripted(vec![ProbeResponse::ok(200, r#"Enjoy YouTube Premium ad-free {"GL":"US"}"#)])).await;
        assert_eq!(ok.status, "supported");
        assert_eq!(ok.region.as_deref(), Some("US"));
        let blocked = youtube(&scripted(vec![ProbeResponse::ok(200, r#"Premium is not available in your country {"GL":"CN"}"#)])).await;
        assert_eq!(blocked.status, "unsupported");
        assert_eq!(blocked.region.as_deref(), Some("CN"));
        // GitHub: homepage reachable → 支持 with trace region.
        let ok = github(&scripted(vec![ProbeResponse::ok(200, "loc=NL"), ProbeResponse::ok(200, "github home")])).await;
        assert_eq!(ok.status, "supported");
        assert_eq!(ok.region.as_deref(), Some("NL"));
        let blocked = github(&scripted(vec![ProbeResponse::ok(200, "loc=NL"), ProbeResponse { status: Some(451), ..Default::default() }])).await;
        assert_eq!(blocked.status, "unsupported");
        // Spotify: country-selector API gate + market region.
        let ok = spotify(&scripted(vec![ProbeResponse::ok(200, r#"{"countryCode":"US","lists":[]}"#)])).await;
        assert_eq!(ok.status, "supported");
        assert_eq!(ok.region.as_deref(), Some("US"));
        let blocked = spotify(&scripted(vec![ProbeResponse::ok(200, "not available in your country")])).await;
        assert_eq!(blocked.status, "unsupported");
        let banned = spotify(&scripted(vec![ProbeResponse { status: Some(403), ..Default::default() }])).await;
        assert_eq!(banned.status, "unsupported");
    }

    #[tokio::test]
    async fn unknown_names_degrade_and_every_detector_survives_transport_failure() {
        let unknown = detect_service("未知服务", scripted(Vec::new())).await;
        assert_eq!(unknown.name, "未知服务");
        assert_eq!(unknown.status, "error");
        let dead_probe = scripted(Vec::new());
        for (name, _) in detector_registry() {
            let result = detect_service(name, dead_probe.clone()).await;
            assert_eq!(result.status, "error", "{name}");
            assert_eq!(result.region, None);
        }
        // The wire shape.
        let value = result_to_value(&ServiceUnlockResult { name: "GitHub".into(), status: "supported", region: Some("NL".into()) });
        assert_eq!(value, json!({ "name": "GitHub", "status": "supported", "region": "NL" }));
    }
}
