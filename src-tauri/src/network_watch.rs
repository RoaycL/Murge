//! Runtime network follow-ups that the connectivity watchdog
//! (`network_detector`) does not cover, after Mihomo Party / FlClash:
//!
//! - **Network switch** (Wi-Fi ↔ Wi-Fi, Wi-Fi ↔ wired) without an outage:
//!   connections that left through the old network hang until TCP gives up
//!   (FlClash `handleResetNetwork`), so the DNS cache is flushed and every
//!   connection is closed. A real outage is already handled by the watchdog,
//!   which restarts the kernel.
//! - **Wi-Fi rules** (Mihomo Party `pauseSSID` / `ssidProfileMap`): on the
//!   listed SSIDs switch to 直连 or to a profile, and put things back on
//!   leaving.
//! - **Resume repair** (Mihomo Party `sys/resume.ts`): after sleep, with TUN
//!   on, routes and DNS hijack can be gone while the core still answers. The
//!   TUN adapter missing → full kernel restart (which brings TUN back);
//!   otherwise one hot reload so mihomo re-applies TUN/DNS. Either way the
//!   DNS cache is flushed and stale connections closed.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::network_name::NetworkSnapshot;
use crate::settings::WifiProfileRule;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WifiAction {
    SetMode(String),
    ActivateProfile(String),
}

/// What the Wi-Fi rules changed and how to put it back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WifiRuleState {
    /// The SSID the rules were last evaluated for (`Some(None)` = not on Wi-Fi).
    pub evaluated: Option<Option<String>>,
    /// The mode before the rules switched to direct.
    pub mode_before: Option<String>,
    /// The profile before the rules switched profile.
    pub profile_before: Option<String>,
}

impl WifiRuleState {
    fn holds_something(&self) -> bool {
        self.mode_before.is_some() || self.profile_before.is_some()
    }
}

/// Plan the actions for arriving on `ssid` (`None` = not on Wi-Fi).
/// A mode or profile the user changed by hand in the meantime is left alone.
pub fn plan_wifi(
    state: &WifiRuleState,
    ssid: Option<&str>,
    mode: &str,
    active_profile: Option<&str>,
    direct: &[String],
    rules: &[WifiProfileRule],
) -> (Vec<WifiAction>, WifiRuleState) {
    let mut actions = Vec::new();
    let mut next = state.clone();
    next.evaluated = Some(ssid.map(str::to_string));

    let on_direct = ssid.is_some_and(|ssid| direct.iter().any(|item| item == ssid));
    if on_direct {
        if state.mode_before.is_none() && mode != "direct" {
            actions.push(WifiAction::SetMode("direct".into()));
            next.mode_before = Some(mode.to_string());
        }
    } else if let Some(before) = &state.mode_before {
        if mode == "direct" {
            actions.push(WifiAction::SetMode(before.clone()));
        }
        next.mode_before = None;
    }

    let rule = ssid.and_then(|ssid| rules.iter().find(|rule| rule.ssid == ssid));
    match rule {
        Some(rule) => {
            if active_profile != Some(rule.profile_id.as_str()) {
                actions.push(WifiAction::ActivateProfile(rule.profile_id.clone()));
                if state.profile_before.is_none() {
                    next.profile_before = active_profile.map(str::to_string);
                }
            }
        }
        None => {
            if let Some(before) = &state.profile_before {
                let switched_by_rule = rules
                    .iter()
                    .any(|rule| Some(rule.profile_id.as_str()) == active_profile);
                if active_profile != Some(before.as_str()) && switched_by_rule {
                    actions.push(WifiAction::ActivateProfile(before.clone()));
                }
                next.profile_before = None;
            }
        }
    }
    (actions, next)
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

fn settings(app: &tauri::AppHandle) -> crate::settings::AppSettings {
    use tauri::Manager;
    app.try_state::<Arc<crate::settings::SettingsStore>>()
        .map(|settings| settings.get())
        .unwrap_or_default()
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
        let mut wifi = WifiRuleState::default();
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
            if let Some(snapshot) = &snapshot {
                apply_wifi_rules(&app, snapshot, &mut wifi).await;
            }
            tokio::time::sleep(POLL).await;
        }
    });
}

async fn apply_wifi_rules(
    app: &tauri::AppHandle,
    snapshot: &NetworkSnapshot,
    state: &mut WifiRuleState,
) {
    use tauri::Manager;
    // Wi-Fi whose SSID cannot be read (Windows 24H2 without location
    // permission): unknown, so nothing changes.
    if snapshot.wifi && snapshot.ssid.is_none() {
        return;
    }
    let ssid = snapshot.ssid.clone();
    if state.evaluated.as_ref() == Some(&ssid) {
        return;
    }
    let current = settings(app);
    if current.wifi_direct_ssids.is_empty()
        && current.wifi_profile_rules.is_empty()
        && !state.holds_something()
    {
        state.evaluated = Some(ssid);
        return;
    }
    if !kernel_running(app) {
        return; // retried on the next tick once the kernel runs
    }
    let Some(client) = controller(app) else {
        return;
    };
    let Ok(config) = client.get_config().await else {
        return;
    };
    let mode = config["mode"].as_str().unwrap_or("rule").to_string();
    let active = app
        .try_state::<Arc<crate::profile_service::ProfilesService>>()
        .and_then(|profiles| profiles.get_active().ok())
        .and_then(|profile| profile["meta"]["id"].as_str().map(str::to_string));
    let (actions, next) = plan_wifi(
        state,
        ssid.as_deref(),
        &mode,
        active.as_deref(),
        &current.wifi_direct_ssids,
        &current.wifi_profile_rules,
    );
    *state = next;
    for action in actions {
        match action {
            WifiAction::SetMode(mode) => {
                crate::diag!("[network-watch] Wi-Fi rule: mode -> {mode}");
                let result = crate::ipc::dispatch_from_app(
                    app,
                    "mihomo:patch-config",
                    &json!([{ "mode": mode }]),
                )
                .await;
                if result.is_ok() {
                    let _ = tauri::Emitter::emit(app, "mihomo:mode-changed-event", mode.as_str());
                }
            }
            WifiAction::ActivateProfile(id) => {
                crate::diag!("[network-watch] Wi-Fi rule: activate profile {id}");
                if let Err(error) =
                    crate::ipc::dispatch_from_app(app, "profiles:activate", &json!([id])).await
                {
                    crate::diag!(
                        "[network-watch] Wi-Fi rule profile switch failed: {}",
                        error.extract_message()
                    );
                }
            }
        }
    }
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

    fn rule(ssid: &str, profile: &str) -> WifiProfileRule {
        WifiProfileRule {
            ssid: ssid.into(),
            profile_id: profile.into(),
        }
    }

    #[test]
    fn direct_ssid_switches_to_direct_and_restores_the_previous_mode() {
        let direct = vec!["Office".to_string()];
        let (actions, state) = plan_wifi(
            &WifiRuleState::default(),
            Some("Office"),
            "global",
            None,
            &direct,
            &[],
        );
        assert_eq!(actions, vec![WifiAction::SetMode("direct".into())]);
        assert_eq!(state.mode_before.as_deref(), Some("global"));
        let (actions, state) = plan_wifi(&state, Some("Home"), "direct", None, &direct, &[]);
        assert_eq!(actions, vec![WifiAction::SetMode("global".into())]);
        assert_eq!(state.mode_before, None);
        // Already direct by hand: nothing to switch, nothing to restore.
        let (actions, state) = plan_wifi(
            &WifiRuleState::default(),
            Some("Office"),
            "direct",
            None,
            &direct,
            &[],
        );
        assert!(actions.is_empty());
        let (actions, _) = plan_wifi(&state, None, "direct", None, &direct, &[]);
        assert!(actions.is_empty());
    }

    #[test]
    fn a_mode_changed_by_hand_is_not_overwritten_on_leaving() {
        let direct = vec!["Office".to_string()];
        let (_, state) = plan_wifi(
            &WifiRuleState::default(),
            Some("Office"),
            "rule",
            None,
            &direct,
            &[],
        );
        let (actions, state) = plan_wifi(&state, Some("Home"), "global", None, &direct, &[]);
        assert!(actions.is_empty());
        assert_eq!(state.mode_before, None);
    }

    #[test]
    fn profile_rules_switch_and_restore_the_original_profile() {
        let rules = vec![rule("Office", "work"), rule("Lab", "lab")];
        let (actions, state) = plan_wifi(
            &WifiRuleState::default(),
            Some("Office"),
            "rule",
            Some("home"),
            &[],
            &rules,
        );
        assert_eq!(actions, vec![WifiAction::ActivateProfile("work".into())]);
        assert_eq!(state.profile_before.as_deref(), Some("home"));
        // Another mapped network keeps the original profile to come back to.
        let (actions, state) = plan_wifi(&state, Some("Lab"), "rule", Some("work"), &[], &rules);
        assert_eq!(actions, vec![WifiAction::ActivateProfile("lab".into())]);
        assert_eq!(state.profile_before.as_deref(), Some("home"));
        let (actions, state) = plan_wifi(&state, None, "rule", Some("lab"), &[], &rules);
        assert_eq!(actions, vec![WifiAction::ActivateProfile("home".into())]);
        assert_eq!(state.profile_before, None);
    }

    #[test]
    fn a_profile_picked_by_hand_is_kept_on_leaving() {
        let rules = vec![rule("Office", "work")];
        let (_, state) = plan_wifi(
            &WifiRuleState::default(),
            Some("Office"),
            "rule",
            Some("home"),
            &[],
            &rules,
        );
        let (actions, state) = plan_wifi(&state, Some("Home"), "rule", Some("other"), &[], &rules);
        assert!(actions.is_empty());
        assert_eq!(state.profile_before, None);
    }
}
