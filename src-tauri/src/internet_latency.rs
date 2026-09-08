//! INTERNET-latency card service — Rust port of
//! `src/main/services/internet-latency-service.ts` (the `mihomo:internet-
//! latency` channel, Phase 3B/3D "last mihomo channel" slice).
//!
//! One sample has three independent slots:
//! - `gatewayMs` — first-hop RTT (TCP handshake to the default gateway; the
//!   mihomo kernel does not own this path, so it is probed directly).
//! - `dnsMs` — the kernel's DNS resolver answering a real NS query, timed
//!   end-to-end around the controller call, with a system-resolver fallback
//!   (a real bounded query; NXDOMAIN counts as answered).
//! - `proxyMs` — the delay the controller itself reports for the node
//!   selected by the first selectable group in the active profile's declared
//!   order (the full INTERNET RTT through the proxy chain).
//!
//! Every slot fails independently to `null` — a degraded path renders as an
//! em dash, never as a fake number and never as a card-wide error.

use serde_json::{json, Value};

use crate::profile_parse::parse_proxy_group_order;

/// First selectable group type whose `now` member represents the default path.
const SELECTABLE_GROUP_TYPES: [&str; 3] = ["Selector", "URLTest", "Fallback"];

/// One INTERNET-latency sample for the activity card.
#[derive(Debug, Clone, PartialEq)]
pub struct InternetLatencySample {
    pub gateway_ms: Option<u64>,
    pub dns_ms: Option<u64>,
    pub proxy_ms: Option<u64>,
    /// The selector's current node the proxy delay was measured against.
    pub proxy_node: Option<String>,
}

/// True when the proxy slot is meaningful: a selector exists and currently
/// points at a concrete node (not DIRECT/REJECT placeholders).
fn resolve_proxy_node(proxies: &Value, group_order: &[String]) -> Option<String> {
    let entries = proxies["proxies"].as_object()?;
    for group_name in group_order {
        let Some(proxy) = entries.get(group_name) else { continue };
        let proxy_type = proxy["type"].as_str().unwrap_or_default();
        if !SELECTABLE_GROUP_TYPES.contains(&proxy_type) {
            continue;
        }
        let name = proxy["name"].as_str().unwrap_or_default();
        if name.eq_ignore_ascii_case("GLOBAL") {
            continue;
        }
        let now = proxy["now"].as_str().unwrap_or_default();
        if !now.is_empty() && now != "DIRECT" && now != "REJECT" {
            return Some(now.to_string());
        }
    }
    None
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Collect one sample. Never fails wholesale; each slot degrades independently.
pub async fn sample(
    client: &crate::mihomo::MihomoClient,
    active_document: Option<&str>,
) -> InternetLatencySample {
    let group_order: Vec<String> = active_document
        .map(parse_proxy_group_order)
        .unwrap_or_default();
    let gateway = crate::route_latency::measure_gateway_rtt();
    let dns = sample_dns(client);
    let proxy = sample_proxy(client, &group_order);
    let (gateway, dns_ms, proxy) = tokio::join!(gateway, dns, proxy);
    InternetLatencySample {
        gateway_ms: gateway.rtt_ms,
        dns_ms,
        proxy_ms: proxy.0,
        proxy_node: proxy.1,
    }
}

async fn sample_dns(client: &crate::mihomo::MihomoClient) -> Option<u64> {
    // Prefer the resolver that actually serves mihomo traffic. If that probe
    // cannot produce a timing (DNS disabled, exchange timeout, controller not
    // ready during startup, etc.), perform a real bounded query through the OS
    // resolver. This keeps the DNS slot independent from controller health and
    // still never invents a number: both paths are timed around an actual query.
    let label = format!("murge-latency-{}.example.com", now_millis());
    let kernel_started = now_millis();
    if client.dns_query(&label, "NS").await.is_ok() {
        return Some(now_millis().saturating_sub(kernel_started));
    }
    let system_started = now_millis();
    if crate::route_latency::system_dns_probe(&label).await {
        return Some(now_millis().saturating_sub(system_started));
    }
    None
}

async fn sample_proxy(
    client: &crate::mihomo::MihomoClient,
    group_order: &[String],
) -> (Option<u64>, Option<String>) {
    let Ok(response) = client.get_proxies().await else {
        return (None, None);
    };
    let Some(proxy_node) = resolve_proxy_node(&response, group_order) else {
        return (None, None);
    };
    let proxy_ms = client
        .delay_test(&proxy_node, None, crate::mihomo::DEFAULT_DELAY_TIMEOUT_MS as i64)
        .await
        .ok()
        .and_then(|result| result["delay"].as_u64());
    (proxy_ms, Some(proxy_node))
}

/// The wire shape (`{ gatewayMs, dnsMs, proxyMs, proxyNode }`).
pub fn to_value(sample: &InternetLatencySample) -> Value {
    json!({
        "gatewayMs": sample.gateway_ms,
        "dnsMs": sample.dns_ms,
        "proxyMs": sample.proxy_ms,
        "proxyNode": sample.proxy_node,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_node_resolution_follows_the_declared_group_order() {
        let proxies = json!({
            "proxies": {
                "自动选择": { "type": "URLTest", "name": "自动选择", "now": "香港 01" },
                "节点选择": { "type": "Selector", "name": "节点选择", "now": "自动选择" },
                "直连": { "type": "Selector", "name": "直连", "now": "DIRECT" }
            }
        });
        // Declared order wins: 节点选择 first in the list -> its `now`.
        let order = vec!["节点选择".to_string(), "自动选择".to_string()];
        assert_eq!(resolve_proxy_node(&proxies, &order), Some("自动选择".to_string()));
        // DIRECT/REJECT placeholders are skipped.
        let order = vec!["直连".to_string(), "节点选择".to_string()];
        assert_eq!(resolve_proxy_node(&proxies, &order), Some("自动选择".to_string()));
        // GLOBAL is skipped.
        let global = json!({ "proxies": { "GLOBAL": { "type": "Selector", "name": "GLOBAL", "now": "x" } } });
        assert_eq!(resolve_proxy_node(&global, &["GLOBAL".to_string()]), None);
        // Unknown groups are skipped.
        assert_eq!(resolve_proxy_node(&proxies, &["不存在".to_string()]), None);
        // No concrete node anywhere.
        let empty = json!({ "proxies": { "直连": { "type": "Selector", "name": "直连", "now": "REJECT" } } });
        assert_eq!(resolve_proxy_node(&empty, &["直连".to_string()]), None);
    }

    #[test]
    fn the_wire_shape_matches_the_ts_sample() {
        let sample = InternetLatencySample {
            gateway_ms: Some(3),
            dns_ms: None,
            proxy_ms: Some(220),
            proxy_node: Some("香港 01".to_string()),
        };
        assert_eq!(
            to_value(&sample),
            json!({ "gatewayMs": 3, "dnsMs": Value::Null, "proxyMs": 220, "proxyNode": "香港 01" })
        );
    }
}
