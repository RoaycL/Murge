//! The Windows production kernel gateway backed by the installed LocalSystem
//! service — Rust port of `kernel/privileged-service-gateway.ts` and
//! `kernel/privileged-exit-monitor.ts`.
//!
//! The service owns one mihomo process for the complete application runtime,
//! including while TUN is off. TUN is therefore a controller config mutation
//! (the hot-switch adapter), never a second process or a port hand-off.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::error::{code, IpcError};
use crate::events::EventHub;
use crate::tun_service::{TunOwnedSession, TunServiceClient};

/// One readiness attempt: `Ok(Some(version))` once the authenticated
/// controller answers for this run's endpoint.
pub type ReadinessProbe = Arc<dyn Fn() -> BoxFuture<'static, Result<Option<String>, IpcError>> + Send + Sync>;
/// Builds the service profile (ports, secret, active document, TUN block
/// present but disabled) for one start.
pub type ProfileBuilder = Arc<dyn Fn() -> Result<String, IpcError> + Send + Sync>;
/// `(channel, specificVersion)` from the durable kernel selection.
pub type VersionSelection = Arc<dyn Fn() -> (String, Option<String>) + Send + Sync>;

pub struct PrivilegedKernelOptions {
    /// Read on every start: the controller port is user-configurable and a
    /// kernel restart must follow the persisted value (the TS runtime factory).
    pub controller_port: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Bounded wait for the controller of a freshly started core. A cold
    /// service home may need to initialize provider caches first; liveness is
    /// still checked on every iteration, so this is not a blind delay.
    pub ready_timeout_ms: u64,
    /// The SCM start window absorbed by the service-call retries.
    pub service_retry_ms: u64,
    pub poll_ms: u64,
}

impl Default for PrivilegedKernelOptions {
    fn default() -> Self {
        PrivilegedKernelOptions { controller_port: Arc::new(|| 9090), ready_timeout_ms: 60_000, service_retry_ms: 10_000, poll_ms: 100 }
    }
}

fn stopped_status() -> Value {
    json!({
        "phase": "stopped", "pid": null, "version": null, "controllerUrl": null,
        "startedAt": null, "lastError": null
    })
}

fn owns_child(outcome: &str) -> bool {
    matches!(outcome, "running" | "starting" | "stopping")
}

pub struct PrivilegedKernelGateway {
    client: Arc<TunServiceClient>,
    build_profile: ProfileBuilder,
    readiness: ReadinessProbe,
    can_start: Arc<dyn Fn() -> bool + Send + Sync>,
    version_selection: VersionSelection,
    options: PrivilegedKernelOptions,
    status: Mutex<Value>,
    /// Start/stop/liveness share one queue: the five-second monitor must never
    /// reconcile halfway through a start and overwrite its transitional status.
    queue: tokio::sync::Mutex<()>,
    pub status_listeners: EventHub,
}

impl PrivilegedKernelGateway {
    pub fn new(
        client: Arc<TunServiceClient>,
        build_profile: ProfileBuilder,
        readiness: ReadinessProbe,
        can_start: Arc<dyn Fn() -> bool + Send + Sync>,
        version_selection: VersionSelection,
        options: PrivilegedKernelOptions,
    ) -> Self {
        PrivilegedKernelGateway {
            client,
            build_profile,
            readiness,
            can_start,
            version_selection,
            options,
            status: Mutex::new(stopped_status()),
            queue: tokio::sync::Mutex::new(()),
            status_listeners: EventHub::new(),
        }
    }

    pub fn client(&self) -> &Arc<TunServiceClient> {
        &self.client
    }

    pub fn get_status(&self) -> Value {
        self.status.lock().expect("privileged status mutex poisoned").clone()
    }

    fn set_status(&self, status: Value) {
        *self.status.lock().expect("privileged status mutex poisoned") = status.clone();
        self.status_listeners.emit(&status);
    }

    fn phase(&self) -> String {
        self.get_status()["phase"].as_str().unwrap_or("stopped").to_string()
    }

    fn controller_url(&self) -> String {
        format!("http://127.0.0.1:{}", (self.options.controller_port)())
    }

    /// Remove a service-owned child left by an abnormal GUI exit before the
    /// persisted runtime intent replays. This also guarantees stale TUN
    /// routes are gone. One immediate probe keeps startup responsive; start()
    /// repeats it with the bounded SCM retry.
    pub async fn initialize(&self) -> Result<(), IpcError> {
        let _queue = self.queue.lock().await;
        let response = self.client.reconcile().await?;
        if owns_child(&response.outcome) {
            self.client.stop().await?;
        }
        self.set_status(stopped_status());
        Ok(())
    }

    pub async fn start(&self) -> Result<Value, IpcError> {
        let _queue = self.queue.lock().await;
        if matches!(self.phase().as_str(), "running" | "starting") {
            return Ok(self.get_status());
        }
        if !(self.can_start)() {
            return Err(IpcError::unsupported("内核已停用，请先在通用设置中启用内核。"));
        }
        self.set_status(json!({
            "phase": "starting", "pid": null, "version": null,
            "controllerUrl": self.controller_url(), "startedAt": null, "lastError": null
        }));
        match self.start_inner().await {
            Ok(status) => Ok(status),
            Err(error) => {
                let _ = self.client.stop().await;
                let mut failed = stopped_status();
                failed["phase"] = json!("failed");
                failed["lastError"] = json!(error.extract_message());
                self.set_status(failed);
                Err(error)
            }
        }
    }

    async fn start_inner(&self) -> Result<Value, IpcError> {
        // Reconcile every start: an abnormal GUI exit leaves a service-owned
        // core with the previous run's controller secret/ports, which must be
        // stopped before this run's authenticated endpoint starts.
        let stale = self.retry_service(|| self.client.reconcile()).await?;
        if owns_child(&stale.outcome) {
            self.client.stop().await?;
        }
        let profile = (self.build_profile)()?;
        let (channel, specific) = (self.version_selection)();
        let requested = match channel.as_str() {
            "specific" => specific,
            "preview" | "smart" => Some(channel.clone()),
            _ => None,
        };
        let owned = self.start_profile(&profile, requested.as_deref()).await?;
        let observed = self.wait_until_ready_or_exited().await?;
        if let Some(requested) = requested.as_deref().filter(|value| is_release_tag(value)) {
            let effective = observed.as_deref().map(|value| value.trim_start_matches('v'));
            if effective != Some(requested.trim_start_matches('v')) {
                return Err(IpcError::code(
                    code::ARTIFACT_HASH_MISMATCH,
                    format!("内核版本未生效：请求 {requested}，实际 {}", observed.as_deref().unwrap_or("未知")),
                ));
            }
        }
        let status = json!({
            "phase": "running", "pid": owned.pid, "version": observed,
            "controllerUrl": self.controller_url(),
            "startedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "lastError": null
        });
        self.set_status(status.clone());
        Ok(status)
    }

    pub async fn stop(&self) -> Result<Value, IpcError> {
        let _queue = self.queue.lock().await;
        if self.phase() == "stopped" {
            return Ok(self.get_status());
        }
        let mut stopping = self.get_status();
        stopping["phase"] = json!("stopping");
        self.set_status(stopping);
        match self.client.stop().await {
            Ok(()) => {
                self.set_status(stopped_status());
                Ok(self.get_status())
            }
            Err(error) => {
                let mut failed = self.get_status();
                failed["phase"] = json!("failed");
                failed["lastError"] = json!(error.extract_message());
                self.set_status(failed);
                Err(error)
            }
        }
    }

    /// Poll the service's process identity. Returns false only when a process
    /// this gateway believed live is now definitively gone.
    pub async fn reconcile_liveness(&self) -> Result<bool, IpcError> {
        let _queue = self.queue.lock().await;
        let response = self.client.reconcile().await?;
        let live = matches!(response.outcome.as_str(), "running" | "starting");
        if !live && matches!(self.phase().as_str(), "running" | "starting") {
            // A service reporting the child exited does not clear the client's
            // session; without this the recovery start is refused locally.
            self.client.forget_owned_session();
            self.mark_failed("Privileged mihomo exited unexpectedly");
            return Ok(false);
        }
        Ok(live)
    }

    /// The exit monitor proved the core gone without the service (the service
    /// itself is down). True when a running/starting core became failed.
    pub async fn declare_lost(&self, reason: &str) -> bool {
        let _queue = self.queue.lock().await;
        if !matches!(self.phase().as_str(), "running" | "starting") {
            return false;
        }
        self.client.forget_owned_session();
        self.mark_failed(reason);
        true
    }

    fn mark_failed(&self, reason: &str) {
        let mut failed = stopped_status();
        failed["phase"] = json!("failed");
        failed["lastError"] = json!(reason);
        self.set_status(failed);
    }

    async fn wait_until_ready_or_exited(&self) -> Result<Option<String>, IpcError> {
        let deadline = Instant::now() + Duration::from_millis(self.options.ready_timeout_ms);
        let mut last_failure = "controller did not respond".to_string();
        while Instant::now() < deadline {
            match (self.readiness)().await {
                Ok(version) => return Ok(version),
                Err(error) => last_failure = error.extract_message(),
            }
            let response = self.client.reconcile().await?;
            if matches!(response.outcome.as_str(), "failed" | "stopped") {
                return Err(IpcError::code(
                    code::KERNEL_SPAWN_FAILED,
                    response
                        .validation_message
                        .or(response.error_code)
                        .unwrap_or_else(|| "privileged mihomo exited before its controller became ready".into()),
                ));
            }
            tokio::time::sleep(Duration::from_millis(self.options.poll_ms)).await;
        }
        Err(IpcError::code(
            code::KERNEL_START_TIMEOUT,
            format!("privileged mihomo did not become ready: {last_failure}"),
        ))
    }

    /// Absorb the bounded SCM startup window so a login start or an
    /// in-progress upgrade does not fail before the pipe appears.
    async fn retry_service<T, F, Fut>(&self, operation: F) -> Result<T, IpcError>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, IpcError>>,
    {
        let deadline = Instant::now() + Duration::from_millis(self.options.service_retry_ms);
        loop {
            match operation().await {
                Ok(value) => return Ok(value),
                Err(error) if error.parts().0 == code::UPSTREAM_UNREACHABLE && Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Recover the ambiguous "service started the child but the reply was
    /// lost" case by reconciling ownership before retrying: a blind second
    /// start would turn a successful first start into a conflict.
    async fn start_profile(&self, profile: &str, version: Option<&str>) -> Result<TunOwnedSession, IpcError> {
        let deadline = Instant::now() + Duration::from_millis(self.options.service_retry_ms);
        loop {
            match self.client.start(profile, version).await {
                Ok(owned) => return Ok(owned),
                Err(error) if error.parts().0 == code::UPSTREAM_UNREACHABLE && Instant::now() < deadline => {
                    if let Ok(reconciled) = self.client.reconcile().await {
                        if reconciled.outcome == "running" {
                            if let Some(owned) = self.client.get_owned_session() {
                                return Ok(owned);
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn is_release_tag(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('v') else { return false };
    let parts: Vec<&str> = rest.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

// ---------------------------------------------------------------------------
// Exit monitor (privileged-exit-monitor.ts)
// ---------------------------------------------------------------------------

/// Three unexpected exits inside this window stop automatic restarts until
/// the user acts (or the window passes).
pub const CRASH_LOOP_WINDOW_MS: u64 = 5 * 60 * 1000;
pub const CRASH_LOOP_LIMIT: usize = 3;
/// Consecutive ticks with an unreachable service AND a dead controller before
/// the core is declared lost: an SCM service restart takes several seconds.
pub const UNREACHABLE_TICKS: usize = 3;

pub struct ExitMonitorDeps {
    pub kernel: Arc<PrivilegedKernelGateway>,
    pub handle_host_exit: Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    pub restore_system_proxy: Arc<dyn Fn() -> BoxFuture<'static, Result<(), IpcError>> + Send + Sync>,
    /// `(autoStartKernel, tunDesired, systemProxyDesired)`.
    pub read_settings: Arc<dyn Fn() -> (bool, bool, bool) + Send + Sync>,
    pub start_kernel: Arc<dyn Fn() -> BoxFuture<'static, Result<(), IpcError>> + Send + Sync>,
    pub wake_intent_recovery: Arc<dyn Fn() + Send + Sync>,
    pub cancel_intent_recovery: Arc<dyn Fn() + Send + Sync>,
    pub is_controller_alive: Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    pub is_suspended: Arc<dyn Fn() -> bool + Send + Sync>,
    pub on_error: Arc<dyn Fn(&str, &str) + Send + Sync>,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// One monitor tick. Ticks never overlap (`busy`), and every recovery step is
/// best-effort: a failing step logs and the next one still runs.
pub struct PrivilegedExitMonitor {
    deps: ExitMonitorDeps,
    busy: std::sync::atomic::AtomicBool,
    unreachable_streak: std::sync::atomic::AtomicUsize,
    exits: Mutex<Vec<u64>>,
}

impl PrivilegedExitMonitor {
    pub fn new(deps: ExitMonitorDeps) -> Self {
        PrivilegedExitMonitor {
            deps,
            busy: std::sync::atomic::AtomicBool::new(false),
            unreachable_streak: std::sync::atomic::AtomicUsize::new(0),
            exits: Mutex::new(Vec::new()),
        }
    }

    pub async fn tick(&self) {
        use std::sync::atomic::Ordering;
        if (self.deps.is_suspended)() || self.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        self.tick_inner().await;
        self.busy.store(false, Ordering::SeqCst);
    }

    async fn tick_inner(&self) {
        let phase = self.deps.kernel.get_status()["phase"].as_str().unwrap_or("stopped").to_string();
        use std::sync::atomic::Ordering;
        if phase != "running" && phase != "starting" {
            self.unreachable_streak.store(0, Ordering::SeqCst);
            return;
        }
        let lost = match self.deps.kernel.reconcile_liveness().await {
            Ok(true) => {
                self.unreachable_streak.store(0, Ordering::SeqCst);
                return;
            }
            Ok(false) => {
                self.unreachable_streak.store(0, Ordering::SeqCst);
                true
            }
            Err(error) if error.parts().0 == code::UPSTREAM_UNREACHABLE => {
                // The service itself is gone (crashed or being restarted by the
                // SCM). Its job object has already killed the core; only the
                // controller can tell us whether something still listens.
                if (self.deps.is_controller_alive)().await {
                    self.unreachable_streak.store(0, Ordering::SeqCst);
                    return;
                }
                if self.unreachable_streak.fetch_add(1, Ordering::SeqCst) + 1 < UNREACHABLE_TICKS {
                    return;
                }
                self.unreachable_streak.store(0, Ordering::SeqCst);
                self.deps.kernel.declare_lost("Privileged service stopped and its mihomo core is gone").await
            }
            Err(error) => {
                (self.deps.on_error)(&error.extract_message(), "liveness probe");
                return;
            }
        };
        if !lost || (self.deps.is_suspended)() {
            return;
        }
        (self.deps.handle_host_exit)().await;
        if let Err(error) = (self.deps.restore_system_proxy)().await {
            (self.deps.on_error)(&error.extract_message(), "system proxy restore");
        }
        if self.crash_loop() {
            (self.deps.cancel_intent_recovery)();
            (self.deps.on_error)("core exited repeatedly; automatic restart paused", "crash loop");
            return;
        }
        let (auto_start, tun_desired, proxy_desired) = (self.deps.read_settings)();
        if auto_start && !tun_desired && !proxy_desired {
            if let Err(error) = (self.deps.start_kernel)().await {
                (self.deps.on_error)(&error.extract_message(), "restart");
            }
        } else {
            (self.deps.wake_intent_recovery)();
        }
    }

    fn crash_loop(&self) -> bool {
        let now = (self.deps.now_ms)();
        let mut exits = self.exits.lock().expect("exit monitor mutex poisoned");
        exits.retain(|at| now.saturating_sub(*at) < CRASH_LOOP_WINDOW_MS);
        exits.push(now);
        exits.len() >= CRASH_LOOP_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tun_service::tests::{reply, ScriptedTransport};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SESSION: &str = "6f1c2f1e-8a5b-4c1d-9e2f-0a1b2c3d4e5f";

    fn gateway(transport: ScriptedTransport, ready_after: usize, channel: &str) -> (Arc<PrivilegedKernelGateway>, Arc<AtomicUsize>) {
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = probes.clone();
        let channel = channel.to_string();
        let gateway = PrivilegedKernelGateway::new(
            Arc::new(TunServiceClient::new(Box::new(transport))),
            Arc::new(|| Ok("mixed-port: 7890\n".to_string())),
            Arc::new(move || {
                let attempt = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move {
                    if attempt > ready_after {
                        Ok(Some("v1.19.30".to_string()))
                    } else {
                        Err(IpcError::code(code::UPSTREAM_UNREACHABLE, "controller unreachable"))
                    }
                })
            }),
            Arc::new(|| true),
            Arc::new(move || (channel.clone(), Some("v1.19.30".to_string()))),
            PrivilegedKernelOptions { controller_port: Arc::new(|| 9097), ready_timeout_ms: 2_000, service_retry_ms: 500, poll_ms: 1 },
        );
        (Arc::new(gateway), probes)
    }

    fn running(transport: &ScriptedTransport) {
        transport.push(|request| Ok(reply(request, "running", request["sessionId"].as_str(), Some(321))));
    }

    #[tokio::test]
    async fn start_reconciles_starts_and_waits_for_the_controller() {
        let transport = ScriptedTransport::default();
        transport.push(|request| Ok(reply(request, "stopped", None, None))); // stale reconcile
        running(&transport); // start
        transport.push(move |request| Ok(reply(request, "running", Some(SESSION), Some(321)))); // liveness while not ready
        let (gateway, probes) = gateway(transport.clone(), 1, "stable");
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        gateway.status_listeners.subscribe(Arc::new(move |status| sink.lock().unwrap().push(status["phase"].as_str().unwrap().to_string())));
        let status = gateway.start().await.unwrap();
        assert_eq!(status["phase"], "running");
        assert_eq!(status["pid"], 321);
        assert_eq!(status["version"], "v1.19.30");
        assert_eq!(status["controllerUrl"], "http://127.0.0.1:9097");
        assert_eq!(probes.load(Ordering::SeqCst), 2);
        assert_eq!(*events.lock().unwrap(), vec!["starting", "running"]);
        let operations: Vec<String> = transport.requests.lock().unwrap().iter().map(|r| r["operation"].as_str().unwrap().to_string()).collect();
        assert_eq!(operations, vec!["reconcile", "start", "reconcile"]);
        // A second start while running is a no-op.
        assert_eq!(gateway.start().await.unwrap()["phase"], "running");
    }

    #[tokio::test]
    async fn a_stale_core_is_stopped_before_this_runs_start() {
        let transport = ScriptedTransport::default();
        transport.push(move |request| Ok(reply(request, "running", Some(SESSION), Some(11)))); // stale
        transport.push(|request| {
            assert_eq!(request["operation"], "stop");
            assert_eq!(request["sessionId"], SESSION);
            Ok(reply(request, "stopped", None, None))
        });
        running(&transport);
        let (gateway, _) = gateway(transport, 0, "stable");
        assert_eq!(gateway.start().await.unwrap()["pid"], 321);
    }

    #[tokio::test]
    async fn a_core_that_exits_before_ready_fails_the_start() {
        let transport = ScriptedTransport::default();
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        running(&transport);
        transport.push(|request| {
            let mut value = reply(request, "failed", None, None);
            value["errorCode"] = json!("CHILD_EXITED");
            Ok(value)
        });
        // Cleanup stop after the failure: the client still owns the session.
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        let (gateway, _) = gateway(transport, usize::MAX, "stable");
        let error = gateway.start().await.unwrap_err();
        assert_eq!(error.parts().0, code::KERNEL_SPAWN_FAILED);
        assert_eq!(gateway.get_status()["phase"], "failed");
        assert_eq!(gateway.get_status()["lastError"], "CHILD_EXITED");
    }

    #[tokio::test]
    async fn the_requested_release_must_take_effect() {
        let transport = ScriptedTransport::default();
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        transport.push(|request| {
            assert_eq!(request["version"], "v1.19.31");
            Ok(reply(request, "running", request["sessionId"].as_str(), Some(5)))
        });
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        let probes = Arc::new(AtomicUsize::new(0));
        let gateway = PrivilegedKernelGateway::new(
            Arc::new(TunServiceClient::new(Box::new(transport))),
            Arc::new(|| Ok("a: 1\n".to_string())),
            Arc::new(move || {
                probes.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some("v1.19.30".to_string())) })
            }),
            Arc::new(|| true),
            Arc::new(|| ("specific".to_string(), Some("v1.19.31".to_string()))),
            PrivilegedKernelOptions { poll_ms: 1, ..PrivilegedKernelOptions::default() },
        );
        let error = gateway.start().await.unwrap_err();
        assert_eq!(error.parts().0, code::ARTIFACT_HASH_MISMATCH);
    }

    #[tokio::test]
    async fn start_retries_while_the_service_pipe_is_not_up_yet() {
        let transport = ScriptedTransport::default();
        transport.push(|_| Err(IpcError::code(code::UPSTREAM_UNREACHABLE, "TUN service is unavailable")));
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        running(&transport);
        let (gateway, _) = gateway(transport, 0, "stable");
        assert_eq!(gateway.start().await.unwrap()["phase"], "running");
    }

    #[tokio::test]
    async fn disabled_kernel_refuses_to_start() {
        let gateway = PrivilegedKernelGateway::new(
            Arc::new(TunServiceClient::new(Box::new(ScriptedTransport::default()))),
            Arc::new(|| Ok(String::new())),
            Arc::new(|| Box::pin(async { Ok(None) })),
            Arc::new(|| false),
            Arc::new(|| ("stable".to_string(), None)),
            PrivilegedKernelOptions::default(),
        );
        assert_eq!(gateway.start().await.unwrap_err().parts().0, code::UNSUPPORTED);
        assert_eq!(gateway.get_status()["phase"], "stopped");
    }

    struct Recorder {
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl Recorder {
        fn push(&self, call: &str) {
            self.calls.lock().unwrap().push(call.to_string());
        }
    }

    fn monitor(gateway: Arc<PrivilegedKernelGateway>, settings: (bool, bool, bool), controller_alive: bool) -> (PrivilegedExitMonitor, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::new(Recorder { calls: calls.clone() });
        let clock = Arc::new(AtomicUsize::new(0));
        let r = |name: &'static str, recorder: &Arc<Recorder>| {
            let recorder = recorder.clone();
            Arc::new(move || recorder.push(name))
        };
        let deps = ExitMonitorDeps {
            kernel: gateway,
            handle_host_exit: {
                let recorder = recorder.clone();
                Arc::new(move || {
                    recorder.push("tun-reset");
                    Box::pin(async {})
                })
            },
            restore_system_proxy: {
                let recorder = recorder.clone();
                Arc::new(move || {
                    recorder.push("proxy-restore");
                    Box::pin(async { Ok(()) })
                })
            },
            read_settings: Arc::new(move || settings),
            start_kernel: {
                let recorder = recorder.clone();
                Arc::new(move || {
                    recorder.push("start");
                    Box::pin(async { Ok(()) })
                })
            },
            wake_intent_recovery: r("wake", &recorder),
            cancel_intent_recovery: r("cancel", &recorder),
            is_controller_alive: Arc::new(move || Box::pin(async move { controller_alive })),
            is_suspended: Arc::new(|| false),
            on_error: {
                let recorder = recorder.clone();
                Arc::new(move |_message, step| recorder.push(&format!("error:{step}")))
            },
            now_ms: Arc::new(move || clock.fetch_add(1000, Ordering::SeqCst) as u64),
        };
        (PrivilegedExitMonitor::new(deps), calls)
    }

    async fn running_gateway(transport: &ScriptedTransport) -> Arc<PrivilegedKernelGateway> {
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        running(transport);
        let (gateway, _) = gateway(transport.clone(), 0, "stable");
        gateway.start().await.unwrap();
        gateway
    }

    #[tokio::test]
    async fn monitor_restores_and_wakes_recovery_after_an_unexpected_exit() {
        let transport = ScriptedTransport::default();
        let gateway = running_gateway(&transport).await;
        transport.push(|request| Ok(reply(request, "failed", None, None)));
        let (monitor, calls) = monitor(gateway.clone(), (true, true, false), false);
        monitor.tick().await;
        assert_eq!(*calls.lock().unwrap(), vec!["tun-reset", "proxy-restore", "wake"]);
        assert_eq!(gateway.get_status()["phase"], "failed");
        // A stopped/failed core is not probed again.
        monitor.tick().await;
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn monitor_restarts_a_plain_autostart_core_and_ignores_a_live_one() {
        let transport = ScriptedTransport::default();
        let gateway = running_gateway(&transport).await;
        transport.push(move |request| Ok(reply(request, "running", Some(SESSION), Some(321))));
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        let (monitor, calls) = monitor(gateway, (true, false, false), false);
        monitor.tick().await;
        assert!(calls.lock().unwrap().is_empty(), "a live core needs nothing");
        monitor.tick().await;
        assert_eq!(*calls.lock().unwrap(), vec!["tun-reset", "proxy-restore", "start"]);
    }

    #[tokio::test]
    async fn monitor_trusts_a_live_controller_when_the_service_is_down() {
        let transport = ScriptedTransport::default();
        let gateway = running_gateway(&transport).await;
        // No scripted reply: the transport reports the pipe unreachable.
        let (alive_monitor, calls) = monitor(gateway.clone(), (true, false, true), true);
        alive_monitor.tick().await;
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(gateway.get_status()["phase"], "running");
        // A transient outage (SCM restart) is debounced: only the third
        // consecutive unreachable tick with a dead controller declares it lost.
        let (dead_monitor, calls) = monitor(gateway.clone(), (true, false, true), false);
        for _ in 1..UNREACHABLE_TICKS {
            dead_monitor.tick().await;
            assert!(calls.lock().unwrap().is_empty());
            assert_eq!(gateway.get_status()["phase"], "running");
        }
        dead_monitor.tick().await;
        assert_eq!(*calls.lock().unwrap(), vec!["tun-reset", "proxy-restore", "wake"]);
        assert_eq!(gateway.get_status()["phase"], "failed");
    }

    #[tokio::test]
    async fn monitor_pauses_restarts_in_a_crash_loop() {
        let transport = ScriptedTransport::default();
        let gateway = running_gateway(&transport).await;
        let (monitor, calls) = monitor(gateway.clone(), (true, false, false), false);
        for round in 0..CRASH_LOOP_LIMIT {
            if round > 0 {
                transport.push(|request| Ok(reply(request, "stopped", None, None)));
                running(&transport);
                gateway.start().await.unwrap();
            }
            transport.push(|request| Ok(reply(request, "failed", None, None)));
            monitor.tick().await;
        }
        let calls = calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|call| *call == "start").count(), CRASH_LOOP_LIMIT - 1);
        assert_eq!(calls.last().map(String::as_str), Some("error:crash loop"));
        assert!(calls.contains(&"cancel".to_string()));
    }
}
