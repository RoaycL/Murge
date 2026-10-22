//! Runtime-intent replay — the Rust port of `src/main/startup/runtime-intent.ts`
//! and `runtime-intent-recovery.ts`, plus the startup recovery ordering from
//! `when-ready.ts` (`recoverManagedState` → `restoreRuntimeIntent` →
//! `RuntimeIntentRecoveryCoordinator`).
//!
//! Order is deliberate (the TS header): the orphaned proxy backup and the TUN
//! mutation journal are recovered first; then an authenticated kernel is
//! established, the system proxy is pointed at its live mixed port, TUN is
//! retried, the proxy is retried, and proxy selections replay last. Nothing
//! runs concurrently, so a slow Windows service cannot race a second core for
//! the same ports.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::error::IpcError;

/// The two user intents the replay honours (`AppSettings.tunDesired` /
/// `systemProxyDesired`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct IntentFlags {
    pub tun_desired: bool,
    pub system_proxy_desired: bool,
}

impl IntentFlags {
    pub fn from_settings(settings: &crate::settings::AppSettings) -> Self {
        IntentFlags {
            tun_desired: settings.tun_desired,
            system_proxy_desired: settings.system_proxy_desired,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct PhaseStatus {
    pub supported: bool,
    pub phase: String,
}

impl PhaseStatus {
    pub fn from_value(value: &Value) -> Self {
        PhaseStatus {
            supported: value["supported"].as_bool().unwrap_or(false),
            phase: value["phase"].as_str().unwrap_or("unsupported").to_string(),
        }
    }
}

/// The gateways the replay drives (the TS `RuntimeIntentRestoreDeps`). Every
/// state-changing call goes through the same queue the IPC handlers use.
pub trait IntentGateways: Send + Sync {
    fn kernel_phase(&self) -> String;
    fn kernel_start(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    fn tun_status(&self) -> PhaseStatus;
    fn tun_enable(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    fn proxy_status(&self) -> PhaseStatus;
    fn proxy_enable(&self) -> BoxFuture<'_, Result<(), IpcError>>;
    fn restore_selections(&self) -> BoxFuture<'_, Result<(), IpcError>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentResult {
    pub kernel: String,
    pub tun: PhaseStatus,
    pub system_proxy: PhaseStatus,
}

pub const RETRY_DELAYS_MS: [u64; 2] = [750, 1_500];
const RETRYABLE_KERNEL_PHASES: [&str; 2] = ["stopped", "failed"];
const RETRYABLE_TUN_PHASES: [&str; 3] = ["configured", "failed", "restore-failed"];
const RETRYABLE_PROXY_PHASES: [&str; 2] = ["disabled", "restore-failed"];

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// `restoreRuntimeIntent`: reconcile the last user-selected networking state.
pub async fn restore_runtime_intent(
    flags: IntentFlags,
    gateways: &dyn IntentGateways,
    retry_delays: &[u64],
    should_continue: &(dyn Fn() -> bool + Send + Sync),
) -> IntentResult {
    let mut kernel = gateways.kernel_phase();
    if RETRYABLE_KERNEL_PHASES.contains(&kernel.as_str()) {
        kernel = retry_kernel_start(gateways, retry_delays, should_continue).await;
    }

    let proxy_retryable = |status: &PhaseStatus, kernel: &str| {
        flags.system_proxy_desired
            && kernel == "running"
            && status.supported
            && RETRYABLE_PROXY_PHASES.contains(&status.phase.as_str())
    };

    let mut proxy = gateways.proxy_status();
    if proxy_retryable(&proxy, &kernel) {
        proxy = retry_proxy_start(gateways, &[], should_continue).await;
    }

    let mut tun = gateways.tun_status();
    if kernel == "running" && flags.tun_desired {
        tun = retry_tun_start(gateways, retry_delays, should_continue).await;
    }

    kernel = gateways.kernel_phase();
    if proxy_retryable(&proxy, &kernel) {
        proxy = retry_proxy_start(gateways, retry_delays, should_continue).await;
    }
    if kernel == "running" {
        // A remembered node becoming unavailable must not tear down a
        // healthy host.
        if let Err(error) = gateways.restore_selections().await {
            eprintln!(
                "[startup-restore] proxy selection restore failed: {}",
                error.extract_message()
            );
        }
    }
    let _ = proxy;
    IntentResult {
        kernel,
        tun,
        system_proxy: gateways.proxy_status(),
    }
}

async fn retry_kernel_start(
    gateways: &dyn IntentGateways,
    retry_delays: &[u64],
    should_continue: &(dyn Fn() -> bool + Send + Sync),
) -> String {
    let mut phase = gateways.kernel_phase();
    let max_attempts = retry_delays.len() + 1;
    let mut attempt = 1;
    while attempt <= max_attempts && RETRYABLE_KERNEL_PHASES.contains(&phase.as_str()) {
        if !should_continue() {
            break;
        }
        if attempt > 1 {
            sleep_ms(retry_delays[attempt - 2]).await;
            if !should_continue() {
                break;
            }
        }
        if let Err(error) = gateways.kernel_start().await {
            eprintln!(
                "[startup-restore] kernel start failed ({attempt}/{max_attempts}): {}",
                error.extract_message()
            );
        }
        phase = gateways.kernel_phase();
        attempt += 1;
    }
    phase
}

async fn retry_tun_start(
    gateways: &dyn IntentGateways,
    retry_delays: &[u64],
    should_continue: &(dyn Fn() -> bool + Send + Sync),
) -> PhaseStatus {
    let mut status = gateways.tun_status();
    if !status.supported || status.phase == "active" {
        return status;
    }
    let max_attempts = retry_delays.len() + 1;
    for attempt in 1..=max_attempts {
        if !RETRYABLE_TUN_PHASES.contains(&status.phase.as_str()) || !should_continue() {
            break;
        }
        if attempt > 1 {
            sleep_ms(retry_delays[attempt - 2]).await;
            if !should_continue() {
                break;
            }
        }
        if let Err(error) = gateways.tun_enable().await {
            eprintln!(
                "[startup-restore] TUN start failed ({attempt}/{max_attempts}): {}",
                error.extract_message()
            );
        }
        status = gateways.tun_status();
        if status.phase == "active" {
            break;
        }
    }
    status
}

async fn retry_proxy_start(
    gateways: &dyn IntentGateways,
    retry_delays: &[u64],
    should_continue: &(dyn Fn() -> bool + Send + Sync),
) -> PhaseStatus {
    let mut status = gateways.proxy_status();
    let max_attempts = retry_delays.len() + 1;
    let mut attempt = 1;
    while attempt <= max_attempts && RETRYABLE_PROXY_PHASES.contains(&status.phase.as_str()) {
        if !status.supported || !should_continue() {
            break;
        }
        if attempt > 1 {
            sleep_ms(retry_delays[attempt - 2]).await;
            if !should_continue() {
                break;
            }
        }
        if let Err(error) = gateways.proxy_enable().await {
            eprintln!(
                "[startup-restore] system proxy start failed ({attempt}/{max_attempts}): {}",
                error.extract_message()
            );
        }
        status = gateways.proxy_status();
        attempt += 1;
    }
    status
}

/// `needsAnotherAttempt` from the recovery coordinator.
pub fn needs_another_attempt(flags: IntentFlags, result: &IntentResult) -> bool {
    if result.kernel != "running" {
        return true;
    }
    if flags.tun_desired
        && result.tun.supported
        && !matches!(
            result.tun.phase.as_str(),
            "active" | "conflict" | "unsupported"
        )
    {
        return true;
    }
    flags.system_proxy_desired
        && result.system_proxy.supported
        && !matches!(
            result.system_proxy.phase.as_str(),
            "enabled" | "conflict" | "unsupported"
        )
}

// ---------------------------------------------------------------------------
// RuntimeIntentRecoveryCoordinator — bounded post-startup self-healing
// ---------------------------------------------------------------------------

/// Six retries over exactly two minutes after the fast startup pass.
pub const DEFAULT_BACKGROUND_BACKOFF_MS: [u64; 6] = [5_000, 10_000, 20_000, 30_000, 30_000, 25_000];

#[derive(Default)]
struct CoordinatorState {
    started: bool,
    running: bool,
    wake_pending: bool,
    generation: u64,
    next_delay: usize,
    deadline: u64,
    timer: Option<tauri::async_runtime::JoinHandle<()>>,
    last: Option<IntentFlags>,
}

/// Each timer performs one reconciliation attempt; the mode queue stays the
/// sole owner of host transitions. Settings are re-read before every attempt
/// and an intent change invalidates the in-flight generation, so a user's
/// later network-mode change is never followed by stale work.
pub struct RecoveryCoordinator {
    gateways: Arc<dyn IntentGateways>,
    read_flags: Arc<dyn Fn() -> IntentFlags + Send + Sync>,
    is_suspended: Arc<dyn Fn() -> bool + Send + Sync>,
    backoff: Vec<u64>,
    state: Mutex<CoordinatorState>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

impl RecoveryCoordinator {
    pub fn new(
        gateways: Arc<dyn IntentGateways>,
        read_flags: Arc<dyn Fn() -> IntentFlags + Send + Sync>,
        is_suspended: Arc<dyn Fn() -> bool + Send + Sync>,
        backoff: Vec<u64>,
    ) -> Arc<Self> {
        Arc::new(RecoveryCoordinator {
            gateways,
            read_flags,
            is_suspended,
            backoff,
            state: Mutex::new(CoordinatorState::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CoordinatorState> {
        self.state.lock().expect("intent recovery mutex poisoned")
    }

    pub fn start(self: &Arc<Self>) {
        let mut state = self.lock();
        if state.started {
            return;
        }
        state.started = true;
        self.reset_window(&mut state);
        self.schedule_next(&mut state);
    }

    /// Immediately retry after a confirmed network-up/resume/host-exit signal:
    /// a fresh recovery episode with a new window.
    pub fn wake(self: &Arc<Self>) {
        let mut state = self.lock();
        if !state.started {
            return;
        }
        self.reset_window(&mut state);
        if state.running {
            state.wake_pending = true;
            return;
        }
        Self::clear_timer(&mut state);
        self.schedule(&mut state, 0);
    }

    /// Abandon queued attempts without unsubscribing; an attempt already
    /// running is fenced by the generation bump.
    pub fn cancel_pending(&self) {
        let mut state = self.lock();
        if !state.started {
            return;
        }
        state.generation += 1;
        state.wake_pending = false;
        Self::clear_timer(&mut state);
        state.next_delay = self.backoff.len();
    }

    pub fn stop(&self) {
        let mut state = self.lock();
        if !state.started {
            return;
        }
        state.started = false;
        state.generation += 1;
        state.wake_pending = false;
        Self::clear_timer(&mut state);
    }

    /// The TS `onChange` subscriber: only an intent change re-arms recovery.
    pub fn handle_settings_change(self: &Arc<Self>, flags: IntentFlags) {
        let mut state = self.lock();
        if state.last == Some(flags) {
            return;
        }
        state.last = Some(flags);
        state.generation += 1;
        Self::clear_timer(&mut state);
        self.reset_window(&mut state);
        if state.running {
            state.wake_pending = true;
            return;
        }
        self.schedule_next(&mut state);
    }

    fn reset_window(&self, state: &mut CoordinatorState) {
        state.next_delay = 0;
        state.deadline = now_ms() + self.backoff.iter().sum::<u64>();
    }

    fn schedule_next(self: &Arc<Self>, state: &mut CoordinatorState) {
        if !state.started || state.next_delay >= self.backoff.len() {
            return;
        }
        let delay = self.backoff[state.next_delay];
        state.next_delay += 1;
        // Attempts take time, so the last configured retry would always land
        // past the window: clamp it to what is left instead of dropping it.
        let remaining = state.deadline.saturating_sub(now_ms());
        if remaining == 0 {
            return;
        }
        self.schedule(state, delay.min(remaining));
    }

    fn schedule(self: &Arc<Self>, state: &mut CoordinatorState, delay: u64) {
        let generation = state.generation;
        let this = self.clone();
        state.timer = Some(tauri::async_runtime::spawn(async move {
            sleep_ms(delay).await;
            this.lock().timer = None;
            this.tick(generation).await;
        }));
    }

    fn clear_timer(state: &mut CoordinatorState) {
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
    }

    async fn tick(self: &Arc<Self>, generation: u64) {
        {
            let mut state = self.lock();
            if !state.started || state.running || generation != state.generation {
                return;
            }
            state.running = true;
        }
        let flags = (self.read_flags)();
        let proceed = {
            let mut state = self.lock();
            state.last = Some(flags);
            generation == state.generation
        };
        if proceed {
            let fence = {
                let this = self.clone();
                move || {
                    let state = this.lock();
                    state.started && state.generation == generation && !(this.is_suspended)()
                }
            };
            // One attempt per background interval; retries belong to this
            // outer backoff and therefore remain cancellable.
            let result = restore_runtime_intent(flags, self.gateways.as_ref(), &[], &fence).await;
            let mut state = self.lock();
            if generation == state.generation {
                if needs_another_attempt(flags, &result) {
                    eprintln!(
                        "[startup-recovery] intent still pending (kernel={}, tun={}, proxy={})",
                        result.kernel, result.tun.phase, result.system_proxy.phase
                    );
                    self.schedule_next(&mut state);
                } else {
                    Self::clear_timer(&mut state);
                }
            }
        }
        let mut state = self.lock();
        state.running = false;
        if state.wake_pending && state.started {
            state.wake_pending = false;
            Self::clear_timer(&mut state);
            self.schedule(&mut state, 0);
        }
    }

    #[cfg(test)]
    fn is_idle(&self) -> bool {
        let state = self.lock();
        !state.running && state.timer.is_none()
    }
}

// ---------------------------------------------------------------------------
// Composition: the app-backed gateways and the startup sequence
// ---------------------------------------------------------------------------

/// The live gateways. Kernel start and TUN enable share the RUNTIME_UPDATE
/// mode queue with every IPC entry point; the replay never writes the
/// persisted intent (it only follows it).
pub struct AppIntentGateways {
    pub app: tauri::AppHandle,
}

impl AppIntentGateways {
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

/// The `tun:enable` IPC arm without its intent write: start a stopped kernel
/// first (in-place strategy), then enable the stock-default device.
pub async fn enable_tun_queued(
    kernel: &crate::kernel::KernelServices,
    tun: &crate::tun::TunCoordinator,
) -> Result<(), IpcError> {
    let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
    let phase = kernel.get_status_value()["phase"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if phase != "running" {
        if phase == "starting" {
            return Err(IpcError::code(
                crate::error::code::KERNEL_RUNNING,
                "A kernel start is already in progress.",
            ));
        }
        kernel.start().await?;
    }
    let intent = serde_json::json!({ "schemaVersion": 2, "device": "Mihomo", "stack": "mixed" });
    tun.enable(&intent).await.map(|_| ())
}

impl IntentGateways for AppIntentGateways {
    fn kernel_phase(&self) -> String {
        self.kernel().get_status_value()["phase"]
            .as_str()
            .unwrap_or("stopped")
            .to_string()
    }

    fn kernel_start(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        let kernel = self.kernel();
        Box::pin(async move {
            let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
            kernel.start().await.map(|_| ())
        })
    }

    fn tun_status(&self) -> PhaseStatus {
        PhaseStatus::from_value(&self.tun().get_status_value())
    }

    fn tun_enable(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        let kernel = self.kernel();
        let tun = self.tun();
        Box::pin(async move { enable_tun_queued(&kernel, &tun).await })
    }

    fn proxy_status(&self) -> PhaseStatus {
        let status = self.proxy().get_status();
        PhaseStatus {
            supported: status.supported,
            phase: status.phase,
        }
    }

    fn proxy_enable(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        let proxy = self.proxy();
        Box::pin(async move { proxy.enable().await.map(|_| ()) })
    }

    fn restore_selections(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        use tauri::Manager;
        let app = self.app.clone();
        Box::pin(async move {
            let mihomo = app
                .state::<Arc<crate::mihomo::MihomoServices>>()
                .inner()
                .clone();
            let models = app
                .state::<Arc<crate::enhancements::ModelStores>>()
                .inner()
                .clone();
            let profiles = app
                .state::<Arc<crate::profile_service::ProfilesService>>()
                .inner()
                .clone();
            crate::live_config::restore_selections_after_reload(&mihomo, &models, &profiles).await;
            Ok(())
        })
    }
}

static STARTUP_STARTED: AtomicBool = AtomicBool::new(false);

/// True when the CI-only flags suppress the startup replay (the TS
/// `skipKernelAutostart` + `--hidden-smoke`).
fn replay_suppressed() -> bool {
    let ci_flags = std::env::var("MURGE_CI_BOOT_FLAGS").unwrap_or_default();
    let has = |flag: &str| {
        std::env::args().any(|arg| arg == flag)
            || ci_flags.split_whitespace().any(|value| value == flag)
    };
    let skip_autostart = std::env::var("GITHUB_ACTIONS")
        .map(|value| value == "true")
        .unwrap_or(false)
        && has("--no-kernel-autostart");
    skip_autostart || has("--hidden-smoke")
}

/// The when-ready recovery chain: orphaned proxy backup → stale service core
/// → TUN transaction journal → intent replay → background recovery. Spawned
/// once; it never gates window or tray creation.
pub fn spawn_startup_recovery(app: tauri::AppHandle) {
    if STARTUP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    use tauri::Manager;
    let is_dev = app
        .state::<crate::paths::AppPaths>()
        .app_data_root
        .is_none();
    let gateways: Arc<dyn IntentGateways> = Arc::new(AppIntentGateways { app: app.clone() });
    let settings = app
        .state::<Arc<crate::settings::SettingsStore>>()
        .inner()
        .clone();
    let read_flags: Arc<dyn Fn() -> IntentFlags + Send + Sync> = {
        let settings = settings.clone();
        Arc::new(move || IntentFlags::from_settings(&settings.get()))
    };
    let coordinator = RecoveryCoordinator::new(
        gateways.clone(),
        read_flags.clone(),
        Arc::new(crate::lifecycle::is_quitting),
        DEFAULT_BACKGROUND_BACKOFF_MS.to_vec(),
    );
    app.manage(coordinator.clone());
    {
        let coordinator = coordinator.clone();
        settings.subscribe(Arc::new(move |value| {
            coordinator.handle_settings_change(IntentFlags {
                tun_desired: value["tunDesired"].as_bool().unwrap_or(false),
                system_proxy_desired: value["systemProxyDesired"].as_bool().unwrap_or(false),
            });
        }));
    }

    tauri::async_runtime::spawn(async move {
        let started_at = std::time::Instant::now();
        recover_managed_state(&app).await;
        crate::startup_timeline::mark("managed-state-recovered");
        crate::startup_timeline::reconciliation_complete(
            crate::startup_timeline::Reconciliation::ManagedState,
        );
        eprintln!(
            "[startup-timing] managed state recovered in {}ms",
            started_at.elapsed().as_millis()
        );
        if is_dev || replay_suppressed() {
            crate::startup_timeline::reconciliation_complete(
                crate::startup_timeline::Reconciliation::RuntimeIntent,
            );
            return;
        }
        let flags = read_flags();
        // A user toggle during the replay wins: stop as soon as the persisted
        // intent no longer matches the snapshot being replayed.
        let fence = {
            let read_flags = read_flags.clone();
            move || !crate::lifecycle::is_quitting() && read_flags() == flags
        };
        let restored =
            restore_runtime_intent(flags, gateways.as_ref(), &RETRY_DELAYS_MS, &fence).await;
        crate::startup_timeline::reconciliation_complete(
            crate::startup_timeline::Reconciliation::RuntimeIntent,
        );
        eprintln!(
            "[startup-timing] runtime restored in {}ms (kernel={}, proxy={}, TUN={})",
            started_at.elapsed().as_millis(),
            restored.kernel,
            restored.system_proxy.phase,
            restored.tun.phase
        );
        if flags.tun_desired && restored.tun.phase != "active" {
            eprintln!(
                "[startup-restore] TUN intent remains pending ({})",
                restored.tun.phase
            );
        }
        if flags.system_proxy_desired && restored.system_proxy.phase != "enabled" {
            eprintln!(
                "[startup-restore] system proxy intent remains pending ({})",
                restored.system_proxy.phase
            );
        }
        if crate::lifecycle::is_quitting() {
            return;
        }
        coordinator.start();
    });
}

/// `recoverManagedState`: the three recovery layers, joined in order.
async fn recover_managed_state(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(proxy) = app.try_state::<Arc<crate::system_proxy::SystemProxyService>>() {
        let mut status = proxy.init().await;
        // An owned backup whose restore failed transiently is retried
        // regardless of the enable intent: the proxy must not keep aiming
        // at us for the whole session after the user turned it off.
        for delay in RETRY_DELAYS_MS {
            if status.phase != "restore-failed" || crate::lifecycle::is_quitting() {
                break;
            }
            sleep_ms(delay).await;
            status = proxy.init().await;
        }
        if status.error_message.is_some()
            || status.phase == "conflict"
            || status.phase == "restore-failed"
        {
            eprintln!(
                "[system-proxy] orphan recovery: {} {}",
                status.phase,
                status.error_message.unwrap_or_default()
            );
        }
    }
    if let Some(kernel) = app.try_state::<Arc<crate::kernel::KernelServices>>() {
        if let Some(privileged) = kernel.privileged.clone() {
            if let Err(error) = privileged.initialize().await {
                eprintln!(
                    "[kernel] privileged service reconcile failed: {}",
                    error.extract_message()
                );
            }
        }
    }
    if let Some(tun) = app.try_state::<Arc<crate::tun::TunCoordinator>>() {
        tun.initialize().await;
    }
}

/// Wake the background recovery (network-up, resume, confirmed host exit).
pub fn wake(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(coordinator) = app.try_state::<Arc<RecoveryCoordinator>>() {
        coordinator.wake();
    }
}

pub fn cancel_pending(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(coordinator) = app.try_state::<Arc<RecoveryCoordinator>>() {
        coordinator.cancel_pending();
    }
}

pub fn stop(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(coordinator) = app.try_state::<Arc<RecoveryCoordinator>>() {
        coordinator.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A scripted host: kernel/TUN/proxy phases plus call counters, with
    /// configurable failures.
    #[derive(Default)]
    struct FakeHost {
        kernel: Mutex<String>,
        tun: Mutex<PhaseStatus>,
        proxy: Mutex<PhaseStatus>,
        kernel_starts_fail: AtomicUsize,
        tun_enables_fail: AtomicUsize,
        proxy_enables_fail: AtomicUsize,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeHost {
        fn new(tun_supported: bool, proxy_supported: bool) -> Arc<Self> {
            let host = FakeHost::default();
            *host.kernel.lock().unwrap() = "stopped".into();
            *host.tun.lock().unwrap() = PhaseStatus {
                supported: tun_supported,
                phase: if tun_supported {
                    "configured"
                } else {
                    "unsupported"
                }
                .into(),
            };
            *host.proxy.lock().unwrap() = PhaseStatus {
                supported: proxy_supported,
                phase: if proxy_supported {
                    "disabled"
                } else {
                    "unsupported"
                }
                .into(),
            };
            Arc::new(host)
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
        fn take_failure(counter: &AtomicUsize) -> bool {
            // Preserve the atomic decrement on the declared Rust 1.82 MSRV.
            let mut value = counter.load(Ordering::SeqCst);
            while let Some(next) = value.checked_sub(1) {
                match counter.compare_exchange(value, next, Ordering::SeqCst, Ordering::SeqCst) {
                    Ok(_) => return true,
                    Err(current) => value = current,
                }
            }
            false
        }
    }

    fn failure() -> IpcError {
        IpcError::code(
            crate::error::code::KERNEL_CRASHED,
            "scripted failure".to_string(),
        )
    }

    impl IntentGateways for FakeHost {
        fn kernel_phase(&self) -> String {
            self.kernel.lock().unwrap().clone()
        }
        fn kernel_start(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("kernel");
                if Self::take_failure(&self.kernel_starts_fail) {
                    *self.kernel.lock().unwrap() = "failed".into();
                    return Err(failure());
                }
                *self.kernel.lock().unwrap() = "running".into();
                Ok(())
            })
        }
        fn tun_status(&self) -> PhaseStatus {
            self.tun.lock().unwrap().clone()
        }
        fn tun_enable(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("tun");
                if Self::take_failure(&self.tun_enables_fail) {
                    self.tun.lock().unwrap().phase = "failed".into();
                    return Err(failure());
                }
                self.tun.lock().unwrap().phase = "active".into();
                Ok(())
            })
        }
        fn proxy_status(&self) -> PhaseStatus {
            self.proxy.lock().unwrap().clone()
        }
        fn proxy_enable(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("proxy");
                if Self::take_failure(&self.proxy_enables_fail) {
                    self.proxy.lock().unwrap().phase = "restore-failed".into();
                    return Err(failure());
                }
                self.proxy.lock().unwrap().phase = "enabled".into();
                Ok(())
            })
        }
        fn restore_selections(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("selections");
                Ok(())
            })
        }
    }

    const BOTH: IntentFlags = IntentFlags {
        tun_desired: true,
        system_proxy_desired: true,
    };
    const FAST: [u64; 2] = [1, 1];

    #[tokio::test]
    async fn replays_kernel_then_proxy_then_tun_then_selections() {
        let host = FakeHost::new(true, true);
        let result = restore_runtime_intent(BOTH, host.as_ref(), &FAST, &|| true).await;
        assert_eq!(host.calls(), vec!["kernel", "proxy", "tun", "selections"]);
        assert_eq!(result.kernel, "running");
        assert_eq!(result.tun.phase, "active");
        assert_eq!(result.system_proxy.phase, "enabled");
    }

    #[tokio::test]
    async fn no_intent_only_starts_the_kernel() {
        let host = FakeHost::new(true, true);
        restore_runtime_intent(IntentFlags::default(), host.as_ref(), &FAST, &|| true).await;
        assert_eq!(host.calls(), vec!["kernel", "selections"]);
    }

    #[tokio::test]
    async fn kernel_start_is_retried_within_the_bounded_delays() {
        let host = FakeHost::new(true, true);
        host.kernel_starts_fail.store(2, Ordering::SeqCst);
        let result =
            restore_runtime_intent(IntentFlags::default(), host.as_ref(), &FAST, &|| true).await;
        assert_eq!(result.kernel, "running");
        assert_eq!(
            host.calls(),
            vec!["kernel", "kernel", "kernel", "selections"]
        );
    }

    #[tokio::test]
    async fn a_dead_kernel_never_enables_proxy_or_tun() {
        let host = FakeHost::new(true, true);
        host.kernel_starts_fail.store(10, Ordering::SeqCst);
        let result = restore_runtime_intent(BOTH, host.as_ref(), &FAST, &|| true).await;
        assert_eq!(result.kernel, "failed");
        assert_eq!(host.calls(), vec!["kernel", "kernel", "kernel"]);
        assert!(needs_another_attempt(BOTH, &result));
    }

    #[tokio::test]
    async fn a_failed_first_proxy_attempt_lets_tun_go_before_the_proxy_retries() {
        let host = FakeHost::new(true, true);
        host.proxy_enables_fail.store(1, Ordering::SeqCst);
        let result = restore_runtime_intent(BOTH, host.as_ref(), &FAST, &|| true).await;
        assert_eq!(
            host.calls(),
            vec!["kernel", "proxy", "tun", "proxy", "selections"]
        );
        assert_eq!(result.system_proxy.phase, "enabled");
    }

    #[tokio::test]
    async fn the_cancellation_fence_stops_state_changes() {
        let host = FakeHost::new(true, true);
        let result = restore_runtime_intent(BOTH, host.as_ref(), &FAST, &|| false).await;
        assert!(host.calls().is_empty());
        assert_eq!(result.kernel, "stopped");
    }

    #[tokio::test]
    async fn unsupported_platforms_are_satisfied() {
        let host = FakeHost::new(false, false);
        let result = restore_runtime_intent(BOTH, host.as_ref(), &FAST, &|| true).await;
        assert!(!needs_another_attempt(BOTH, &result));
        assert_eq!(host.calls(), vec!["kernel", "selections"]);
    }

    async fn wait_until(condition: impl Fn() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn background_recovery_retries_until_the_intent_is_met() {
        let host = FakeHost::new(true, true);
        host.tun_enables_fail.store(2, Ordering::SeqCst);
        let coordinator = RecoveryCoordinator::new(
            host.clone(),
            Arc::new(|| BOTH),
            Arc::new(|| false),
            vec![1, 1, 1, 1, 1, 50],
        );
        coordinator.start();
        wait_until(|| host.tun_status().phase == "active").await;
        wait_until(|| coordinator.is_idle()).await;
        assert_eq!(
            host.calls().iter().filter(|call| **call == "tun").count(),
            3
        );
    }

    #[tokio::test]
    async fn background_recovery_stops_after_the_window() {
        let host = FakeHost::new(true, true);
        host.kernel_starts_fail.store(100, Ordering::SeqCst);
        let coordinator = RecoveryCoordinator::new(
            host.clone(),
            Arc::new(|| BOTH),
            Arc::new(|| false),
            vec![1, 1, 1],
        );
        coordinator.start();
        wait_until(|| !host.calls().is_empty()).await;
        // The window (3ms) closes: attempts stop on their own.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        wait_until(|| coordinator.is_idle()).await;
        let settled = host.calls().len();
        assert!((1..=3).contains(&settled));
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(host.calls().len(), settled);
        // A wake opens a fresh episode.
        coordinator.wake();
        wait_until(|| host.calls().len() > settled).await;
    }

    #[tokio::test]
    async fn suspended_and_stopped_coordinators_do_nothing() {
        let host = FakeHost::new(true, true);
        let coordinator =
            RecoveryCoordinator::new(host.clone(), Arc::new(|| BOTH), Arc::new(|| true), vec![1]);
        coordinator.start();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(host.calls().is_empty());
        coordinator.stop();
        coordinator.wake();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unchanged_intent_does_not_rearm() {
        let host = FakeHost::new(true, true);
        let coordinator =
            RecoveryCoordinator::new(host.clone(), Arc::new(|| BOTH), Arc::new(|| false), vec![1]);
        coordinator.start();
        wait_until(|| coordinator.is_idle() && !host.calls().is_empty()).await;
        let calls = host.calls().len();
        coordinator.handle_settings_change(BOTH);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(host.calls().len(), calls);
    }
}
