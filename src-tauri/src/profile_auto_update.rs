//! Subscription refresh parity: launch, every 72h, transport retry after 15m
//! or network recovery. One worker serializes passes; profile writes/reloads
//! reuse the same guarded transaction as manual updates.
use crate::error::IpcError;
use futures_util::future::BoxFuture;
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;

const INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
const RETRY: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
struct Profile {
    id: String,
    active: bool,
}
type List = Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<Profile>, IpcError>> + Send + Sync>;
type Update = Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), IpcError>> + Send + Sync>;

pub struct ProfileAutoUpdater {
    active: AtomicBool,
    wake: Notify,
    list: List,
    update: Update,
    interval: Duration,
    retry: Duration,
}
impl ProfileAutoUpdater {
    fn new(list: List, update: Update, interval: Duration, retry: Duration) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicBool::new(false),
            wake: Notify::new(),
            list,
            update,
            interval,
            retry,
        })
    }
    pub fn start(self: &Arc<Self>) {
        if self.active.swap(true, Ordering::SeqCst) {
            return;
        }
        let worker = self.clone();
        tauri::async_runtime::spawn(async move {
            worker.run().await;
        });
    }
    pub fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
        self.wake.notify_one();
    }
    pub fn retry_failed(&self) {
        if self.active.load(Ordering::SeqCst) {
            self.wake.notify_one();
        }
    }
    async fn pass(&self, failed: &mut BTreeSet<String>, retry_only: bool) {
        let mut profiles = match (self.list)().await {
            Ok(profiles) => profiles,
            Err(_) => {
                crate::diag!("[profiles] automatic update could not list profiles");
                return;
            }
        };
        let ids: BTreeSet<_> = profiles.iter().map(|profile| profile.id.clone()).collect();
        failed.retain(|id| ids.contains(id));
        profiles.sort_by_key(|profile| !profile.active);
        for profile in profiles {
            if !self.active.load(Ordering::SeqCst) {
                break;
            }
            if retry_only && !failed.contains(&profile.id) {
                continue;
            }
            match (self.update)(profile.id.clone()).await {
                Ok(()) => {
                    failed.remove(&profile.id);
                }
                Err(error) => {
                    if crate::subscription::is_transport_failure(&error) {
                        failed.insert(profile.id);
                    } else {
                        failed.remove(&profile.id);
                    }
                    // Fixed diagnostics only; source URLs and transport errors
                    // can contain credentials and never belong in this log.
                    crate::diag!("[profiles] automatic subscription update failed");
                }
            }
        }
    }
    async fn run(self: Arc<Self>) {
        let mut failed = BTreeSet::new();
        self.pass(&mut failed, false).await;
        let mut regular = tokio::time::Instant::now() + self.interval;
        let mut retry = (!failed.is_empty()).then(|| tokio::time::Instant::now() + self.retry);
        while self.active.load(Ordering::SeqCst) {
            let deadline = retry.map_or(regular, |retry| retry.min(regular));
            let woken = tokio::select! {
                _ = self.wake.notified() => true,
                _ = tokio::time::sleep_until(deadline) => false,
            };
            if !self.active.load(Ordering::SeqCst) {
                break;
            }
            let full = tokio::time::Instant::now() >= regular;
            if !full && woken && failed.is_empty() {
                continue;
            }
            self.pass(&mut failed, !full).await;
            if full {
                regular = tokio::time::Instant::now() + self.interval;
            }
            retry = (!failed.is_empty()).then(|| tokio::time::Instant::now() + self.retry);
        }
    }
}

pub fn install(app: &tauri::AppHandle) {
    use tauri::Manager;
    let profiles = app
        .state::<Arc<crate::profile_service::ProfilesService>>()
        .inner()
        .clone();
    let list: List = Arc::new(move || {
        let profiles = profiles.clone();
        Box::pin(async move {
            let value = profiles.list()?;
            Ok(value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|meta| {
                    if meta["source"]["type"].as_str() != Some("url") {
                        return None;
                    }
                    Some(Profile {
                        id: meta["id"].as_str()?.to_owned(),
                        active: meta["active"].as_bool().unwrap_or(false),
                    })
                })
                .collect())
        })
    });
    let handle = app.clone();
    let update: Update = Arc::new(move |id| {
        let app = handle.clone();
        Box::pin(async move {
            let profiles = app.state::<Arc<crate::profile_service::ProfilesService>>();
            let overrides = app.state::<Arc<crate::override_service::OverrideService>>();
            let models = app.state::<Arc<crate::enhancements::ModelStores>>();
            let kernel = app.state::<Arc<crate::kernel::KernelServices>>();
            let proxy = app.state::<Arc<crate::system_proxy::SystemProxyService>>();
            let mihomo = app.state::<Arc<crate::mihomo::MihomoServices>>();
            crate::ipc::refresh_subscription(
                &id, &profiles, &overrides, &models, &kernel, &proxy, &mihomo,
            )
            .await
            .map(|_| ())
        })
    });
    app.manage(ProfileAutoUpdater::new(list, update, INTERVAL, RETRY));
}

pub fn start(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(worker) = app.try_state::<Arc<ProfileAutoUpdater>>() {
        worker.start();
    }
}
pub fn retry_failed(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(worker) = app.try_state::<Arc<ProfileAutoUpdater>>() {
        worker.retry_failed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Mutex};
    fn profiles(ids: &[(&str, bool)]) -> Vec<Profile> {
        ids.iter()
            .map(|(id, active)| Profile {
                id: id.to_string(),
                active: *active,
            })
            .collect()
    }
    #[tokio::test]
    async fn launch_pass_is_active_first_and_only_transport_failures_retry() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let worker = ProfileAutoUpdater::new(
            Arc::new(|| {
                Box::pin(async { Ok(profiles(&[("b", false), ("a", true), ("c", false)])) })
            }),
            Arc::new(move |id| {
                observed.lock().unwrap().push(id.clone());
                Box::pin(async move {
                    match id.as_str() {
                        "b" => Err(IpcError::code(
                            crate::error::code::UPSTREAM_UNREACHABLE,
                            "network",
                        )),
                        "c" => Err(IpcError::invalid_argument("HTTP 403")),
                        _ => Ok(()),
                    }
                })
            }),
            INTERVAL,
            RETRY,
        );
        worker.active.store(true, Ordering::SeqCst);
        let mut failed = BTreeSet::new();
        worker.pass(&mut failed, false).await;
        assert_eq!(*calls.lock().unwrap(), vec!["a", "b", "c"]);
        assert_eq!(failed, BTreeSet::from(["b".into()]));
        worker.pass(&mut failed, true).await;
        assert_eq!(*calls.lock().unwrap(), vec!["a", "b", "c", "b"]);
    }
    #[tokio::test]
    async fn removed_profiles_are_not_retried_and_stop_ends_a_pass() {
        let list: List = Arc::new(|| Box::pin(async { Ok(profiles(&[("current", true)])) }));
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let worker = ProfileAutoUpdater::new(
            list,
            Arc::new(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }),
            INTERVAL,
            RETRY,
        );
        worker.active.store(true, Ordering::SeqCst);
        let mut failed = BTreeSet::from(["deleted".into()]);
        worker.pass(&mut failed, true).await;
        assert!(failed.is_empty());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        worker.stop();
        worker.pass(&mut failed, false).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    async fn recv(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }
    fn timed_worker(
        interval: Duration,
        retry: Duration,
        fail: bool,
    ) -> (
        Arc<ProfileAutoUpdater>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let worker = ProfileAutoUpdater::new(
            Arc::new(|| Box::pin(async { Ok(profiles(&[("a", true)])) })),
            Arc::new(move |id| {
                tx.send(id).unwrap();
                Box::pin(async move {
                    if fail {
                        Err(IpcError::code(
                            crate::error::code::UPSTREAM_UNREACHABLE,
                            "network",
                        ))
                    } else {
                        Ok(())
                    }
                })
            }),
            interval,
            retry,
        );
        (worker, rx)
    }
    #[tokio::test]
    async fn timers_run_launch_periodic_and_bounded_transport_retry() {
        let (worker, mut rx) = timed_worker(Duration::from_millis(10), RETRY, false);
        worker.active.store(true, Ordering::SeqCst);
        let task = tokio::spawn(worker.clone().run());
        assert_eq!(recv(&mut rx).await, "a");
        assert_eq!(recv(&mut rx).await, "a");
        worker.stop();
        task.await.unwrap();
        let (worker, mut rx) = timed_worker(INTERVAL, Duration::from_millis(10), true);
        worker.active.store(true, Ordering::SeqCst);
        let task = tokio::spawn(worker.clone().run());
        assert_eq!(recv(&mut rx).await, "a");
        assert_eq!(recv(&mut rx).await, "a");
        worker.stop();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn network_recovery_wakes_only_the_serial_worker() {
        let (worker, mut rx) = timed_worker(INTERVAL, RETRY, true);
        worker.active.store(true, Ordering::SeqCst);
        let task = tokio::spawn(worker.clone().run());
        assert_eq!(recv(&mut rx).await, "a");
        worker.retry_failed();
        worker.retry_failed(); // Notify coalesces events instead of overlapping passes.
        assert_eq!(recv(&mut rx).await, "a");
        worker.stop();
        task.await.unwrap();
    }
}
