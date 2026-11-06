//! Runtime network follow-ups that the connectivity watchdog
//! (`network_detector`) does not cover, after Mihomo Party / FlClash:
//!
//! - **Network switch** (Wi-Fi ↔ Wi-Fi, Wi-Fi ↔ wired) without an outage:
//!   connections that left through the old network hang until TCP gives up
//!   (FlClash `handleResetNetwork`), so the DNS cache is flushed and every
//!   connection is closed. A real outage is already handled by the watchdog,
//!   which restarts the kernel.
//! - **Resume repair** (Mihomo Party `sys/resume.ts`): after sleep, with TUN
//!   on, routes and DNS hijack can be gone while the core still answers. The
//!   TUN adapter missing → full kernel restart (which brings TUN back);
//!   otherwise one hot reload so mihomo re-applies TUN/DNS. Either way the
//!   DNS cache is flushed and stale connections closed.

use std::sync::Arc;
use std::time::Duration;

use crate::network_name::NetworkSnapshot;

const POLL: Duration = Duration::from_secs(5);
const RESUME_SETTLE: Duration = Duration::from_secs(3);
const RESUME_NETWORK_WAIT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Pure parts (unit-tested)
// ---------------------------------------------------------------------------

/// Remembers the last network seen; reports a switch between two online
/// networks. Offline samples are ignored: the outage path owns them, and the
/// network found after it is compared with the one before.
#[derive(Default)]
pub struct ChangeTracker {
    last: Option<NetworkSnapshot>,
}

impl ChangeTracker {
    pub fn observe(&mut self, now: Option<&NetworkSnapshot>) -> bool {
        let Some(now) = now else {
            return false;
        };
        let changed = self
            .last
            .as_ref()
            .is_some_and(|last| !last.same_network(now));
        // Keep a readable SSID once known; a later failed read must not wipe it.
        let mut next = now.clone();
        if next.ssid.is_none() && !changed {
            next.ssid = self.last.as_ref().and_then(|last| last.ssid.clone());
        }
        self.last = Some(next);
        changed
    }
}

// ---------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------

fn kernel_running(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.try_state::<Arc<crate::kernel::KernelServices>>()
        .map(|kernel| kernel.get_status_value()["phase"].as_str() == Some("running"))
        .unwrap_or(false)
}

fn controller(app: &tauri::AppHandle) -> Option<crate::mihomo::MihomoClient> {
    use tauri::Manager;
    let models = app.try_state::<Arc<crate::enhancements::ModelStores>>()?;
    crate::ipc::controller_client(&models).ok()
}

async fn read_snapshot() -> Option<NetworkSnapshot> {
    tokio::task::spawn_blocking(crate::network_name::snapshot)
        .await
        .ok()
        .flatten()
}

/// Flush the DNS cache and close every connection (both best-effort).
async fn reset_connections(client: &crate::mihomo::MihomoClient) {
    let _ = client.flush_dns_cache().await;
    let _ = client.close_all_connections().await;
}

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tracker = ChangeTracker::default();
        loop {
            if crate::lifecycle::is_quitting() {
                return;
            }
            let snapshot = read_snapshot().await;
            if tracker.observe(snapshot.as_ref()) && kernel_running(&app) {
                if let Some(client) = controller(&app) {
                    crate::diag!(
                        "[network-watch] network changed; flushing DNS and closing connections"
                    );
                    reset_connections(&client).await;
                }
            }
            tokio::time::sleep(POLL).await;
        }
    });
}

/// After a system resume: wait for the network, then repair TUN.
pub fn repair_after_resume(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESUME_SETTLE).await;
        let deadline = tokio::time::Instant::now() + RESUME_NETWORK_WAIT;
        while !crate::network_detector::system_is_connected()
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if let Err(error) = repair_tun(&app).await {
            crate::diag!(
                "[network-watch] resume repair failed: {}",
                error.extract_message()
            );
        }
    });
}

async fn repair_tun(app: &tauri::AppHandle) -> Result<(), crate::error::IpcError> {
    use tauri::Manager;
    if crate::lifecycle::is_quitting() || !kernel_running(app) {
        return Ok(());
    }
    let tun = app
        .state::<Arc<crate::tun::TunCoordinator>>()
        .inner()
        .clone();
    if tun.get_status().phase != "active" {
        return Ok(());
    }
    let Some(client) = controller(app) else {
        return Ok(());
    };
    let kernel = app
        .state::<Arc<crate::kernel::KernelServices>>()
        .inner()
        .clone();
    let system_proxy = app
        .state::<Arc<crate::system_proxy::SystemProxyService>>()
        .inner()
        .clone();
    let _gate = crate::lifecycle::runtime_update_guard().await?;
    let config = if client.is_responsive(3_000).await {
        client.get_config().await.ok()
    } else {
        None
    };
    let device = config
        .as_ref()
        .and_then(|config| config["tun"]["device"].as_str().map(str::to_string))
        .unwrap_or_default();
    let device_present = {
        let device = device.clone();
        tokio::task::spawn_blocking(move || crate::network_name::adapter_present(&device))
            .await
            .unwrap_or(true)
    };
    if config.is_none() || !device_present {
        crate::diag!(
            "[network-watch] after resume the core {} ; restarting it",
            if config.is_none() {
                "does not answer"
            } else {
                "lost its TUN adapter"
            }
        );
        return crate::live_config::restart_kernel_for_active_profile(
            &kernel,
            &system_proxy,
            Some(client),
            None,
        )
        .await;
    }
    let models = app.state::<Arc<crate::enhancements::ModelStores>>();
    let profiles = app.state::<Arc<crate::profile_service::ProfilesService>>();
    let overrides = app.state::<Arc<crate::override_service::OverrideService>>();
    let reloader = crate::live_config::LiveConfigReloader::from_ipc(
        kernel.as_ref(),
        &models,
        &profiles,
        &overrides,
    )?;
    crate::diag!("[network-watch] reloading the config after resume to restore TUN routes and DNS");
    if reloader.reload_if_running().await? {
        let active = profiles
            .get_active()
            .ok()
            .and_then(|profile| profile["meta"]["id"].as_str().map(str::to_string));
        if let (Some(active), Some(mihomo)) = (
            active,
            app.try_state::<Arc<crate::mihomo::MihomoServices>>(),
        ) {
            let _ = mihomo.restore_selections(&client, Some(active)).await;
        }
    }
    reset_connections(&client).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wifi(ssid: Option<&str>) -> NetworkSnapshot {
        NetworkSnapshot {
            identity: "{wlan}|192.168.1.1".into(),
            wifi: true,
            ssid: ssid.map(str::to_string),
        }
    }

    #[test]
    fn tracker_reports_only_switches_between_online_networks() {
        let mut tracker = ChangeTracker::default();
        assert!(!tracker.observe(Some(&wifi(Some("Home")))), "first sample");
        assert!(!tracker.observe(Some(&wifi(None))), "unreadable SSID");
        assert!(!tracker.observe(None), "offline is the watchdog's");
        assert!(tracker.observe(Some(&wifi(Some("Office")))));
        let wired = NetworkSnapshot {
            identity: "{eth}|10.0.0.1".into(),
            wifi: false,
            ssid: None,
        };
        assert!(tracker.observe(Some(&wired)));
        assert!(!tracker.observe(Some(&wired)));
    }
}
