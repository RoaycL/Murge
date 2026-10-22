//! Windows session/power notifications for the Tauri shell.
//!
//! Electron only offered `powerMonitor`/`session-end` events that started an
//! ASYNC quit flow; Windows could terminate the process before the
//! `reg.exe`/PowerShell restore finished, leaving the system proxy aimed at a
//! dead port after logoff/shutdown (known gap since v0.9.27). Here a hidden
//! top-level window on its own thread receives the broadcasts directly:
//!
//! - `WM_QUERYENDSESSION`: register a shutdown block reason while the proxy
//!   is owned, and let the session end (never veto).
//! - `WM_ENDSESSION(TRUE)`: the process may be killed as soon as every window
//!   returns, so the handler BLOCKS (bounded) until the owned proxy is
//!   restored — first through the service queue, then, if that queue is busy,
//!   through the synchronous native registry path — while the ordered
//!   shutdown flow (TUN off, core stop, log flush) runs alongside.
//! - `WM_POWERBROADCAST(PBT_APMRESUMEAUTOMATIC)`: probe connectivity now and
//!   wake the intent recovery (the TS `powerMonitor.on('resume')`).

/// Bounded budget for the blocking session-end work. Windows starts showing
/// the "this app is preventing shutdown" UI after about five seconds.
#[allow(dead_code)]
const SESSION_END_PROXY_BUDGET_MS: u64 = 2_000;
#[allow(dead_code)]
const SESSION_END_TOTAL_BUDGET_MS: u64 = 4_000;

/// Resume handler shared by every platform hook: probe connectivity first,
/// then wake the intent recovery (never waits for the next periodic tick).
#[allow(dead_code)]
pub fn on_resume(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        if let Some(detector) =
            app.try_state::<std::sync::Arc<crate::network_detector::NetworkDetector>>()
        {
            let detector = detector.inner().clone();
            detector.probe_now().await;
        }
        crate::runtime_intent::wake(&app);
    });
}

/// The session-end work, run on the notification thread. Returns once the
/// owned proxy is confirmed safe or the budget is spent.
#[allow(dead_code)]
pub fn on_session_end(app: &tauri::AppHandle) {
    use std::time::{Duration, Instant};
    use tauri::Manager;
    let started = Instant::now();
    crate::lifecycle::mark_quitting();
    // No path may write the proxy from here on: an enable that holds the
    // queue (mid-probe) aborts before its first write instead of applying
    // after our restore.
    if let Some(proxy) = app.try_state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>()
    {
        proxy.fence_mutations();
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::lifecycle::begin_application_shutdown(app, true).await;
            let _ = done_tx.send(());
        });
    }
    // 1. The queued restore (same decision rules as every other path).
    let restored = match app.try_state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>()
    {
        Some(proxy) => {
            let proxy = proxy.inner().clone();
            tauri::async_runtime::block_on(async move {
                tokio::time::timeout(
                    Duration::from_millis(SESSION_END_PROXY_BUDGET_MS),
                    proxy.restore_before_kernel_unavailable(),
                )
                .await
            })
            .map(|result| result.is_ok())
            .unwrap_or(false)
        }
        None => true,
    };
    // 2. The queue was busy or the restore failed: restore synchronously,
    //    outside the queue, straight from the durable backup.
    if !restored {
        #[cfg(windows)]
        if let Some(root) = app.state::<crate::paths::AppPaths>().app_data_root.clone() {
            let adapter = crate::system_proxy::NativeWindowsSystemProxyAdapter::win32();
            let path = root
                .join(crate::system_proxy::SYSTEM_PROXY_BACKUP_SUBDIR)
                .join(crate::system_proxy::SYSTEM_PROXY_BACKUP_FILE);
            match crate::system_proxy::restore_owned_proxy_blocking(&adapter, &path) {
                Ok(outcome) => eprintln!("[session-end] direct proxy restore: {outcome}"),
                Err(error) => eprintln!("[session-end] direct proxy restore failed: {error}"),
            }
        }
    }
    // 3. Give the ordered flow (TUN off, core stop, flush) the rest of the
    //    budget; the process may be terminated any time after we return.
    let remaining =
        Duration::from_millis(SESSION_END_TOTAL_BUDGET_MS).saturating_sub(started.elapsed());
    let _ = done_rx.recv_timeout(remaining);
}

#[cfg(windows)]
mod platform {
    use std::sync::OnceLock;

    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, MSG, PBT_APMRESUMEAUTOMATIC, WINDOW_EX_STYLE, WM_ENDSESSION,
        WM_POWERBROADCAST, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
    };

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    fn proxy_owned(app: &tauri::AppHandle) -> bool {
        use tauri::Manager;
        app.state::<crate::paths::AppPaths>()
            .app_data_root
            .as_ref()
            .map(|root| {
                root.join(crate::system_proxy::SYSTEM_PROXY_BACKUP_SUBDIR)
                    .join(crate::system_proxy::SYSTEM_PROXY_BACKUP_FILE)
                    .exists()
            })
            .unwrap_or(false)
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_QUERYENDSESSION => {
                if let Some(app) = APP.get() {
                    if proxy_owned(app) {
                        let _ = ShutdownBlockReasonCreate(hwnd, w!("正在恢复系统代理设置"));
                    }
                }
                LRESULT(1)
            }
            WM_ENDSESSION => {
                if wparam.0 != 0 {
                    if let Some(app) = APP.get() {
                        super::on_session_end(app);
                    }
                }
                let _ = ShutdownBlockReasonDestroy(hwnd);
                LRESULT(0)
            }
            WM_POWERBROADCAST => {
                if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC {
                    if let Some(app) = APP.get() {
                        super::on_resume(app.clone());
                    }
                }
                LRESULT(1)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    pub fn install(app: tauri::AppHandle) {
        if APP.set(app).is_err() {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("murge-session-events".into())
            .spawn(|| unsafe {
                let Ok(module) = GetModuleHandleW(None) else {
                    eprintln!("[session-events] GetModuleHandleW failed");
                    return;
                };
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: module.into(),
                    lpszClassName: w!("MurgeSessionEvents"),
                    ..Default::default()
                };
                if RegisterClassW(&class) == 0 {
                    eprintln!("[session-events] RegisterClassW failed");
                    return;
                }
                // A hidden TOP-LEVEL window: message-only windows do not receive
                // the session/power broadcasts.
                let created = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("MurgeSessionEvents"),
                    w!("Murge session events"),
                    WS_OVERLAPPED,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    module,
                    None,
                );
                if created.is_err() {
                    eprintln!("[session-events] CreateWindowExW failed");
                    return;
                }
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            });
        if let Err(error) = spawned {
            eprintln!("[session-events] thread spawn failed: {error}");
        }
    }
}

/// Install the session/power listener (Windows only; a no-op elsewhere).
pub fn install(app: tauri::AppHandle) {
    #[cfg(windows)]
    platform::install(app);
    #[cfg(not(windows))]
    let _ = app;
}
