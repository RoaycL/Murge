//! 带宽 card: a short download + upload throughput test through the kernel's
//! LIVE mixed port, so the numbers describe the path the current rules pick
//! for the test host (like Surge's 带宽 widget testing the current policy).
//!
//! Each direction is bounded in both bytes and time; when the time budget runs
//! out first, the bytes moved so far still give an honest rate. A direction
//! that fails or moves too little data to time reports `null` (rendered as an
//! em dash), never an invented number.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const DOWNLOAD_URL: &str = "https://speed.cloudflare.com/__down?bytes=";
const UPLOAD_URL: &str = "https://speed.cloudflare.com/__up";
const DOWNLOAD_BYTES: u64 = 50_000_000;
const UPLOAD_BYTES: u64 = 20_000_000;
const UPLOAD_CHUNK: usize = 64 * 1024;
/// Time budget per direction once the transfer is under way.
const PHASE_BUDGET: Duration = Duration::from_secs(8);
/// Connect + TLS + first byte through the proxy chain.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Below this much data a rate is mostly handshake noise.
const MIN_MEASURED_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct BandwidthSample {
    pub down_mbps: Option<f64>,
    pub up_mbps: Option<f64>,
}

/// Megabits per second for `bytes` moved in `elapsed`, or None when too little
/// data or time was observed to mean anything.
pub fn mbps(bytes: u64, elapsed: Duration) -> Option<f64> {
    let seconds = elapsed.as_secs_f64();
    if bytes < MIN_MEASURED_BYTES || seconds <= 0.05 {
        return None;
    }
    let value = bytes as f64 * 8.0 / seconds / 1_000_000.0;
    Some((value * 10.0).round() / 10.0)
}

fn client(mixed_port: u16) -> Option<reqwest::Client> {
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{mixed_port}")).ok()?;
    reqwest::Client::builder()
        .proxy(proxy)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .ok()
}

async fn download(client: &reqwest::Client) -> Option<f64> {
    let url = format!("{DOWNLOAD_URL}{DOWNLOAD_BYTES}");
    let response = tokio::time::timeout(CONNECT_TIMEOUT, client.get(url).send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    // Timing starts at the response headers: the handshake through the chain
    // is latency, not bandwidth.
    let started = Instant::now();
    let mut received: u64 = 0;
    let mut response = response;
    loop {
        let remaining = PHASE_BUDGET.checked_sub(started.elapsed())?;
        match tokio::time::timeout(remaining, response.chunk()).await {
            Ok(Ok(Some(chunk))) => received += chunk.len() as u64,
            Ok(Ok(None)) => break,
            Ok(Err(_)) => return None,
            Err(_) => break, // time budget used up: rate from what arrived
        }
        if started.elapsed() >= PHASE_BUDGET {
            break;
        }
    }
    mbps(received, started.elapsed())
}

async fn upload(client: &reqwest::Client) -> Option<f64> {
    let sent = Arc::new(AtomicU64::new(0));
    // Set when hyper pulls the first chunk, i.e. once the connection through
    // the chain is up: the handshake is latency, not bandwidth.
    let first_chunk = Arc::new(std::sync::OnceLock::<Instant>::new());
    let counter = sent.clone();
    let opened = first_chunk.clone();
    let chunks = (UPLOAD_BYTES as usize).div_ceil(UPLOAD_CHUNK);
    let payload = bytes::Bytes::from(vec![0u8; UPLOAD_CHUNK]);
    // The body ends early once the phase budget has run out since the first
    // chunk, so a slow link uploads less instead of running on.
    let body = futures_util::stream::iter((0..chunks).map_while(move |_| {
        let started = *opened.get_or_init(Instant::now);
        if started.elapsed() >= PHASE_BUDGET {
            return None;
        }
        counter.fetch_add(UPLOAD_CHUNK as u64, Ordering::Relaxed);
        Some(Ok::<bytes::Bytes, std::io::Error>(payload.clone()))
    }));
    let request = client
        .post(UPLOAD_URL)
        .header("content-type", "application/octet-stream")
        .body(reqwest::Body::wrap_stream(body))
        .send();
    let elapsed = || first_chunk.get().map(Instant::elapsed);
    match tokio::time::timeout(CONNECT_TIMEOUT + PHASE_BUDGET + CONNECT_TIMEOUT, request).await {
        Ok(Ok(response)) if response.status().is_success() => {
            mbps(sent.load(Ordering::Relaxed), elapsed()?)
        }
        Ok(_) => None,
        // The server never answered: rate from the bytes handed to the socket.
        Err(_) => mbps(sent.load(Ordering::Relaxed), elapsed()?),
    }
}

/// Run download then upload (never both at once, so they don't compete).
pub async fn run(mixed_port: u16) -> BandwidthSample {
    let Some(client) = client(mixed_port) else {
        return BandwidthSample {
            down_mbps: None,
            up_mbps: None,
        };
    };
    let down_mbps = download(&client).await;
    let up_mbps = upload(&client).await;
    BandwidthSample { down_mbps, up_mbps }
}

/// The wire shape (`{ downMbps, upMbps, testedAt }`).
pub fn to_value(sample: &BandwidthSample) -> Value {
    json!({
        "downMbps": sample.down_mbps,
        "upMbps": sample.up_mbps,
        "testedAt": crate::usage::epoch_millis_now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_need_enough_data_and_round_to_one_decimal() {
        assert_eq!(mbps(1_250_000, Duration::from_secs(1)), Some(10.0));
        assert_eq!(mbps(3_000_000, Duration::from_millis(1500)), Some(16.0));
        assert_eq!(mbps(1_000, Duration::from_secs(1)), None);
        assert_eq!(mbps(10_000_000, Duration::from_millis(10)), None);
    }

    #[test]
    fn the_wire_shape_keeps_failed_directions_null() {
        let value = to_value(&BandwidthSample {
            down_mbps: Some(87.5),
            up_mbps: None,
        });
        assert_eq!(value["downMbps"], 87.5);
        assert_eq!(value["upMbps"], Value::Null);
        assert!(value["testedAt"].as_i64().unwrap() > 0);
    }
}
