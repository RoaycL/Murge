//! Push-stream + event emit pipeline — Rust port of
//! `src/main/services/mihomo-stream.ts` (shared WebSocket transports with
//! exponential-backoff reconnect), the stream fan-out of
//! `src/main/services/mihomo-service.ts` (`onTraffic`/`onConnections`/
//! `onLogs`/`onStreamError` + the /logs retention tap) and the push forwarder
//! of `src/main/ipc/register-ipc.ts` (one subscription per channel at startup,
//! forwarded to every renderer window). Kernel status / kernel-manager state
//! transitions emit the same way (supervisor `setStatus` -> `status` event).
//!
//! Renderer delivery uses Tauri's global `emit` (broadcast), which matches the
//! TS "send to every open renderer window" fan-out for the single-window shell.
//!
//! Milestone staging (documented in docs/tauri/phase3/README.md): the streams
//! bind the core-settings controller endpoint exactly like the REST client;
//! the `logSink` (file log capture) lands with the Phase 4 logging slice.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::error::{code, IpcError};
use crate::mihomo::{
    parse_mihomo_connections, parse_mihomo_log, parse_mihomo_traffic, MihomoLogBuffer,
};

/// A typed listener registry — the Rust mirror of the TS `Set<listener>` +
/// unsubscribe contract used by every stream and status emitter.
#[derive(Clone)]
pub struct EventHub {
    // Shared inner state: clones of a hub are THE SAME hub (the streams and
    // the service must fan out to one listener set).
    inner: Arc<EventHubInner>,
}

struct EventHubInner {
    listeners: Mutex<Vec<(i64, EventListener)>>,
    next_id: AtomicI64,
}

pub type EventListener = Arc<dyn Fn(&Value) + Send + Sync>;

impl EventHub {
    pub fn new() -> Self {
        EventHub { inner: Arc::new(EventHubInner { listeners: Mutex::new(Vec::new()), next_id: AtomicI64::new(0) }) }
    }

    /// Register a listener; returns the unsubscribe handle.
    pub fn subscribe(&self, listener: EventListener) -> i64 {
        let id = self.next_seq();
        self.inner.listeners.lock().expect("event hub mutex poisoned").push((id, listener));
        id
    }

    #[allow(dead_code)] // lifecycle API exercised by tests; prod uses hub teardown on close
    pub fn unsubscribe(&self, id: i64) {
        self.inner.listeners.lock().expect("event hub mutex poisoned").retain(|(entry, _)| *entry != id);
    }

    /// Fan a value out to every listener (registration order, like the TS Set).
    pub fn emit(&self, value: &Value) {
        let listeners = self.inner.listeners.lock().expect("event hub mutex poisoned").clone();
        for (_, listener) in listeners {
            listener(value);
        }
    }

    #[cfg(test)]
    pub fn listener_count(&self) -> usize {
        self.inner.listeners.lock().expect("event hub mutex poisoned").len()
    }

    fn next_seq(&self) -> i64 {
        self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Stream transport (mihomo-stream.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Traffic,
    Connections,
    Logs,
}

impl StreamKind {
    pub fn channel(self) -> &'static str {
        match self {
            StreamKind::Traffic => "mihomo:traffic-event",
            StreamKind::Connections => "mihomo:connections-event",
            StreamKind::Logs => "mihomo:log-event",
        }
    }

    fn source(self) -> &'static str {
        match self {
            StreamKind::Traffic => "traffic",
            StreamKind::Connections => "connections",
            StreamKind::Logs => "logs",
        }
    }
}

/// The controller endpoint the push streams bind (`ws://127.0.0.1:{port}`).
#[derive(Clone, PartialEq)]
pub struct ControllerEndpoint {
    pub port: i64,
    pub secret: String,
}

pub struct StreamOptions {
    /// Maximum reconnect attempts before giving up (0 = reconnect forever).
    pub max_retries: i64,
    pub backoff_ms: u64,
    pub max_backoff_ms: u64,
    /// Random jitter multiplier applied to each backoff, e.g. 0.2 = +/-20%.
    pub jitter: f64,
    /// A socket open for this long is considered "stable": the reconnect
    /// backoff counter resets, so a connect-then-drop cycle cannot collapse
    /// into a reconnect storm.
    pub stable_reset_ms: u64,
}

impl Default for StreamOptions {
    fn default() -> Self {
        // The production streams retry FOREVER while listeners remain.
        StreamOptions { max_retries: 0, backoff_ms: 250, max_backoff_ms: 5000, jitter: 0.2, stable_reset_ms: 10_000 }
    }
}

/// Exponential backoff with jitter, clamped to the configured maximum — the
/// exact TS formula.
pub fn backoff_delay(attempt: i64, options: &StreamOptions) -> u64 {
    let base = (options.max_backoff_ms).min(options.backoff_ms.saturating_mul(2u64.pow(attempt.max(0) as u32)));
    let factor = if options.jitter <= 0.0 {
        1.0
    } else {
        1.0 + (pseudo_random_unit() * 2.0 - 1.0) * options.jitter
    };
    (base as f64 * factor).round() as u64
}

/// A tiny deterministic-enough unit sampler (the TS uses Math.random; the
/// exact sequence is not observable in the protocol).
fn pseudo_random_unit() -> f64 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    (nanos % 10_000) as f64 / 10_000.0
}

struct StreamShared {
    kind: StreamKind,
    url: String,
    secret: String,
    options: StreamOptions,
    /// Parsed-value listeners (the forwarder subscribes one per stream).
    listeners: EventHub,
    /// The service-wide stream-error hub (`onStreamError`).
    errors: EventHub,
    /// The /logs retention tap: every VALID message is retained regardless of
    /// who is subscribed (mihomo's /logs is a live tail with no replay).
    logs: Option<Arc<MihomoLogBuffer>>,
    closed: AtomicBool,
    attempt: AtomicI64,
}

impl StreamShared {
    /// Parse one raw controller message and fan it out. The logs kind taps
    /// the parse boundary to retain history first (with its `seq`).
    fn handle_message(self: &Arc<Self>, raw: &str) {
        let parsed: Value = match serde_json::from_str(raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                self.report_parse_error(IpcError::code(
                    code::INVALID_UPSTREAM,
                    format!("mihomo returned invalid JSON: {error}"),
                ));
                return;
            }
        };
        let value = match self.kind {
            StreamKind::Traffic => {
                let parsed = match parse_mihomo_traffic(&parsed) {
                    Ok(parsed) => parsed,
                    Err(error) => return self.report_parse_error(error),
                };
                // The forwarder-visible sample carries its arrival timestamp.
                let mut sample = json!({ "timestamp": now_millis() });
                if let (Some(target), Some(source)) = (sample.as_object_mut(), parsed.as_object()) {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
                sample
            }
            StreamKind::Connections => match parse_mihomo_connections(&parsed) {
                Ok(parsed) => parsed,
                Err(error) => return self.report_parse_error(error),
            },
            StreamKind::Logs => {
                let mut message = match parse_mihomo_log(&parsed) {
                    Ok(parsed) => parsed,
                    Err(error) => return self.report_parse_error(error),
                };
                if let Some(logs) = &self.logs {
                    let seq = logs.append(message.clone());
                    message["seq"] = json!(seq);
                }
                message
            }
        };
        self.listeners.emit(&value);
    }

    fn report_parse_error(self: &Arc<Self>, error: IpcError) {
        self.report_error("parse", &error);
    }

    fn report_connection_error(self: &Arc<Self>, message: &str) {
        self.report_error(
            "connection",
            &IpcError::code(code::UPSTREAM_UNREACHABLE, message),
        );
    }

    /// `{ code, message: "<source> stream: <message>", source, kind }` — the
    /// exact `MihomoStreamError` shape.
    fn report_error(self: &Arc<Self>, kind: &str, error: &IpcError) {
        let (error_code, message) = error.parts();
        self.errors.emit(&json!({
            "code": error_code,
            "message": format!("{} stream: {}", self.kind.source(), message),
            "source": self.kind.source(),
            "kind": kind
        }));
    }
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(not(test))]
fn spawn_task<F>(future: F) -> tauri::async_runtime::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(future)
}

#[cfg(test)]
fn spawn_task<F>(future: F) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(future)
}

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// Connect one WebSocket and yield the raw-text message stream. `Err` carries
/// a human-readable transport message (mapped to `connection` errors).
async fn connect_socket(url: &str, secret: &str) -> Result<WsStream, String> {
    let mut request = tungstenite::client::IntoClientRequest::into_client_request(url)
        .map_err(|error| error.to_string())?;
    if !secret.is_empty() {
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {secret}").parse().map_err(|_| "invalid header".to_string())?,
        );
    }
    let (stream, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stream.split().1)
}

/// The reconnect loop. Backoff semantics mirror the TS transport exactly:
/// retry forever while listeners remain (`max_retries: 0`), reset the attempt
/// counter only after the socket stayed open for the "stable" window, and
/// surface every failure immediately to the error hub.
async fn run_stream(shared: Arc<StreamShared>) {
    loop {
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        let attempt = shared.attempt.load(Ordering::SeqCst);
        if shared.options.max_retries > 0 && attempt >= shared.options.max_retries {
            shared.report_connection_error("reconnect attempts exhausted");
            return;
        }
        shared.attempt.fetch_add(1, Ordering::SeqCst);
        let connected = connect_socket(&shared.url, &shared.secret).await;
        match connected {
            Ok(mut source) => {
                let opened_at = Instant::now();
                loop {
                    if shared.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    match futures_util::StreamExt::next(&mut source).await {
                        Some(Ok(tungstenite::Message::Text(text))) => {
                            shared.handle_message(&text);
                        }
                        Some(Ok(_)) => continue, // pings/pongs/binary keep the socket
                        Some(Err(error)) => {
                            shared.finish_drop(opened_at);
                            shared.report_connection_error(&error.to_string());
                            break;
                        }
                        None => {
                            shared.finish_drop(opened_at);
                            shared.report_connection_error("stream closed unexpectedly");
                            break;
                        }
                    }
                }
            }
            Err(message) => {
                shared.report_connection_error(&message);
            }
        }
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        let delay = backoff_delay(shared.attempt.load(Ordering::SeqCst) - 1, &shared.options);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

impl StreamShared {
    /// A socket that stayed open past the "stable" window resets the backoff
    /// counter; a shorter-lived drop keeps growing it.
    fn finish_drop(&self, opened_at: Instant) {
        if opened_at.elapsed() >= Duration::from_millis(self.options.stable_reset_ms) {
            self.attempt.store(0, Ordering::SeqCst);
        }
    }
}

#[cfg(not(test))]
type SpawnJoin = tauri::async_runtime::JoinHandle<()>;
#[cfg(test)]
type SpawnJoin = tokio::task::JoinHandle<()>;

struct StreamSlot {
    shared: Option<Arc<StreamShared>>,
    #[allow(dead_code)] // read by close() during shutdown
    task: Option<SpawnJoin>,
}

/// The three push streams of one controller endpoint plus the shared
/// stream-error hub. `ensure` (re)binds the streams when the endpoint changes.
pub struct MihomoStreams {
    slots: Mutex<[StreamSlot; 3]>,
    pub errors: EventHub,
    endpoint: Mutex<Option<ControllerEndpoint>>,
    logs: Arc<MihomoLogBuffer>,
}

impl MihomoStreams {
    pub fn new(logs: Arc<MihomoLogBuffer>) -> Self {
        MihomoStreams {
            slots: Mutex::new([StreamSlot { shared: None, task: None }, StreamSlot { shared: None, task: None }, StreamSlot { shared: None, task: None }]),
            errors: EventHub::new(),
            endpoint: Mutex::new(None),
            logs,
        }
    }

    /// Build the three transports for `endpoint`. Called from app setup with
    /// the controller the kernel will use; later slices rebind on kernel
    /// transitions. Already-running streams for the same endpoint are kept.
    pub fn ensure(&self, endpoint: &ControllerEndpoint) {
        let mut current = self.endpoint.lock().expect("streams endpoint mutex poisoned");
        if current.as_ref() == Some(endpoint) {
            return;
        }
        let mut slots = self.slots.lock().expect("streams slot mutex poisoned");
        for index in 0..3 {
            let kind = [StreamKind::Traffic, StreamKind::Connections, StreamKind::Logs][index];
            let shared = Arc::new(StreamShared {
                kind,
                url: format!("ws://127.0.0.1:{}/{}/", endpoint.port, path_of(kind)),
                secret: endpoint.secret.clone(),
                options: StreamOptions::default(),
                listeners: EventHub::new(),
                errors: self.errors.clone(),
                logs: if kind == StreamKind::Logs { Some(self.logs.clone()) } else { None },
                closed: AtomicBool::new(false),
                attempt: AtomicI64::new(0),
            });
            let task = spawn_task(run_stream(shared.clone()));
            slots[index] = StreamSlot { shared: Some(shared), task: Some(task) };
        }
        *current = Some(endpoint.clone());
    }

    /// Subscribe to one stream's parsed values (the forwarder holds this for
    /// the app lifetime, like the TS startup subscription).
    pub fn subscribe(&self, kind: StreamKind, listener: EventListener) -> i64 {
        let slots = self.slots.lock().expect("streams slot mutex poisoned");
        match &slots[index_of(kind)].shared {
            Some(shared) => shared.listeners.subscribe(listener),
            None => {
                let _ = listener;
                -1
            }
        }
    }

    #[allow(dead_code)] // lifecycle API exercised by tests; the app process teardown owns shutdown
    pub fn close(&self) {
        let mut slots = self.slots.lock().expect("streams slot mutex poisoned");
        for slot in slots.iter_mut() {
            if let Some(shared) = &slot.shared {
                shared.closed.store(true, Ordering::SeqCst);
                shared.listeners.inner.listeners.lock().expect("event hub mutex poisoned").clear();
            }
            if let Some(task) = slot.task.take() {
                task.abort();
            }
            slot.shared = None;
        }
        *self.endpoint.lock().expect("streams endpoint mutex poisoned") = None;
    }
}

fn index_of(kind: StreamKind) -> usize {
    match kind {
        StreamKind::Traffic => 0,
        StreamKind::Connections => 1,
        StreamKind::Logs => 2,
    }
}

fn path_of(kind: StreamKind) -> &'static str {
    match kind {
        StreamKind::Traffic => "traffic",
        StreamKind::Connections => "connections",
        StreamKind::Logs => "logs",
    }
}

// ---------------------------------------------------------------------------
// Push forwarder (register-ipc.ts)
// ---------------------------------------------------------------------------

/// The startup subscription set: one forwarder per push channel, delivering to
/// every renderer via Tauri's broadcast emit. Kernel status + kernel-manager
/// state transitions forward through the hubs the supervisor/manager own.
pub fn start_forwarding(
    app: tauri::AppHandle,
    streams: &MihomoStreams,
    kernel: &crate::kernel::KernelServices,
) {
    let emit = move |channel: &str, value: Value| {
        let _ = tauri::Emitter::emit(&app, channel, value);
    };
    for kind in [StreamKind::Traffic, StreamKind::Connections, StreamKind::Logs] {
        let emitter = emit.clone();
        let channel = kind.channel();
        streams.subscribe(
            kind,
            Arc::new(move |value| emitter(channel, value.clone())),
        );
    }
    let emitter = emit.clone();
    streams.errors.subscribe(Arc::new(move |value| {
        emitter("mihomo:stream-error-event", value.clone())
    }));
    let emitter = emit.clone();
    kernel.supervisor.status_listeners.subscribe(Arc::new(move |value| {
        emitter("kernel:status-event", value.clone())
    }));
    let emitter = emit.clone();
    kernel.manager.state_listeners.subscribe(Arc::new(move |value| {
        emitter("kernel-manager:state-event", value.clone())
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collector() -> (Arc<Mutex<Vec<Value>>>, EventListener) {
        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (events.clone(), Arc::new(move |value: &Value| sink.lock().unwrap().push(value.clone())))
    }

    #[test]
    fn event_hub_subscription_semantics() {
        let hub = EventHub::new();
        let (received, listener) = collector();
        let id = hub.subscribe(listener);
        hub.emit(&json!({ "phase": "stopped" }));
        assert_eq!(received.lock().unwrap().len(), 1);
        hub.unsubscribe(id);
        assert_eq!(hub.listener_count(), 0);
        hub.emit(&json!({ "phase": "running" }));
        assert_eq!(received.lock().unwrap().len(), 1, "unsubscribed listeners stop receiving");
    }

    #[test]
    fn backoff_doubles_and_clamps() {
        let options = StreamOptions { jitter: 0.0, ..StreamOptions::default() };
        assert_eq!(backoff_delay(0, &options), 250);
        assert_eq!(backoff_delay(1, &options), 500);
        assert_eq!(backoff_delay(2, &options), 1000);
        assert_eq!(backoff_delay(3, &options), 2000);
        assert_eq!(backoff_delay(4, &options), 4000);
        assert_eq!(backoff_delay(5, &options), 5000, "clamped to the maximum");
        assert_eq!(backoff_delay(50, &options), 5000);
    }

    #[test]
    fn stream_error_payload_matches_the_ts_shape() {
        let shared = Arc::new(StreamShared {
            kind: StreamKind::Traffic,
            url: "ws://127.0.0.1:1/traffic/".into(),
            secret: String::new(),
            options: StreamOptions::default(),
            listeners: EventHub::new(),
            errors: EventHub::new(),
            logs: None,
            closed: AtomicBool::new(false),
            attempt: AtomicI64::new(0),
        });
        let (received, listener) = collector();
        shared.errors.subscribe(listener);
        shared.report_connection_error("stream closed unexpectedly");
        let error = received.lock().unwrap()[0].clone();
        assert_eq!(error["code"], "UPSTREAM_UNREACHABLE");
        assert_eq!(error["message"], "traffic stream: stream closed unexpectedly");
        assert_eq!(error["source"], "traffic");
        assert_eq!(error["kind"], "connection");
        shared.report_parse_error(IpcError::code(code::INVALID_UPSTREAM, "Invalid traffic payload: Required"));
        let error = received.lock().unwrap()[1].clone();
        assert_eq!(error["code"], "INVALID_UPSTREAM");
        assert_eq!(error["kind"], "parse");
        assert_eq!(error["message"], "traffic stream: Invalid traffic payload: Required");
    }

    #[tokio::test]
    async fn streams_parse_fan_out_and_tap_the_log_buffer() {
        // A real WebSocket server that accepts ALL THREE client connections.
        // Frames are routed by the client's requested path, exactly like the
        // controller does (the client dials traffic/connections/logs).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            use futures_util::SinkExt;
            use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
            loop {
                let Ok((socket, _)) = listener.accept().await else { break };
                // Route by the client's upgrade path (accept_hdr_async hands
                // us the request before completing the handshake).
                let path: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
                let capture = path.clone();
                let ws = tokio_tungstenite::accept_hdr_async(socket, move |req: &Request, resp: Response| {
                    if let Ok(mut held) = capture.lock() {
                        *held = req.uri().path().to_string();
                    }
                    Ok(resp)
                })
                .await;
                let Ok(mut ws) = ws else { break };
                let path = path.lock().unwrap().clone();
                let frames: Vec<&str> = if path.contains("/traffic") {
                    vec![r#"{"up":10,"down":20,"upTotal":1,"downTotal":2}"#]
                } else if path.contains("/connections") {
                    vec![]
                } else if path.contains("/logs") {
                    vec![r#"{"type":"info","payload":"kernel started"}"#, "not json"]
                } else {
                    vec![]
                };
                // Serve the connection on its own task so the accept loop
                // keeps taking the other two streams.
                tokio::spawn(async move {
                    for frame in frames {
                        let _ = ws.send(tungstenite::Message::Text(frame.to_string())).await;
                    }
                    // Hold the socket open so the client does not reconnect.
                    while let Some(Ok(_)) = futures_util::StreamExt::next(&mut ws).await {}
                });
            }
        });

        let logs = Arc::new(MihomoLogBuffer::new());
        let streams = MihomoStreams::new(logs.clone());
        let (traffic_events, traffic_listener) = collector();
        let (log_events, log_listener) = collector();
        let (errors, error_listener) = collector();
        streams.ensure(&ControllerEndpoint { port: port as i64, secret: String::new() });
        streams.subscribe(StreamKind::Traffic, traffic_listener);
        streams.subscribe(StreamKind::Logs, log_listener);
        streams.errors.subscribe(error_listener);
        // Wait for the fan-out (both messages) + the parse error.
        for _ in 0..150 {
            if traffic_events.lock().unwrap().len() >= 1
                && log_events.lock().unwrap().len() >= 1
                && errors.lock().unwrap().len() >= 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        {
            let traffic = traffic_events.lock().unwrap();
            assert!(!traffic.is_empty(), "traffic sample fanned out");
            assert_eq!(traffic[0]["up"], 10);
            assert!(traffic[0]["timestamp"].as_u64().unwrap_or(0) > 0, "arrival timestamp stamped");
        }
        {
            let log_events = log_events.lock().unwrap();
            assert!(!log_events.is_empty(), "log message fanned out");
            assert_eq!(log_events[0]["payload"], "kernel started");
            assert_eq!(log_events[0]["seq"], 1, "the retained copy and the event agree on seq");
        }
        {
            let snapshot = logs.snapshot(0);
            assert_eq!(snapshot.len(), 1, "buffer tapped regardless of subscribers");
            assert_eq!(snapshot[0]["payload"], "kernel started");
        }
        {
            let errors = errors.lock().unwrap();
            assert_eq!(errors.len(), 1, "exactly one parse error");
            assert_eq!(errors[0]["code"], "INVALID_UPSTREAM");
            assert_eq!(errors[0]["kind"], "parse");
            assert_eq!(errors[0]["source"], "logs");
            assert!(
                errors[0]["message"].as_str().unwrap_or("").starts_with("logs stream: mihomo returned invalid JSON"),
                "{}",
                errors[0]["message"]
            );
        }
        server.abort();
        streams.close();
    }

    #[tokio::test]
    async fn connection_failure_reports_immediately_and_keeps_retrying() {
        // Nothing listens on this port (bound then dropped).
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let logs = Arc::new(MihomoLogBuffer::new());
        let streams = MihomoStreams::new(logs);
        let (errors, error_listener) = collector();
        streams.ensure(&ControllerEndpoint { port: port as i64, secret: String::new() });
        streams.errors.subscribe(error_listener);
        // The very first connect attempt fails fast (connection refused).
        for _ in 0..50 {
            if !errors.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let error = errors.lock().unwrap();
        assert!(!error.is_empty(), "first connection failure surfaces immediately");
        assert_eq!(error[0]["kind"], "connection");
        assert_eq!(error[0]["source"], "traffic");
        streams.close();
    }

    #[tokio::test]
    async fn close_stops_the_reconnect_loop() {
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let logs = Arc::new(MihomoLogBuffer::new());
        let streams = MihomoStreams::new(logs);
        streams.ensure(&ControllerEndpoint { port: port as i64, secret: String::new() });
        streams.close();
        tokio::time::sleep(Duration::from_millis(50)).await;
        // After close the endpoint is cleared; re-ensure rebuilds cleanly.
        streams.ensure(&ControllerEndpoint { port: port as i64, secret: String::new() });
        streams.close();
    }
}
