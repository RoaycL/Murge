//! TUN lifecycle coordinator — the Rust mirror of `src/main/tun/*` and the
//! `tun:*` IPC surface.
//!
//! The decision machine (state machine, serialization, audit evidence) ports
//! completely; the privileged mutation stays behind the injected
//! `TunMutationAdapter` seam. The production adapter is the fail-closed
//! `GatedTunMutationAdapter` exactly like this Electron build — "Windows TUN
//! service transport is not available in this build" — so the honest boundary
//! (no fake Wintun calls) is preserved until the G1 helper design review
//! lands.

use crate::error::{code, IpcError};
use crate::events::EventHub;
use futures_util::future::BoxFuture;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

// ---------------------------------------------------------------------------
// Shared contract (src/shared/tun.ts)
// ---------------------------------------------------------------------------

/// Non-fatal: controller enable succeeded, but public reachability was not proven.
#[allow(dead_code)] // consumed by the readiness surface + renderer copy
pub const TUN_DATA_PLANE_UNCONFIRMED: &str = "TUN_DATA_PLANE_UNCONFIRMED";

/// Renderer-visible lifecycle status (`src/shared/tun.ts` TunStatus).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunStatus {
    pub supported: bool,
    pub phase: String,
    pub error_message: Option<String>,
    pub conflict_detail: Option<String>,
    pub updated_at: Option<String>,
}

/// Phase 9B renderer-safe intent: no privileged paths, no OS mutations.
#[allow(dead_code)] // the adapter seam consumes it when the gate lifts
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MihomoOwnedTunIntent {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub device: String,
    pub stack: String,
}

/// Machine-code lifecycle evidence entry (threat model T07: never secrets).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunAuditEntry {
    pub sequence: u64,
    pub at: String,
    pub event: String,
    pub phase: String,
    pub detail_code: Option<String>,
}

// ---------------------------------------------------------------------------
// Audit log (tun/audit-log.ts) — in-memory diagnostic evidence only
// ---------------------------------------------------------------------------

const DETAIL_CODE_PREFIX_OK: fn(&str) -> bool = |detail: &str| {
    detail.len() >= 1
        && detail.len() <= 128
        && detail.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
};

/// It accepts machine codes, never arbitrary config or secret text.
pub struct TunAuditLog {
    entries: Mutex<AuditState>,
}

struct AuditState {
    entries: Vec<TunAuditEntry>,
    bytes: usize,
    sequence: u64,
}

#[allow(dead_code)] // snapshot/len/is_empty are the diagnostics surface
impl TunAuditLog {
    pub fn new() -> Self {
        TunAuditLog { entries: Mutex::new(AuditState { entries: Vec::new(), bytes: 0, sequence: 0 }) }
    }

    pub fn append(&self, event: &str, phase: &str, detail_code: Option<&str>) -> Result<(), String> {
        if let Some(detail) = detail_code {
            if !DETAIL_CODE_PREFIX_OK(detail) {
                return Err("TUN audit detailCode must be a bounded machine code".to_string());
            }
        }
        let mut state = self.entries.lock().expect("tun audit poisoned");
        let entry = TunAuditEntry {
            sequence: state.sequence,
            at: crate::system_proxy::now_iso(),
            event: event.to_string(),
            phase: phase.to_string(),
            detail_code: detail_code.map(str::to_string),
        };
        state.sequence += 1;
        state.bytes += serde_json::to_vec(&entry).map(|bytes| bytes.len()).unwrap_or(0);
        state.entries.push(entry);
        const MAX_BYTES: usize = 128 * 1024;
        const MAX_ENTRIES: usize = 1000;
        while !state.entries.is_empty()
            && (state.entries.len() > MAX_ENTRIES || state.bytes > MAX_BYTES)
        {
            let removed = state.entries.remove(0);
            state.bytes -= serde_json::to_vec(&removed).map(|bytes| bytes.len()).unwrap_or(0);
        }
        Ok(())
    }

    pub fn snapshot(&self, limit: usize) -> Vec<TunAuditEntry> {
        let state = self.entries.lock().expect("tun audit poisoned");
        state.entries.iter().skip(state.entries.len().saturating_sub(limit)).cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.entries.lock().expect("tun audit poisoned").entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for TunAuditLog {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// State machine (tun/state-machine.ts) — the pure transition function
// ---------------------------------------------------------------------------

/// The one invalid-transition copy (the TS ProtocolError message).
const INVALID_TRANSITION_PREFIX: &str = "Invalid TUN transition: ";

/// Map a phase + intent to the next phase (the TRANSITIONS table), or None
/// when the combination is illegal.
fn transition_table(phase: &str, intent: &str) -> Option<&'static str> {
    match (phase, intent) {
        ("configured", "initialize") => Some("configured"),
        ("configured", "enable") => Some("starting"),
        ("configured", "unsupported") => Some("unsupported"),
        ("starting", "enabled") => Some("active"),
        ("starting", "disable") => Some("restoring"),
        ("starting", "fail") => Some("restoring"),
        ("starting", "fatal") => Some("failed"),
        ("starting", "conflict") => Some("conflict"),
        ("active", "disable") => Some("restoring"),
        ("active", "fail") => Some("restoring"),
        ("active", "fatal") => Some("failed"),
        ("active", "conflict") => Some("conflict"),
        ("restoring", "restored") => Some("configured"),
        ("restoring", "fail") => Some("restore-failed"),
        ("restoring", "conflict") => Some("conflict"),
        ("failed", "enable") => Some("starting"),
        ("failed", "disable") => Some("restoring"),
        ("failed", "unsupported") => Some("unsupported"),
        // `conflict` is NOT terminal: disabling re-runs the restore path,
        // which reconciles first — the only user-facing way out.
        ("conflict", "disable") => Some("restoring"),
        ("unsupported", "initialize") => Some("unsupported"),
        // `restore-failed` may retry the enable: the previous mode switch
        // already stopped the main kernel.
        ("restore-failed", "enable") => Some("starting"),
        ("restore-failed", "disable") => Some("restoring"),
        _ => None,
    }
}

pub fn initial_tun_status(supported: bool) -> TunStatus {
    TunStatus {
        supported,
        phase: if supported { "configured" } else { "unsupported" }.to_string(),
        error_message: None,
        conflict_detail: None,
        updated_at: None,
    }
}

/// Pure transition function. It cannot activate a helper or mutate networking.
pub fn transition_tun_status(
    status: &TunStatus,
    intent: &str,
    error_message: Option<&str>,
    conflict_detail: Option<&str>,
) -> Result<TunStatus, IpcError> {
    let Some(next) = transition_table(&status.phase, intent) else {
        return Err(IpcError::code(
            code::TUN_INVALID_TRANSITION,
            format!("{INVALID_TRANSITION_PREFIX}{phase} + {intent}", phase = status.phase),
        ));
    };
    if next == "conflict" && conflict_detail.is_none() && status.conflict_detail.is_none() {
        return Err(IpcError::invalid_argument("TUN conflict transition requires conflictDetail"));
    }
    Ok(TunStatus {
        supported: next != "unsupported",
        phase: next.to_string(),
        error_message: error_message
            .map(str::to_string)
            .or_else(|| {
                if next == "failed" || next == "restore-failed" {
                    status.error_message.clone()
                } else {
                    None
                }
            }),
        conflict_detail: if next == "conflict" {
            conflict_detail.map(str::to_string).or_else(|| status.conflict_detail.clone())
        } else {
            None
        },
        updated_at: Some(crate::system_proxy::now_iso()),
    })
}

// ---------------------------------------------------------------------------
// Mutation adapter seam (tun/coordinator.ts TunMutationAdapter)
// ---------------------------------------------------------------------------

pub type BoxFut<'a, T> = BoxFuture<'a, T>;

/// Enable outcomes (the TS discriminated union).
#[allow(dead_code)] // adapter seam vocabulary
pub enum TunEnableResult {
    Active {
        readiness: Option<BoxFut<'static, Result<(), String>>>,
    },
    RollbackRequired { error_message: String },
    Conflict { conflict_detail: String },
}

impl std::fmt::Debug for TunEnableResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunEnableResult::Active { readiness: has } => {
                formatter.write_str(if has.is_some() { "Active{readiness}" } else { "Active" })
            }
            TunEnableResult::RollbackRequired { error_message } => {
                write!(formatter, "RollbackRequired({error_message})")
            }
            TunEnableResult::Conflict { conflict_detail } => {
                write!(formatter, "Conflict({conflict_detail})")
            }
        }
    }
}

#[allow(dead_code)] // adapter seam vocabulary
#[derive(Debug)]
pub enum TunRestoreResult {
    Restored,
    RestoreFailed { error_message: String },
    Conflict { conflict_detail: String },
}

/// Privileged operations are injected here. The production implementation
/// stays gated until G1 and the helper design review are complete.
#[allow(dead_code)] // the seam vocabulary; the coordinator consumes it via Arc
pub trait TunMutationAdapter: Send + Sync {
    fn recovery_required(&self) -> BoxFut<'_, bool>;
    fn enable(&self, intent: &MihomoOwnedTunIntent) -> BoxFut<'_, Result<TunEnableResult, IpcError>>;
    fn restore(&self) -> BoxFut<'_, Result<TunRestoreResult, IpcError>>;
    /// The live owned session's mixed-port, when the implementation runs one.
    fn get_active_runtime(&self) -> Option<u16> {
        None
    }
}

/// Fail-closed production placeholder. It performs no I/O or OS mutation.
pub struct GatedTunMutationAdapter;

impl TunMutationAdapter for GatedTunMutationAdapter {
    fn recovery_required(&self) -> BoxFut<'_, bool> {
        Box::pin(async move { false })
    }

    fn enable(&self, _intent: &MihomoOwnedTunIntent) -> BoxFut<'_, Result<TunEnableResult, IpcError>> {
        Box::pin(async move {
            Err(IpcError::code(
                code::TUN_IMPLEMENTATION_GATED,
                "Windows TUN service transport is not available in this build",
            ))
        })
    }

    fn restore(&self) -> BoxFut<'_, Result<TunRestoreResult, IpcError>> {
        Box::pin(async move {
            Err(IpcError::code(
                code::TUN_IMPLEMENTATION_GATED,
                "Windows TUN service transport is not available in this build",
            ))
        })
    }
}

/// The TS `machineMessage`: a ProtocolError carries its code as the machine
/// message; anything else collapses to the generic code.
fn machine_message(error: &IpcError) -> String {
    let (machine_code, _) = error.parts();
    machine_code.to_string()
}

// ---------------------------------------------------------------------------
// Coordinator (tun/coordinator.ts)
// ---------------------------------------------------------------------------

/// Serial, renderer-independent lifecycle orchestration. This class never
/// calls Wintun, COM, routing or DNS APIs itself; tests inject a
/// deterministic fake. Clones share ONE core (the managed handle + the
/// readiness task observe the same state).
#[derive(Clone)]
pub struct TunCoordinator {
    inner: Arc<TunCoordinatorInner>,
}

#[allow(dead_code)] // enable/parse/generation are the IPC + readiness surface
struct TunCoordinatorInner {
    adapter: Arc<dyn TunMutationAdapter>,
    status: Mutex<TunStatus>,
    queue: tokio::sync::Mutex<()>,
    readiness_generation: AtomicUsize,
    pub listeners: EventHub,
    audit: TunAuditLog,
}

// initialize/emergency_disable/handle_host_exit/get_active_mixed_port wire
// into startup reconciliation, before-quit and the system-proxy TUN probe.
#[allow(dead_code)]
impl TunCoordinator {
    pub fn new(adapter: Arc<dyn TunMutationAdapter>, supported: bool) -> Self {
        TunCoordinator {
            inner: Arc::new(TunCoordinatorInner {
                adapter,
                status: Mutex::new(initial_tun_status(supported)),
                queue: tokio::sync::Mutex::new(()),
                readiness_generation: AtomicUsize::new(0),
                listeners: EventHub::new(),
                audit: TunAuditLog::new(),
            }),
        }
    }

    fn status(&self) -> MutexGuard<'_, TunStatus> {
        self.inner.status.lock().expect("tun status poisoned")
    }

    /// Register a status listener; returns the unsubscribe handle (the TS
    /// onStatus contract).
    pub fn subscribe(&self, listener: crate::events::EventListener) -> i64 {
        self.inner.listeners.subscribe(listener)
    }

    /// Bounded snapshot of lifecycle evidence for diagnostics.
    pub fn get_audit_snapshot(&self) -> Vec<TunAuditEntry> {
        self.inner.audit.snapshot(1000)
    }

    pub fn get_status(&self) -> TunStatus {
        self.status().clone()
    }

    pub fn get_status_value(&self) -> Value {
        serde_json::to_value(self.get_status()).expect("tun status serializes")
    }

    /// The mixed-port of the live owned TUN session, or null when TUN is not
    /// serving traffic. Only reported in `active`: during starting/restoring
    /// the child's inbound is not a target the system proxy may be pointed at.
    pub fn get_active_mixed_port(&self) -> Option<u16> {
        if self.get_status().phase != "active" {
            return None;
        }
        self.inner.adapter.get_active_runtime()
    }

    /// Startup reconciliation (crash recovery). Never throws.
    pub async fn initialize(&self) -> TunStatus {
        let _guard = self.inner.queue.lock().await;
        let supported = self.get_status().supported;
        if !supported || self.get_status().phase != "configured" {
            return self.get_status();
        }
        if self.inner.adapter.recovery_required().await {
            self.move_status("enable");
            self.move_status_detail("fail", Some("Interrupted TUN transaction requires recovery"), None);
            self.restore_internal().await;
            return self.get_status();
        }
        self.get_status()
    }

    /// Renderer enable: parse the intent, move to starting, run the adapter.
    pub async fn enable(&self, input: &Value) -> Result<TunStatus, IpcError> {
        let _guard = self.inner.queue.lock().await;
        let phase = self.get_status().phase;
        if matches!(phase.as_str(), "active" | "starting" | "restoring" | "conflict" | "unsupported") {
            return Ok(self.get_status());
        }
        // `restore-failed` intentionally falls through: retrying the enable is
        // the natural recovery.
        let intent = parse_tun_intent(input)?;
        let readiness_generation = self.inner.readiness_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.move_status("enable");
        match self.inner.adapter.enable(&intent).await {
            Ok(TunEnableResult::Active { readiness }) => {
                self.move_status("enabled");
                if let Some(readiness) = readiness {
                    self.observe_readiness(readiness, readiness_generation);
                }
            }
            Ok(TunEnableResult::Conflict { conflict_detail }) => {
                self.move_status_detail("conflict", None, Some(&conflict_detail));
            }
            Ok(TunEnableResult::RollbackRequired { error_message }) => {
                self.move_status_detail("fail", Some(&error_message), None);
                self.restore_internal().await;
            }
            Err(error) => {
                self.move_status_detail("fatal", Some(&machine_message(&error)), None);
            }
        }
        Ok(self.get_status())
    }

    /// Renderer disable. The TS handlers call `emergencyDisable` through the
    /// gateway; both share this restore path.
    pub async fn disable(&self) -> TunStatus {
        self.emergency_disable().await
    }

    /// Safe to call from before-quit or a recovery CLI without a renderer.
    pub async fn emergency_disable(&self) -> TunStatus {
        let _guard = self.inner.queue.lock().await;
        let phase = self.get_status().phase;
        if matches!(phase.as_str(), "configured" | "unsupported") {
            return self.get_status();
        }
        self.inner.readiness_generation.fetch_add(1, Ordering::SeqCst);
        // `conflict` participates again: the restore path reconciles first,
        // which is the only way a latched service conflict can clear.
        if self.get_status().phase != "restoring" {
            self.move_status("disable");
        }
        self.restore_internal().await;
        self.get_status()
    }

    /// The one shared core exited, so no TUN adapter or route owned by that
    /// process can still be active. Reset the renderer state before restart.
    pub async fn handle_host_exit(&self) -> TunStatus {
        let _guard = self.inner.queue.lock().await;
        if !self.get_status().supported {
            return self.get_status();
        }
        self.inner.readiness_generation.fetch_add(1, Ordering::SeqCst);
        *self.status() = initial_tun_status(true);
        let snapshot = self.get_status();
        let value = serde_json::to_value(&snapshot).expect("tun status serializes");
        self.inner.listeners.emit(&value);
        snapshot
    }

    async fn restore_internal(&self) {
        match self.inner.adapter.restore().await {
            Ok(TunRestoreResult::Restored) => self.move_status("restored"),
            Ok(TunRestoreResult::Conflict { conflict_detail }) => {
                self.move_status_detail("conflict", None, Some(&conflict_detail));
            }
            Ok(TunRestoreResult::RestoreFailed { error_message }) => {
                self.move_status_detail("fail", Some(&error_message), None);
            }
            Err(error) => {
                self.move_status_detail("fail", Some(&machine_message(&error)), None);
            }
        }
    }

    /// Fast TUN enable publishes `active` after the controller accepts the
    /// config, while an external connectivity probe continues asynchronously.
    /// A probe failure is surfaced as a warning (TUN_DATA_PLANE_UNCONFIRMED)
    /// instead of tearing down a usable TUN on restricted networks; the
    /// generation fence prevents an old probe from poisoning a newer enable.
    fn observe_readiness(&self, readiness: BoxFut<'static, Result<(), String>>, generation: usize) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            if readiness.await.is_ok() {
                return;
            }
            // The generation fence: a disable/re-enable cycle invalidates
            // late probe results.
            if generation != inner.readiness_generation.load(Ordering::SeqCst) {
                return;
            }
            let mut current = inner.status.lock().expect("tun status poisoned");
            if current.phase != "active" {
                return;
            }
            let message = TUN_DATA_PLANE_UNCONFIRMED.to_string();
            current.error_message = Some(message.clone());
            current.updated_at = Some(crate::system_proxy::now_iso());
            let snapshot = current.clone();
            drop(current);
            let _ = inner
                .audit
                .append("readiness:unconfirmed", &snapshot.phase, Some(&message));
            let value = serde_json::to_value(&snapshot).expect("tun status serializes");
            inner.listeners.emit(&value);
        });
    }

    fn move_status(&self, intent: &str) {
        self.move_status_detail(intent, None, None);
    }

    fn move_status_detail(&self, intent: &str, error_message: Option<&str>, conflict_detail: Option<&str>) {
        let from = self.status().phase.clone();
        let next = match transition_tun_status(&self.status().clone(), intent, error_message, conflict_detail) {
            Ok(next) => next,
            // An illegal transition here would be an internal sequencing bug;
            // the TS would throw into serialize. Log-and-keep is the closest
            // safe Rust behavior for a diagnostic-only audit path.
            Err(_) => return,
        };
        *self.status() = next.clone();
        // Machine-code lifecycle evidence: never throws into the state machine.
        let _ = self.inner.audit.append(
            &format!("transition:{from}->{}", next.phase),
            &next.phase,
            next.conflict_detail
                .as_deref()
                .filter(|detail| DETAIL_CODE_PREFIX_OK(detail)),
        );
        let value = serde_json::to_value(&next).expect("tun status serializes");
        self.inner.listeners.emit(&value);
    }
}

// ---------------------------------------------------------------------------
// IPC parse (shared/schemas/tun.ts mihomoOwnedTunIntentSchema)
// ---------------------------------------------------------------------------

/// Strict intent parse: literal schemaVersion 2, a safe adapter label
/// (trim → 1..=128 chars → no control characters → the device charset) and
/// one of the three stacks.
#[allow(dead_code)] // consumed by the tun:enable dispatch arm below
pub fn parse_tun_intent(input: &Value) -> Result<MihomoOwnedTunIntent, IpcError> {
    const GATED: fn() -> IpcError = || {
        IpcError::code(code::TUN_IMPLEMENTATION_GATED, "Windows TUN service transport is not available in this build")
    };
    let _ = GATED;
    let object = input
        .as_object()
        .ok_or_else(|| IpcError::invalid_argument("tun intent must be an object"))?;
    if object.len() != 3 || !object.contains_key("schemaVersion") || !object.contains_key("device") || !object.contains_key("stack") {
        return Err(IpcError::invalid_argument("invalid tun intent"));
    }
    if object.get("schemaVersion").and_then(Value::as_i64) != Some(2) {
        return Err(IpcError::invalid_argument("invalid tun intent: schemaVersion must be 2"));
    }
    let device = object
        .get("device")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("invalid tun intent: device must be a string"))?;
    let device = device.trim();
    if device.is_empty() || device.chars().count() > 128 || device.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
        return Err(IpcError::invalid_argument("invalid tun intent: unsafe adapter label"));
    }
    if !(device.chars().next().map(|first| first.is_ascii_alphanumeric()).unwrap_or(false)
        && device.len() <= 64
        && device.chars().enumerate().all(|(index, c)| {
            index == 0 || c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-')
        }))
    {
        return Err(IpcError::invalid_argument("invalid tun intent: device contains unsupported characters"));
    }
    let stack = object
        .get("stack")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::invalid_argument("invalid tun intent: stack must be a string"))?;
    if !matches!(stack, "mixed" | "system" | "gvisor") {
        return Err(IpcError::invalid_argument("invalid tun intent: unknown stack"));
    }
    Ok(MihomoOwnedTunIntent {
        schema_version: 2,
        device: device.to_string(),
        stack: stack.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct FakeAdapter {
        recovery: AtomicBool,
        enable_result: Mutex<TunEnableResult>,
        restore_result: Mutex<TunRestoreResult>,
        enable_error: AtomicBool,
        restore_error: AtomicBool,
        active_port: std::sync::atomic::AtomicU16,
        active_flag: AtomicBool,
    }

    impl FakeAdapter {
        fn new(enable: TunEnableResult, restore: TunRestoreResult) -> Self {
            FakeAdapter {
                recovery: AtomicBool::new(false),
                enable_result: Mutex::new(enable),
                restore_result: Mutex::new(restore),
                enable_error: AtomicBool::new(false),
                restore_error: AtomicBool::new(false),
                active_port: std::sync::atomic::AtomicU16::new(0),
                active_flag: AtomicBool::new(false),
            }
        }
    }

    impl TunMutationAdapter for FakeAdapter {
        fn recovery_required(&self) -> BoxFut<'_, bool> {
            Box::pin(async move { self.recovery.load(Ordering::SeqCst) })
        }

        fn enable(&self, _intent: &MihomoOwnedTunIntent) -> BoxFut<'_, Result<TunEnableResult, IpcError>> {
            if self.enable_error.load(Ordering::SeqCst) {
                return Box::pin(async move {
                    Err(IpcError::code(code::TUN_SERVICE_CONFLICT, "service conflict"))
                });
            }
            if self.active_flag.load(Ordering::SeqCst) {
                self.active_port.store(17890, Ordering::SeqCst);
            }
            let result = match &*self.enable_result.lock().unwrap() {
                TunEnableResult::Active { readiness } => TunEnableResult::Active { readiness: readiness.is_some().then(|| Box::pin(async { Err("probe failed".to_string()) }) as BoxFut<'static, Result<(), String>>) },
                TunEnableResult::RollbackRequired { error_message } => TunEnableResult::RollbackRequired { error_message: error_message.clone() },
                TunEnableResult::Conflict { conflict_detail } => TunEnableResult::Conflict { conflict_detail: conflict_detail.clone() },
            };
            Box::pin(async move { Ok(result) })
        }

        fn restore(&self) -> BoxFut<'_, Result<TunRestoreResult, IpcError>> {
            if self.restore_error.load(Ordering::SeqCst) {
                return Box::pin(async move {
                    Err(IpcError::code(code::TUN_HELPER_PROTOCOL_INVALID, "helper protocol"))
                });
            }
            let result = match &*self.restore_result.lock().unwrap() {
                TunRestoreResult::Restored => TunRestoreResult::Restored,
                TunRestoreResult::RestoreFailed { error_message } => TunRestoreResult::RestoreFailed { error_message: error_message.clone() },
                TunRestoreResult::Conflict { conflict_detail } => TunRestoreResult::Conflict { conflict_detail: conflict_detail.clone() },
            };
            Box::pin(async move { Ok(result) })
        }

        fn get_active_runtime(&self) -> Option<u16> {
            if self.active_flag.load(Ordering::SeqCst) {
                Some(self.active_port.load(Ordering::SeqCst))
            } else {
                None
            }
        }
    }

    fn active_adapter() -> Arc<FakeAdapter> {
        let mut adapter = FakeAdapter::new(
            TunEnableResult::Active { readiness: None },
            TunRestoreResult::Restored,
        );
        adapter.active_flag.store(true, Ordering::SeqCst);
        Arc::new(adapter)
    }

    fn gated() -> TunCoordinator {
        TunCoordinator::new(Arc::new(GatedTunMutationAdapter), true)
    }

    #[test]
    fn transition_table_matches_the_ts_matrix() {
        // Legal moves.
        assert_eq!(transition_table("configured", "enable"), Some("starting"));
        assert_eq!(transition_table("starting", "enabled"), Some("active"));
        assert_eq!(transition_table("active", "disable"), Some("restoring"));
        assert_eq!(transition_table("restoring", "restored"), Some("configured"));
        assert_eq!(transition_table("restoring", "fail"), Some("restore-failed"));
        assert_eq!(transition_table("failed", "enable"), Some("starting"));
        assert_eq!(transition_table("conflict", "disable"), Some("restoring"));
        assert_eq!(transition_table("restore-failed", "enable"), Some("starting"));
        assert_eq!(transition_table("unsupported", "initialize"), Some("unsupported"));
        // Illegal: active cannot enable twice; conflict cannot enable.
        assert_eq!(transition_table("active", "enable"), None);
        assert_eq!(transition_table("conflict", "enable"), None);
        assert_eq!(transition_table("configured", "restored"), None);
    }

    #[test]
    fn invalid_transition_carries_the_machine_copy() {
        let status = initial_tun_status(true);
        let error = transition_tun_status(&status, "restored", None, None).unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:TUN_INVALID_TRANSITION::Invalid TUN transition: configured + restored");
        // configured+unsupported is legal (the supported flag drops).
        let unsupported = transition_tun_status(&status, "unsupported", None, None).unwrap();
        assert_eq!(unsupported.phase, "unsupported");
        assert_eq!(unsupported.supported, false);
        let starting = transition_tun_status(&status, "enable", None, None).unwrap();
        let error = transition_tun_status(&starting, "conflict", None, None).unwrap_err();
        assert_eq!(
            error.0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::TUN conflict transition requires conflictDetail"
        );
    }

    #[test]
    fn transition_preserves_error_on_fail_and_clears_on_success() {
        let status = initial_tun_status(true);
        let failed = transition_tun_status(&status, "enable", Some("boom"), None).unwrap();
        assert_eq!(failed.phase, "starting");
        let failed = transition_tun_status(&failed, "fatal", Some("boom"), None).unwrap();
        assert_eq!(failed.phase, "failed");
        assert_eq!(failed.error_message.as_deref(), Some("boom"));
        assert_eq!(failed.supported, true);
        // A later enable clears the message.
        let starting = transition_tun_status(&failed, "enable", None, None).unwrap();
        assert_eq!(starting.phase, "starting");
        assert_eq!(starting.error_message, None);
        // Conflict keeps the detail while latched, clears on restore.
        let conflict = transition_tun_status(&starting, "conflict", None, Some("SERVICE_CONFLICT")).unwrap();
        assert_eq!(conflict.conflict_detail.as_deref(), Some("SERVICE_CONFLICT"));
        let restoring = transition_tun_status(&conflict, "disable", None, None).unwrap();
        assert_eq!(restoring.conflict_detail, None);
        // updatedAt carries an ISO stamp.
        assert!(restoring.updated_at.is_some());
    }

    #[test]
    fn audit_log_bounds_and_machine_code_gate() {
        let audit = TunAuditLog::new();
        audit.append("transition:configured->starting", "starting", None).unwrap();
        audit.append("transition:starting->active", "active", Some("SERVICE_CONFLICT")).unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit.snapshot(1)[0].event, "transition:starting->active");
        // Non-machine detail codes are rejected, never stored.
        assert!(audit.append("event", "phase", Some("arbitrary text with spaces")).is_err());
        assert!(audit.append("event", "phase", Some("OK_CODE-1.2:3_4")).is_ok());
    }

    #[tokio::test]
    async fn gated_adapter_is_the_fail_closed_production_surface() {
        let coordinator = gated();
        // The adapter itself fails closed with the typed gate error...
        let adapter = GatedTunMutationAdapter;
        let error = adapter
            .enable(&MihomoOwnedTunIntent { schema_version: 2, device: "M".to_string(), stack: "mixed".to_string() })
            .await
            .unwrap_err();
        assert_eq!(
            error.0,
            "PROTOCOL_ERROR:TUN_IMPLEMENTATION_GATED::Windows TUN service transport is not available in this build"
        );
        // ...while the coordinator catches it into `fatal` (the IPC surface
        // returns the status, never a throw, like the TS serialize).
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "Murge TUN", "stack": "mixed" })).await.unwrap();
        assert_eq!(status.phase, "failed");
        assert_eq!(status.error_message.as_deref(), Some("TUN_IMPLEMENTATION_GATED"));
        // Disable routes through restoring → fail (restore throws the same gate).
        let status = coordinator.disable().await;
        assert_eq!(status.phase, "restore-failed");
        assert_eq!(status.error_message.as_deref(), Some("TUN_IMPLEMENTATION_GATED"));
        // Unsupported platform never leaves its phase.
        let unsupported = TunCoordinator::new(Arc::new(GatedTunMutationAdapter), false);
        assert_eq!(unsupported.get_status().phase, "unsupported");
        let status = unsupported.enable(&json!({ "schemaVersion": 2, "device": "x", "stack": "mixed" })).await.unwrap();
        assert_eq!(status.phase, "unsupported");
    }

    #[tokio::test]
    async fn enable_happy_path_moves_through_starting_to_active() {
        let adapter = active_adapter();
        let coordinator = TunCoordinator::new(adapter.clone(), true);
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        coordinator.subscribe(Arc::new(move |value| {
            sink.lock().unwrap().push(value["phase"].as_str().unwrap_or_default().to_string());
        }));
        let status = coordinator
            .enable(&json!({ "schemaVersion": 2, "device": "Murge TUN", "stack": "mixed" }))
            .await
            .unwrap();
        assert_eq!(status.phase, "active");
        assert_eq!(events.lock().unwrap().clone(), vec!["starting".to_string(), "active".to_string()]);
        // The live session port is only reported while active.
        assert_eq!(coordinator.get_active_mixed_port(), Some(17890));
        // Audit captured the lifecycle evidence.
        let events: Vec<String> = coordinator.get_audit_snapshot().iter().map(|entry| entry.event.clone()).collect();
        assert_eq!(events, vec!["transition:configured->starting", "transition:starting->active"]);
        // Idempotent: enabling again while active is a no-op.
        let again = coordinator.enable(&json!({ "schemaVersion": 2, "device": "Murge TUN", "stack": "mixed" })).await.unwrap();
        assert_eq!(again.phase, "active");
        // Disable returns to configured and clears the active port.
        let status = coordinator.disable().await;
        assert_eq!(status.phase, "configured");
        assert_eq!(coordinator.get_active_mixed_port(), None);
    }

    #[tokio::test]
    async fn enable_rollback_and_conflict_outcomes() {
        // Rollback-required: fail → restoring → configured.
        let adapter = Arc::new(FakeAdapter::new(
            TunEnableResult::RollbackRequired { error_message: "adapter create failed".to_string() },
            TunRestoreResult::Restored,
        ));
        let coordinator = TunCoordinator::new(adapter.clone(), true);
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "gvisor" })).await.unwrap();
        assert_eq!(status.phase, "configured");
        // Conflict outcome latches with the service detail.
        let adapter = Arc::new(FakeAdapter::new(
            TunEnableResult::Conflict { conflict_detail: "SERVICE_CONFLICT".to_string() },
            TunRestoreResult::Restored,
        ));
        let coordinator = TunCoordinator::new(adapter, true);
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "system" })).await.unwrap();
        assert_eq!(status.phase, "conflict");
        assert_eq!(status.conflict_detail.as_deref(), Some("SERVICE_CONFLICT"));
        // The only way out of a latched conflict is the disable/restore path.
        let status = coordinator.disable().await;
        assert_eq!(status.phase, "configured");
        // Restore-failed enable is retryable; the retry then succeeds.
        let adapter = Arc::new(FakeAdapter::new(
            TunEnableResult::RollbackRequired { error_message: "x".to_string() },
            TunRestoreResult::RestoreFailed { error_message: "network restore failed".to_string() },
        ));
        let coordinator = TunCoordinator::new(adapter.clone(), true);
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "mixed" })).await.unwrap();
        assert_eq!(status.phase, "restore-failed");
        assert_eq!(status.error_message.as_deref(), Some("network restore failed"));
        *adapter.enable_result.lock().unwrap() = TunEnableResult::Active { readiness: None };
        adapter.active_flag.store(false, Ordering::SeqCst);
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "mixed" })).await.unwrap();
        assert_eq!(status.phase, "active");
    }

    #[tokio::test]
    async fn startup_recovery_marks_failed_then_restores() {
        let adapter = active_adapter();
        adapter.recovery.store(true, Ordering::SeqCst);
        let coordinator = TunCoordinator::new(adapter, true);
        let status = coordinator.initialize().await;
        // recoveryRequired → enable → fail → restoring → configured.
        assert_eq!(status.phase, "configured");
        let events: Vec<String> = coordinator.get_audit_snapshot().iter().map(|entry| entry.event.clone()).collect();
        assert_eq!(
            events,
            vec![
                "transition:configured->starting",
                "transition:starting->restoring",
                "transition:restoring->configured"
            ]
        );
        // A clean adapter is a no-op.
        let clean = TunCoordinator::new(active_adapter(), true);
        assert_eq!(clean.initialize().await.phase, "configured");
        assert!(clean.get_audit_snapshot().is_empty());
        // A service conflict during the recovery RESTORE latches.
        let conflicting = Arc::new(FakeAdapter::new(
            TunEnableResult::Active { readiness: None },
            TunRestoreResult::Restored,
        ));
        conflicting.restore_error.store(true, Ordering::SeqCst);
        conflicting.recovery.store(true, Ordering::SeqCst);
        let coordinator = TunCoordinator::new(conflicting, true);
        // restore ERROR during recovery → restoring maps `fail` to restore-failed.
        assert_eq!(coordinator.initialize().await.phase, "restore-failed");
        assert_eq!(coordinator.get_status().error_message.as_deref(), Some("TUN_HELPER_PROTOCOL_INVALID"));
    }

    #[tokio::test]
    async fn host_exit_resets_the_state_machine() {
        let coordinator = TunCoordinator::new(active_adapter(), true);
        coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "mixed" })).await.unwrap();
        let status = coordinator.handle_host_exit().await;
        assert_eq!(status.phase, "configured");
        assert_eq!(status.error_message, None);
        assert_eq!(status.conflict_detail, None);
    }

    #[tokio::test]
    async fn readiness_probe_failure_warns_without_tearing_down() {
        let adapter = FakeAdapter::new(
            TunEnableResult::Active { readiness: None },
            TunRestoreResult::Restored,
        );
        adapter.active_flag.store(true, Ordering::SeqCst);
        let adapter = Arc::new(adapter);
        let coordinator = TunCoordinator::new(adapter.clone(), true);
        // Inject a failing readiness future.
        *adapter.enable_result.lock().unwrap() = TunEnableResult::Active {
            readiness: Some(Box::pin(async { Err("public endpoint unreachable".to_string()) })),
        };
        let status = coordinator.enable(&json!({ "schemaVersion": 2, "device": "M", "stack": "mixed" })).await.unwrap();
        assert_eq!(status.phase, "active");
        // The async probe fails shortly after; the phase STAYS active with the warning.
        for _ in 0..50 {
            if coordinator.get_status().error_message.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let status = coordinator.get_status();
        assert_eq!(status.phase, "active");
        assert_eq!(status.error_message.as_deref(), Some(TUN_DATA_PLANE_UNCONFIRMED));
        // The audit captured the diagnostic.
        assert!(coordinator.get_audit_snapshot().iter().any(|entry| entry.event == "readiness:unconfirmed"));
    }

    #[test]
    fn parse_tun_intent_is_strict() {
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "Murge TUN", "stack": "mixed" })).is_ok());
        // Wrong schemaVersion.
        assert!(parse_tun_intent(&json!({ "schemaVersion": 1, "device": "M", "stack": "mixed" })).is_err());
        // Unknown stack.
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "M", "stack": "tun" })).is_err());
        // Device starting with punctuation / too long / control characters.
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "-M", "stack": "mixed" })).is_err());
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "x".repeat(65), "stack": "mixed" })).is_err());
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "M\u{0007}x", "stack": "mixed" })).is_err());
        // Extra keys reject (strict).
        assert!(parse_tun_intent(&json!({ "schemaVersion": 2, "device": "M", "stack": "mixed", "extra": 1 })).is_err());
        assert!(parse_tun_intent(&json!(null)).is_err());
    }

    #[test]
    fn machine_message_collapses_protocol_errors_to_codes() {
        assert_eq!(machine_message(&IpcError::code(code::TUN_SERVICE_CONFLICT, "service conflict")), "TUN_SERVICE_CONFLICT");
        assert_eq!(machine_message(&IpcError::internal("anything")), "INTERNAL");
    }
}
