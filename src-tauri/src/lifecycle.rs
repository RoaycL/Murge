//! The application quit path — the Rust port of `lifecycle-adapter.ts` +
//! `quit-guard.ts`.
//!
//! Ordering invariants are load-bearing (the TS header states them verbatim):
//! - Restore the OWNED system proxy BEFORE the kernel stops (the registry must
//!   never aim at a port that is about to close).
//! - A failed restore blocks the quit — leaving a dead-port proxy behind is
//!   worse than holding the app open.
//! - Every shutdown signal joins one idempotent flow, so concurrent
//!   session-end/shutdown/before-quit cannot interleave.
//!
//! The Tauri mapping: `RunEvent::ExitRequested` (code None = user interaction)
//! is the `before-quit` equivalent — the first request is prevented, the
//! ordered flow runs, and the real exit goes through `AppHandle::exit(0)`
//! (which re-enters `ExitRequested` with a code and passes straight through).

use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::BoxFuture;

use crate::error::IpcError;

const MAX_QUIT_RESTORE_ATTEMPTS: u32 = 3;
const QUIT_RESTORE_RETRY_DELAY_MS: u64 = 250;

/// The `state.shutdownPromise` idempotency flag: concurrent quit signals join
/// the flow already in flight instead of interleaving with it.
static SHUTDOWN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// The `state.isQuitting` guard: once the confirmed flow starts tearing
/// services down, a second quit signal passes straight through.
static IS_QUITTING: AtomicBool = AtomicBool::new(false);

pub fn is_quitting() -> bool {
    IS_QUITTING.load(Ordering::SeqCst)
}

/// Fence every reconnect/replay path before a session-end shutdown starts
/// (the Windows session-end handler calls this first).
pub fn mark_quitting() {
    IS_QUITTING.store(true, Ordering::SeqCst);
}

/// Whether a live native tray exists. Without one, close-to-tray would strand
/// a windowless process the user cannot reach, so the close button quits.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

pub fn set_tray_ready(ready: bool) {
    TRAY_READY.store(ready, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// quit-guard.ts — the before-quit decision, unit-testable without a runtime
// ---------------------------------------------------------------------------

pub enum QuitFlowResult {
    RestoreFailed,
    Quitting,
}

pub struct QuitFlowDeps {
    /// Restore the owned system proxy, retrying internally. `true` = confirmed
    /// restored (or nothing owned — conflict is safe); `false` = could not.
    pub restore: Box<dyn FnOnce() -> BoxFuture<'static, bool> + Send>,
    /// Stop the kernel / controller (only called after a confirmed restore).
    pub stop_kernel: Option<Box<dyn FnOnce() -> BoxFuture<'static, Result<serde_json::Value, IpcError>> + Send>>,
    /// Dispose IPC / services (only called after a confirmed restore).
    pub dispose: Option<Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>>,
}

/// The core of the app-before-quit decision, split out so the "never stop the
/// kernel and never quit when the owned proxy could not be restored" invariant
/// is unit-testable without a host runtime.
///
/// When `restore()` resolves `false` the flow returns [`QuitFlowResult::RestoreFailed`]
/// WITHOUT touching `stop_kernel` or `dispose` — the caller keeps the window and
/// kernel alive and lets the user retry. Otherwise the kernel is stopped,
/// services disposed, and the caller quits. A post-restore cleanup failure is
/// swallowed (the proxy is already confirmed restored and safe) — never rethrown
/// to the caller, exactly like the TS `onCleanupError` sink.
pub async fn run_quit_flow(deps: QuitFlowDeps) -> QuitFlowResult {
    if !(deps.restore)().await {
        return QuitFlowResult::RestoreFailed;
    }
    if let Some(stop_kernel) = deps.stop_kernel {
        let _ = stop_kernel().await;
    }
    if let Some(dispose) = deps.dispose {
        dispose().await;
    }
    QuitFlowResult::Quitting
}

// ---------------------------------------------------------------------------
// lifecycle-adapter.ts — the ordered restore + the shutdown orchestration
// ---------------------------------------------------------------------------

/// Restore an owned system proxy (if any) before tearing down the controller.
/// A genuine failure is retried a bounded number of times; `true` once the
/// proxy is confirmed restored (or there was nothing owned — conflict is safe,
/// since the proxy no longer points at us).
pub async fn restore_with_retry<'a, F>(mut restore: F) -> bool
where
    F: FnMut() -> BoxFuture<'a, Result<(), IpcError>>,
{
    for attempt in 1..=MAX_QUIT_RESTORE_ATTEMPTS {
        if restore().await.is_ok() {
            return true;
        }
        if attempt < MAX_QUIT_RESTORE_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(QUIT_RESTORE_RETRY_DELAY_MS)).await;
        }
    }
    false
}

/// `restoreNetworkBeforeQuit`: inside the ONE mode-transition queue, so a
/// concurrent renderer start/stop can never interleave with the shutdown
/// sequence. Restores the owned system proxy FIRST (while the live host still
/// holds the unified mixed port), then emergency-disables the TUN device.
pub async fn restore_network_before_quit(app: &tauri::AppHandle) -> bool {
    let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
    use tauri::Manager;
    let restored = match app.try_state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>() {
        Some(proxy) => {
            let proxy = proxy.inner();
            restore_with_retry(|| Box::pin(proxy.restore_before_kernel_unavailable())).await
        }
        None => true,
    };
    if let Some(tun) = app.try_state::<std::sync::Arc<crate::tun::TunCoordinator>>() {
        let status = tun.emergency_disable().await;
        // Unconfirmed TUN teardown is logged, never blocking (the TS console).
        if !matches!(status.phase.as_str(), "configured" | "unsupported") {
            eprintln!("[tun] TUN stop was not confirmed during quit: {}", status.phase);
        }
    }
    restored
}

/// `deps.flushLogs`: the shutdown marker (`bootstrap.ts` will-quit) + the
/// final queue flush. Best-effort — logging failures never block the exit.
async fn flush_logs(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(file_logs) = app.try_state::<std::sync::Arc<crate::file_log::FileLogService>>() {
        file_logs.write_app(
            crate::file_log::FileLogLevel::Info,
            "application shutdown completed",
            "shutdown",
        );
        file_logs.flush().await;
    }
}

/// The dispose step (the TS `state.*` teardown list, minus the surfaces this
/// build has not ported yet: tray, IPC dispose, exit monitor).
async fn dispose_services(app: &tauri::AppHandle) {
    use tauri::Manager;
    crate::runtime_intent::stop(app);
    if let Some(detector) = app.try_state::<std::sync::Arc<crate::network_detector::NetworkDetector>>() {
        detector.stop();
    }
    if let Some(updates) = app.try_state::<std::sync::Arc<crate::updates::UpdateService>>() {
        updates.dispose();
    }
    if let Some(substore) = app.try_state::<std::sync::Arc<crate::substore::SubStoreService>>() {
        substore.dispose();
    }
    if let Some(usage) = app.try_state::<std::sync::Arc<crate::usage::UsageHistoryService>>() {
        if let Err(error) = usage.flush() {
            eprintln!("[usage-history] final flush failed: {error:?}");
        }
    }
    flush_logs(app).await;
}

/// `beginApplicationShutdown` — the single idempotent shutdown flow. Every
/// quit signal funnels here; the first call runs the ordered sequence, later
/// calls join it (no-op).
pub async fn begin_application_shutdown(app: tauri::AppHandle, session_ending: bool) {
    if SHUTDOWN_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    IS_QUITTING.store(true, Ordering::SeqCst);
    use tauri::Manager;

    // Proxy selections share the profile mutation boundary; the RUNTIME_UPDATE
    // gate IS that boundary in this build. Acquiring and RELEASING it once
    // here drains every accepted dispatcher-level mutation before teardown
    // (the TS `waitForProfileOperations` waits for the queue tail without
    // holding the boundary). Each flow step re-acquires the gate separately —
    // holding it across the whole flow would deadlock against the restore
    // step's own acquisition.
    drop(crate::kernel::RUNTIME_UPDATE.lock().await);
    let result = run_quit_flow(QuitFlowDeps {
        restore: {
            let app = app.clone();
            Box::new(move || Box::pin(async move { restore_network_before_quit(&app).await }))
        },
        stop_kernel: {
            let app = app.clone();
            Some(Box::new(move || {
                Box::pin(async move {
                    // Inside the same mode queue as the restore step, so a
                    // queued renderer transition cannot interleave.
                    let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
                    if let Some(kernel) = app.try_state::<std::sync::Arc<crate::kernel::KernelServices>>() {
                        return kernel.stop().await;
                    }
                    Ok(serde_json::Value::Null)
                })
            }))
        },
        dispose: {
            let app = app.clone();
            Some(Box::new(move || {
                Box::pin(async move { dispose_services(&app).await })
            }))
        },
    });

    let result = result.await;
    match result {
        QuitFlowResult::RestoreFailed => {
            SHUTDOWN_IN_FLIGHT.store(false, Ordering::SeqCst);
            if session_ending {
                // The host may terminate the process immediately. Preserve the
                // proxy backup/TUN journal so the next launch's init restores
                // them before replaying the saved user intent.
                flush_logs(&app).await;
                app.exit(0);
                return;
            }
            IS_QUITTING.store(false, Ordering::SeqCst);
            // Reveal the window so the user can fix the proxy and retry.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        QuitFlowResult::Quitting => {
            app.exit(0);
        }
    }
}


// ---------------------------------------------------------------------------
// window-adapter.ts / boot-flags.ts — launch, close and second-instance rules
// ---------------------------------------------------------------------------

/// `MURGE_CI_BOOT_FLAGS` forwarding + argv, exactly like `parseBootFlags`.
pub fn has_boot_flag(argv: &[String], ci_flags: &str, flag: &str) -> bool {
    argv.iter().any(|arg| arg == flag) || ci_flags.split_whitespace().any(|value| value == flag)
}

/// Login-item silent launch: the window must not be shown.
pub fn launch_hidden() -> bool {
    let argv: Vec<String> = std::env::args().collect();
    has_boot_flag(&argv, &std::env::var("MURGE_CI_BOOT_FLAGS").unwrap_or_default(), "--hidden")
}

/// `onSecondInstance`: a duplicate login registration (`--hidden`) must never
/// turn a tray-only startup into a visible launch; a manual launch reveals
/// the existing window. (Deep links are not registered in this shell yet.)
pub fn second_instance_reveals(argv: &[String]) -> bool {
    !argv.iter().any(|arg| arg == "--hidden")
}

pub fn reveal_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if is_quitting() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn on_second_instance(app: &tauri::AppHandle, argv: &[String]) {
    if second_instance_reveals(argv) {
        reveal_main_window(app);
    }
}

/// What the close button does (the TS `window.on('close')`).
#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// A real quit is already running: let the window go.
    Allow,
    /// Close-to-tray (最小化到托盘而非退出).
    Hide,
    /// The same bounded restore-and-shutdown flow as the tray menu.
    Quit,
}

pub fn close_action(quitting: bool, close_to_tray: bool, tray_ready: bool) -> CloseAction {
    if quitting {
        CloseAction::Allow
    } else if close_to_tray && tray_ready {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// Main-window wiring: close-to-tray and the hidden login launch. The window
/// is created invisible (`visible: false` in tauri.conf.json) and shown here
/// unless this is a `--hidden` launch.
pub fn wire_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let target = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let close_to_tray = handle
                .try_state::<std::sync::Arc<crate::settings::SettingsStore>>()
                .map(|settings| settings.get().close_to_tray)
                .unwrap_or(true);
            match close_action(is_quitting(), close_to_tray, TRAY_READY.load(Ordering::SeqCst)) {
                CloseAction::Allow => {}
                CloseAction::Hide => {
                    api.prevent_close();
                    let _ = target.hide();
                }
                CloseAction::Quit => {
                    api.prevent_close();
                    let app = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        begin_application_shutdown(app, false).await;
                    });
                }
            }
        }
    });
    if !launch_hidden() {
        let _ = window.show();
    }
}

/// Proxy guard cadence (clash-verge-rev defaults to 30s; same as Electron).
const PROXY_GUARD_INTERVAL_SECS: u64 = 30;

/// The proxy guard loop: repair an externally degraded owned proxy, never
/// fight a takeover. Gated live on the `proxyGuard` setting.
fn start_proxy_guard(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(PROXY_GUARD_INTERVAL_SECS));
        interval.tick().await;
        loop {
            interval.tick().await;
            if is_quitting() {
                continue;
            }
            let enabled = app
                .try_state::<std::sync::Arc<crate::settings::SettingsStore>>()
                .map(|settings| settings.get().proxy_guard)
                .unwrap_or(false);
            if !enabled {
                continue;
            }
            if let Some(proxy) = app.try_state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>() {
                match proxy.verify_integrity().await {
                    "repaired" => eprintln!("[system-proxy] guard repaired an externally mutated proxy"),
                    "repair-failed" => eprintln!("[system-proxy] guard re-apply failed"),
                    _ => {}
                }
            }
        }
    });
}

/// Phase 4 desktop integration, started once from setup after every service
/// is managed: window rules, startup recovery + intent replay, connectivity
/// watchdog, proxy guard and the Windows session/power listener.
pub fn start_desktop_integration(app: &tauri::AppHandle) {
    wire_main_window(app);
    crate::runtime_intent::spawn_startup_recovery(app.clone());
    crate::network_detector::start(app.clone());
    start_proxy_guard(app.clone());
    crate::session_events::install(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn ok<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
        Box::pin(async move { value })
    }

    #[test]
    fn boot_flags_read_argv_and_the_ci_forwarder() {
        let argv = vec!["murge.exe".to_string(), "--hidden".to_string()];
        assert!(has_boot_flag(&argv, "", "--hidden"));
        assert!(!has_boot_flag(&argv, "", "--hidden-smoke"));
        assert!(has_boot_flag(&["murge.exe".to_string()], " --hidden-smoke  ", "--hidden-smoke"));
    }

    #[test]
    fn a_hidden_second_instance_stays_in_the_tray() {
        assert!(!second_instance_reveals(&["murge.exe".into(), "--hidden".into()]));
        assert!(second_instance_reveals(&["murge.exe".into()]));
    }

    #[test]
    fn close_button_follows_the_close_to_tray_preference() {
        assert_eq!(close_action(false, true, true), CloseAction::Hide);
        assert_eq!(close_action(false, false, true), CloseAction::Quit);
        assert_eq!(close_action(true, false, true), CloseAction::Allow);
        assert_eq!(close_action(true, true, true), CloseAction::Allow);
        // No live tray: closing must not strand an unreachable process.
        assert_eq!(close_action(false, true, false), CloseAction::Quit);
    }

    #[tokio::test]
    async fn restore_failure_skips_stop_dispose_and_quit() {
        let stops = Arc::new(Mutex::new(Vec::new()));
        let stops_for_stop = std::sync::Arc::clone(&stops);
        let result = run_quit_flow(QuitFlowDeps {
            restore: Box::new(|| ok(false)),
            stop_kernel: Some(Box::new(move || {
                let stops = std::sync::Arc::clone(&stops_for_stop);
                Box::pin(async move {
                    stops.lock().await.push("stop");
                    Ok(serde_json::Value::Null)
                })
            })),
            dispose: None,
        });
        assert!(matches!(result.await, QuitFlowResult::RestoreFailed));
        assert!(stops.lock().await.is_empty());
    }

    #[tokio::test]
    async fn confirmed_restore_stops_then_disposes_then_quits() {
        let steps = Arc::new(Mutex::new(Vec::new()));
        let steps_for_stop = std::sync::Arc::clone(&steps);
        let steps_for_dispose = std::sync::Arc::clone(&steps);
        let result = run_quit_flow(QuitFlowDeps {
            restore: Box::new(|| ok(true)),
            stop_kernel: Some(Box::new(move || {
                let steps = std::sync::Arc::clone(&steps_for_stop);
                Box::pin(async move {
                    steps.lock().await.push("stop");
                    Ok(serde_json::Value::Null)
                })
            })),
            dispose: Some(Box::new(move || {
                let steps = std::sync::Arc::clone(&steps_for_dispose);
                Box::pin(async move {
                    steps.lock().await.push("dispose");
                })
            })),
        });
        assert!(matches!(result.await, QuitFlowResult::Quitting));
        assert_eq!(*steps.lock().await, vec!["stop", "dispose"]);
    }

    #[tokio::test]
    async fn cleanup_errors_never_block_the_quit() {
        // The proxy is already confirmed restored: a failing stop/dispose is
        // swallowed (the TS onCleanupError sink) and the quit still happens.
        let disposed = Arc::new(Mutex::new(false));
        let disposed_for_dispose = std::sync::Arc::clone(&disposed);
        let result = run_quit_flow(QuitFlowDeps {
            restore: Box::new(|| ok(true)),
            stop_kernel: Some(Box::new(|| {
                Box::pin(async {
                    let result: Result<serde_json::Value, IpcError> = Err(IpcError::code(
                        crate::error::code::KERNEL_CRASHED,
                        "stop exploded".to_string(),
                    ));
                    result
                })
            })),
            dispose: Some(Box::new(move || {
                let disposed = std::sync::Arc::clone(&disposed_for_dispose);
                Box::pin(async move {
                    *disposed.lock().await = true;
                })
            })),
        });
        assert!(matches!(result.await, QuitFlowResult::Quitting));
        assert!(*disposed.lock().await);
    }

    #[tokio::test]
    async fn restore_retry_succeeds_after_a_transient_failure() {
        let attempts = Arc::new(Mutex::new(0));
        let attempts_probe = std::sync::Arc::clone(&attempts);
        let restored = restore_with_retry(move || {
            let attempts = std::sync::Arc::clone(&attempts_probe);
            Box::pin(async move {
                let mut count = attempts.lock().await;
                *count += 1;
                if *count < 2 {
                    Err(IpcError::code(
                        crate::error::code::UPSTREAM_UNREACHABLE,
                        "transient".to_string(),
                    ))
                } else {
                    Ok(())
                }
            })
        })
        .await;
        assert!(restored);
        assert_eq!(*attempts.lock().await, 2);
    }

    #[tokio::test]
    async fn restore_retry_gives_up_after_the_bounded_attempts() {
        let attempts = Arc::new(Mutex::new(0));
        let attempts_probe = std::sync::Arc::clone(&attempts);
        let restored = restore_with_retry(move || {
            let attempts = std::sync::Arc::clone(&attempts_probe);
            Box::pin(async move {
                *attempts.lock().await += 1;
                Err(IpcError::code(
                    crate::error::code::UPSTREAM_UNREACHABLE,
                    "down".to_string(),
                ))
            })
        })
        .await;
        assert!(!restored);
        assert_eq!(*attempts.lock().await, 3);
    }
}
