//! Surge-compatible `[Script]` runner (`type=http-request` / `http-response`).
//!
//! Every invocation gets a fresh QuickJS runtime on a blocking thread, so a
//! script cannot see another script's globals and a runaway loop only costs
//! its own thread until the interrupt handler trips the deadline. The globals
//! (`$request`, `$response`, `$done`, `$httpClient`, `$persistentStore`,
//! `$notification`, `$argument`, timers, `TextEncoder`, `URL` …) are defined
//! by `prelude.js` on top of a small `__host` bridge implemented here.
//! `$httpClient` requests and timers are driven by a tiny event loop until
//! the script calls `$done` or the timeout fires.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rquickjs::function::Opt;
use rquickjs::{ArrayBuffer, Context, Ctx, Function, Object, Runtime, TypedArray, Value};
use serde_json::{json, Map, Value as Json};

const PRELUDE: &str = include_str!("prelude.js");
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const STACK_LIMIT: usize = 4 * 1024 * 1024;
/// Hard cap on what a script may hold in `$persistentStore`.
const STORE_VALUE_LIMIT: usize = 8 * 1024 * 1024;
const STORE_TOTAL_LIMIT: usize = 64 * 1024 * 1024;
const MAX_HTTP_CALLS: usize = 64;
const LOG_LIMIT: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    Request,
    Response,
}

impl ScriptKind {
    fn label(self) -> &'static str {
        match self {
            ScriptKind::Request => "http-request",
            ScriptKind::Response => "http-response",
        }
    }
}

/// One HTTP message as a script sees it. `status` is 0 for requests.
#[derive(Debug, Clone, Default)]
pub struct HttpMessage {
    pub url: String,
    pub method: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct ScriptCall {
    pub name: String,
    pub code: Arc<str>,
    pub kind: ScriptKind,
    pub argument: String,
    pub timeout: Duration,
    pub binary: bool,
    /// Expose the Quantumult X globals as well.
    pub qx: bool,
    pub request: HttpMessage,
    pub response: Option<HttpMessage>,
}

/// What `$done(value)` asked for. Fields left out mean "unchanged".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptDone {
    pub url: Option<String>,
    pub method: Option<String>,
    pub status: Option<u16>,
    pub headers: Option<Vec<(String, String)>>,
    pub body: Option<Vec<u8>>,
    /// A request script answering directly (`$done({ response: … })`).
    pub response: Option<Box<ScriptDone>>,
    /// `$done({ abort: true })` / QX `$done({ status: 'reject' })`.
    pub abort: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScriptOutcome {
    /// `$done()` / `$done({})`, or the script ended without calling it.
    Unchanged,
    Done(ScriptDone),
    Failed(String),
}

pub struct ScriptReport {
    pub outcome: ScriptOutcome,
    pub logs: Vec<String>,
    pub elapsed: Duration,
}

/// An outgoing `$httpClient` request.
#[derive(Debug, Clone)]
pub struct HttpCall {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    pub follow_redirects: bool,
}

#[derive(Debug, Clone)]
pub struct HttpReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Fetcher = Arc<dyn Fn(HttpCall) -> BoxFuture<Result<HttpReply, String>> + Send + Sync>;
pub type Notifier = Arc<dyn Fn(Notification) + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub script: String,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// $persistentStore
// ---------------------------------------------------------------------------

/// Key-value store shared by every script, persisted as one JSON file.
#[derive(Default)]
pub struct PersistentStore {
    path: Option<PathBuf>,
    data: Mutex<BTreeMap<String, String>>,
}

impl PersistentStore {
    pub fn open(path: Option<PathBuf>) -> Self {
        let data = path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        PersistentStore {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn read(&self, key: &str) -> Option<String> {
        self.data.lock().expect("store").get(key).cloned()
    }

    /// `None` deletes the key. False when the value is too large.
    pub fn write(&self, key: &str, value: Option<String>) -> bool {
        let mut data = self.data.lock().expect("store");
        match value {
            Some(value) => {
                if value.len() > STORE_VALUE_LIMIT {
                    return false;
                }
                let total: usize = data
                    .iter()
                    .filter(|(k, _)| k.as_str() != key)
                    .map(|(k, v)| k.len() + v.len())
                    .sum();
                if total + key.len() + value.len() > STORE_TOTAL_LIMIT {
                    return false;
                }
                data.insert(key.to_string(), value);
            }
            None => {
                data.remove(key);
            }
        }
        let snapshot = serde_json::to_string(&*data).unwrap_or_else(|_| "{}".into());
        drop(data);
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
            if std::fs::write(&tmp, snapshot).is_err() || std::fs::rename(&tmp, path).is_err() {
                return false;
            }
        }
        true
    }

    pub fn len(&self) -> usize {
        self.data.lock().expect("store").len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.data.lock().expect("store").clear();
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Everything a script reaches outside its sandbox.
#[derive(Clone)]
pub struct ScriptHost {
    pub store: Arc<PersistentStore>,
    pub fetcher: Fetcher,
    pub notifier: Arc<Mutex<Option<Notifier>>>,
}

impl ScriptHost {
    fn notify(&self, notification: Notification) {
        let notifier = self.notifier.lock().expect("notifier").clone();
        if let Some(notifier) = notifier {
            notifier(notification);
        }
    }
}

// ---------------------------------------------------------------------------
// Running a script
// ---------------------------------------------------------------------------

/// Run one script to completion off the async runtime.
pub fn run(host: ScriptHost, call: ScriptCall) -> BoxFuture<ScriptReport> {
    Box::pin(run_inner(host, call))
}

async fn run_inner(host: ScriptHost, call: ScriptCall) -> ScriptReport {
    let handle = tokio::runtime::Handle::current();
    let name = call.name.clone();
    match tokio::task::spawn_blocking(move || run_blocking(&host, &handle, call)).await {
        Ok(report) => report,
        Err(error) => ScriptReport {
            outcome: ScriptOutcome::Failed(format!("脚本 {name} 异常退出：{error}")),
            logs: Vec::new(),
            elapsed: Duration::ZERO,
        },
    }
}

enum Event {
    Http(u32, Result<HttpReply, String>, bool),
}

#[derive(Default)]
struct LoopState {
    done: Option<ScriptOutcome>,
    timers: Vec<(Instant, u32)>,
    in_flight: usize,
    http_calls: usize,
    logs: Vec<String>,
    request_body: Option<Vec<u8>>,
    response_body: Option<Vec<u8>>,
}

fn run_blocking(
    host: &ScriptHost,
    handle: &tokio::runtime::Handle,
    call: ScriptCall,
) -> ScriptReport {
    let started = Instant::now();
    let deadline = started + call.timeout;
    let state = Rc::new(RefCell::new(LoopState::default()));
    let outcome = match execute(host, handle, &call, deadline, &state) {
        Ok(outcome) => outcome,
        Err(message) => ScriptOutcome::Failed(message),
    };
    let logs = std::mem::take(&mut state.borrow_mut().logs);
    ScriptReport {
        outcome,
        logs,
        elapsed: started.elapsed(),
    }
}

fn headers_json(headers: &[(String, String)]) -> Json {
    let mut map = Map::new();
    for (name, value) in headers {
        match map.get_mut(name) {
            Some(Json::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                map.insert(name.clone(), Json::String(value.clone()));
            }
        }
    }
    Json::Object(map)
}

fn execute(
    host: &ScriptHost,
    handle: &tokio::runtime::Handle,
    call: &ScriptCall,
    deadline: Instant,
    state: &Rc<RefCell<LoopState>>,
) -> Result<ScriptOutcome, String> {
    let runtime = Runtime::new().map_err(|e| format!("无法创建脚本引擎：{e}"))?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime).map_err(|e| format!("无法创建脚本环境：{e}"))?;
    let (events_tx, events_rx) = mpsc::channel::<Event>();

    {
        let mut s = state.borrow_mut();
        s.request_body = call.request.body.clone();
        s.response_body = call.response.as_ref().and_then(|r| r.body.clone());
    }
    let input = json!({
        "name": call.name,
        "type": call.kind.label(),
        "argument": call.argument,
        "binary": call.binary,
        "qx": call.qx,
        "id": format!("{:x}", rand::random::<u64>()),
        "request": {
            "url": call.request.url,
            "method": call.request.method,
            "headers": headers_json(&call.request.headers),
        },
        "response": call.response.as_ref().map(|response| json!({
            "status": response.status,
            "headers": headers_json(&response.headers),
        })),
    })
    .to_string();

    let setup = context.with(|ctx| install(ctx, host, handle, call, state, &events_tx, input));
    setup.map_err(|e| format!("脚本环境初始化失败：{e}"))?;

    context.with(|ctx| eval(&ctx, PRELUDE, "prelude"))?;
    context.with(|ctx| eval(&ctx, &call.code, &call.name))?;

    loop {
        drain_jobs(&runtime, &context, state)?;
        if let Some(outcome) = state.borrow_mut().done.take() {
            return Ok(outcome);
        }
        if Instant::now() > deadline {
            return Err(format!("脚本超时（{} 秒）", call.timeout.as_secs()));
        }
        let (next_timer, in_flight) = {
            let s = state.borrow();
            (s.timers.iter().map(|(due, _)| *due).min(), s.in_flight)
        };
        if next_timer.is_none() && in_flight == 0 {
            // Nothing left that could call $done.
            return Ok(ScriptOutcome::Unchanged);
        }
        let wake = next_timer.unwrap_or(deadline).min(deadline);
        let wait = wake.saturating_duration_since(Instant::now());
        match events_rx.recv_timeout(wait) {
            Ok(Event::Http(id, result, binary)) => {
                state.borrow_mut().in_flight -= 1;
                context.with(|ctx| deliver_http(&ctx, id, result, binary))?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                let due: Vec<u32> = {
                    let mut s = state.borrow_mut();
                    let mut due: Vec<(Instant, u32)> = Vec::new();
                    s.timers.retain(|timer| {
                        if timer.0 <= now {
                            due.push(*timer);
                            false
                        } else {
                            true
                        }
                    });
                    due.sort();
                    due.into_iter().map(|(_, id)| id).collect()
                };
                for id in due {
                    context.with(|ctx| -> Result<(), String> {
                        let fire: Function = ctx
                            .globals()
                            .get("__fireTimer")
                            .map_err(|e| e.to_string())?;
                        fire.call::<_, ()>((id,)).map_err(|e| exception(&ctx, e))
                    })?;
                    drain_jobs(&runtime, &context, state)?;
                    if state.borrow().done.is_some() {
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Ok(ScriptOutcome::Unchanged);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn install<'js>(
    ctx: Ctx<'js>,
    host: &ScriptHost,
    handle: &tokio::runtime::Handle,
    call: &ScriptCall,
    state: &Rc<RefCell<LoopState>>,
    events_tx: &mpsc::Sender<Event>,
    input: String,
) -> rquickjs::Result<()> {
    let bridge = Object::new(ctx.clone())?;
    bridge.set("input", Function::new(ctx.clone(), move || input.clone())?)?;
    let binary = call.binary;
    {
        let state = state.clone();
        bridge.set(
            "requestBody",
            Function::new(
                ctx.clone(),
                move |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
                    let body = state.borrow_mut().request_body.take();
                    body_value(&ctx, body, binary)
                },
            )?,
        )?;
    }
    {
        let state = state.clone();
        bridge.set(
            "responseBody",
            Function::new(
                ctx.clone(),
                move |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
                    let body = state.borrow_mut().response_body.take();
                    body_value(&ctx, body, binary)
                },
            )?,
        )?;
    }
    {
        let state = state.clone();
        let name = call.name.clone();
        bridge.set(
            "log",
            Function::new(ctx.clone(), move |level: String, text: String| {
                let mut s = state.borrow_mut();
                if s.logs.len() < LOG_LIMIT {
                    let text: String = text.chars().take(2000).collect();
                    s.logs.push(if level == "log" || level == "info" {
                        text
                    } else {
                        format!("[{level}] {text}")
                    });
                }
                if level == "error" {
                    crate::diag!("[mitm] 脚本 {name}：{text}");
                }
            })?,
        )?;
    }
    {
        let state = state.clone();
        bridge.set(
            "timer",
            Function::new(ctx.clone(), move |id: u32, ms: f64| {
                let delay = Duration::from_millis(ms.clamp(0.0, 3_600_000.0) as u64);
                state.borrow_mut().timers.push((Instant::now() + delay, id));
            })?,
        )?;
    }
    bridge.set(
        "utf8Encode",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            TypedArray::<u8>::new(ctx, text.into_bytes())
        })?,
    )?;
    bridge.set(
        "utf8Decode",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, data: Value<'js>, fatal: Opt<bool>, ignore_bom: Opt<bool>| {
                let bytes = bytes_of(&data).unwrap_or_default();
                let bytes =
                    if !ignore_bom.0.unwrap_or(false) && bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                        &bytes[3..]
                    } else {
                        &bytes[..]
                    };
                if fatal.0.unwrap_or(false) {
                    match std::str::from_utf8(bytes) {
                        Ok(text) => Ok(text.to_string()),
                        Err(_) => Err(rquickjs::Exception::throw_type(
                            &ctx,
                            "The encoded data was not valid utf-8",
                        )),
                    }
                } else {
                    Ok(String::from_utf8_lossy(bytes).into_owned())
                }
            },
        )?,
    )?;
    bridge.set(
        "ungzip",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, data: Value<'js>| -> rquickjs::Result<Value<'js>> {
                use std::io::Read;
                let bytes = bytes_of(&data).unwrap_or_default();
                let mut out = Vec::new();
                if flate2::read::GzDecoder::new(&bytes[..])
                    .take(64 * 1024 * 1024)
                    .read_to_end(&mut out)
                    .is_err()
                {
                    return Ok(Value::new_null(ctx));
                }
                Ok(TypedArray::<u8>::new(ctx, out)?.into_value())
            },
        )?,
    )?;
    {
        let store = host.store.clone();
        bridge.set(
            "storeRead",
            Function::new(ctx.clone(), move |key: String| store.read(&key))?,
        )?;
        let store = host.store.clone();
        bridge.set(
            "storeWrite",
            Function::new(ctx.clone(), move |value: Option<String>, key: String| {
                store.write(&key, value)
            })?,
        )?;
    }
    {
        let host = host.clone();
        let script = call.name.clone();
        let sent = Rc::new(RefCell::new(0usize));
        bridge.set(
            "notify",
            Function::new(
                ctx.clone(),
                move |title: String, subtitle: String, body: String, url: String| {
                    let mut sent = sent.borrow_mut();
                    if *sent >= 5 {
                        return;
                    }
                    *sent += 1;
                    host.notify(Notification {
                        script: script.clone(),
                        title,
                        subtitle,
                        body,
                        url,
                    });
                },
            )?,
        )?;
    }
    {
        let state = state.clone();
        let fetcher = host.fetcher.clone();
        let handle = handle.clone();
        let events = events_tx.clone();
        bridge.set(
            "http",
            Function::new(
                ctx.clone(),
                move |id: u32, meta: String, body: Value<'js>| {
                    let meta: Json = serde_json::from_str(&meta).unwrap_or(Json::Null);
                    let binary = meta["binary"].as_bool().unwrap_or(false);
                    let mut s = state.borrow_mut();
                    if s.http_calls >= MAX_HTTP_CALLS {
                        let _ =
                            events.send(Event::Http(id, Err("脚本发出的请求过多".into()), binary));
                        return;
                    }
                    s.http_calls += 1;
                    s.in_flight += 1;
                    drop(s);
                    let call = HttpCall {
                        method: meta["method"].as_str().unwrap_or("GET").to_string(),
                        url: meta["url"].as_str().unwrap_or_default().to_string(),
                        headers: meta["headers"]
                            .as_object()
                            .map(|map| {
                                map.iter()
                                    .filter_map(|(k, v)| {
                                        let value = match v {
                                            Json::String(s) => s.clone(),
                                            Json::Null => return None,
                                            other => other.to_string(),
                                        };
                                        Some((k.clone(), value))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        body: bytes_of(&body),
                        timeout: Duration::from_secs_f64(
                            meta["timeout"]
                                .as_f64()
                                .filter(|t| *t > 0.0)
                                .map(|t| if t > 1000.0 { t / 1000.0 } else { t })
                                .unwrap_or(30.0)
                                .min(300.0),
                        ),
                        follow_redirects: meta["redirect"].as_bool().unwrap_or(true),
                    };
                    let fetcher = fetcher.clone();
                    let events = events.clone();
                    handle.spawn(async move {
                        let timeout = call.timeout;
                        let result = match tokio::time::timeout(timeout, fetcher(call)).await {
                            Ok(result) => result,
                            Err(_) => Err("请求超时".into()),
                        };
                        let _ = events.send(Event::Http(id, result, binary));
                    });
                },
            )?,
        )?;
    }
    {
        let state = state.clone();
        bridge.set(
            "done",
            Function::new(ctx.clone(), move |value: Value<'js>| {
                let mut s = state.borrow_mut();
                if s.done.is_none() {
                    s.done = Some(match parse_done(&value) {
                        Some(done) if done != ScriptDone::default() => ScriptOutcome::Done(done),
                        _ => ScriptOutcome::Unchanged,
                    });
                }
            })?,
        )?;
    }
    ctx.globals().set("__host", bridge)?;
    Ok(())
}

fn eval(ctx: &Ctx<'_>, code: &str, name: &str) -> Result<(), String> {
    let mut options = rquickjs::context::EvalOptions::default();
    options.global = true;
    options.strict = false;
    options.filename = Some(name.to_string());
    ctx.eval_with_options::<(), _>(code.as_bytes().to_vec(), options)
        .map_err(|e| exception(ctx, e))
}

fn drain_jobs(
    runtime: &Runtime,
    context: &Context,
    state: &Rc<RefCell<LoopState>>,
) -> Result<(), String> {
    while runtime.is_job_pending() {
        if state.borrow().done.is_some() {
            return Ok(());
        }
        if let Err(error) = runtime.execute_pending_job() {
            let message = context.with(|ctx| {
                let _ = error;
                describe(&ctx.catch())
            });
            if message.contains("interrupted") {
                return Err("脚本超时".into());
            }
            // An unhandled rejection in one promise does not end the script.
            let mut s = state.borrow_mut();
            if s.logs.len() < LOG_LIMIT {
                s.logs.push(format!("[error] {message}"));
            }
        }
    }
    Ok(())
}

fn deliver_http(
    ctx: &Ctx<'_>,
    id: u32,
    result: Result<HttpReply, String>,
    binary: bool,
) -> Result<(), String> {
    let deliver: Function = ctx
        .globals()
        .get("__deliverHttp")
        .map_err(|e| e.to_string())?;
    let outcome = match result {
        Ok(reply) => {
            let meta = json!({
                "status": reply.status,
                "headers": headers_json(&reply.headers),
            })
            .to_string();
            let data = body_value(ctx, Some(reply.body), binary).map_err(|e| e.to_string())?;
            deliver.call::<_, ()>((id, Value::new_null(ctx.clone()), meta, data))
        }
        Err(message) => deliver.call::<_, ()>((
            id,
            message,
            Value::new_null(ctx.clone()),
            Value::new_null(ctx.clone()),
        )),
    };
    outcome.map_err(|e| exception(ctx, e))
}

fn body_value<'js>(
    ctx: &Ctx<'js>,
    body: Option<Vec<u8>>,
    binary: bool,
) -> rquickjs::Result<Value<'js>> {
    match body {
        None => Ok(Value::new_undefined(ctx.clone())),
        Some(bytes) if binary => Ok(TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value()),
        Some(bytes) => {
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
            };
            Ok(rquickjs::String::from_str(ctx.clone(), &text)?.into_value())
        }
    }
}

/// Copy the bytes out of a `Uint8Array`, any typed array view, an
/// `ArrayBuffer`, or a string (UTF-8).
fn bytes_of(value: &Value<'_>) -> Option<Vec<u8>> {
    if let Some(text) = value.as_string() {
        return text.to_string().ok().map(String::into_bytes);
    }
    let object = value.as_object()?;
    if let Some(array) = object.as_typed_array::<u8>() {
        // SAFETY: the bytes are copied immediately, while no JS code runs.
        return unsafe { array.as_bytes() }.map(<[u8]>::to_vec);
    }
    if let Some(buffer) = object.as_array_buffer() {
        // SAFETY: as above.
        return unsafe { buffer.as_bytes() }.map(<[u8]>::to_vec);
    }
    // Other views (Int8Array, DataView …): go through their buffer.
    let buffer: ArrayBuffer = object.get::<_, ArrayBuffer>("buffer").ok()?;
    let offset: usize = object.get("byteOffset").unwrap_or(0);
    let length: usize = object.get("byteLength").unwrap_or(0);
    // SAFETY: as above.
    let bytes = unsafe { buffer.as_bytes() }?;
    bytes.get(offset..offset + length).map(<[u8]>::to_vec)
}

fn parse_status(value: &Value<'_>) -> Option<u16> {
    if let Some(number) = value.as_number() {
        return (100.0..=599.0).contains(&number).then_some(number as u16);
    }
    if let Some(int) = value.as_int() {
        return u16::try_from(int)
            .ok()
            .filter(|code| (100..=599).contains(code));
    }
    // QX: "HTTP/1.1 200 OK".
    let text = value.as_string()?.to_string().ok()?;
    text.split_whitespace()
        .find_map(|part| part.parse::<u16>().ok())
        .filter(|code| (100..=599).contains(code))
}

fn parse_headers(value: &Value<'_>) -> Option<Vec<(String, String)>> {
    let object = value.as_object()?;
    let mut out = Vec::new();
    for entry in object.props::<String, Value>() {
        let Ok((name, value)) = entry else { continue };
        if value.is_undefined() || value.is_null() {
            continue;
        }
        if let Some(array) = value.as_array() {
            for item in array.iter::<Value>().flatten() {
                if let Some(text) = js_to_string(&item) {
                    out.push((name.clone(), text));
                }
            }
        } else if let Some(text) = js_to_string(&value) {
            out.push((name, text));
        }
    }
    Some(out)
}

fn js_to_string(value: &Value<'_>) -> Option<String> {
    if let Some(text) = value.as_string() {
        return text.to_string().ok();
    }
    if let Some(number) = value.as_number() {
        return Some(if number.fract() == 0.0 && number.abs() < 1e15 {
            format!("{}", number as i64)
        } else {
            number.to_string()
        });
    }
    if let Some(int) = value.as_int() {
        return Some(int.to_string());
    }
    value.as_bool().map(|b| b.to_string())
}

fn parse_done(value: &Value<'_>) -> Option<ScriptDone> {
    let object = value.as_object()?;
    let get = |key: &str| {
        object
            .get::<_, Value>(key)
            .ok()
            .filter(|v| !v.is_undefined() && !v.is_null())
    };
    let mut done = ScriptDone {
        url: get("url").and_then(|v| js_to_string(&v)),
        method: get("method").and_then(|v| js_to_string(&v)),
        status: get("status").and_then(|v| parse_status(&v)),
        headers: get("headers").and_then(|v| parse_headers(&v)),
        body: get("bodyBytes")
            .and_then(|v| bytes_of(&v))
            .or_else(|| get("body").and_then(|v| body_bytes(&v))),
        response: get("response").and_then(|v| parse_done(&v)).map(Box::new),
        abort: get("abort").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    if done.status.is_none() {
        if let Some(text) = get("status").and_then(|v| js_to_string(&v)) {
            if text.eq_ignore_ascii_case("reject") {
                done.abort = true;
            }
        }
    }
    Some(done)
}

/// `$done({ body })` accepts a string, bytes, or (leniently) an object that
/// is serialised as JSON.
fn body_bytes(value: &Value<'_>) -> Option<Vec<u8>> {
    if let Some(bytes) = bytes_of(value) {
        return Some(bytes);
    }
    if value.is_object() {
        let ctx = value.ctx().clone();
        let json: Object = ctx.globals().get("JSON").ok()?;
        let stringify: Function = json.get("stringify").ok()?;
        let text: String = stringify.call((value.clone(),)).ok()?;
        return Some(text.into_bytes());
    }
    js_to_string(value).map(String::into_bytes)
}

fn describe(value: &Value<'_>) -> String {
    if let Some(object) = value.as_object() {
        let message: Option<String> = object.get("message").ok();
        let stack: Option<String> = object.get("stack").ok();
        if let Some(message) = message {
            let mut text = message;
            if let Some(first) = stack.as_deref().and_then(|s| s.lines().next()) {
                text.push_str(&format!("（{}）", first.trim()));
            }
            return text;
        }
    }
    js_to_string(value).unwrap_or_else(|| "未知错误".into())
}

fn exception(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if matches!(error, rquickjs::Error::Exception) {
        let message = describe(&ctx.catch());
        if message.contains("interrupted") {
            return "脚本超时".into();
        }
        if message.contains("out of memory") {
            return "脚本内存超限".into();
        }
        return message;
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_with(fetcher: Fetcher) -> (ScriptHost, Arc<Mutex<Vec<Notification>>>) {
        let notes = Arc::new(Mutex::new(Vec::new()));
        let sink = notes.clone();
        let notifier: Notifier = Arc::new(move |n| sink.lock().unwrap().push(n));
        (
            ScriptHost {
                store: Arc::new(PersistentStore::default()),
                fetcher,
                notifier: Arc::new(Mutex::new(Some(notifier))),
            },
            notes,
        )
    }

    fn echo_fetcher() -> Fetcher {
        Arc::new(|call: HttpCall| {
            Box::pin(async move {
                Ok(HttpReply {
                    status: 200,
                    headers: vec![("Content-Type".into(), "text/plain".into())],
                    body: format!("{} {}", call.method, call.url).into_bytes(),
                })
            })
        })
    }

    fn call(kind: ScriptKind, code: &str, binary: bool) -> ScriptCall {
        ScriptCall {
            name: "test".into(),
            code: Arc::from(code),
            kind,
            argument: "a=1&b=2".into(),
            timeout: Duration::from_secs(5),
            binary,
            qx: false,
            request: HttpMessage {
                url: "https://api.example.com/v1?x=1".into(),
                method: "GET".into(),
                status: 0,
                headers: vec![("User-Agent".into(), "UA".into())],
                body: None,
            },
            response: (kind == ScriptKind::Response).then(|| HttpMessage {
                url: String::new(),
                method: String::new(),
                status: 200,
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: Some(br#"{"ads":[1],"vip":false}"#.to_vec()),
            }),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn response_script_rewrites_json_body() {
        let (host, _) = host_with(echo_fetcher());
        let report = run(
            host,
            call(
                ScriptKind::Response,
                r#"
                const obj = JSON.parse($response.body)
                delete obj.ads
                obj.vip = true
                obj.arg = $argument
                obj.ua = $request.headers['User-Agent']
                console.log('ok', 1)
                $done({ body: JSON.stringify(obj) })
                "#,
                false,
            ),
        )
        .await;
        let ScriptOutcome::Done(done) = report.outcome else {
            panic!("{:?} {:?}", report.outcome, report.logs);
        };
        assert_eq!(
            String::from_utf8(done.body.unwrap()).unwrap(),
            r#"{"vip":true,"arg":"a=1&b=2","ua":"UA"}"#
        );
        assert_eq!(report.logs, vec!["ok 1"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn request_script_answers_directly_after_http_and_timer() {
        let (host, notes) = host_with(echo_fetcher());
        host.store.write("k", Some("stored".into()));
        let report = run(
            host.clone(),
            call(
                ScriptKind::Request,
                r#"
                $httpClient.post({ url: 'https://x.test/a', body: { a: 1 } }, (err, resp, data) => {
                  setTimeout(() => {
                    $persistentStore.write('v2', 'k2')
                    $notification.post('标题', '副', data, { url: 'https://open' })
                    $done({ response: { status: 201, headers: { 'X-A': 1 }, body: data + ' ' + $persistentStore.read('k') } })
                  }, 10)
                })
                "#,
                false,
            ),
        )
        .await;
        let ScriptOutcome::Done(done) = report.outcome else {
            panic!("{:?} {:?}", report.outcome, report.logs);
        };
        let response = done.response.unwrap();
        assert_eq!(response.status, Some(201));
        assert_eq!(response.headers, Some(vec![("X-A".into(), "1".into())]));
        assert_eq!(
            String::from_utf8(response.body.unwrap()).unwrap(),
            "POST https://x.test/a stored"
        );
        assert_eq!(host.store.read("k2").as_deref(), Some("v2"));
        let notes = notes.lock().unwrap();
        assert_eq!(notes[0].title, "标题");
        assert_eq!(notes[0].url, "https://open");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn binary_mode_round_trips_bytes_and_text_codecs() {
        let (host, _) = host_with(echo_fetcher());
        let mut c = call(
            ScriptKind::Response,
            r#"
            const bytes = $response.body
            if (!(bytes instanceof Uint8Array)) throw new Error('not bytes')
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            const out = new TextEncoder().encode(text.replace('false', 'true') + '中')
            let threw = false
            try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])) } catch { threw = true }
            if (!threw) throw new Error('fatal decode did not throw')
            if (atob(btoa('hi')) !== 'hi') throw new Error('base64')
            const u = new URL('https://a.com/p?q=1&r=2')
            u.searchParams.set('q', '9')
            if (u.href !== 'https://a.com/p?q=9&r=2') throw new Error(u.href)
            $done({ bodyBytes: out.buffer })
            "#,
            true,
        );
        c.timeout = Duration::from_secs(5);
        let report = run(host, c).await;
        let ScriptOutcome::Done(done) = report.outcome else {
            panic!("{:?} {:?}", report.outcome, report.logs);
        };
        assert_eq!(
            String::from_utf8(done.body.unwrap()).unwrap(),
            r#"{"ads":[1],"vip":true}中"#
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn errors_timeouts_and_missing_done() {
        let (host, _) = host_with(echo_fetcher());
        let report = run(
            host.clone(),
            call(ScriptKind::Request, "throw new Error('boom')", false),
        )
        .await;
        assert!(
            matches!(&report.outcome, ScriptOutcome::Failed(m) if m.contains("boom")),
            "{:?}",
            report.outcome
        );

        let mut spin = call(ScriptKind::Request, "for(;;){}", false);
        spin.timeout = Duration::from_millis(300);
        let report = run(host.clone(), spin).await;
        assert!(
            matches!(&report.outcome, ScriptOutcome::Failed(m) if m.contains("超时")),
            "{:?}",
            report.outcome
        );

        let report = run(host.clone(), call(ScriptKind::Request, "let a = 1", false)).await;
        assert_eq!(report.outcome, ScriptOutcome::Unchanged);
        let report = run(host.clone(), call(ScriptKind::Request, "$done({})", false)).await;
        assert_eq!(report.outcome, ScriptOutcome::Unchanged);
        let report = run(
            host,
            call(
                ScriptKind::Request,
                "Promise.resolve().then(() => $done({ url: 'https://b.com/' }))",
                false,
            ),
        )
        .await;
        assert_eq!(
            report.outcome,
            ScriptOutcome::Done(ScriptDone {
                url: Some("https://b.com/".into()),
                ..Default::default()
            })
        );
    }

    #[test]
    fn store_limits_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        let store = PersistentStore::open(Some(path.clone()));
        assert!(store.write("a", Some("1".into())));
        assert!(!store.write("big", Some("x".repeat(STORE_VALUE_LIMIT + 1))));
        let reopened = PersistentStore::open(Some(path));
        assert_eq!(reopened.read("a").as_deref(), Some("1"));
        assert!(reopened.write("a", None));
        assert!(reopened.read("a").is_none());
    }
}
