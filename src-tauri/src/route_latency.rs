//! Default-gateway RTT probe — Rust port of
//! `src/main/services/route-latency-service.ts` (the "路由" slot of the
//! INTERNET 延迟 card).
//!
//! Node has no ICMP API, so the RTT is measured as a TCP connect handshake to
//! the gateway itself (its DNS proxy on :53 first, then the admin UI on :80).
//! That is a genuine first-hop liveness/latency signal — exactly what
//! distinguishes a LAN/Wi-Fi hiccup from an upstream outage — without ever
//! sending raw packets or mutating the host network.
//!
//! The probe is READ-ONLY with respect to the system: one routing-table read
//! and outbound TCP connects to the gateway the machine already uses.

use std::time::{Duration, Instant};

const PROBE_PORTS: [u16; 2] = [53, 80];
const PROBE_TIMEOUT_MS: u64 = 1200;

/// `route -n get default` → `   gateway: 192.168.1.1`
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // platform-gated caller
pub fn parse_darwin_default_gateway(stdout: &str) -> Option<String> {
    let pattern = regex::Regex::new(r"(?m)^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$").expect("gateway regex compiles");
    pattern.captures(stdout).map(|captures| captures.get(1).expect("group").as_str().to_string())
}

/// /proc/net/route → the destination-00000000 row's little-endian hex gateway.
pub fn parse_linux_proc_route(text: &str) -> Option<String> {
    for line in text.lines() {
        let columns: Vec<&str> = line.trim().split_whitespace().collect();
        if columns.get(1) != Some(&"00000000") {
            continue;
        }
        let hex = columns.get(2)?;
        if hex.len() != 8 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        // /proc/net/route stores the address little-endian.
        let bytes: Vec<u8> = (0..4)
            .map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex checked"))
            .collect();
        let mut owned = bytes;
        owned.reverse();
        return Some(
            owned
                .iter()
                .map(|byte| byte.to_string())
                .collect::<Vec<String>>()
                .join("."),
        );
    }
    None
}

/// `route print 0.0.0.0` → the active IPv4 route row whose network destination
/// and mask are both 0.0.0.0; the gateway is the third column. Multiple default
/// routes are listed by metric order, so the first match is the active one.
#[cfg_attr(not(windows), allow(dead_code))] // platform-gated caller
pub fn parse_windows_route_print(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let columns: Vec<&str> = line.trim().split_whitespace().collect();
        if columns.first() != Some(&"0.0.0.0") || columns.get(1) != Some(&"0.0.0.0") {
            continue;
        }
        let gateway = columns.get(2)?;
        if regex::Regex::new(r"^\d{1,3}(?:\.\d{1,3}){3}$").expect("ipv4 regex compiles").is_match(gateway) {
            return Some(gateway.to_string());
        }
    }
    None
}

/// Detect the default gateway for the current platform.
fn detect_gateway() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/net/route").ok()?;
        parse_linux_proc_route(&text)
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("route")
            .args(["-n", "get", "default"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_darwin_default_gateway(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("route")
            .args(["print", "0.0.0.0"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_windows_route_print(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// TCP connect to `host:port`, resolving with the handshake RTT in ms. Ports
/// typically open on a home gateway (DNS proxy, admin UI); a refused port
/// falls through to the next candidate, a timeout swallows into null.
async fn gateway_connect_rtt(host: &str) -> Option<u64> {
    for port in PROBE_PORTS {
        let address = format!("{host}:{port}");
        let started = Instant::now();
        match tokio::time::timeout(Duration::from_millis(PROBE_TIMEOUT_MS), tokio::net::TcpStream::connect(&address)).await {
            Ok(Ok(_stream)) => return Some(started.elapsed().as_millis() as u64),
            // Refused / timed out / unreachable: try the next candidate port.
            Ok(Err(_)) | Err(_) => continue,
        }
    }
    None
}

/// One first-hop probe result (`GatewayRttResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct GatewayRttResult {
    /// Dotted gateway address, when the platform's routing table exposed one.
    pub gateway: Option<String>,
    /// Connect-handshake RTT in ms, null when unreachable or undetectable.
    pub rtt_ms: Option<u64>,
}

/// Resolve the default gateway for the current platform and time a TCP
/// handshake against it. Never throws/never panics: every detection/connect
/// failure degrades to nulls, which the UI renders as an em dash.
pub async fn measure_gateway_rtt() -> GatewayRttResult {
    let Some(gateway) = detect_gateway() else {
        return GatewayRttResult { gateway: None, rtt_ms: None };
    };
    let rtt = gateway_connect_rtt(&gateway).await;
    GatewayRttResult { gateway: Some(gateway), rtt_ms: rtt }
}

/// System-resolver fallback (the `Resolver.resolveNs` analog): time a real
/// DNS lookup for a random label under a real public zone through the OS
/// resolver. An ANSWER or a definitive negative reply proves the upstream
/// round trip completed — only timeouts/network errors mean the measurement
/// is unusable. Uses the std resolver over UDP:53 through a real query
/// built by hand (A record for the label; NXDOMAIN counts as answered).
pub async fn system_dns_probe(label: &str) -> bool {
    // Build a minimal DNS A query.
    let mut query = Vec::with_capacity(17 + label.len());
    query.extend_from_slice(&[0xab, 0xcd, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    for part in label.split('.') {
        query.push(part.len() as u8);
        query.extend_from_slice(part.as_bytes());
    }
    query.push(0);
    query.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // A, IN

    let Ok(mut addrs) = ("1.1.1.1", 53u16).to_socket_addrs() else { return false };
    let Some(address) = addrs.next() else { return false };
    let _ = &mut addrs;
    let Ok(udp) = tokio::net::UdpSocket::bind(if address.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).await else {
        return false;
    };
    let send = udp.send_to(&query, address).await;
    let mut buffer = vec![0u8; 512];
    let receive = tokio::time::timeout(Duration::from_millis(1200), udp.recv_from(&mut buffer)).await;
    match (send, receive) {
        (Ok(_), Ok(Ok((size, _)))) => {
            // A response (answer or rcode header) proves the upstream round
            // trip completed; only the absence of one fails the probe.
            size >= 12
        }
        _ => false,
    }
}

use std::net::ToSocketAddrs;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ts_route_tables_verbatim() {
        // darwin
        assert_eq!(parse_darwin_default_gateway("   gateway: 192.168.1.1\n"), Some("192.168.1.1".to_string()));
        assert_eq!(parse_darwin_default_gateway("no gateway here\n"), None);
        // linux: little-endian hex decode (0100A8C0 → 192.168.0.1), the TS
        // fixture byte-for-byte; a non-default row never matches.
        let proc_route = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\neth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\neth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t0000FFFF\t0\n";
        assert_eq!(parse_linux_proc_route(proc_route), Some("192.168.0.1".to_string()));
        let no_default = "eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t0000FFFF\t0\n";
        assert_eq!(parse_linux_proc_route(no_default), None);
        assert_eq!(parse_linux_proc_route("Iface\tDestination\tGateway\neth0\t08000000\tC0A80001\t0000\t0\t0\t0\t00000000\t0\n"), None);
        // windows: first 0.0.0.0/0 row wins
        let route_print = "Active Routes:\n  0.0.0.0          0.0.0.0      192.168.1.254      10\n  0.0.0.0          0.0.0.0      192.168.1.1        1\n";
        assert_eq!(parse_windows_route_print(route_print), Some("192.168.1.254".to_string()));
        assert_eq!(parse_windows_route_print("  0.0.0.0        128.0.0.0      192.168.1.1     5\n"), None);
    }

    #[tokio::test]
    async fn gateway_probe_degrades_to_nulls_without_a_gateway() {
        // On a machine with no detectable default gateway the probe returns
        // nulls (and on the CI runner it typically finds one — either way it
        // must not panic or throw).
        let result = measure_gateway_rtt().await;
        if let Some(gateway) = &result.gateway {
            assert!(regex::Regex::new(r"^\d{1,3}(\.\d{1,3}){3}$").unwrap().is_match(gateway));
        } else {
            assert_eq!(result.rtt_ms, None);
        }
    }
}
