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
    let restored = match app.try_state::<crate::system_proxy::SystemProxyService>() {
        Some(proxy) => {
            let proxy = proxy.inner();
            restore_with_retry(|| Box::pin(proxy.restore_before_kernel_unavailable())).await
        }
        None => true,
    };
    if let Some(tun) = app.try_state::<crate::tun::TunCoordinator>() {
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
/// build has not ported yet: tray, IPC dispose, exit monitor, intent recovery).
async fn dispose_services(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(updates) = app.try_state::<crate::updates::UpdateService>() {
        updates.dispose();
    }
    if let Some(substore) = app.try_state::<crate::substore::SubStoreService>() {
        substore.dispose();
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
                    if let Some(kernel) = app.try_state::<crate::kernel::KernelServices>() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn ok<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
        Box::pin(async move { value })
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
