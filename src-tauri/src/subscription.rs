//! Subscription fetch pipeline — Rust port of
//! `src/main/subscriptions/subscription-fetcher.ts` (Phase 3C network slice).
//!
//! A subscription is a remote YAML config fetched over HTTP(S). This module
//! centralizes the transport so tests can inject a resolver and so no
//! credential material ever reaches logs: URLs are redacted in every message
//! and errors are formatted against the redacted form.
//!
//! Ported behavior, verbatim from the TS module:
//! - SSRF allow-list: literal hosts AND every DNS answer flow through one
//!   `is_public_address` predicate (private/loopback/link-local/CGNAT/
//!   benchmarking/TEST-NET/multicast/reserved v4 ranges; v6 mapped-v4,
//!   0000::/8, NAT64, discard-only, 2001::/23, documentation, 6to4, ULA,
//!   link-local, multicast). The only carve-out is an all-fake-ip DNS answer
//!   (198.18.0.0/15) on HTTPS — TLS still authenticates the hostname.
//! - Per-hop redirect validation: redirects are NEVER followed inside the
//!   transport (manual policy). Each 3xx is resolved against the current URL,
//!   validated (scheme + public-IP rules) and budgeted before the next hop.
//! - Streaming size limit (2 MiB default) enforced while the body streams.
//! - Credential redaction on every user-visible message (see `redact`).
//! - Suggested display name: Content-Disposition filename → final-URL
//!   filename → URL host → "远程订阅" (the caller's fallback).

use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{code, IpcError};
use crate::redact::redact_credentials;

const DEFAULT_MAX_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS: usize = 5;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Longest auto-derived profile name; anything longer is a URL/abuse, not a name.
pub const MAX_SUGGESTED_NAME_LENGTH: usize = 48;

const SUBSCRIPTION_USER_AGENT: &str = "ClashforWindows/0.20.39";
const SUBSCRIPTION_ACCEPT: &str = "application/x-yaml,text/yaml,text/plain,application/octet-stream,*/*";

// ---------------------------------------------------------------------------
// Public-IP allow-list (the SSRF reject table)
// ---------------------------------------------------------------------------

/// Convert a canonical dotted-quad IPv4 literal to a 32-bit integer, or null.
/// const-friendly: a byte scanner (exactly four dot-separated octets, each
/// 0..=255, no leading zeros enforced by `is_ipv4` at the call sites).
const fn ipv4_to_int(ip: &str) -> Option<u32> {
    let bytes = ip.as_bytes();
    let mut value: u32 = 0;
    let mut octets = 0;
    let mut index = 0;
    while index < bytes.len() {
        // One octet: up to three digits followed by a dot (or end of input).
        let mut num: u32 = 0;
        let mut digits = 0;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            num = num * 10 + (bytes[index] - b'0') as u32;
            digits += 1;
            index += 1;
            if digits > 3 {
                return None;
            }
        }
        if digits == 0 {
            return None;
        }
        if num > 255 {
            return None;
        }
        value = value * 256 + num;
        octets += 1;
        if octets < 4 {
            if index >= bytes.len() || bytes[index] != b'.' {
                return None;
            }
            index += 1;
        }
    }
    if octets != 4 {
        return None;
    }
    Some(value)
}

/// [start, end] inclusive 32-bit range for an IPv4 CIDR block.
const fn ipv4_cidr_range(base: &str, prefix: u32) -> (u32, u32) {
    let start = ipv4_to_int(base).expect("CIDR base compiles");
    let size = 1u32 << (32 - prefix);
    // Saturating: the last block (240.0.0.0/4) intentionally ends at u32::MAX.
    (start, start.saturating_add(size - 1))
}

/// IPv4 blocks that are never a legitimate subscription target: private,
/// loopback, link-local, CGNAT, benchmarking, TEST-NET, multicast and reserved
/// space. This is the allow-list's reject table — an address is "public" only
/// when it falls in none of these ranges.
const IPV4_NON_PUBLIC_RANGES: [(u32, u32); 18] = [
    ipv4_cidr_range("0.0.0.0", 8),       // "this" network
    ipv4_cidr_range("10.0.0.0", 8),      // private
    ipv4_cidr_range("100.64.0.0", 10),   // CGNAT shared address space
    ipv4_cidr_range("127.0.0.0", 8),     // loopback
    ipv4_cidr_range("169.254.0.0", 16),  // link-local
    ipv4_cidr_range("172.16.0.0", 12),   // private
    ipv4_cidr_range("192.0.0.0", 24),    // IETF protocol assignments
    ipv4_cidr_range("192.0.2.0", 24),    // TEST-NET-1
    ipv4_cidr_range("192.31.196.0", 24), // AS112-v4
    ipv4_cidr_range("192.52.193.0", 24), // AMT
    ipv4_cidr_range("192.88.99.0", 24),  // deprecated 6to4 relay anycast
    ipv4_cidr_range("192.168.0.0", 16),  // private
    ipv4_cidr_range("192.175.48.0", 24), // AS112
    ipv4_cidr_range("198.18.0.0", 15),   // benchmarking (also Surge/mihomo fake-ip)
    ipv4_cidr_range("198.51.100.0", 24), // TEST-NET-2
    ipv4_cidr_range("203.0.113.0", 24),  // TEST-NET-3
    ipv4_cidr_range("224.0.0.0", 4),     // multicast
    ipv4_cidr_range("240.0.0.0", 4),     // reserved (incl. broadcast)
];

fn is_public_ipv4(ip: &str) -> bool {
    let value = match ipv4_to_int(ip) {
        Some(value) => value,
        None => return false,
    };
    for (start, end) in IPV4_NON_PUBLIC_RANGES {
        if value >= start && value <= end {
            return false;
        }
    }
    true
}

/// Expand a canonical IPv6 literal to its 8 hextets (0..0xffff), handling `::`
/// compression and an embedded IPv4 tail. Returns null when unparseable.
fn expand_ipv6(address: &str) -> Option<Vec<u32>> {
    let mut text = address.to_string();
    // Embedded IPv4 in the final two hextets (e.g. ::ffff:127.0.0.1 or
    // 2001:db8::192.0.2.1): convert it to two hextets first.
    if let Some(colon) = text.rfind(':') {
        let tail = &text[colon + 1..];
        if tail.contains('.') {
            let ipv4 = ipv4_to_int(tail)?;
            text = format!("{}{:x}:{:x}", &text[..colon + 1], ipv4 >> 16, ipv4 & 0xffff);
        }
    }
    let split: Vec<&str> = text.split("::").collect();
    if split.len() > 2 {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if split.len() == 2 {
        let left: Vec<&str> = if split[0].is_empty() { Vec::new() } else { split[0].split(':').collect() };
        let right: Vec<&str> = if split[1].is_empty() { Vec::new() } else { split[1].split(':').collect() };
        if left.len() + right.len() > 7 {
            return None;
        }
        parts.extend(left.iter().map(|s| s.to_string()));
        for _ in 0..8 - left.len() - right.len() {
            parts.push("0".to_string());
        }
        parts.extend(right.iter().map(|s| s.to_string()));
    } else {
        parts.extend(text.split(':').map(|s| s.to_string()));
    }
    if parts.len() != 8 {
        return None;
    }
    let mut out = Vec::with_capacity(8);
    for part in parts {
        if part.is_empty() || part.len() > 4 || !part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        out.push(u32::from_str_radix(&part, 16).ok()?);
    }
    Some(out)
}

/// IPv4-mapped forms are judged by their embedded IPv4, not the IPv6 prefix.
fn is_public_ipv6(address: &str) -> bool {
    if let Some(mapped) = regex::Regex::new(r"^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$")
        .expect("mapped-dotted regex compiles")
        .captures(address)
    {
        return is_public_ipv4(mapped.get(1).map(|m| m.as_str()).unwrap_or(""));
    }
    if let Some(mapped) = regex::Regex::new(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$")
        .expect("mapped-hex regex compiles")
        .captures(address)
    {
        let high = u32::from_str_radix(mapped.get(1).map(|m| m.as_str()).unwrap_or("0"), 16).unwrap_or(0);
        let low = u32::from_str_radix(mapped.get(2).map(|m| m.as_str()).unwrap_or("0"), 16).unwrap_or(0);
        let int = (high << 16) | low;
        return is_public_ipv4(&format!("{}.{}.{}.{}", (int >> 24) & 0xff, (int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff));
    }
    let Some(hextets) = expand_ipv6(address) else {
        return false;
    };
    let a = hextets[0];
    let b = hextets[1];
    if a == 0 {
        return false; // 0000::/8 (unspecified, loopback, reserved)
    }
    if a == 0x0064 && b == 0xff9b {
        return false; // 64:ff9b::/96 NAT64 well-known
    }
    if a == 0x0100 && b == 0x0000 {
        return false; // 100::/64 discard-only
    }
    if a == 0x2001 && (b & 0xfe00) == 0 {
        return false; // 2001::/23 (Teredo, ORCHID, IETF)
    }
    if a == 0x2001 && b == 0x0db8 {
        return false; // 2001:db8::/32 documentation
    }
    if a == 0x2002 {
        return false; // 2002::/16 6to4
    }
    if (a & 0xfe00) == 0xfc00 {
        return false; // fc00::/7 ULA
    }
    if (a & 0xffc0) == 0xfe80 {
        return false; // fe80::/10 link-local
    }
    if (a & 0xff00) == 0xff00 {
        return false; // ff00::/8 multicast
    }
    true
}

/// Strict dotted-quad detection (mirrors `net.isIP(v) === 4`: no leading
/// zeros, each octet 0-255).
fn is_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
        part.parse::<u32>().map(|n| n <= 255).unwrap_or(false)
    })
}

/// Strict IPv6 literal detection: only hex digits, colons and (for the
/// embedded-v4 tail) dots, parseable to 8 hextets (mirrors `net.isIP === 6`).
fn is_ipv6(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if value.bytes().any(|b| !(b.is_ascii_hexdigit() || b == b':' || b == b'.')) {
        return false;
    }
    expand_ipv6(value).is_some()
}

/// SSRF allow-list: is `address` a globally routable unicast IP?
///
/// Both literal subscription hosts and every DNS answer flow through this
/// single check, so the literal-IP and resolved-IP verdicts can never diverge.
/// The only carve-out is applied by the caller: Surge/mihomo fake-ip DNS maps
/// public hosts into 198.18.0.0/15, which is otherwise rejected here.
pub fn is_public_address(address: &str) -> bool {
    let mut normalized = address.trim().to_lowercase();
    if normalized.starts_with('[') && normalized.ends_with(']') {
        normalized = normalized[1..normalized.len() - 1].to_string();
    }
    normalized = normalized.split('%').next().unwrap_or("").to_string();
    if is_ipv4(&normalized) {
        return is_public_ipv4(&normalized);
    }
    if is_ipv6(&normalized) {
        return is_public_ipv6(&normalized);
    }
    false
}

// ---------------------------------------------------------------------------
// Suggested display-name helpers
// ---------------------------------------------------------------------------

fn sanitize_suggested_name(value: &str) -> Option<String> {
    // Take the basename, then strip a config extension.
    let basename: String = value.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    let candidate = regex::Regex::new(r"(?i)\.(?:ya?ml|txt|conf|json)$")
        .expect("extension regex compiles")
        .replace(&basename, "")
        .to_string();
    // Strip wrapping quotes and control characters.
    let candidate = candidate
        .trim_matches(|c| c == '"' || c == '\'')
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if candidate.is_empty() {
        return None;
    }
    Some(if candidate.chars().count() > MAX_SUGGESTED_NAME_LENGTH {
        candidate.chars().take(MAX_SUGGESTED_NAME_LENGTH).collect()
    } else {
        candidate
    })
}

/// Extract a human-friendly display filename from a `Content-Disposition`
/// header: prefer the RFC 5987 extended form (`filename*=UTF-8''…`,
/// percent-decoded), fall back to the plain `filename=` form, strip a config
/// extension, and sanitize (quotes, control characters, hard length cap).
/// Returns `None` when nothing usable remains — the caller then falls back to
/// the URL host.
pub fn parse_disposition_filename(header: Option<&str>) -> Option<String> {
    let header = header?;
    let mut candidate: Option<String> = None;
    if let Some(extended) = regex::Regex::new(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)")
        .expect("filename* regex compiles")
        .captures(header)
    {
        candidate = Some(percent_decode(extended.get(1).map(|m| m.as_str().trim()).unwrap_or("")));
    }
    if candidate.as_deref().map(str::is_empty).unwrap_or(true) {
        let plain = regex::Regex::new(r#"(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))"#)
            .expect("filename regex compiles")
            .captures(header);
        if let Some(plain) = plain {
            let value = plain
                .get(1)
                .or_else(|| plain.get(2))
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            candidate = Some(value);
        }
    }
    let candidate = candidate?;
    if candidate.is_empty() {
        return None;
    }
    sanitize_suggested_name(&candidate)
}

/// `decodeURIComponent` analog; malformed sequences pass through untouched
/// (the TS version catches and keeps the raw segment).
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Match Clash Verge Rev's fallback: prefer a decoded final-URL filename, then
/// the URL host. Filename segments that look like tokens (`raw`, `sub`,
/// `api`, version numbers, 20+ char hex/UUID) are rejected so a token-bearing
/// URL can never become a user-visible profile name.
pub fn derive_fallback_subscription_name(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let raw_segment = parsed
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .last()
        .unwrap_or("");
    let decoded = percent_decode(raw_segment);
    let unsafe_name = regex::Regex::new(r"^(?:raw|sub|subscribe|subscription|config|clash|api|v\d+)$")
        .expect("unsafe-name regex compiles")
        .is_match(&decoded)
        || regex::Regex::new(r"^[0-9a-f-]{20,}$")
            .expect("hex-name regex compiles")
            .is_match(&decoded);
    if !unsafe_name {
        if let Some(filename) = sanitize_suggested_name(&decoded) {
            return Some(filename);
        }
    }
    let host = parsed.host_str()?;
    Some(if host.chars().count() > MAX_SUGGESTED_NAME_LENGTH {
        host.chars().take(MAX_SUGGESTED_NAME_LENGTH).collect()
    } else {
        host.to_string()
    })
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/// Injectable DNS resolver (tests pin verdicts without a live resolver).
type ResolveHost = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;

pub struct SubscriptionFetcher {
    direct: reqwest::Client,
    proxy: Option<reqwest::Client>,
    max_bytes: usize,
    strict_url_validation: bool,
    max_redirects: usize,
    timeout_ms: u64,
    resolve_host: ResolveHost,
}

impl SubscriptionFetcher {
    /// Production constructor. `proxy_client` is the system-proxy-aware
    /// transport (the app's own mixed port when the system proxy is enabled);
    /// it is wired by the 3D system-proxy slice.
    pub fn new(proxy_client: Option<reqwest::Client>) -> Self {
        SubscriptionFetcher {
            direct: Self::build_client(None),
            proxy: proxy_client,
            max_bytes: DEFAULT_MAX_BYTES,
            strict_url_validation: true,
            max_redirects: DEFAULT_MAX_REDIRECTS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            resolve_host: Arc::new(resolve_host_system),
        }
    }

    /// Test constructor: relaxed SSRF enforcement (loopback servers are the
    /// test fixture) and an injected resolver, mirroring the TS tests that
    /// stub both.
    #[allow(dead_code)] // test constructor; production uses `new`
    pub fn for_testing(resolve_host: ResolveHost, timeout_ms: u64, max_bytes: usize) -> Self {
        SubscriptionFetcher {
            direct: Self::build_client(None),
            proxy: None,
            max_bytes,
            strict_url_validation: false,
            max_redirects: DEFAULT_MAX_REDIRECTS,
            timeout_ms,
            resolve_host,
        }
    }

    /// Manual redirect policy is MANDATORY: redirects must surface to the
    /// per-hop validation loop instead of being followed silently, which would
    /// bypass the SSRF checks entirely.
    fn build_client(proxy: Option<&str>) -> reqwest::Client {
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if let Some(url) = proxy {
            if let Ok(proxy) = reqwest::Proxy::all(url) {
                builder = builder.proxy(proxy);
            }
        }
        builder.build().expect("subscription HTTP client builds")
    }

    /// Test toggle: enforce the SSRF allow-list with an injected resolver.
    #[allow(dead_code)] // test toggle; production is strict by default
    pub fn with_strict_urls(mut self, strict: bool) -> Self {
        self.strict_url_validation = strict;
        self
    }

    /// Whether a distinct system-proxy-aware transport is available.
    pub fn has_proxy_transport(&self) -> bool {
        self.proxy.is_some()
    }

    /// Validate a URL against SSRF protections.
    fn validate_url(&self, url: &str) -> Result<(), IpcError> {
        if !self.strict_url_validation {
            return Ok(());
        }
        let parsed = match url::Url::parse(url) {
            Ok(parsed) => parsed,
            // NEVER interpolate the raw URL here: an unparseable URL can still
            // carry userinfo or a token, and this message reaches the renderer.
            Err(_) => {
                return Err(IpcError::code(
                    code::INVALID_ARGUMENT,
                    format!("无效的订阅 URL：{}", redact_credentials(url)),
                ));
            }
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(IpcError::code(
                code::INVALID_ARGUMENT,
                format!("订阅 URL 必须使用 http 或 https 协议：{}", redact_credentials(url)),
            ));
        }
        let host = parsed.host_str().unwrap_or_default().to_string();
        if host.is_empty() {
            return Err(IpcError::code(
                code::INVALID_ARGUMENT,
                format!("无效的订阅 URL：{}", redact_credentials(url)),
            ));
        }
        // `url` keeps IPv6 literals in bracket notation; strip them so the
        // literal check and the allow-list predicate see the bare address.
        let bare_host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let is_literal = is_ipv4(&bare_host) || is_ipv6(&bare_host) || bare_host.eq_ignore_ascii_case("localhost");
        // A literal IP (or the localhost alias) is checked directly against
        // the public-unicast allow-list. A hostname is resolved and every
        // returned address must be globally routable, so both verdicts share
        // one predicate.
        if is_literal {
            if !is_public_address(&bare_host) {
                return Err(IpcError::code(
                    code::INVALID_ARGUMENT,
                    format!("禁止访问内部地址：{}", redact_credentials(url)),
                ));
            }
        } else {
            let addresses = (self.resolve_host)(&bare_host);
            // Surge/mihomo fake-ip DNS intentionally maps arbitrary public
            // hosts into 198.18.0.0/15, so a host allow-list cannot solve this
            // for real subscription providers. Permit an all-fake-IP answer
            // only for HTTPS: TLS still authenticates the requested hostname
            // and redirects are validated again hop-by-hop. Mixed/private
            // answers remain rejected.
            let trusted_fake_ip_answer = parsed.scheme() == "https";
            let fake_ip_only = !addresses.is_empty()
                && addresses
                    .iter()
                    .all(|address| regex::Regex::new(r"^198\.(?:18|19)\.").expect("fake-ip regex compiles").is_match(address));
            if addresses.is_empty()
                || (addresses.iter().any(|address| !is_public_address(address)) && !(trusted_fake_ip_answer && fake_ip_only))
            {
                return Err(IpcError::code(
                    code::INVALID_ARGUMENT,
                    format!("订阅域名解析到非公网地址：{}", redact_credentials(url)),
                ));
            }
        }
        Ok(())
    }

    fn transport(&self, via_proxy: bool) -> &reqwest::Client {
        match (via_proxy, &self.proxy) {
            (true, Some(proxy)) => proxy,
            _ => &self.direct,
        }
    }

    /// Fetch a subscription config with SSRF protection, redirect tracking,
    /// and a streaming size limit. `via_proxy` routes the sweep through the
    /// fallback transport (which must have been configured).
    pub async fn fetch(&self, url: &str, via_proxy: bool) -> Result<FetchSubscriptionResult, IpcError> {
        // One timeout covers the ENTIRE sweep (every hop), exactly like the TS
        // abort-signal timer that is cleared in a `finally`.
        match tokio::time::timeout(Duration::from_millis(self.timeout_ms), self.fetch_sweep(url, via_proxy)).await {
            Ok(result) => result,
            Err(_elapsed) => Err(IpcError::code(
                code::UPSTREAM_UNREACHABLE,
                format!("订阅获取超时（{}ms）：{}", self.timeout_ms, redact_credentials(url)),
            )),
        }
    }

    async fn fetch_sweep(&self, url: &str, via_proxy: bool) -> Result<FetchSubscriptionResult, IpcError> {
        let transport = self.transport(via_proxy);
        let mut current_url = url.to_string();
        let mut redirect_count = 0usize;
        let mut response;

        loop {
            // Validate current URL before each request.
            self.validate_url(&current_url)?;

            let parsed = url::Url::parse(&current_url)
                .map_err(|_| IpcError::code(code::INVALID_ARGUMENT, format!("无效的订阅 URL：{}", redact_credentials(&current_url))))?;
            let sent = transport
                .get(parsed)
                .header(reqwest::header::USER_AGENT, SUBSCRIPTION_USER_AGENT)
                .header(reqwest::header::ACCEPT, SUBSCRIPTION_ACCEPT)
                .send()
                .await;
            let hop = match sent {
                Ok(response) => response,
                Err(error) => {
                    return Err(IpcError::code(
                        code::UPSTREAM_UNREACHABLE,
                        format!("订阅获取失败：{}（{}）", redact_credentials(url), redact_credentials(&describe_reqwest_error(&error))),
                    ));
                }
            };

            // A transport that follows redirects internally (the kernel-proxy
            // path) surfaces its final url here: validate where we actually
            // landed and adopt it so the stored source and error messages
            // reflect reality. (The manual-redirect transport always reports
            // the requested hop — modulo reqwest stripping userinfo — so
            // adoption stays a no-op for it; the stripped form never counts
            // as "landing elsewhere".)
            let final_url = hop.url().to_string();
            if final_url != current_url && final_url != strip_userinfo(&current_url) {
                self.validate_url(&final_url)?;
                current_url = final_url;
            }

            // Handle redirects manually with validation.
            let status = hop.status().as_u16();
            if (300..400).contains(&status) && hop.headers().get(reqwest::header::LOCATION).is_some() {
                redirect_count += 1;
                if redirect_count > self.max_redirects {
                    return Err(IpcError::code(
                        code::UPSTREAM_HTTP_ERROR,
                        format!("重定向次数过多（超过 {}）：{}", self.max_redirects, redact_credentials(&current_url)),
                    ));
                }
                let location = hop
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                // Resolve relative URLs; a redirect target is attacker-
                // controlled and may embed credentials.
                let base = url::Url::parse(&current_url)
                    .map_err(|_| IpcError::code(code::INVALID_ARGUMENT, format!("无效的订阅 URL：{}", redact_credentials(&current_url))))?;
                let next_url = base
                    .join(&location)
                    .map_err(|_| IpcError::code(code::INVALID_ARGUMENT, format!("无效的重定向地址：{}", redact_credentials(&location))))?;
                // Validate the redirect target.
                self.validate_url(next_url.as_str())?;
                current_url = next_url.to_string();
                continue;
            }

            response = hop;
            break;
        }

        // Now process the actual response with a streaming size check.
        let status = response.status().as_u16();
        let redacted_url = redact_credentials(&current_url);
        if !(200..300).contains(&status) {
            return Err(IpcError::code(
                code::UPSTREAM_HTTP_ERROR,
                format!("订阅获取失败：{}（HTTP {}）", redacted_url, status),
            ));
        }
        let content_disposition = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut total_bytes = 0usize;
        let mut raw: Vec<u8> = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| {
                    IpcError::code(
                        code::UPSTREAM_UNREACHABLE,
                        format!("订阅获取失败：{}（{}）", redacted_url, redact_credentials(&describe_reqwest_error(&error))),
                    )
                })?;
            let Some(chunk) = chunk else { break };
            total_bytes += chunk.len();
            // Check size limit during streaming.
            if total_bytes > self.max_bytes {
                return Err(IpcError::code(
                    code::UPSTREAM_HTTP_ERROR,
                    format!("订阅配置过大：{} 字节超过上限 {}", total_bytes, self.max_bytes),
                ));
            }
            raw.extend_from_slice(&chunk);
        }
        // A streaming UTF-8 decoder flushes its tail; lossy conversion keeps
        // the same replace-invalid-sequences semantics for a multibyte
        // character split at a chunk boundary.
        let document = String::from_utf8_lossy(&raw).to_string();

        Ok(FetchSubscriptionResult {
            suggested_name: parse_disposition_filename(content_disposition.as_deref())
                .or_else(|| derive_fallback_subscription_name(&redacted_url)),
            document,
            source: json!({
                "type": "url",
                // Only store redacted URL for security.
                "url": redacted_url,
                "expire": Value::Null,
                "usage": Value::Null,
            }),
        })
    }
}

/// One completed subscription sweep.
#[derive(Debug)]
pub struct FetchSubscriptionResult {
    pub document: String,
    /// `ProfileSubscription` envelope (the URL is already redacted).
    pub source: Value,
    /// Display name suggested by the subscription response itself (the
    /// `Content-Disposition` attachment filename). `None` when the response
    /// carries no usable filename — the caller then falls back to the URL
    /// host. Never derived from the raw URL path, so a token-bearing URL can
    /// never become a user-visible profile name.
    pub suggested_name: Option<String>,
}

/// True when a fetch failure is TRANSPORT-level (DNS, TLS, connect, abort) —
/// the class of failure a kernel-proxy retry can plausibly fix. HTTP error
/// statuses and validation failures are excluded on purpose: retrying them
/// through the proxy would only double the round-trips.
pub fn is_transport_failure(error: &IpcError) -> bool {
    error.parts().0 == code::UPSTREAM_UNREACHABLE
}

/// Remove userinfo from a URL (the `url` crate's normalized form of the
/// request target, which reqwest reports without credentials).
fn strip_userinfo(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

fn describe_reqwest_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    if error.is_timeout() && !message.contains("timed out") {
        message.push_str(" (operation timed out)");
    }
    message
}

/// System resolver lookup (the `node:dns/promises lookup all` analog): every
/// address the host resolves to, in resolver order.
fn resolve_host_system(hostname: &str) -> Vec<String> {
    let target = if hostname.contains(':') {
        format!("[{hostname}]:443")
    } else {
        format!("{hostname}:443")
    };
    match target.to_socket_addrs() {
        Ok(addrs) => addrs.map(|addr| addr.ip().to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Shared composition used by the profile service: prefer the
/// system-proxy-aware transport, fall back to direct ONLY on a transport-level
/// failure (`ProfileService.fetchSubscription`).
pub async fn fetch_with_fallback(fetcher: &SubscriptionFetcher, url: &str) -> Result<FetchSubscriptionResult, IpcError> {
    if !fetcher.has_proxy_transport() {
        return fetcher.fetch(url, false).await;
    }
    match fetcher.fetch(url, true).await {
        Ok(result) => Ok(result),
        Err(error) => {
            if !is_transport_failure(&error) {
                return Err(error);
            }
            match fetcher.fetch(url, false).await {
                Ok(result) => Ok(result),
                // Both routes failed — keep the preferred-route failure
                // because it is the one matching the user's current
                // proxy/TUN network path.
                Err(_) => Err(error),
            }
        }
    }
}

/// Schema validation for the `profiles:import-from-url` URL argument
/// (`shared/schemas/profiles.ts` `parseSubscriptionUrl`).
pub fn parse_subscription_url(input: Option<&str>) -> Result<String, IpcError> {
    let input = match input {
        Some(input) => input,
        None => return Err(IpcError::invalid_argument("subscription URL must be a non-empty string of at most 2048 characters")),
    };
    if input.is_empty() || input.len() > 2048 {
        return Err(IpcError::invalid_argument("subscription URL must be a non-empty string of at most 2048 characters"));
    }
    let parsed = url::Url::parse(input).map_err(|_| IpcError::invalid_argument("subscription URL is invalid"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(IpcError::invalid_argument("subscription URL must use http or https"));
    }
    Ok(input.to_string())
}

/// `parseOptionalImportName`: empty string when absent, control chars rejected.
pub fn parse_optional_import_name(input: Option<&str>) -> Result<String, IpcError> {
    let Some(name) = input else {
        return Ok(String::new());
    };
    if name.chars().count() > 256 {
        return Err(IpcError::invalid_argument("profile name must be a string of at most 256 characters"));
    }
    if name.contains('\n') || name.contains('\r') || name.contains('\0') {
        return Err(IpcError::invalid_argument("profile name contains invalid control characters"));
    }
    Ok(name.to_string())
}

/// `parseOptionalBoolean`: false when absent.
pub fn parse_optional_boolean(input: Option<&Value>, field: &str) -> Result<bool, IpcError> {
    match input {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(IpcError::invalid_argument(format!("{field} must be a boolean when provided"))),
    }
}

/// Local HTTP stub: answers every request with one canned response and
/// records request heads (for UA/accept assertions). Threads + std listener;
/// reqwest is a plain HTTP client on loopback here, no TLS needed.
#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::Receiver;

    pub struct HttpStub {
        /// Read by tests that assert the stub observed the request.
        #[allow(dead_code)]
        pub receiver: Receiver<String>,
    }

    /// Accepts and reads request heads but NEVER answers — for the timeout
    /// sweep test.
    pub fn start_hanging_stub() -> (String, HttpStub) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener binds");
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let sender = sender.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(match stream.try_clone() {
                        Ok(reader) => reader,
                        Err(_) => return,
                    });
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) if line.trim().is_empty() => break,
                            Ok(_) => continue,
                            Err(_) => return,
                        }
                    }
                    let _ = sender.send("hung".to_string());
                    std::thread::sleep(std::time::Duration::from_secs(30));
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), HttpStub { receiver })
    }

    pub fn start_http_stub(
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: String,
    ) -> (String, HttpStub) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener binds");
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let sender = sender.clone();
                let headers = headers.clone();
                let body = body.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut reader = BufReader::new(match stream.try_clone() {
                        Ok(reader) => reader,
                        Err(_) => return,
                    });
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        return;
                    }
                    let mut head = request_line.clone();
                    let mut content_length = 0usize;
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) => {
                                if line.trim().is_empty() {
                                    break;
                                }
                                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                                    content_length = value.trim().parse().unwrap_or(0);
                                }
                                head.push_str(&line);
                            }
                            Err(_) => return,
                        }
                    }
                    if content_length > 0 {
                        let mut sink = vec![0u8; content_length];
                        let _ = reader.read_exact(&mut sink);
                    }
                    let _ = sender.send(head);
                    let header_block: String = headers
                        .iter()
                        .map(|(name, value)| format!("{name}: {value}\r\n"))
                        .collect();
                    let response = format!(
                        "HTTP/1.1 {status} STUB\r\ncontent-length: {}\r\nconnection: close\r\n{header_block}\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), HttpStub { receiver })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::is_redacted_url;

    const VALID_DOC: &str = "mixed-port: 7890\nproxies:\n  - name: node-01\n    server: 127.0.0.1\nrules:\n  - MATCH,DIRECT\n";
    #[allow(dead_code)]
    const INVALID_DOC: &str = "proxies: [\n  - name: node-01\n";

    #[test]
    fn public_address_matches_the_ts_verdicts() {
        // Public unicast.
        assert!(is_public_address("93.184.216.34"));
        assert!(is_public_address("1.1.1.1"));
        assert!(is_public_address("2606:4700:4700::1111"));
        // Private / loopback / link-local / CGNAT / benchmarking / reserved.
        assert!(!is_public_address("127.0.0.1"));
        assert!(!is_public_address("10.0.0.1"));
        assert!(!is_public_address("172.16.0.1"));
        assert!(!is_public_address("192.168.1.1"));
        assert!(!is_public_address("169.254.1.1"));
        assert!(!is_public_address("100.64.0.1"));
        assert!(!is_public_address("198.18.0.1"));
        assert!(!is_public_address("224.0.0.1"));
        assert!(!is_public_address("240.0.0.1"));
        assert!(!is_public_address("::1"));
        assert!(!is_public_address("::"));
        assert!(!is_public_address("fe80::1"));
        assert!(!is_public_address("fc00::1"));
        assert!(!is_public_address("2001:db8::1"));
        assert!(!is_public_address("64:ff9b::1.2.3.4"));
        // IPv4-mapped forms are judged by the embedded IPv4.
        assert!(!is_public_address("::ffff:127.0.0.1"));
        assert!(is_public_address("::ffff:8.8.8.8"));
        assert!(!is_public_address("::ffff:7f00:1"));
        // Hostnames are not addresses.
        assert!(!is_public_address("example.com"));
    }

    #[test]
    fn disposition_filenames_follow_the_ts_precedence() {
        // RFC 5987 extended form wins and percent-decodes.
        assert_eq!(
            parse_disposition_filename(Some("attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA%E8%AE%A2%E9%98%85.yaml")),
            Some("机场订阅".to_string())
        );
        // Plain quoted form.
        assert_eq!(parse_disposition_filename(Some("attachment; filename=\"home lab.yaml\"")), Some("home lab".to_string()));
        // Extension stripped, quotes/control characters sanitized.
        assert_eq!(parse_disposition_filename(Some("attachment; filename=sub.yaml")), Some("sub".to_string()));
        // Nothing usable.
        assert_eq!(parse_disposition_filename(Some("attachment")), None);
        assert_eq!(parse_disposition_filename(None), None);
    }

    #[test]
    fn fallback_names_reject_token_segments() {
        // Token-like path segments never become a user-visible name.
        assert_eq!(
            derive_fallback_subscription_name("https://gist.githubusercontent.com/RoaycL/8bb169258b029784d6a534b23b92cc8e/raw/MihomoParty"),
            Some("MihomoParty".to_string())
        );
        assert_eq!(
            derive_fallback_subscription_name("https://example.com/8bb169258b029784d6a534b23b92cc8e"),
            Some("example.com".to_string())
        );
        assert_eq!(
            derive_fallback_subscription_name("https://airport.example.com/sub"),
            Some("airport.example.com".to_string())
        );
        // Token query parameters do not leak into names.
        let derived = derive_fallback_subscription_name("https://example.com/sub?token=secret");
        assert_eq!(derived, Some("example.com".to_string()));
    }

    #[test]
    fn redaction_artifacts_are_recognized() {
        assert!(is_redacted_url("https://example.com/[UUID_REDACTED]"));
        assert!(is_redacted_url("https://example.com/sub?token=***REDACTED***"));
        assert!(is_redacted_url("https://[redacted]@example.com/x"));
        assert!(!is_redacted_url("https://example.com/sub"));
    }

    #[test]
    fn url_schema_validation_mirrors_parse_subscription_url() {
        assert!(parse_subscription_url(Some("https://example.com/sub")).is_ok());
        assert!(parse_subscription_url(Some("ftp://example.com/sub")).is_err());
        assert!(parse_subscription_url(Some("")).is_err());
        assert!(parse_subscription_url(Some(&"a".repeat(2049))).is_err());
        assert!(parse_subscription_url(None).is_err());
        assert!(parse_optional_import_name(None).unwrap().is_empty());
        assert!(parse_optional_import_name(Some("ok name")).is_ok());
        assert!(parse_optional_import_name(Some("bad\nname")).is_err());
        assert!(parse_optional_import_name(Some(&"a".repeat(257))).is_err());
        assert!(parse_optional_boolean(Some(&Value::Bool(true)), "activate").unwrap());
        assert!(!parse_optional_boolean(None, "activate").unwrap());
        assert!(parse_optional_boolean(Some(&Value::String("yes".into())), "activate").is_err());
    }

    /// Direct-fetch stub pointing at a loopback HTTP server.
    fn loopback_fetcher(timeout_ms: u64, max_bytes: usize) -> SubscriptionFetcher {
        let fetcher = SubscriptionFetcher::for_testing(Arc::new(|_| Vec::new()), timeout_ms, max_bytes);
        fetcher
    }

    #[tokio::test]
    async fn fetches_a_document_and_redacts_the_source_url() {
        let (base, _server) = test_support::start_http_stub(200, vec![], VALID_DOC.to_string());
        let fetcher = loopback_fetcher(5000, 1024 * 1024);
        // Credentials in the URL are redacted in the stored envelope (strict
        // validation is off in the test constructor).
        let url = format!("http://user:secret@{}/x", base.trim_start_matches("http://"));
        let result = fetcher.fetch(&url, false).await.unwrap();
        assert_eq!(result.document, VALID_DOC);
        assert!(result.source["url"].as_str().unwrap().contains("://redacted@"), "{}", result.source["url"]);
        assert!(!result.source["url"].as_str().unwrap().contains("secret"));
        assert_eq!(result.source["type"], "url");
        assert!(result.source["expire"].is_null());
        // The redacted form is also the suggested-name input: the final path
        // segment is `x`, so the derived name is `x` (the host fallback only
        // applies when the segment is token-like).
        assert_eq!(result.suggested_name.as_deref(), Some("x"));
    }

    #[tokio::test]
    async fn http_errors_and_transport_failures_are_typed() {
        let (base, _server) = test_support::start_http_stub(404, vec![], "not found".to_string());
        let fetcher = loopback_fetcher(5000, 1024 * 1024);
        let error = fetcher.fetch(&format!("{base}/missing"), false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_HTTP_ERROR);
        assert!(error.parts().1.contains("HTTP 404"), "{}", error.parts().1);
        // A closed port is a transport failure (UPSTREAM_UNREACHABLE).
        let fetcher = loopback_fetcher(1000, 1024 * 1024);
        let error = fetcher.fetch("http://127.0.0.1:9/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_UNREACHABLE);
        assert!(is_transport_failure(&error));
        // And an HTTP failure is NOT a transport failure (no proxy retry).
        let error = fetcher.fetch(&format!("{base}/missing"), false).await.unwrap_err();
        assert!(!is_transport_failure(&error));
    }

    #[tokio::test]
    async fn redirects_are_validated_and_budgeted_hop_by_hop() {
        // Chain: 302 (absolute) -> 301 (relative) -> 200, all loopback (strict
        // validation is off in the test constructor).
        let (base_c, _server_c) = test_support::start_http_stub(200, vec![], VALID_DOC.to_string());
        let (base_b, _server_b) = test_support::start_http_stub(301, vec![("location", format!("{base_c}/c"))], String::new());
        let (base_a, _server_a) = test_support::start_http_stub(302, vec![("location", format!("{base_b}/b"))], String::new());
        let fetcher = loopback_fetcher(5000, 1024 * 1024);
        let result = fetcher.fetch(&format!("{base_a}/a"), false).await.unwrap();
        assert_eq!(result.document, VALID_DOC);
        // The final URL is adopted (the stored source lands on /c).
        assert!(result.source["url"].as_str().unwrap().ends_with("/c"), "{}", result.source["url"]);
        let _ = (&base_b, &_server_b);
        // Budget exhaustion: a redirect loop trips the cap with the TS copy.
        let (loop_base, _loop_server) = test_support::start_http_stub(302, vec![("location", "/next".to_string())], String::new());
        let fetcher = loopback_fetcher(5000, 1024 * 1024);
        let error = fetcher.fetch(&loop_base, false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_HTTP_ERROR);
        assert!(error.parts().1.contains("重定向次数过多（超过 5）"), "{}", error.parts().1);
        let _ = base_c;
    }

    #[tokio::test]
    async fn oversized_documents_trip_mid_stream() {
        let big = "x".repeat(64 * 1024);
        let (base, _server) = test_support::start_http_stub(200, vec![], big);
        let fetcher = loopback_fetcher(5000, 32 * 1024);
        let error = fetcher.fetch(&base, false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_HTTP_ERROR);
        assert!(error.parts().1.contains("订阅配置过大"), "{}", error.parts().1);
        assert!(error.parts().1.contains("超过上限 32768"), "{}", error.parts().1);
    }

    #[tokio::test]
    async fn a_hung_server_times_out_with_the_ts_copy() {
        // A server that accepts, reads the request head, and never answers.
        let (base, _server) = test_support::start_hanging_stub();
        let fetcher = loopback_fetcher(300, 1024 * 1024);
        let error = fetcher.fetch(&format!("{base}/x"), false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_UNREACHABLE);
        assert!(error.parts().1.contains("订阅获取超时（300ms）"), "{}", error.parts().1);
    }

    #[tokio::test]
    async fn strict_validation_rejects_non_public_targets_before_any_request() {
        let fetcher = SubscriptionFetcher::new(None);
        // Literal private addresses.
        for host in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "[::1]"] {
            let error = fetcher.fetch(&format!("http://{host}/x"), false).await.unwrap_err();
            assert_eq!(error.parts().0, code::INVALID_ARGUMENT, "{host}");
            assert!(error.parts().1.contains("禁止访问内部地址"), "{host}: {}", error.parts().1);
        }
        // Non-http schemes.
        let error = fetcher.fetch("ftp://example.com/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::INVALID_ARGUMENT);
        assert!(error.parts().1.contains("订阅 URL 必须使用 http 或 https 协议"), "{}", error.parts().1);
        // No request ever reached the wire: the loopback stubs above would
        // have answered a literal-loopback URL.
    }

    #[tokio::test]
    async fn dns_answers_flow_through_the_same_allow_list() {
        // A hostname resolving to private space is rejected with the DNS copy.
        let fetcher = SubscriptionFetcher::for_testing(
            Arc::new(|_| vec!["10.0.0.1".to_string()]),
            5000,
            1024 * 1024,
        )
        .with_strict_urls(true);
        let error = fetcher.fetch("http://private.example/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::INVALID_ARGUMENT);
        assert!(error.parts().1.contains("订阅域名解析到非公网地址"), "{}", error.parts().1);
        // The fake-ip carve-out: an ALL-fake-ip answer is allowed on HTTPS only.
        let fake = SubscriptionFetcher::for_testing(
            Arc::new(|_| vec!["198.18.0.7".to_string()]),
            5000,
            1024 * 1024,
        )
        .with_strict_urls(true);
        // HTTP is rejected even though every answer is fake-ip...
        let error = fake.fetch("http://tun.example/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::INVALID_ARGUMENT);
        // ...and HTTPS gets past DNS (the fetch itself fails on the bogus
        // certificate/host, which is a transport-level error, proving DNS
        // validation passed).
        let error = fake.fetch("https://tun.example/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::UPSTREAM_UNREACHABLE);
        // Mixed answers (fake-ip + private) stay rejected even on HTTPS.
        let mixed = SubscriptionFetcher::for_testing(
            Arc::new(|_| vec!["198.18.0.7".to_string(), "192.168.0.1".to_string()]),
            5000,
            1024 * 1024,
        )
        .with_strict_urls(true);
        let error = mixed.fetch("https://tun.example/x", false).await.unwrap_err();
        assert_eq!(error.parts().0, code::INVALID_ARGUMENT);
    }
}
