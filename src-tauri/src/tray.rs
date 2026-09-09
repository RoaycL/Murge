//! The tray controller — Rust port of `src/main/tray/tray-controller.ts`
//! (the state owner) with the `TrayView` seam the TS interface defines, so
//! the menu tree and action routing are unit-testable without a native tray.
//!
//! Structure: the controller owns NO renderer state and trusts nothing
//! optimistic ("Main-process tray state owner"). Every value that can change
//! outside the tray is re-pulled on refresh; a network probe runs inside a
//! bounded window and never blocks longer than that; actions run one at a
//! time (`busy` guard) and re-read authoritative state afterwards.
//!
//! Tauri platform notes (documented differences):
//! - Electron re-renders the menu the instant it opens (`onMenuOpen`). Tauri
//!   has no menu-open hook, so the controller refreshes on every status
//!   event, after every action, and on a bounded cadence instead — the menu
//!   the OS draws is the most recent snapshot.
//! - The native menu is re-created per render (muda menus are immutable once
//!   shown); the TS `setMenu(items)` contract maps onto that.
//!
//! The native view lives in `crate::tray_view` behind the seam.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::IpcError;

// ---------------------------------------------------------------------------
// Menu tree (data) — the TS TrayMenuItem shape
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MenuKind {
    Normal,
    Separator,
    Checkbox,
    Radio,
}

#[derive(Clone, Debug)]
pub(crate) struct TrayMenuItem {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) checked: bool,
    pub(crate) kind: MenuKind,
    pub(crate) children: Vec<TrayMenuItem>,
}

impl TrayMenuItem {
    fn normal(id: &str, label: &str, enabled: bool) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            enabled,
            checked: false,
            kind: MenuKind::Normal,
            children: Vec::new(),
        }
    }

    fn separator() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            enabled: false,
            checked: false,
            kind: MenuKind::Separator,
            children: Vec::new(),
        }
    }

    fn stateful(id: &str, label: &str, enabled: bool, checked: bool, radio: bool) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            enabled,
            checked,
            kind: if radio { MenuKind::Radio } else { MenuKind::Checkbox },
            children: Vec::new(),
        }
    }

    fn submenu(id: &str, label: &str, enabled: bool, children: Vec<TrayMenuItem>) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            enabled,
            checked: false,
            kind: MenuKind::Normal,
            children,
        }
    }
}

/// The TS `TrayView` seam: the controller paints state; the native view draws it.
pub(crate) trait TrayView: Send + Sync {
    fn set_tooltip(&self, value: &str);
    fn set_menu(&self, items: Vec<TrayMenuItem>);
    /// Recompute the notification-area icon from the runtime accent + theme.
    fn set_runtime_appearance(&self, accent: &str, dark: bool);
}

// ---------------------------------------------------------------------------
// Labels + pure row helpers (the TS module-level helpers, byte-exact)
// ---------------------------------------------------------------------------

pub fn phase_label(phase: &str) -> &'static str {
    match phase {
        "starting" => "正在启动",
        "running" => "运行中",
        "stopping" => "正在停止",
        "failed" => "启动失败",
        _ => "已停止",
    }
}

pub fn mode_label(mode: &str) -> &'static str {
    match mode {
        "global" => "全局",
        "direct" => "直连",
        _ => "规则",
    }
}

const SELECTABLE_GROUP_TYPES: [&str; 3] = ["Selector", "URLTest", "Fallback"];

/// `proxy.fixed ?? proxy.now` — a fixed selection wins over the reported one.
pub fn selected_member(proxy: &Value) -> Option<String> {
    if let Some(fixed) = proxy["fixed"].as_str() {
        if !fixed.is_empty() {
            return Some(fixed.to_string());
        }
    }
    proxy["now"].as_str().map(str::to_string)
}

/// The TS `formatBytes` (B / KB / MB / GB, one decimal above a KiB).
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024u64.pow(2) {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    if bytes < 1024u64.pow(3) {
        return format!("{:.1} MB", bytes as f64 / 1024f64.powi(2));
    }
    format!("{:.1} GB", bytes as f64 / 1024f64.powi(3))
}

/// Top-12 processes by total transfer over the live connections
/// (`metadata.process?.trim() || '未知进程'`).
pub fn process_rows(connections: &Value) -> Vec<(String, u64)> {
    let mut totals: HashMap<String, u64> = HashMap::new();
    if let Some(items) = connections["connections"].as_array() {
        for connection in items {
            let upload = connection["upload"].as_u64().unwrap_or(0);
            let download = connection["download"].as_u64().unwrap_or(0);
            let name = connection["metadata"]["process"]
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("未知进程")
                .to_string();
            *totals.entry(name).or_insert(0) += upload + download;
        }
    }
    let mut rows: Vec<(String, u64)> = totals.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    rows.truncate(12);
    rows
}

fn client_for(models: &crate::enhancements::ModelStores) -> Result<crate::mihomo::MihomoClient, IpcError> {
    let core = crate::enhancements::coerce_core_settings(&models.core.get());
    crate::mihomo::MihomoClient::new(
        core["controllerPort"].as_i64().unwrap_or(9090),
        core["controllerSecret"].as_str().unwrap_or_default(),
    )
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/// The exact dependency set the TS controller receives (options object).
/// Queue parity: every action the TS runs through a queued gateway takes the
/// dispatcher-level gate here (the kernel/TUN/profile/selection arms share
/// that boundary), and the raw service calls happen inside it.
pub struct TrayDeps {
    pub product_name: String,
    pub kernel: Arc<crate::kernel::KernelServices>,
    pub system_proxy: Arc<crate::system_proxy::SystemProxyService>,
    pub tun: Arc<crate::tun::TunCoordinator>,
    pub profiles: Arc<crate::profile_service::ProfilesService>,
    pub models: Arc<crate::enhancements::ModelStores>,
    pub mihomo: Arc<crate::mihomo::MihomoServices>,
    /// Order from the exact enhanced document materialized for mihomo.
    pub resolve_group_order: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    /// Controller-patch reload used by the tray's 重新载入当前配置 entry.
    pub reload_config: Box<dyn Fn() -> BoxFuture<'static, Result<(), IpcError>> + Send + Sync>,
    /// The ordered-restart fallback (`reloadProfile` + selection replay).
    pub restart_kernel: Box<dyn Fn() -> BoxFuture<'static, Result<(), IpcError>> + Send + Sync>,
    /// The `profiles:*` ipc arms (activate / update-from-source), reused
    /// verbatim so the tray cannot drift from the renderer's gateway
    /// semantics (gates + rollback live in ONE place).
    pub profiles_arm:
        Box<dyn Fn(&str, &str) -> BoxFuture<'static, Result<Value, IpcError>> + Send + Sync>,
    /// The `tun:enable`/`tun:disable` ipc arms, reused verbatim so the tray
    /// cannot drift from the renderer's gateway semantics.
    pub tun_desired: Box<dyn Fn(bool) -> BoxFuture<'static, Result<Value, IpcError>> + Send + Sync>,
    pub on_check_update: Box<dyn Fn() + Send + Sync>,
    pub show_window: Box<dyn Fn() + Send + Sync>,
    pub quit: Box<dyn Fn() + Send + Sync>,
    pub open_directory: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    pub copy_text: Box<dyn Fn(&str) + Send + Sync>,
    pub on_error: Box<dyn Fn(&str) + Send + Sync>,
}

#[derive(Default)]
pub(crate) struct TrayState {
    status_phase: String,
    system_proxy_phase: String,
    system_proxy_supported: bool,
    tun_phase: String,
    tun_supported: bool,
    mode: String,
    mixed_port: Option<u64>,
    proxies: Value,
    group_order: Vec<String>,
    profiles: Vec<Value>,
    connections: Value,
    network_latency_ms: Option<u64>,
    active_profile_stamp: String,
    busy: bool,
    disposed: bool,
}

pub struct TrayController {
    deps: TrayDeps,
    view: Arc<dyn TrayView>,
    state: Mutex<TrayState>,
}

impl TrayController {
    pub fn new(deps: TrayDeps, view: Arc<dyn TrayView>) -> Self {
        Self {
            deps,
            view,
            state: Mutex::new(TrayState {
                status_phase: "stopped".to_string(),
                system_proxy_phase: "unsupported".to_string(),
                tun_phase: "unsupported".to_string(),
                mode: "rule".to_string(),
                ..TrayState::default()
            }),
        }
    }

    /// Pull every value that can also change outside the tray. Best-effort at
    /// every step: a failing source keeps the previous snapshot (the TS
    /// `.catch(() => this.…)` guards).
    pub async fn refresh(&self) {
        let kernel = self.deps.kernel.supervisor.get_status();
        let system_proxy = self.deps.system_proxy.get_status();
        let tun = self.deps.tun.get_status_value();
        let profiles: Vec<Value> = self
            .deps
            .profiles
            .list()
            .ok()
            .and_then(|profiles| profiles.as_array().cloned())
            .unwrap_or_default();
        let group_order = (self.deps.resolve_group_order)();

        let mut config = None;
        let mut proxies = None;
        let mut connections = None;
        let mut latency_ms = None;
        if kernel["phase"].as_str() == Some("running") {
            let Ok(client) = client_for(&self.deps.models) else {
                let mut state = self.state.lock().await;
                self.render_locked(&mut state);
                return;
            };
            // The three controller reads are independent (the TS Promise.all).
            let (config_result, proxies_result, connections_result) = tokio::join!(
                client.get_config(),
                client.get_proxies(),
                client.get_connections()
            );
            config = config_result.ok();
            proxies = proxies_result.ok();
            connections = connections_result.ok();
            // A network probe may take seconds; never hold the refresh cadence
            // open for it — bounded wait, degrade to '—' (the TS background
            // refresh runs unbounded; the tray here re-renders on the next
            // cadence tick either way).
            let sample = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                crate::internet_latency::sample(&client, None),
            )
            .await
            .ok();
            if let Some(sample) = sample {
                latency_ms = sample.proxy_ms.or(sample.gateway_ms);
            }
        }

        let mut state = self.state.lock().await;
        state.status_phase = kernel["phase"].as_str().unwrap_or("stopped").to_string();
        state.system_proxy_phase = system_proxy.phase.clone();
        state.system_proxy_supported = system_proxy.supported;
        state.tun_phase = tun["phase"].as_str().unwrap_or("unsupported").to_string();
        state.tun_supported = tun["supported"].as_bool().unwrap_or(false);
        state.profiles = profiles;
        state.group_order = group_order;

        let active = state
            .profiles
            .iter()
            .find(|profile| profile["active"].as_bool() == Some(true))
            .cloned();
        // The TS stamp is `id:updatedAt` (any revision re-arms the icon
        // sources); this build's metas carry the same updatedAt.
        let active_stamp = active
            .as_ref()
            .map(|profile| {
                format!(
                    "{}:{}",
                    profile["id"].as_str().unwrap_or(""),
                    profile["updatedAt"].as_u64().unwrap_or(0)
                )
            })
            .unwrap_or_default();
        if active_stamp != state.active_profile_stamp {
            state.active_profile_stamp = active_stamp;
        }

        if state.status_phase == "running" {
            if let Some(config) = &config {
                state.mode = config["mode"].as_str().unwrap_or("rule").to_string();
                state.mixed_port = config["mixed-port"].as_u64().or(config["port"].as_u64());
            }
            if let Some(proxies) = &proxies {
                state.proxies = proxies["proxies"].clone();
            }
            if let Some(connections) = &connections {
                state.connections = connections.clone();
            }
            state.network_latency_ms = latency_ms;
        } else {
            state.proxies = Value::Null;
            state.connections = Value::Null;
            state.network_latency_ms = None;
            state.mixed_port = None;
        }
        self.render_locked(&mut state);
    }

    pub async fn on_kernel_status(&self, status: &Value) {
        let mut state = self.state.lock().await;
        state.status_phase = status["phase"].as_str().unwrap_or("stopped").to_string();
        self.render_locked(&mut state);
    }

    pub async fn on_system_proxy_status(&self, status: &Value) {
        let mut state = self.state.lock().await;
        state.system_proxy_phase = status["phase"].as_str().unwrap_or("unsupported").to_string();
        state.system_proxy_supported = status["supported"].as_bool().unwrap_or(false);
        self.render_locked(&mut state);
    }

    pub async fn on_tun_status(&self, status: &Value) {
        let mut state = self.state.lock().await;
        state.tun_phase = status["phase"].as_str().unwrap_or("unsupported").to_string();
        state.tun_supported = status["supported"].as_bool().unwrap_or(false);
        self.render_locked(&mut state);
    }

    /// Dispatch a menu id to its action, then re-read authoritative state.
    pub async fn handle_menu(&self, id: &str) {
        match id {
            "show" => (self.deps.show_window)(),
            "check-update" => (self.deps.on_check_update)(),
            "quit" => (self.deps.quit)(),
            _ => {
                if let Some(mode) = id.strip_prefix("outbound-mode:") {
                    let mode = mode.to_string();
                    self.act(move |this| {
                        Box::pin(async move { this.patch_mode(&mode).await })
                    })
                    .await;
                } else if let Some(rest) = id.strip_prefix("group:") {
                    if let Some((group, member)) = rest.split_once('\u{0}') {
                        let group = group.to_string();
                        let member = member.to_string();
                        self.act(move |this| {
                            Box::pin(async move { this.select_proxy(&group, &member).await })
                        })
                        .await;
                    }
                } else if id == "system-proxy" {
                    self.act(|this| Box::pin(async move { this.toggle_system_proxy().await }))
                        .await;
                } else if id == "tun" {
                    self.act(|this| Box::pin(async move { this.toggle_tun().await }))
                        .await;
                } else if id == "copy-terminal-proxy" {
                    self.copy_proxy().await;
                } else if id == "reload-config" {
                    self.act(|this| Box::pin(async move { this.run_reload_config().await }))
                        .await;
                } else if id == "restart-kernel" {
                    self.act(|this| Box::pin(async move { this.run_restart_kernel().await }))
                        .await;
                } else if let Some(profile_id) = id.strip_prefix("profile:") {
                    let profile_id = profile_id.to_string();
                    self.act(move |this| {
                        Box::pin(async move { this.activate_profile(&profile_id).await })
                    })
                    .await;
                } else if let Some(profile_id) = id.strip_prefix("update-profile:") {
                    let profile_id = profile_id.to_string();
                    self.act(move |this| {
                        Box::pin(async move { this.update_profile(&profile_id).await })
                    })
                    .await;
                } else if id == "update-all-profiles" {
                    self.act(|this| Box::pin(async move { this.update_all_profiles().await }))
                        .await;
                } else if let Some(directory) = id.strip_prefix("open-directory:") {
                    if let Err(error) = (self.deps.open_directory)(directory) {
                        (self.deps.on_error)(&error);
                    }
                }
            }
        }
    }

    // -- actions ------------------------------------------------------------

    /// The TS `act()`: busy-guarded, then action + authoritative refresh.
    async fn act<F>(&self, action: F)
    where
        F: FnOnce(&TrayController) -> BoxFuture<'_, ()>,
    {
        if !self.begin_act().await {
            return;
        }
        action(self).await;
        self.refresh().await;
        let mut state = self.state.lock().await;
        state.busy = false;
        self.render_locked(&mut state);
    }

    async fn begin_act(&self) -> bool {
        let mut state = self.state.lock().await;
        if state.busy || state.disposed {
            return false;
        }
        state.busy = true;
        self.render_locked(&mut state);
        true
    }

    async fn patch_mode(&self, mode: &str) {
        // The tray mode patch is the same direct controller PATCH the renderer
        // uses (no queue in the TS gateway chain either).
        if let Ok(client) = client_for(&self.deps.models) {
            let _ = client
                .patch_config(&serde_json::json!({ "mode": mode }))
                .await;
        }
    }

    async fn select_proxy(&self, group: &str, member: &str) {
        let active = self.deps.profiles.get_active().ok();
        let profile_id = active
            .as_ref()
            .and_then(|profile| profile["meta"]["id"].as_str())
            .map(str::to_string);
        // ProxySelectionGateway parity: attribution -> PUT -> durable record
        // inside the profile mutation boundary.
        let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
        if let Ok(client) = client_for(&self.deps.models) {
            let _ = self
                .deps
                .mihomo
                .select_proxy(&client, profile_id, group, member)
                .await;
        }
    }

    async fn toggle_system_proxy(&self) {
        let (enabled, kernel_running, tun_active) = {
            let state = self.state.lock().await;
            (
                state.system_proxy_phase == "enabled",
                state.status_phase == "running",
                state.tun_phase == "active",
            )
        };
        if enabled {
            let _ = self.deps.system_proxy.disable().await;
        } else {
            // The TS tray starts the (queued) kernel before enabling the proxy.
            if !kernel_running && !tun_active {
                let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
                let _ = self.deps.kernel.start().await;
            }
            let _ = self.deps.system_proxy.enable().await;
        }
    }

    async fn toggle_tun(&self) {
        let active = {
            let state = self.state.lock().await;
            state.tun_phase == "active"
        };
        if active {
            // The TS tray disable path is `queuedTun.disable()` =
            // `controller.disableTun()`; the exact disable semantics live in
            // the ipc dispatcher's `tun:disable` arm (gate + tunDesired=false
            // + coordinator disable), so the tray reuses the same gateway.
            let _ = (self.deps.tun_desired)(false).await;
        } else {
            // The `tun:enable` arm semantics: kernel start gate, tunDesired
            // persistence, then the coordinator enable with the exact intent.
            let _ = (self.deps.tun_desired)(true).await;
        }
    }

    async fn copy_proxy(&self) {
        let (running, mixed_port) = {
            let state = self.state.lock().await;
            (state.status_phase == "running", state.mixed_port)
        };
        if running {
            if let Some(port) = mixed_port.filter(|port| *port > 0) {
                let endpoint = format!("127.0.0.1:{port}");
                (self.deps.copy_text)(&format!(
                    "$env:HTTP_PROXY=\"http://{endpoint}\"\n$env:HTTPS_PROXY=$env:HTTP_PROXY\n$env:ALL_PROXY=\"socks5://{endpoint}\""
                ));
            }
        }
    }

    async fn run_reload_config(&self) {
        if let Err(error) = (self.deps.reload_config)().await {
            (self.deps.on_error)(&error.extract_message());
        }
    }

    async fn run_restart_kernel(&self) {
        if let Err(error) = (self.deps.restart_kernel)().await {
            (self.deps.on_error)(&error.extract_message());
        }
    }

    async fn activate_profile(&self, id: &str) {
        if let Err(error) = (self.deps.profiles_arm)("profiles:activate", id).await {
            (self.deps.on_error)(&error.extract_message());
        }
    }

    async fn update_profile(&self, id: &str) {
        if let Err(error) = (self.deps.profiles_arm)("profiles:update-from-source", id).await {
            (self.deps.on_error)(&error.extract_message());
        }
    }

    async fn update_all_profiles(&self) {
        // Promise.allSettled parity: run every URL update, surface one failure.
        let url_ids: Vec<String> = {
            let state = self.state.lock().await;
            state
                .profiles
                .iter()
                .filter(|profile| profile["source"]["type"].as_str() == Some("url"))
                .filter_map(|profile| profile["id"].as_str().map(str::to_string))
                .collect()
        };
        let mut results = Vec::new();
        for id in &url_ids {
            results.push((self.deps.profiles_arm)("profiles:update-from-source", id).await);
        }
        if let Some(Err(error)) = results.into_iter().find(|result| result.is_err()) {
            (self.deps.on_error)(&error.extract_message());
        }
    }

    /// Compose the menu tree (the TS `render()`), then hand it to the view.
    pub(crate) fn render_locked(&self, state: &mut TrayState) {
        if state.disposed {
            return;
        }
        self.view
            .set_tooltip(&tooltip_text(&self.deps.product_name, &state.status_phase));
        self.view.set_menu(render_menu(&self.deps.product_name, state));
    }
}

fn mode_menu(state: &TrayState, transition: bool) -> TrayMenuItem {
    TrayMenuItem::submenu(
        "outbound-mode",
        &format!("出站模式 · {}", mode_label(&state.mode)),
        state.status_phase == "running" && !transition,
        ["rule", "global", "direct"]
            .iter()
            .map(|mode| {
                TrayMenuItem::stateful(
                    &format!("outbound-mode:{mode}"),
                    mode_label(mode),
                    !transition,
                    state.mode == *mode,
                    true,
                )
            })
            .collect(),
    )
}

fn selectable_groups(state: &TrayState) -> Vec<(String, Value)> {
    let mut order: HashMap<String, usize> = HashMap::new();
    for (index, name) in state.group_order.iter().enumerate() {
        order.insert(name.clone(), index);
    }
    let mut groups: Vec<(String, Value)> = state
        .proxies
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(_, proxy)| {
                    SELECTABLE_GROUP_TYPES.contains(&proxy["type"].as_str().unwrap_or_default())
                        && proxy["all"].as_array().map(|all| !all.is_empty()).unwrap_or(false)
                })
                .map(|(name, proxy)| (name.clone(), proxy.clone()))
                .collect()
        })
        .unwrap_or_default();
    groups.sort_by_key(|(name, _)| order.get(name).copied().unwrap_or(usize::MAX));
    groups
}

fn group_menus(state: &TrayState, transition: bool) -> Vec<TrayMenuItem> {
    selectable_groups(state)
        .into_iter()
        .map(|(group, proxy)| {
            let selected = selected_member(&proxy);
            let label = selected
                .as_ref()
                .map(|member| format!("{group} · {member}"))
                .unwrap_or_else(|| group.clone());
            let children = proxy["all"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .filter_map(|member| member.as_str())
                        .map(|member| {
                            TrayMenuItem::stateful(
                                &format!("group:{group}\u{0}{member}"),
                                member,
                                !transition,
                                selected.as_deref() == Some(member),
                                true,
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            TrayMenuItem::submenu(&format!("group:{group}"), &label, !transition, children)
        })
        .collect()
}

fn process_menu(state: &TrayState) -> TrayMenuItem {
    let rows = process_rows(&state.connections);
    let count = state
        .connections["connections"]
        .as_array()
        .map(|items| items.len())
        .unwrap_or(0);
    let children = rows
        .iter()
        .enumerate()
        .map(|(index, (name, bytes))| {
            TrayMenuItem::normal(
                &format!("process:{index}"),
                &format!("{name} · {}", format_bytes(*bytes)),
                false,
            )
        })
        .collect();
    TrayMenuItem::submenu(
        "processes",
        &format!("进程与客户端 · {count} 个连接"),
        !rows.is_empty(),
        children,
    )
}

fn configuration_menu(state: &TrayState, transition: bool) -> TrayMenuItem {
    let active = state
        .profiles
        .iter()
        .find(|profile| profile["active"].as_bool() == Some(true));
    let active_is_url =
        active.and_then(|profile| profile["source"]["type"].as_str()) == Some("url");
    let url_ids: Vec<String> = state
        .profiles
        .iter()
        .filter(|profile| profile["source"]["type"].as_str() == Some("url"))
        .filter_map(|profile| profile["id"].as_str().map(str::to_string))
        .collect();
    let mut children = vec![
        TrayMenuItem::normal(
            "reload-config",
            "重新载入当前配置",
            active.is_some() && state.status_phase == "running" && !transition,
        ),
        TrayMenuItem::normal(
            if state.status_phase == "running" { "restart-kernel" } else { "start-kernel" },
            if state.status_phase == "running" { "重启内核" } else { "启动内核" },
            !transition,
        ),
    ];
    if !state.profiles.is_empty() {
        children.push(TrayMenuItem::separator());
        children.extend(state.profiles.iter().map(|profile| {
            TrayMenuItem::stateful(
                &format!("profile:{}", profile["id"].as_str().unwrap_or("")),
                profile["name"].as_str().unwrap_or(""),
                !transition,
                profile["active"].as_bool() == Some(true),
                true,
            )
        }));
    }
    if !url_ids.is_empty() {
        children.push(TrayMenuItem::separator());
        if let Some(active) = active {
            let id = active["id"].as_str().unwrap_or("");
            children.push(TrayMenuItem::normal(
                &format!("update-profile:{id}"),
                "更新当前订阅",
                active_is_url && !transition,
            ));
        }
        children.push(TrayMenuItem::normal(
            "update-all-profiles",
            "更新全部订阅",
            !url_ids.is_empty() && !transition,
        ));
    }
    TrayMenuItem::submenu("configuration", "配置", true, children)
}

fn directory_menu() -> TrayMenuItem {
    TrayMenuItem::submenu(
        "open-directory",
        "打开目录",
        true,
        vec![
            TrayMenuItem::normal("open-directory:application", "应用目录", true),
            TrayMenuItem::normal("open-directory:working", "工作目录", true),
            TrayMenuItem::normal("open-directory:kernel", "内核目录", true),
            TrayMenuItem::normal("open-directory:logs", "日志目录", true),
        ],
    )
}

/// Compose the menu tree (the TS `render()`), then hand it to the view.
/// Callers hold the state lock (internal + test seams only).

/// The tooltip line (`{product} · {phase label}`).
pub(crate) fn tooltip_text(product: &str, phase: &str) -> String {
    format!("{product} · {}", phase_label(phase))
}

/// The pure menu tree — everything the TS `render()` composes, independent of
/// any service, so the whole tree is unit-testable on state alone.
pub(crate) fn render_menu(product: &str, state: &TrayState) -> Vec<TrayMenuItem> {
    let phase = state.status_phase.clone();
    let transition = phase == "starting" || phase == "stopping" || state.busy;
    let system_proxy_busy =
        state.system_proxy_phase == "enabling" || state.system_proxy_phase == "restoring";
    let tun_busy = state.tun_phase == "starting" || state.tun_phase == "restoring";
    let mut menu = vec![
        TrayMenuItem::normal("show", "显示主窗口", true),
        TrayMenuItem::separator(),
        mode_menu(state, transition),
    ];
    menu.extend(group_menus(state, transition));
    menu.push(TrayMenuItem::separator());
    menu.push(TrayMenuItem::normal(
        "network-quality",
        &format!(
            "网络质量 · {}",
            match state.network_latency_ms {
                Some(ms) => format!("{ms} ms"),
                None => "—".to_string(),
            }
        ),
        false,
    ));
    menu.push(process_menu(state));
    menu.push(TrayMenuItem::separator());
    menu.push(TrayMenuItem::stateful(
        "system-proxy",
        "系统代理",
        state.system_proxy_supported && !system_proxy_busy && !transition,
        state.system_proxy_phase == "enabled",
        false,
    ));
    menu.push(TrayMenuItem::stateful(
        "tun",
        "TUN 模式",
        state.tun_supported && !tun_busy && !transition,
        state.tun_phase == "active",
        false,
    ));
    menu.push(TrayMenuItem::normal(
        "copy-terminal-proxy",
        "复制终端代理命令",
        state.status_phase == "running" && state.mixed_port.is_some(),
    ));
    menu.push(TrayMenuItem::separator());
    menu.push(configuration_menu(state, transition));
    menu.push(directory_menu());
    menu.push(TrayMenuItem::normal("check-update", "检查更新", true));
    menu.push(TrayMenuItem::separator());
    menu.push(TrayMenuItem::normal("quit", &format!("退出 {product}"), true));
    menu
}

// ---------------------------------------------------------------------------
// Composition-root wiring (the tray-adapter.ts construction block)
// ---------------------------------------------------------------------------

use tauri::Manager;

/// The runtime accent contract (shared/runtime-accent.ts): TUN wins while it
/// owns the network path; a verified system proxy wins otherwise.
pub(crate) fn resolve_runtime_accent(system_proxy_phase: &str, tun_phase: &str) -> &'static str {
    if tun_phase == "active" {
        "tun"
    } else if system_proxy_phase == "enabled" {
        "proxy"
    } else {
        "idle"
    }
}

fn reveal_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The tray icon root, mirroring the TS adapter: dev uses the checkout's
/// `resources/tray`, a packaged build uses the bundled resource directory
/// (`bundle.resources` ships `resources/tray/*.png`).
fn tray_icon_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        std::env::current_dir()
            .map(|dir| dir.join("resources").join("tray"))
            .unwrap_or_else(|_| std::path::PathBuf::from("resources/tray"))
    } else {
        app.path()
            .resource_dir()
            .unwrap_or_default()
            .join("resources")
            .join("tray")
    }
}

fn open_file_manager(target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(target)
        .spawn()
        .map_err(|error| error.to_string())
        .map(|_| ())
}

/// Build the controller + native view, subscribe every status source, and
/// start the bounded refresh cadence. Returns the error of a failed native
/// tray (the caller logs it and continues tray-less).
pub(crate) fn wire_tray(app: tauri::AppHandle) -> Result<(), tauri::Error> {
    let kernel: Arc<crate::kernel::KernelServices> = app.state::<Arc<crate::kernel::KernelServices>>().inner().clone();
    let system_proxy: Arc<crate::system_proxy::SystemProxyService> = app.state::<Arc<crate::system_proxy::SystemProxyService>>().inner().clone();
    let tun: Arc<crate::tun::TunCoordinator> = app.state::<Arc<crate::tun::TunCoordinator>>().inner().clone();
    let profiles: Arc<crate::profile_service::ProfilesService> = app.state::<Arc<crate::profile_service::ProfilesService>>().inner().clone();
    let overrides: Arc<crate::override_service::OverrideService> = app.state::<Arc<crate::override_service::OverrideService>>().inner().clone();
    let models: Arc<crate::enhancements::ModelStores> = app.state::<Arc<crate::enhancements::ModelStores>>().inner().clone();
    let mihomo: Arc<crate::mihomo::MihomoServices> = app.state::<Arc<crate::mihomo::MihomoServices>>().inner().clone();
    let updates: Arc<crate::updates::UpdateService> = app.state::<Arc<crate::updates::UpdateService>>().inner().clone();
    let usage: Arc<crate::usage::UsageHistoryService> = app.state::<Arc<crate::usage::UsageHistoryService>>().inner().clone();
    let desktop: Arc<crate::icons::DesktopServices> = app.state::<Arc<crate::icons::DesktopServices>>().inner().clone();
    let metadata: Arc<crate::network_metadata::NetworkMetadataService> = app.state::<Arc<crate::network_metadata::NetworkMetadataService>>().inner().clone();
    let startup: Arc<crate::startup::StartupService> = app.state::<Arc<crate::startup::StartupService>>().inner().clone();
    let substore: Arc<crate::substore::SubStoreService> = app.state::<Arc<crate::substore::SubStoreService>>().inner().clone();
    let settings: Arc<crate::settings::SettingsStore> = app.state::<Arc<crate::settings::SettingsStore>>().inner().clone();
    let paths: crate::paths::AppPaths = app.state::<crate::paths::AppPaths>().inner().clone();

    let view: Arc<dyn TrayView> = Arc::new(
        crate::tray_view::NativeTrayView::create(app.clone(), Some(tray_icon_root(&app)))?,
    );

    let deps = TrayDeps {
        product_name: crate::brand::load_brand()
            .map(|brand| brand.product_name)
            .unwrap_or_else(|_| "Murge".to_string()),
        kernel: kernel.clone(),
        system_proxy: system_proxy.clone(),
        tun: tun.clone(),
        profiles: profiles.clone(),
        models: models.clone(),
        mihomo: mihomo.clone(),
        resolve_group_order: {
            let profiles = profiles.clone();
            let overrides = overrides.clone();
            let models = models.clone();
            Box::new(move || {
                let profile = match profiles.get_active() {
                    Ok(profile) if !profile.is_null() => profile,
                    _ => return Vec::new(),
                };
                let document = profile["document"].as_str().unwrap_or_default().to_string();
                let profile_id = profile["meta"]["id"].as_str().unwrap_or_default().to_string();
                let Ok(overridden) = overrides.apply_for_profile(&document, Some(&profile_id)) else {
                    return Vec::new();
                };
                let dns = crate::enhancements::coerce_dns_enhancement(&models.dns.get());
                let (dns_text, _) = crate::inspection::apply_dns_to_document(&overridden, &dns);
                let sniffer = crate::enhancements::coerce_sniffer_enhancement(&models.sniffer.get());
                let (text, _) = crate::inspection::apply_sniffer_to_document(&dns_text, &sniffer);
                crate::profile_parse::parse_proxy_group_order(&text)
            })
        },
        reload_config: {
            let models = models.clone();
            let mihomo = mihomo.clone();
            let profiles = profiles.clone();
            let overrides = overrides.clone();
            let kernel = kernel.clone();
            Box::new(move || {
                let models = models.clone();
                let mihomo = mihomo.clone();
                let profiles = profiles.clone();
                let overrides = overrides.clone();
                let kernel = kernel.clone();
                Box::pin(async move {
                    // updateRuntimeConfig parity: the gate serializes the live
                    // reload; a replay follows a successful apply.
                    let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
                    let reloader = crate::live_config::LiveConfigReloader::from_ipc(
                        &kernel.supervisor,
                        &models,
                        &profiles,
                        &overrides,
                    )?;
                    let applied = reloader.reload_if_running().await?;
                    if applied {
                        let client = client_for(&models)?;
                        let active = profiles.get_active().ok().and_then(|profile| {
                            profile["meta"]["id"].as_str().map(str::to_string)
                        });
                        if let Some(active) = active {
                            let _ = mihomo.restore_selections(&client, Some(active)).await;
                        }
                    }
                    Ok(())
                })
            })
        },
        restart_kernel: {
            let models = models.clone();
            let mihomo = mihomo.clone();
            let profiles = profiles.clone();
            let overrides = overrides.clone();
            let kernel = kernel.clone();
            let system_proxy = system_proxy.clone();
            Box::new(move || {
                let models = models.clone();
                let mihomo = mihomo.clone();
                let profiles = profiles.clone();
                let overrides = overrides.clone();
                let kernel = kernel.clone();
                let system_proxy = system_proxy.clone();
                Box::pin(async move {
                    // reloadProfile(reloadKernelForActiveProfile) parity: the
                    // ordered restart inside the gate, then the replay.
                    let _gate = crate::kernel::RUNTIME_UPDATE.lock().await;
                    crate::live_config::reload_active_profile_with_rollback(
                        &profiles,
                        &overrides,
                        &models,
                        &kernel,
                        &system_proxy,
                        None,
                    )
                    .await?;
                    let client = client_for(&models)?;
                    let active = profiles
                        .get_active()
                        .ok()
                        .and_then(|profile| profile["meta"]["id"].as_str().map(str::to_string));
                    if let Some(active) = active {
                        let _ = mihomo.restore_selections(&client, Some(active)).await;
                    }
                    Ok(())
                })
            })
        },
        tun_desired: {
            let settings = settings.clone();
            let profiles = profiles.clone();
            let overrides = overrides.clone();
            let models = models.clone();
            let usage = usage.clone();
            let kernel = kernel.clone();
            let mihomo = mihomo.clone();
            let desktop = desktop.clone();
            let metadata = metadata.clone();
            let startup = startup.clone();
            let substore = substore.clone();
            let system_proxy = system_proxy.clone();
            let tun = tun.clone();
            let updates = updates.clone();
            let paths = paths.clone();
            Box::new(move |enable| {
                let settings = settings.clone();
                let profiles = profiles.clone();
                let overrides = overrides.clone();
                let models = models.clone();
                let usage = usage.clone();
                let kernel = kernel.clone();
                let mihomo = mihomo.clone();
                let desktop = desktop.clone();
                let metadata = metadata.clone();
                let startup = startup.clone();
                let substore = substore.clone();
                let system_proxy = system_proxy.clone();
                let tun = tun.clone();
                let updates = updates.clone();
                let paths = paths.clone();
                Box::pin(async move {
                    let channel = if enable { "tun:enable" } else { "tun:disable" };
                    crate::ipc::dispatch(
                        channel,
                        &serde_json::json!([]),
                        &paths,
                        &settings,
                        &profiles,
                        &overrides,
                        &models,
                        &usage,
                        &kernel,
                        &mihomo,
                        &desktop,
                        &metadata,
                        &startup,
                        &substore,
                        &system_proxy,
                        &tun,
                        &updates,
                    )
                    .await
                })
            })
        },
        profiles_arm: {
            let settings = settings.clone();
            let profiles = profiles.clone();
            let overrides = overrides.clone();
            let models = models.clone();
            let usage = usage.clone();
            let kernel = kernel.clone();
            let mihomo = mihomo.clone();
            let desktop = desktop.clone();
            let metadata = metadata.clone();
            let startup = startup.clone();
            let substore = substore.clone();
            let system_proxy = system_proxy.clone();
            let tun = tun.clone();
            let updates = updates.clone();
            let paths = paths.clone();
            Box::new(move |channel, id| {
                let settings = settings.clone();
                let profiles = profiles.clone();
                let overrides = overrides.clone();
                let models = models.clone();
                let usage = usage.clone();
                let kernel = kernel.clone();
                let mihomo = mihomo.clone();
                let desktop = desktop.clone();
                let metadata = metadata.clone();
                let startup = startup.clone();
                let substore = substore.clone();
                let system_proxy = system_proxy.clone();
                let tun = tun.clone();
                let updates = updates.clone();
                let paths = paths.clone();
                let channel = channel.to_string();
                let id = id.to_string();
                Box::pin(async move {
                    crate::ipc::dispatch(
                        &channel,
                        &serde_json::json!([id]),
                        &paths,
                        &settings,
                        &profiles,
                        &overrides,
                        &models,
                        &usage,
                        &kernel,
                        &mihomo,
                        &desktop,
                        &metadata,
                        &startup,
                        &substore,
                        &system_proxy,
                        &tun,
                        &updates,
                    )
                    .await
                })
            })
        },
        on_check_update: {
            let updates = updates.clone();
            Box::new(move || {
                let updates = updates.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = updates.check().await {
                        eprintln!("[updates] tray check failed: {}", error.extract_message());
                    }
                });
            })
        },
        show_window: {
            let app = app.clone();
            Box::new(move || reveal_window(&app))
        },
        quit: {
            let app = app.clone();
            Box::new(move || {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::lifecycle::begin_application_shutdown(app, false).await;
                });
            })
        },
        open_directory: Box::new(|directory| {
            // The tray-adapter directory map (application/working/kernel/logs).
            let target = match directory {
                "application" => {
                    return std::env::current_exe()
                        .ok()
                        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
                        .ok_or_else(|| "unable to resolve the application directory".to_string())
                        .and_then(|dir| open_file_manager(&dir));
                }
                "working" => match crate::paths::AppPaths::probe().app_data_root {
                    Some(root) => root,
                    None => return Err("no working directory in dev".to_string()),
                },
                "kernel" => match crate::paths::AppPaths::probe().kernel_root() {
                    Some(root) => root,
                    None => return Err("no kernel directory in dev".to_string()),
                },
                "logs" => match crate::paths::AppPaths::probe().app_data_root {
                    Some(root) => root.join("logs"),
                    None => return Err("no log directory in dev".to_string()),
                },
                _ => return Err(format!("unknown tray directory: {directory}")),
            };
            open_file_manager(&target)
        }),
        copy_text: Box::new(|value| {
            // Best-effort clipboard write (the TS `clipboard.writeText`).
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(value);
            }
        }),
        on_error: Box::new(|error| eprintln!("[tray] kernel action failed: {error}")),
    };

    let controller = Arc::new(TrayController::new(deps, view.clone()));

    // Menu events -> actions (muda: ONE id dispatcher; Electron: per-item
    // click closures).
    let controller_for_menu = controller.clone();
    app.on_menu_event(move |_app, event| {
        let controller = controller_for_menu.clone();
        let id = event.id().0.clone();
        tauri::async_runtime::spawn(async move {
            controller.handle_menu(&id).await;
        });
    });

    // Status listeners re-render immediately (the TS onStatus subscribers).
    {
        let controller = controller.clone();
        kernel.supervisor.status_listeners.subscribe(Arc::new(move |status| {
            let controller = controller.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                controller.on_kernel_status(&status).await;
            });
        }));
    }
    {
        let controller = controller.clone();
        system_proxy.listeners.subscribe(Arc::new(move |status| {
            let controller = controller.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                controller.on_system_proxy_status(&status).await;
            });
        }));
    }
    tun.subscribe({
        let controller = controller.clone();
        Arc::new(move |status| {
            let controller = controller.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                controller.on_tun_status(&status).await;
            });
        })
    });

    // The refresh cadence stands in for the TS onMenuOpen hook (Tauri has no
    // menu-open event): the menu the OS draws is the latest snapshot. Each
    // tick also recomputes the runtime accent (the TS
    // updateRuntimeAppearance) so the icon follows proxy/TUN phases.
    tauri::async_runtime::spawn(async move {
        loop {
            controller.refresh().await;
            let accent = {
                let proxy = controller.deps.system_proxy.get_status();
                let tun = controller.deps.tun.get_status_value();
                resolve_runtime_accent(
                    proxy.phase.as_str(),
                    tun["phase"].as_str().unwrap_or("unsupported"),
                )
            };
            // Dark is the notification-area default (matches the view's
            // initial paint; Windows tray glyphs are theme-stable here).
            view.set_runtime_appearance(accent, true);
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The pure render/menu/label helpers need no services; TrayDeps is only
    // constructed by the composition root (wire_tray), so no test-side deps
    // exist here — TrayDeps remains fully exercised through its typed fields.
    #[allow(dead_code)]
    fn _deps_fields_covered() {
        let _tun: Box<dyn Fn(bool) -> BoxFuture<'static, Result<Value, IpcError>> + Send + Sync> =
            Box::new(|_| Box::pin(async { Ok(Value::Null) }));
    }

    fn state() -> TrayState {
        TrayState {
            status_phase: "stopped".to_string(),
            system_proxy_phase: "unsupported".to_string(),
            tun_phase: "unsupported".to_string(),
            mode: "rule".to_string(),
            ..TrayState::default()
        }
    }

    fn flat_labels(items: &[TrayMenuItem], out: &mut Vec<(String, bool, bool)>) {
        for item in items {
            if item.kind == MenuKind::Separator {
                continue;
            }
            out.push((item.label.clone(), item.checked, item.enabled));
            flat_labels(&item.children, out);
        }
    }

    fn labels_of(state: &TrayState) -> Vec<(String, bool, bool)> {
        let mut out = Vec::new();
        flat_labels(&render_menu("Murge", state), &mut out);
        out
    }

    #[test]
    fn format_bytes_matches_the_ts_contract() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(format_bytes(3 * 1024u64.pow(3)), "3.0 GB");
    }

    #[test]
    fn phase_and_mode_labels_are_byte_exact() {
        assert_eq!(phase_label("stopped"), "已停止");
        assert_eq!(phase_label("starting"), "正在启动");
        assert_eq!(phase_label("running"), "运行中");
        assert_eq!(phase_label("stopping"), "正在停止");
        assert_eq!(phase_label("failed"), "启动失败");
        assert_eq!(phase_label("anything-else"), "已停止");
        assert_eq!(mode_label("rule"), "规则");
        assert_eq!(mode_label("global"), "全局");
        assert_eq!(mode_label("direct"), "直连");
        assert_eq!(mode_label("unknown"), "规则");
    }

    #[test]
    fn tooltip_pairs_product_with_phase_label() {
        assert_eq!(tooltip_text("Murge", "running"), "Murge · 运行中");
        assert_eq!(tooltip_text("Murge", "stopped"), "Murge · 已停止");
    }

    #[test]
    fn fixed_selection_wins_over_now() {
        assert_eq!(selected_member(&json!({"fixed": "A", "now": "B"})), Some("A".to_string()));
        assert_eq!(selected_member(&json!({"fixed": "", "now": "B"})), Some("B".to_string()));
        assert_eq!(selected_member(&json!({"now": "B"})), Some("B".to_string()));
        assert_eq!(selected_member(&json!({})), None);
    }

    #[test]
    fn process_rows_rank_merge_and_cap_at_twelve() {
        let connections = json!({
            "connections": [
                {"metadata": {"process": "chrome "}, "upload": 100, "download": 300},
                {"metadata": {"process": ""}, "upload": 10, "download": 10},
                {"metadata": {}, "upload": 5, "download": 5}
            ]
        });
        let rows = process_rows(&connections);
        assert_eq!(rows[0], ("chrome".to_string(), 400));
        // The unnamed processes merge under the same 未知进程 row.
        assert_eq!(rows[1], ("未知进程".to_string(), 30));
        assert_eq!(rows.len(), 2);

        let many = json!({"connections": (0..15)
            .map(|i| json!({"metadata": {"process": format!("p{i:02}")}, "upload": 15 - i, "download": 0}))
            .collect::<Vec<_>>()});
        let rows = process_rows(&many);
        assert_eq!(rows.len(), 12);
        assert_eq!(rows[0], ("p00".to_string(), 15));
        assert_eq!(rows[11], ("p11".to_string(), 4));
    }

    #[test]
    fn accent_resolution_follows_tun_then_proxy() {
        assert_eq!(resolve_runtime_accent("enabled", "active"), "tun");
        assert_eq!(resolve_runtime_accent("enabled", "inactive"), "proxy");
        assert_eq!(resolve_runtime_accent("disabled", "inactive"), "idle");
    }

    #[test]
    fn only_selectable_group_types_with_members_render() {
        let mut state = state();
        state.status_phase = "running".to_string();
        state.proxies = json!({
            "Selector 组": {"type": "Selector", "now": "香港 01", "all": ["香港 01", "日本 02"]},
            "URLTest 组": {"type": "URLTest", "fixed": "美国 03", "all": ["美国 03", "香港 01"]},
            "Empty 组": {"type": "Selector", "now": "x", "all": []},
            "Direct": {"type": "Direct", "now": "DIRECT"}
        });
        state.group_order = vec!["URLTest 组".to_string(), "Selector 组".to_string()];
        let labels = labels_of(&state);
        // Order follows the enhanced document (URLTest 组 first), Direct and
        // the empty group never render.
        let url_index = labels.iter().position(|(label, _, _)| label == "URLTest 组 · 美国 03").unwrap();
        let selector_index = labels.iter().position(|(label, _, _)| label == "Selector 组 · 香港 01").unwrap();
        assert!(url_index < selector_index);
        assert!(!labels.iter().any(|(label, _, _)| label == "Direct · DIRECT"));
        assert!(!labels.iter().any(|(label, _, _)| label.starts_with("Empty 组")));
        // The fixed selection drives the checked member.
        let checked_us = labels.iter().any(|(label, checked, _)| label == "美国 03" && *checked);
        assert!(checked_us);
    }

    #[test]
    fn render_paints_the_full_menu_tree_from_state() {
        let mut state = state();
        state.status_phase = "running".to_string();
        state.system_proxy_phase = "enabled".to_string();
        state.system_proxy_supported = true;
        state.tun_phase = "inactive".to_string();
        state.tun_supported = true;
        state.mode = "global".to_string();
        state.mixed_port = Some(7897);
        state.proxies = json!({
            "🚀 节点选择": {"type": "Selector", "now": "香港 01", "all": ["香港 01", "日本 02"]}
        });
        state.group_order = vec!["🚀 节点选择".to_string()];
        state.profiles = vec![
            json!({"id": "p1", "name": "Home", "active": true, "source": {"type": "url"}, "createdAt": 1, "updatedAt": 5}),
            json!({"id": "p2", "name": "Work", "active": false, "source": {"type": "local"}, "createdAt": 2, "updatedAt": 2}),
        ];
        state.connections = json!({"connections": [
            {"metadata": {"process": "chrome"}, "upload": 100, "download": 300}
        ]});
        state.network_latency_ms = Some(42);

        let labels = labels_of(&state);
        assert_eq!(labels[0], ("显示主窗口".to_string(), false, true));
        assert!(labels.iter().any(|(label, _, _)| label == "出站模式 · 全局"));
        assert!(labels.iter().any(|(label, checked, _)| label == "全局" && *checked));
        assert!(labels.iter().any(|(label, _, _)| label == "🚀 节点选择 · 香港 01"));
        assert!(labels.iter().any(|(label, _, _)| label == "网络质量 · 42 ms"));
        assert!(labels.iter().any(|(label, _, _)| label == "chrome · 400 B"));
        assert!(labels.iter().any(|(label, _, _)| label == "进程与客户端 · 1 个连接"));
        assert!(labels.iter().any(|(label, checked, _)| label == "系统代理" && *checked));
        assert!(labels.iter().any(|(label, checked, _)| label == "TUN 模式" && !checked));
        assert!(labels.iter().any(|(label, _, _)| label == "复制终端代理命令"));
        assert!(labels.iter().any(|(label, _, _)| label == "重新载入当前配置"));
        assert!(labels.iter().any(|(label, _, _)| label == "重启内核"));
        assert!(labels.iter().any(|(label, checked, _)| label == "Home" && *checked));
        assert!(labels.iter().any(|(label, checked, _)| label == "Work" && !checked));
        assert!(labels.iter().any(|(label, _, _)| label == "更新当前订阅"));
        assert!(labels.iter().any(|(label, _, _)| label == "更新全部订阅"));
        assert!(labels.iter().any(|(label, _, _)| label == "应用目录"));
        assert!(labels.iter().any(|(label, _, _)| label == "日志目录"));
        assert!(labels.iter().any(|(label, _, _)| label == "检查更新"));
        assert!(labels.iter().any(|(label, _, _)| label == "退出 Murge"));
    }

    #[test]
    fn transitional_phases_and_busy_disable_runtime_controls() {
        let mut starting = state();
        starting.status_phase = "starting".to_string();
        starting.mode = "rule".to_string();
        let labels = labels_of(&starting);
        let mode_item = labels.iter().find(|(label, _, _)| label == "出站模式 · 规则").unwrap();
        assert!(!mode_item.2, "outbound-mode disabled while starting");
        let kernel_item = labels.iter().find(|(label, _, _)| label == "启动内核").unwrap();
        assert!(!kernel_item.2);
        fn has_id(items: &[TrayMenuItem], id: &str) -> bool {
            items
                .iter()
                .any(|item| item.id == id || has_id(&item.children, id))
        }
        assert!(has_id(&render_menu("Murge", &starting), "start-kernel"));

        let mut busy = starting;
        busy.status_phase = "running".to_string();
        busy.busy = true;
        let labels = labels_of(&busy);
        let mode_item = labels.iter().find(|(label, _, _)| label == "出站模式 · 规则").unwrap();
        assert!(!mode_item.2, "outbound-mode disabled while busy");

        let mut stopping = state();
        stopping.status_phase = "stopping".to_string();
        stopping.mode = "rule".to_string();
        let item = labels_of(&stopping)
            .iter()
            .find(|(label, _, _)| label.starts_with("出站模式"))
            .expect("the outbound-mode submenu always renders")
            .2;
        assert!(!item, "outbound-mode disabled while stopping");
    }

    #[test]
    fn stopped_kernel_clears_runtime_dependent_rows() {
        let mut state = state();
        state.status_phase = "stopped".to_string();
        state.proxies = json!({"stale": {"type": "Selector", "now": "x", "all": ["x", "y"]}});
        state.connections = Value::Null;
        state.network_latency_ms = None;
        state.mixed_port = Some(7897);
        state.mode = "global".to_string();
        let labels = labels_of(&state);
        assert!(labels.iter().any(|(label, _, _)| label == "网络质量 · —"));
        assert!(labels.iter().any(|(label, _, _)| label == "进程与客户端 · 0 个连接"));
        let mode_item = labels.iter().find(|(label, _, _)| label.starts_with("出站模式")).unwrap();
        assert!(!mode_item.2, "outbound-mode disabled while stopped");
        assert!(labels.iter().any(|(label, _, enabled)| label == "复制终端代理命令" && !enabled));
        assert!(labels.iter().any(|(label, _, _)| label == "启动内核"));
    }

    #[test]
    fn unsupported_platforms_disable_the_platform_toggles() {
        let mut state = state();
        state.status_phase = "running".to_string();
        state.system_proxy_phase = "unsupported".to_string();
        state.system_proxy_supported = false;
        state.tun_phase = "unsupported".to_string();
        state.tun_supported = false;
        let labels = labels_of(&state);
        assert!(labels.iter().any(|(label, _, enabled)| label == "系统代理" && !enabled));
        assert!(labels.iter().any(|(label, _, enabled)| label == "TUN 模式" && !enabled));
    }

    #[test]
    fn active_url_profile_enables_the_update_entries() {
        let mut state = state();
        state.status_phase = "running".to_string();
        state.profiles = vec![json!({"id": "p1", "name": "Home", "active": true, "source": {"type": "url"}, "createdAt": 1, "updatedAt": 5})];
        let labels = labels_of(&state);
        assert!(labels.iter().any(|(label, _, enabled)| label == "更新当前订阅" && *enabled));
        assert!(labels.iter().any(|(label, _, enabled)| label == "更新全部订阅" && *enabled));

        let mut local = state;
        local.profiles = vec![json!({"id": "p2", "name": "Local", "active": true, "source": {"type": "local"}, "createdAt": 1, "updatedAt": 5})];
        let labels = labels_of(&local);
        assert!(!labels.iter().any(|(label, _, _)| label == "更新当前订阅"));
        assert!(!labels.iter().any(|(label, _, _)| label == "更新全部订阅"));
    }
}
