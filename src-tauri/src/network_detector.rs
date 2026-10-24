//! Connectivity watchdog — the Rust port of `src/main/services/network-detector.ts`
//! (sparkle's `network.ts` state machine, adapted).
//!
//! Offline (sleep/resume, Wi-Fi switch, cable pull): the owned system proxy is
//! turned off and the host stopped, so neither the proxy nor TUN routes
//! blackhole traffic. Back online: the host that was serving before the outage
//! is restarted and the proxy re-enabled — no user action after a resume. The
//! restart is gated on the detector having stopped it, so it never fights the
//! user's explicit stop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;

use crate::error::IpcError;

/// Interfaces that never count as connectivity. Short loopback names match
/// exactly (a substring `lo` hid "Local Area Connection").
const IGNORED_INTERFACE_NAMES: [&str; 2] = ["lo", "lo0"];
const IGNORED_INTERFACE_PATTERNS: [&str; 7] =
    ["docker", "utun", "tun", "veth", "mihomo", "meta", "vmnet"];

pub fn is_ignored_interface_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    IGNORED_INTERFACE_NAMES.contains(&lower.as_str())
        || IGNORED_INTERFACE_PATTERNS
            .iter()
            .any(|pattern| lower.contains(pattern))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunMode {
    Stopped,
    Kernel,
    Tun,
}

/// The detector's gateway (the TS `NetworkDetectorGateway`).
pub trait NetworkGateway: Send + Sync {
    fn run_mode(&self) -> RunMode;
    fn start_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    fn start_tun(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    fn stop_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    /// `disabled` | `reenabled` | `idle` | `failed`
    fn network_down(&self) -> BoxFuture<'_, &'static str>;
    fn network_up(&self) -> BoxFuture<'_, &'static str>;
}

#[derive(Default)]
struct DetectorState {
    checking: bool,
    saw_offline: bool,
    /// Exact host that was serving before this outage.
    resume_mode: Option<RunMode>,
    /// Latches the offline actions per outage episode.
    outage_handled: bool,
    /// A previous outage stop failed; retry on the next offline tick.
    stop_kernel_pending: bool,
    /// Never stop a host until the owned OS proxy is confirmed safe.
    proxy_disable_pending: bool,
}

pub struct NetworkDetector {
    gateway: Arc<dyn NetworkGateway>,
    is_connected: Arc<dyn Fn() -> bool + Send + Sync>,
    interval_seconds: u64,
    offline_confirmation_ms: u64,
    generation: AtomicU64,
    state: tokio::sync::Mutex<DetectorState>,
}

impl NetworkDetector {
    pub fn new(
        gateway: Arc<dyn NetworkGateway>,
        is_connected: Arc<dyn Fn() -> bool + Send + Sync>,
        interval_seconds: u64,
        offline_confirmation_ms: u64,
    ) -> Arc<Self> {
        Arc::new(NetworkDetector {
            gateway,
            is_connected,
            interval_seconds: interval_seconds.clamp(5, 300),
            offline_confirmation_ms: offline_confirmation_ms.min(10_000),
            generation: AtomicU64::new(0),
            state: tokio::sync::Mutex::new(DetectorState::default()),
        })
    }

    pub fn start(self: &Arc<Self>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(this.interval_seconds));
            interval.tick().await;
            loop {
                interval.tick().await;
                if this.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                this.tick(generation).await;
            }
        });
        crate::diag!(
            "[network-detector] started (every {}s)",
            self.interval_seconds
        );
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// One detection cycle now (used after a resume).
    pub async fn probe_now(&self) {
        self.tick(self.generation.load(Ordering::SeqCst)).await;
    }

    async fn tick(&self, generation: u64) {
        let mut state = match self.state.try_lock() {
            Ok(state) if !state.checking => state,
            _ => return,
        };
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        state.checking = true;
        let mut connected = (self.is_connected)();
        // A single offline sample (route/TUN adapter churn) must never restore
        // the proxy and kill the shared core: confirm the first sample.
        if !connected && !state.outage_handled && self.offline_confirmation_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                self.offline_confirmation_ms,
            ))
            .await;
            if generation != self.generation.load(Ordering::SeqCst) {
                state.checking = false;
                return;
            }
            connected = (self.is_connected)();
        }
        if connected {
            if state.saw_offline {
                // The proxy re-enable needs a live kernel, so the host comes
                // back FIRST; both retry on every tick until they succeed.
                let mut current = self.gateway.run_mode();
                if let Some(resume) = state.resume_mode {
                    if current != resume {
                        let result = match resume {
                            RunMode::Tun => self.gateway.start_tun().await,
                            _ => self.gateway.start_kernel().await,
                        };
                        if let Err(error) = result {
                            crate::diag!(
                                "[network-detector] kernel restart after reconnect failed: {}",
                                error.extract_message()
                            );
                        }
                        current = self.gateway.run_mode();
                    }
                }
                let mut proxy_recovered = false;
                if state.resume_mode.is_none() || current != RunMode::Stopped {
                    proxy_recovered = self.gateway.network_up().await != "failed";
                }
                if proxy_recovered
                    && state
                        .resume_mode
                        .map(|resume| resume == current)
                        .unwrap_or(true)
                {
                    state.saw_offline = false;
                    state.resume_mode = None;
                }
            }
        } else if !state.outage_handled || state.proxy_disable_pending || state.stop_kernel_pending
        {
            state.saw_offline = true;
            if !state.outage_handled {
                state.outage_handled = true;
                let mode = self.gateway.run_mode();
                state.resume_mode = if mode == RunMode::Stopped {
                    None
                } else {
                    Some(mode)
                };
                state.stop_kernel_pending = mode != RunMode::Stopped;
                state.proxy_disable_pending = true;
            }
            if state.proxy_disable_pending {
                state.proxy_disable_pending = self.gateway.network_down().await == "failed";
            }
            // A failed proxy restore keeps the listener alive (a dead-port
            // proxy is worse); the next offline tick retries the restore.
            if !state.proxy_disable_pending
                && state.stop_kernel_pending
                && self.gateway.stop_kernel().await.is_ok()
            {
                state.stop_kernel_pending = false;
            }
        }
        // Keep the episode latched while recovery is incomplete, so a brief
        // flap cannot forget that TUN must come back.
        if connected && !state.saw_offline {
            state.outage_handled = false;
            state.proxy_disable_pending = false;
        }
        state.checking = false;
    }
}

/// Real connectivity: the OS reports a connection AND a non-virtual,
/// non-loopback interface carries an address.
pub fn system_is_connected() -> bool {
    os_reports_online() && has_real_interface()
}

fn has_real_interface() -> bool {
    if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces.iter().any(|interface| {
                !interface.is_loopback() && !is_ignored_interface_name(&interface.name)
            })
        })
        .unwrap_or(true)
}

#[cfg(windows)]
fn os_reports_online() -> bool {
    use windows::Win32::Networking::WinInet::{InternetGetConnectedState, INTERNET_CONNECTION};
    let mut flags = INTERNET_CONNECTION(0);
    unsafe { InternetGetConnectedState(&mut flags, 0).is_ok() }
}

#[cfg(not(windows))]
fn os_reports_online() -> bool {
    true
}

/// The live gateway: every host transition goes through the RUNTIME_UPDATE
/// mode queue, and nothing is brought back up once shutdown has started.
pub struct AppNetworkGateway {
    pub app: tauri::AppHandle,
}

impl AppNetworkGateway {
    fn kernel(&self) -> Arc<crate::kernel::KernelServices> {
        use tauri::Manager;
        self.app
            .state::<Arc<crate::kernel::KernelServices>>()
            .inner()
            .clone()
    }
    fn tun(&self) -> Arc<crate::tun::TunCoordinator> {
        use tauri::Manager;
        self.app
            .state::<Arc<crate::tun::TunCoordinator>>()
            .inner()
            .clone()
    }
    fn proxy(&self) -> Arc<crate::system_proxy::SystemProxyService> {
        use tauri::Manager;
        self.app
            .state::<Arc<crate::system_proxy::SystemProxyService>>()
            .inner()
            .clone()
    }
}

impl NetworkGateway for AppNetworkGateway {
    fn run_mode(&self) -> RunMode {
        let tun = self.tun().get_status();
        if matches!(tun.phase.as_str(), "active" | "starting" | "restoring") {
            return RunMode::Tun;
        }
        if self.kernel().get_status_value()["phase"].as_str() == Some("running") {
            RunMode::Kernel
        } else {
            RunMode::Stopped
        }
    }

    fn start_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        let kernel = self.kernel();
        Box::pin(async move {
            if crate::lifecycle::is_quitting() {
                return Ok(());
            }
            let _gate = crate::lifecycle::runtime_update_guard().await?;
            kernel.start().await.map(|_| ())
        })
    }

    fn start_tun(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        use tauri::Manager;
        let kernel = self.kernel();
        let tun = self.tun();
        // The outage may have caught an explicit TUN disable mid-flight
        // (`restoring` maps to Tun): the durable intent decides, and a host
        // without TUN intent comes back as the plain kernel.
        let tun_desired = self
            .app
            .try_state::<Arc<crate::settings::SettingsStore>>()
            .map(|settings| settings.get().tun_desired)
            .unwrap_or(false);
        Box::pin(async move {
            if crate::lifecycle::is_quitting() {
                return Ok(());
            }
            if !tun_desired {
                let _gate = crate::lifecycle::runtime_update_guard().await?;
                return kernel.start().await.map(|_| ());
            }
            crate::runtime_intent::enable_tun_queued(&kernel, &tun).await
        })
    }

    fn stop_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        let kernel = self.kernel();
        let proxy = self.proxy();
        let tun = self.tun();
        Box::pin(async move {
            // The ordered gateway: restore the owned proxy before the
            // listener goes away, and take TUN down with the host.
            let _gate = crate::lifecycle::runtime_update_guard().await?;
            proxy.restore_before_kernel_unavailable().await?;
            if tun.get_status().phase == "active" {
                tun.emergency_disable().await;
            }
            kernel.stop().await.map(|_| ())
        })
    }

    fn network_down(&self) -> BoxFuture<'_, &'static str> {
        let proxy = self.proxy();
        Box::pin(async move {
            let Ok(_gate) = crate::lifecycle::runtime_update_guard().await else {
                return "failed";
            };
            proxy.handle_network_down().await
        })
    }

    fn network_up(&self) -> BoxFuture<'_, &'static str> {
        let proxy = self.proxy();
        let app = self.app.clone();
        Box::pin(async move {
            let Ok(_gate) = crate::lifecycle::runtime_update_guard().await else {
                return "failed";
            };
            let result = proxy.handle_network_up().await;
            crate::runtime_intent::wake(&app);
            crate::profile_auto_update::retry_failed(&app);
            result
        })
    }
}

/// Start the 15-second watchdog and keep it in managed state (resume probes
/// and shutdown reach it from there).
pub fn start(app: tauri::AppHandle) {
    use tauri::Manager;
    let detector = NetworkDetector::new(
        Arc::new(AppNetworkGateway { app: app.clone() }),
        Arc::new(system_is_connected),
        15,
        2_000,
    );
    detector.start();
    app.manage(detector);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    struct FakeGateway {
        mode: Mutex<RunMode>,
        down_result: Mutex<&'static str>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeGateway {
        fn new(mode: RunMode) -> Arc<Self> {
            Arc::new(FakeGateway {
                mode: Mutex::new(mode),
                down_result: Mutex::new("disabled"),
                calls: Mutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl NetworkGateway for FakeGateway {
        fn run_mode(&self) -> RunMode {
            *self.mode.lock().unwrap()
        }
        fn start_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("start-kernel");
                *self.mode.lock().unwrap() = RunMode::Kernel;
                Ok(())
            })
        }
        fn start_tun(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("start-tun");
                *self.mode.lock().unwrap() = RunMode::Tun;
                Ok(())
            })
        }
        fn stop_kernel(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("stop-kernel");
                *self.mode.lock().unwrap() = RunMode::Stopped;
                Ok(())
            })
        }
        fn network_down(&self) -> BoxFuture<'_, &'static str> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("down");
                *self.down_result.lock().unwrap()
            })
        }
        fn network_up(&self) -> BoxFuture<'_, &'static str> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("up");
                "reenabled"
            })
        }
    }

    fn detector(gateway: Arc<FakeGateway>, online: Arc<AtomicBool>) -> Arc<NetworkDetector> {
        NetworkDetector::new(
            gateway,
            Arc::new(move || online.load(Ordering::SeqCst)),
            15,
            0,
        )
    }

    #[test]
    fn interface_filter_matches_the_ts_rules() {
        assert!(is_ignored_interface_name("lo"));
        assert!(is_ignored_interface_name("Mihomo"));
        assert!(is_ignored_interface_name("veth0"));
        assert!(!is_ignored_interface_name("Local Area Connection"));
        assert!(!is_ignored_interface_name("Wi-Fi"));
    }

    #[tokio::test]
    async fn an_outage_restores_the_proxy_before_stopping_and_resumes_tun() {
        let gateway = FakeGateway::new(RunMode::Tun);
        let online = Arc::new(AtomicBool::new(false));
        let detector = detector(gateway.clone(), online.clone());
        detector.probe_now().await;
        assert_eq!(gateway.calls(), vec!["down", "stop-kernel"]);
        // Still offline: the outage actions are latched.
        detector.probe_now().await;
        assert_eq!(gateway.calls().len(), 2);
        online.store(true, Ordering::SeqCst);
        detector.probe_now().await;
        assert_eq!(
            gateway.calls(),
            vec!["down", "stop-kernel", "start-tun", "up"]
        );
        detector.probe_now().await;
        assert_eq!(gateway.calls().len(), 4);
    }

    #[tokio::test]
    async fn a_failed_proxy_restore_keeps_the_host_alive_and_retries() {
        let gateway = FakeGateway::new(RunMode::Kernel);
        *gateway.down_result.lock().unwrap() = "failed";
        let online = Arc::new(AtomicBool::new(false));
        let detector = detector(gateway.clone(), online.clone());
        detector.probe_now().await;
        assert_eq!(gateway.calls(), vec!["down"]);
        *gateway.down_result.lock().unwrap() = "disabled";
        detector.probe_now().await;
        assert_eq!(gateway.calls(), vec!["down", "down", "stop-kernel"]);
    }

    #[tokio::test]
    async fn a_user_stopped_host_is_not_restarted() {
        let gateway = FakeGateway::new(RunMode::Stopped);
        let online = Arc::new(AtomicBool::new(false));
        let detector = detector(gateway.clone(), online.clone());
        detector.probe_now().await;
        online.store(true, Ordering::SeqCst);
        detector.probe_now().await;
        assert_eq!(gateway.calls(), vec!["down", "up"]);
    }

    #[tokio::test]
    async fn a_single_offline_sample_is_confirmed_first() {
        let gateway = FakeGateway::new(RunMode::Kernel);
        let samples = Arc::new(Mutex::new(vec![true, false]));
        let detector = NetworkDetector::new(
            gateway.clone(),
            Arc::new(move || samples.lock().unwrap().pop().unwrap_or(true)),
            15,
            1,
        );
        detector.probe_now().await;
        assert!(gateway.calls().is_empty());
    }
}
