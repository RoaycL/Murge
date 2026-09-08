//! Application-update state machine — the Rust mirror of
//! `src/main/updates/service.ts` and the `updates:*` IPC surface.
//!
//! The service owns the lifecycle state machine and reduces a narrow driver's
//! event stream into a single `UpdateState` snapshot pushed to renderer
//! windows. The production driver is `GatedUpdaterDriver` (`supported:
//! false`): this build cannot reach an update feed, so the service reports the
//! exact same clear message the Electron build shows for dev/unpackaged runs
//! instead of pretending to update.

use crate::error::IpcError;
use crate::events::{EventHub, EventListener};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Byte-exact renderer copy (service.ts NOT_SUPPORTED). Consumed by the
/// unsupported branch of `check()` — reachable once a real driver lands.
#[allow(dead_code)]
const NOT_SUPPORTED: &str = "当前构建不支持自动更新（仅安装版可用）";

/// Normalized driver event (`updates/updater-driver.ts`).
#[allow(dead_code)] // driver seam vocabulary; tests + the future driver emit it
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdaterDriverEvent {
    Checking,
    NotAvailable,
    Available {
        version: String,
        release_notes: Option<String>,
    },
    DownloadProgress {
        percent: f64,
        #[serde(rename = "bytesPerSecond")]
        bytes_per_second: u64,
        transferred: u64,
        total: Option<u64>,
    },
    Downloaded,
    Error {
        message: String,
    },
}

/// Download progress snapshot (`shared/updates.ts`).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub percent: f64,
    pub bytes_per_second: u64,
    pub transferred: u64,
    pub total: Option<u64>,
}

/// Lifecycle snapshot (`shared/updates.ts` UpdateState).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: String,
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    pub progress: Option<UpdateProgress>,
    pub error: Option<String>,
    pub can_install: bool,
}

pub fn default_update_state() -> UpdateState {
    UpdateState {
        phase: "idle".to_string(),
        current_version: None,
        available_version: None,
        progress: None,
        error: None,
        can_install: false,
    }
}

/// Coerce an unknown value (from a stale IPC payload or a malformed device)
/// into a state snapshot — every missing field falls back to the default.
#[allow(dead_code)] // renderer payload hardening for the notification slice
pub fn coerce_update_state(value: &Value) -> UpdateState {
    const PHASES: [&str; 7] = ["idle", "checking", "available", "downloading", "downloaded", "not-available", "error"];
    let Some(record) = value.as_object() else {
        return default_update_state();
    };
    let progress = record.get("progress").and_then(|raw| raw.as_object()).map(|raw| UpdateProgress {
        percent: raw.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
        bytes_per_second: raw.get("bytesPerSecond").and_then(Value::as_u64).unwrap_or(0),
        transferred: raw.get("transferred").and_then(Value::as_u64).unwrap_or(0),
        total: raw.get("total").and_then(Value::as_u64),
    });
    UpdateState {
        phase: record
            .get("phase")
            .and_then(Value::as_str)
            .filter(|phase| PHASES.contains(phase))
            .unwrap_or("idle")
            .to_string(),
        current_version: record.get("currentVersion").and_then(Value::as_str).map(str::to_string),
        available_version: record.get("availableVersion").and_then(Value::as_str).map(str::to_string),
        progress,
        error: record.get("error").and_then(Value::as_str).map(str::to_string),
        can_install: record.get("canInstall").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// The narrow seam electron-updater fills. The Tauri build ships the gate
/// until the updater integration lands; it performs no I/O.
pub trait UpdaterDriver: Send + Sync {
    fn current_version(&self) -> String;
    /// Whether this build can actually reach an update feed. False for dev /
    /// unpackaged runs, so the service reports a clear "not supported" state
    /// instead of throwing on a missing feed.
    fn supported(&self) -> bool;
    /// Attach listeners and apply helper flags once, before any check.
    fn configure(&self);
    /// Kick off a feed check; results arrive as events. A synchronous
    /// pre-flight failure returns Err WITHOUT ever emitting an 'error' event.
    fn check(&self) -> Result<(), String>;
    /// Start (or resume) downloading the available update in the background.
    fn download(&self);
    /// Install a fully-downloaded update and restart the app.
    fn quit_and_install(&self);
    /// Subscribe to normalized events; returns the unsubscribe handle.
    fn on_event(&self, listener: EventListener) -> i64;
    #[allow(dead_code)] // the real driver releases feed handles here
    fn dispose(&self);
}

/// Fail-closed production driver: the update feed is not wired in this build
/// (the Electron equivalent reports the same on dev/unpackaged runs). No
/// network, no updater flags, no notifications.
pub struct GatedUpdaterDriver {
    events: EventHub,
}

impl GatedUpdaterDriver {
    pub fn new() -> Self {
        GatedUpdaterDriver { events: EventHub::new() }
    }
}

impl Default for GatedUpdaterDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterDriver for GatedUpdaterDriver {
    fn current_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    fn supported(&self) -> bool {
        false
    }

    fn configure(&self) {}

    fn check(&self) -> Result<(), String> {
        Ok(())
    }

    fn download(&self) {}

    fn quit_and_install(&self) {}

    fn on_event(&self, listener: EventListener) -> i64 {
        self.events.subscribe(listener)
    }

    fn dispose(&self) {}
}

/// Owns the application-update state machine. It wraps a narrow
/// [`UpdaterDriver`] and reduces its event stream into a single
/// [`UpdateState`] snapshot that is pushed to renderer windows and returned
/// from the narrow IPC commands.
#[derive(Clone)]
pub struct UpdateService {
    inner: Arc<UpdateServiceInner>,
}

struct UpdateServiceInner {
    driver: Arc<dyn UpdaterDriver>,
    state: Mutex<UpdateState>,
    listeners: EventHub,
    started: Mutex<bool>,
    poll_generation: std::sync::atomic::AtomicU64,
    /// A ready update remains installable while a newer feed check is in flight.
    downloaded_before_check: Mutex<Option<UpdateState>>,
}

impl UpdateService {
    pub fn new(driver: Arc<dyn UpdaterDriver>) -> Self {
        let state = default_update_state();
        UpdateService {
            inner: Arc::new(UpdateServiceInner {
                state: Mutex::new(UpdateState { current_version: Some(driver.current_version()), ..state }),
                driver,
                listeners: EventHub::new(),
                started: Mutex::new(false),
                poll_generation: std::sync::atomic::AtomicU64::new(0),
                downloaded_before_check: Mutex::new(None),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, UpdateState> {
        self.inner.state.lock().expect("update state poisoned")
    }

    /// Attach the driver and subscribe to its events. Call once after
    /// construction; idempotent.
    pub fn start(&self) {
        let mut started = self.inner.started.lock().expect("update started poisoned");
        if *started {
            return;
        }
        *started = true;
        drop(started);
        self.inner.driver.configure();
        let service = self.clone();
        self.inner.driver.on_event(Arc::new(move |event| {
            service.handle_event(event);
        }));
    }

    /// One poll tick: re-check unless a check/download is in flight. Split
    /// from the timer so tests can drive the cadence deterministically.
    pub async fn poll_tick(&self) {
        if !self.inner.driver.supported() {
            return;
        }
        let _ = self.check().await;
    }

    /// Poll the feed on a fixed cadence while the app is running (the
    /// mihomo-party / sparkle model), so a Release published mid-session is
    /// picked up without a restart. No-op when the build cannot self-update.
    /// `check()` already refuses to restart an in-flight check/download, so
    /// overlapping ticks are safe.
    pub fn start_polling(&self, poll_interval_ms: u64) {
        if !self.inner.driver.supported() {
            return;
        }
        let generation = self.inner.poll_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let service = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(poll_interval_ms));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await; // polling never fires the first check eagerly
            loop {
                ticker.tick().await;
                if service.inner.poll_generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
                    return; // stopped or restarted
                }
                service.poll_tick().await;
            }
        });
    }

    // Wired into before-quit cleanup (before-quit slice).
    #[allow(dead_code)]
    pub fn stop_polling(&self) {
        self.inner.poll_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn get_state(&self) -> UpdateState {
        self.state().clone()
    }

    pub fn get_state_value(&self) -> Value {
        serde_json::to_value(self.get_state()).expect("update state serializes")
    }

    pub async fn check(&self) -> Result<UpdateState, IpcError> {
        if !self.inner.driver.supported() {
            self.transition(UpdateState {
                phase: "error".to_string(),
                error: Some(NOT_SUPPORTED.to_string()),
                can_install: false,
                ..self.get_state()
            });
            return Ok(self.get_state());
        }
        // Only coalesce work that is actually in flight. A downloaded update
        // is not terminal: a newer release may appear before the user
        // installs it, and the next manual/poll check must be allowed to
        // replace the stale package.
        {
            let current = self.state();
            if current.phase == "checking" || current.phase == "downloading" {
                return Ok(current.clone());
            }
        }
        {
            let mut pending = self.inner.downloaded_before_check.lock().expect("update pending poisoned");
            *pending = if self.state().phase == "downloaded" { Some(self.get_state()) } else { None };
        }
        self.transition(UpdateState { phase: "checking".to_string(), error: None, ..self.get_state() });
        match self.inner.driver.check() {
            Ok(()) => {}
            // A driver may fail synchronously (a pre-flight failure) WITHOUT
            // ever emitting an 'error' event. Without this the phase would
            // stay 'checking' forever and the guard above would reject every
            // later check. Reduce the failure into the same terminal 'error'
            // state the event path produces.
            Err(message) => {
                let restored = {
                    let mut pending = self.inner.downloaded_before_check.lock().expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState { error: Some(message), ..restored });
                } else {
                    self.transition(UpdateState {
                        phase: "error".to_string(),
                        error: Some(message),
                        can_install: false,
                        ..self.get_state()
                    });
                }
            }
        }
        Ok(self.get_state())
    }

    pub async fn download(&self) -> Result<UpdateState, IpcError> {
        if !self.inner.driver.supported() {
            return Ok(self.get_state());
        }
        if self.state().phase != "available" {
            return Ok(self.get_state());
        }
        self.transition(UpdateState { phase: "downloading".to_string(), error: None, ..self.get_state() });
        self.inner.driver.download();
        Ok(self.get_state())
    }

    pub fn install(&self) {
        if self.inner.driver.supported() && self.state().can_install {
            self.inner.driver.quit_and_install();
        }
    }

    pub fn subscribe(&self, listener: EventListener) -> i64 {
        self.inner.listeners.subscribe(listener)
    }

    /// Dispose stops the poll timer and detaches the driver.
    #[allow(dead_code)] // wired into before-quit cleanup (before-quit slice)
    pub fn dispose(&self) {
        self.stop_polling();
        self.inner.driver.dispose();
    }

    /// serde tags the driver events kebab-case; the renderer-facing progress
    /// fields are camelCase. Accept both spellings on the boundary.
    fn field<'a>(event: &'a Value, camel: &str, kebab: &str) -> Option<&'a Value> {
        event.get(camel).or_else(|| event.get(kebab))
    }

    fn handle_event(&self, event: &Value) {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
        match kind.as_str() {
            "checking" => {
                self.transition(UpdateState { phase: "checking".to_string(), error: None, ..self.get_state() });
            }
            "not-available" => {
                let restored = {
                    let mut pending = self.inner.downloaded_before_check.lock().expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState { error: None, ..restored });
                } else {
                    self.transition(UpdateState {
                        phase: "not-available".to_string(),
                        available_version: None,
                        progress: None,
                        can_install: false,
                        error: None,
                        ..self.get_state()
                    });
                }
            }
            "available" => {
                *self.inner.downloaded_before_check.lock().expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "available".to_string(),
                    available_version: event.get("version").and_then(Value::as_str).map(str::to_string),
                    progress: None,
                    can_install: false,
                    error: None,
                    ..self.get_state()
                });
            }
            "download-progress" => {
                *self.inner.downloaded_before_check.lock().expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "downloading".to_string(),
                    can_install: false,
                    progress: Some(UpdateProgress {
                        percent: event.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
                        bytes_per_second: Self::field(event, "bytesPerSecond", "bytes-per-second").and_then(Value::as_u64).unwrap_or(0),
                        transferred: event.get("transferred").and_then(Value::as_u64).unwrap_or(0),
                        total: event.get("total").and_then(Value::as_u64),
                    }),
                    ..self.get_state()
                });
            }
            "downloaded" => {
                *self.inner.downloaded_before_check.lock().expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "downloaded".to_string(),
                    can_install: true,
                    progress: None,
                    error: None,
                    ..self.get_state()
                });
            }
            "error" => {
                let restored = {
                    let mut pending = self.inner.downloaded_before_check.lock().expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState { error: Some(event.get("message").and_then(Value::as_str).unwrap_or_default().to_string()), ..restored });
                } else {
                    self.transition(UpdateState {
                        phase: "error".to_string(),
                        error: Some(event.get("message").and_then(Value::as_str).unwrap_or_default().to_string()),
                        can_install: false,
                        ..self.get_state()
                    });
                }
            }
            _ => {}
        }
    }

    fn transition(&self, next: UpdateState) {
        *self.state() = next.clone();
        let value = serde_json::to_value(&next).expect("update state serializes");
        self.inner.listeners.emit(&value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    struct FakeDriver {
        supported: bool,
        configure_calls: AtomicUsize,
        check_calls: AtomicUsize,
        download_calls: AtomicUsize,
        install_calls: AtomicUsize,
        dispose_calls: AtomicUsize,
        check_fails: AtomicBool,
        events: EventHub,
    }

    impl FakeDriver {
        fn new(supported: bool) -> Arc<FakeDriver> {
            Arc::new(FakeDriver {
                supported,
                configure_calls: AtomicUsize::new(0),
                check_calls: AtomicUsize::new(0),
                download_calls: AtomicUsize::new(0),
                install_calls: AtomicUsize::new(0),
                dispose_calls: AtomicUsize::new(0),
                check_fails: AtomicBool::new(false),
                events: EventHub::new(),
            })
        }

        fn emit(&self, event: &UpdaterDriverEvent) {
            let value = serde_json::to_value(event).expect("event serializes");
            self.events.emit(&value);
        }
    }

    impl UpdaterDriver for FakeDriver {
        fn current_version(&self) -> String {
            "0.0.0-test".to_string()
        }
        fn supported(&self) -> bool {
            self.supported
        }
        fn configure(&self) {
            self.configure_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn check(&self) -> Result<(), String> {
            self.check_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.check_fails.load(std::sync::atomic::Ordering::SeqCst) {
                Err("feed descriptor missing".to_string())
            } else {
                Ok(())
            }
        }
        fn download(&self) {
            self.download_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn quit_and_install(&self) {
            self.install_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn on_event(&self, listener: EventListener) -> i64 {
            self.events.subscribe(listener)
        }
        fn dispose(&self) {
            self.dispose_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn counters(driver: &FakeDriver) -> (usize, usize, usize, usize, usize) {
        (
            driver.configure_calls.load(std::sync::atomic::Ordering::SeqCst),
            driver.check_calls.load(std::sync::atomic::Ordering::SeqCst),
            driver.download_calls.load(std::sync::atomic::Ordering::SeqCst),
            driver.install_calls.load(std::sync::atomic::Ordering::SeqCst),
            driver.dispose_calls.load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    #[tokio::test]
    async fn start_configures_the_driver_once_and_carries_the_version() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        assert_eq!(counters(&driver).0, 0);
        service.start();
        service.start();
        assert_eq!(counters(&driver).0, 1);
        assert_eq!(service.get_state().current_version.as_deref(), Some("0.0.0-test"));
        assert_eq!(service.get_state().phase, "idle");
    }

    #[tokio::test]
    async fn unsupported_check_reports_the_clear_copy_and_never_touches_the_driver() {
        let driver = FakeDriver::new(false);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "error");
        assert_eq!(state.error.as_deref(), Some("当前构建不支持自动更新（仅安装版可用）"));
        assert_eq!(state.can_install, false);
        assert_eq!(counters(&driver).1, 0);
        // Polling is a no-op on unsupported builds.
        service.start_polling(10);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(counters(&driver).1, 0);
    }

    #[tokio::test]
    async fn supported_check_transitions_to_checking() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "checking");
        assert_eq!(counters(&driver).1, 1);
        // The in-flight check is coalesced (no second driver call).
        let again = service.check().await.unwrap();
        assert_eq!(again.phase, "checking");
        assert_eq!(counters(&driver).1, 1);
        // The terminal event unblocks later checks.
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        let next = service.check().await.unwrap();
        assert_eq!(next.phase, "checking");
        assert_eq!(counters(&driver).1, 2);
    }

    #[tokio::test]
    async fn synchronous_check_failure_is_reduced_into_error() {
        let driver = FakeDriver::new(true);
        driver.check_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "error");
        assert_eq!(state.error.as_deref(), Some("feed descriptor missing"));
        // A later check must not be blocked by the previous stuck phase.
        driver.check_fails.store(false, std::sync::atomic::Ordering::SeqCst);
        let next = service.check().await.unwrap();
        assert_eq!(next.phase, "checking");
    }

    #[tokio::test]
    async fn poll_ticks_coalesce_in_flight_checks() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        // Polling never fires the first check eagerly.
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 1);
        // The in-flight check is still 'checking', so the next tick coalesces.
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 1);
        // After the check resolves, the following tick checks again.
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 2);
    }

    #[tokio::test]
    async fn downloaded_updates_are_not_terminal_for_checks() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.1".to_string(), release_notes: None });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        let state = service.check().await.unwrap();
        assert_eq!(counters(&driver).1, 1);
        // The downloaded package stays installable while re-checking.
        assert_eq!(state.phase, "checking");
        assert_eq!(state.available_version.as_deref(), Some("1.0.1"));
        assert_eq!(state.can_install, true);
        // A newer release replaces it.
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.2".to_string(), release_notes: None });
        let state = service.get_state();
        assert_eq!(state.phase, "available");
        assert_eq!(state.available_version.as_deref(), Some("1.0.2"));
        assert_eq!(state.can_install, false);
        driver.emit(&UpdaterDriverEvent::DownloadProgress {
            percent: 10.0,
            bytes_per_second: 1,
            transferred: 1,
            total: Some(10),
        });
        let state = service.get_state();
        assert_eq!(state.phase, "downloading");
        assert_eq!(state.available_version.as_deref(), Some("1.0.2"));
    }

    #[tokio::test]
    async fn a_failed_newer_check_keeps_the_downloaded_update_installable() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.1".to_string(), release_notes: None });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.check().await.unwrap();
        driver.emit(&UpdaterDriverEvent::Error { message: "feed unavailable".to_string() });
        let state = service.get_state();
        assert_eq!(state.phase, "downloaded");
        assert_eq!(state.available_version.as_deref(), Some("1.0.1"));
        assert_eq!(state.can_install, true);
        assert_eq!(state.error.as_deref(), Some("feed unavailable"));
    }

    #[tokio::test]
    async fn event_reduction_covers_progress_and_not_available() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Checking);
        assert_eq!(service.get_state().phase, "checking");
        driver.emit(&UpdaterDriverEvent::Available { version: "1.2.3".to_string(), release_notes: Some("notes".to_string()) });
        let state = service.get_state();
        assert_eq!(state.phase, "available");
        assert_eq!(state.available_version.as_deref(), Some("1.2.3"));
        assert_eq!(state.can_install, false);
        driver.emit(&UpdaterDriverEvent::DownloadProgress {
            percent: 42.0,
            bytes_per_second: 2048,
            transferred: 1024,
            total: Some(4096),
        });
        assert_eq!(
            service.get_state().progress,
            Some(UpdateProgress { percent: 42.0, bytes_per_second: 2048, transferred: 1024, total: Some(4096) })
        );
        driver.emit(&UpdaterDriverEvent::Downloaded);
        let state = service.get_state();
        assert_eq!(state.phase, "downloaded");
        assert_eq!(state.can_install, true);
        assert_eq!(state.progress, None);
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        let state = service.get_state();
        assert_eq!(state.phase, "not-available");
        assert_eq!(state.available_version, None);
        assert_eq!(state.can_install, false);
    }

    #[tokio::test]
    async fn download_only_starts_from_available_and_is_a_noop_when_done() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 0);
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.1".to_string(), release_notes: None });
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 1);
        assert_eq!(service.get_state().phase, "downloading");
        // Already downloaded → no second download call.
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 1);
    }

    #[tokio::test]
    async fn install_requires_downloaded_and_the_gate_blocks_it() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        service.install();
        assert_eq!(counters(&driver).3, 0);
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.1".to_string(), release_notes: None });
        service.install();
        assert_eq!(counters(&driver).3, 0);
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.install();
        assert_eq!(counters(&driver).3, 1);
        // The gated production driver never installs.
        let gated = UpdateService::new(Arc::new(GatedUpdaterDriver::new()));
        gated.start();
        gated.install();
        assert_eq!(gated.get_state().phase, "idle");
        assert_eq!(gated.get_state().current_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn coerce_update_state_falls_back_field_wise() {
        assert_eq!(coerce_update_state(&json!(null)), default_update_state());
        assert_eq!(coerce_update_state(&json!({ "phase": "bogus" })), default_update_state());
        let state = coerce_update_state(&json!({
            "phase": "downloading",
            "currentVersion": "1.0.0",
            "availableVersion": "1.0.1",
            "progress": { "percent": 12.5, "bytesPerSecond": 8, "transferred": 3 },
            "error": "x",
            "canInstall": true
        }));
        assert_eq!(state.phase, "downloading");
        assert_eq!(state.current_version.as_deref(), Some("1.0.0"));
        assert_eq!(state.progress.as_ref().map(|p| p.percent), Some(12.5));
        assert_eq!(state.progress.as_ref().and_then(|p| p.total), None);
        assert_eq!(state.can_install, true);
    }

    #[tokio::test]
    async fn state_events_reach_subscribers() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        service.subscribe(Arc::new(move |value| {
            sink.lock().unwrap().push(value["phase"].as_str().unwrap_or_default().to_string());
        }));
        service.start();
        driver.emit(&UpdaterDriverEvent::Available { version: "1.0.1".to_string(), release_notes: None });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        assert_eq!(seen.lock().unwrap().clone(), vec!["available".to_string(), "downloaded".to_string()]);
        service.dispose();
        assert_eq!(counters(&driver).4, 1);
    }
}
