//! Application-update state machine — the Rust mirror of
//! `src/main/updates/service.ts` and the `updates:*` IPC surface.
//!
//! The service owns the lifecycle state machine and reduces a narrow driver's
//! event stream into a single `UpdateState` snapshot pushed to renderer
//! windows. The production driver is [`TauriUpdaterDriver`], backed by
//! `tauri-plugin-updater`: every downloaded installer must carry a minisign
//! signature from the release key whose public half is pinned in
//! `tauri.conf.json` (`plugins.updater.pubkey`), and that signature must name
//! the announced version (`requireSignedVersion`). GitHub mirrors therefore
//! only ever act as transport — they cannot substitute or roll back a build
//! (review item S1). `GatedUpdaterDriver` stays as the fail-closed fallback
//! for dev runs and tests.
//!
//! Releases are announced on two channels, each a fixed GitHub release whose
//! `latest.json` the release workflows rewrite: `channel-stable` (the
//! Electron build) and `channel-experimental` (this build). An installer of
//! this build must be newer; one of the Electron build is a switch back to
//! stable and is taken whatever its version (same model as
//! `src/main/updates/signed-manifest-driver.ts`).

use crate::error::IpcError;
use crate::events::{EventHub, EventListener};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Byte-exact renderer copy (service.ts NOT_SUPPORTED). Consumed by the
/// unsupported branch of `check()` — reachable once a real driver lands.
#[allow(dead_code)]
const NOT_SUPPORTED: &str = "当前构建不支持自动更新（仅安装版可用）";

/// Normalized driver event (`updates/updater-driver.ts`).
#[allow(dead_code)] // driver seam vocabulary; tests + the future driver emit it
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdaterDriverEvent {
    Checking,
    NotAvailable,
    Available {
        version: String,
        release_notes: Option<String>,
        /// The build the installer belongs to ("tauri" | "electron").
        #[serde(skip_serializing_if = "Option::is_none")]
        product: Option<String>,
    },
    DownloadProgress {
        percent: f64,
        #[serde(rename = "bytesPerSecond")]
        bytes_per_second: u64,
        transferred: u64,
        total: Option<u64>,
    },
    Downloaded,
    Error {
        message: String,
    },
}

/// Download progress snapshot (`shared/updates.ts`).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub percent: f64,
    pub bytes_per_second: u64,
    pub transferred: u64,
    pub total: Option<u64>,
}

/// Lifecycle snapshot (`shared/updates.ts` UpdateState).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: String,
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    /// Release notes of the available update, as published.
    pub release_notes: Option<String>,
    /// The build that is running ("tauri").
    pub current_product: String,
    /// The build the available update installs; differs from
    /// `current_product` on a channel switch.
    pub available_product: Option<String>,
    pub progress: Option<UpdateProgress>,
    pub error: Option<String>,
    pub can_install: bool,
    /// True when this build can follow the stable / experimental channels.
    pub channels_supported: bool,
}

/// This build, as `UpdateState.currentProduct` names it.
pub const PRODUCT: &str = "tauri";

pub fn default_update_state() -> UpdateState {
    UpdateState {
        phase: "idle".to_string(),
        current_version: None,
        available_version: None,
        release_notes: None,
        current_product: PRODUCT.to_string(),
        available_product: None,
        progress: None,
        error: None,
        can_install: false,
        channels_supported: false,
    }
}

/// Coerce an unknown value (from a stale IPC payload or a malformed device)
/// into a state snapshot — every missing field falls back to the default.
#[allow(dead_code)] // renderer payload hardening for the notification slice
pub fn coerce_update_state(value: &Value) -> UpdateState {
    const PRODUCTS: [&str; 2] = ["electron", "tauri"];
    const PHASES: [&str; 7] = [
        "idle",
        "checking",
        "available",
        "downloading",
        "downloaded",
        "not-available",
        "error",
    ];
    let Some(record) = value.as_object() else {
        return default_update_state();
    };
    let progress = record
        .get("progress")
        .and_then(|raw| raw.as_object())
        .map(|raw| UpdateProgress {
            percent: raw.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
            bytes_per_second: raw
                .get("bytesPerSecond")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            transferred: raw.get("transferred").and_then(Value::as_u64).unwrap_or(0),
            total: raw.get("total").and_then(Value::as_u64),
        });
    UpdateState {
        phase: record
            .get("phase")
            .and_then(Value::as_str)
            .filter(|phase| PHASES.contains(phase))
            .unwrap_or("idle")
            .to_string(),
        current_version: record
            .get("currentVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        available_version: record
            .get("availableVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        release_notes: record
            .get("releaseNotes")
            .and_then(Value::as_str)
            .map(str::to_string),
        current_product: record
            .get("currentProduct")
            .and_then(Value::as_str)
            .filter(|product| PRODUCTS.contains(product))
            .unwrap_or(PRODUCT)
            .to_string(),
        available_product: record
            .get("availableProduct")
            .and_then(Value::as_str)
            .filter(|product| PRODUCTS.contains(product))
            .map(str::to_string),
        progress,
        error: record
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        can_install: record
            .get("canInstall")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        channels_supported: record
            .get("channelsSupported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// The narrow seam electron-updater fills. The Tauri build ships the gate
/// until the updater integration lands; it performs no I/O.
pub trait UpdaterDriver: Send + Sync {
    fn current_version(&self) -> String;
    /// Follow another release channel ("stable" | "experimental"). Drops any
    /// offer or staged installer of the previous channel; the caller starts
    /// a fresh check. Drivers without channels ignore it.
    fn set_channel(&self, _channel: &str) {}
    /// Whether [`UpdaterDriver::set_channel`] does anything.
    fn channels_supported(&self) -> bool {
        false
    }
    /// Whether this build can actually reach an update feed. False for dev /
    /// unpackaged runs, so the service reports a clear "not supported" state
    /// instead of throwing on a missing feed.
    fn supported(&self) -> bool;
    /// Attach listeners and apply helper flags once, before any check.
    fn configure(&self);
    /// Kick off a feed check; results arrive as events. A synchronous
    /// pre-flight failure returns Err WITHOUT ever emitting an 'error' event.
    fn check(&self) -> Result<(), String>;
    /// Start (or resume) downloading the available update in the background.
    fn download(&self);
    /// Install a fully-downloaded update and restart the app.
    fn quit_and_install(&self);
    /// Subscribe to normalized events; returns the unsubscribe handle.
    fn on_event(&self, listener: EventListener) -> i64;
    #[allow(dead_code)] // the real driver releases feed handles here
    fn dispose(&self);
}

/// Fail-closed production driver: the update feed is not wired in this build
/// (the Electron equivalent reports the same on dev/unpackaged runs). No
/// network, no updater flags, no notifications.
pub struct GatedUpdaterDriver {
    events: EventHub,
}

impl GatedUpdaterDriver {
    pub fn new() -> Self {
        GatedUpdaterDriver {
            events: EventHub::new(),
        }
    }
}

impl Default for GatedUpdaterDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterDriver for GatedUpdaterDriver {
    fn current_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    fn supported(&self) -> bool {
        false
    }

    fn configure(&self) {}

    fn check(&self) -> Result<(), String> {
        Ok(())
    }

    fn download(&self) {}

    fn quit_and_install(&self) {}

    fn on_event(&self, listener: EventListener) -> i64 {
        self.events.subscribe(listener)
    }

    fn dispose(&self) {}
}

/// GitHub mirrors tried alongside a direct connection (the Electron driver's
/// list). In much of China a direct hit on `github.com` times out. They only
/// carry bytes: the signature check below is what decides trust.
const GITHUB_PROXIES: [&str; 2] = ["https://gh-proxy.org", "https://ghfast.top"];

/// Mid-session feed polling cadence (the mihomo-party / sparkle model).
pub const POLL_INTERVAL_MS: u64 = 10 * 60 * 1000;

/// Timeout for a single manifest probe before the source is dropped.
const FEED_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Upper bound for one installer download attempt.
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The static manifest each channel release carries (`latest.json`, written
/// by `scripts/tauri-updater-manifest.mjs` / `scripts/channel-manifest.mjs`).
const MANIFEST_NAME: &str = "latest.json";

/// `https://github.com/<owner>/<repo>` derived from the brand's repository URL
/// (never hardcoded).
pub fn repository_base(repository_url: &str) -> Option<String> {
    let url = url::Url::parse(repository_url).ok()?;
    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?.trim_end_matches(".git");
    Some(format!("https://github.com/{owner}/{repo}"))
}

/// The fixed release tag that carries a channel's manifest.
pub fn channel_tag(channel: &str) -> &'static str {
    if channel == "stable" {
        "channel-stable"
    } else {
        "channel-experimental"
    }
}

/// The build each channel delivers. A manifest naming the other build is
/// refused: manifests are unsigned, so a stale or hostile mirror could
/// otherwise serve an old, validly signed installer of the other build, which
/// would be taken as a channel switch at any version. Moving the stable
/// channel to Tauri later takes a client release that changes this mapping.
pub fn channel_product(channel: &str) -> &'static str {
    if channel == "stable" {
        "electron"
    } else {
        "tauri"
    }
}

/// Direct GitHub download base of a channel's manifest release.
pub fn channel_feed_base(repository: &str, channel: &str) -> String {
    format!("{repository}/releases/download/{}", channel_tag(channel))
}

/// The build an installer belongs to, from its file name: the Tauri bundler
/// writes `<product>_<version>_<arch>-setup.exe`, electron-builder
/// `<product>-Setup-<version>-<arch>.exe`.
pub fn installer_product(file_name: &str) -> Option<&'static str> {
    let tauri =
        regex::Regex::new(r"_\d+\.\d+\.\d+_(?:x64|arm64)-setup\.exe$").expect("valid regex");
    let electron =
        regex::Regex::new(r"-Setup-\d+\.\d+\.\d+-(?:x64|arm64)\.exe$").expect("valid regex");
    if tauri.is_match(file_name) {
        Some("tauri")
    } else if electron.is_match(file_name) {
        Some("electron")
    } else {
        None
    }
}

/// The manifest's platform map is unsigned. Its selected entry may name a
/// perfectly signed installer for another CPU, so bind the signed file name
/// to the actual executable target as well as its product and version.
pub fn installer_matches_arch(file_name: &str, arch: &str) -> bool {
    let suffix = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return false,
    };
    match installer_product(file_name) {
        Some("tauri") => file_name.ends_with(&format!("_{suffix}-setup.exe")),
        Some("electron") => file_name.ends_with(&format!("-{suffix}.exe")),
        _ => false,
    }
}

/// The last path segment of a download URL, percent-decoded.
pub fn installer_file_name(download_url: &url::Url) -> String {
    let raw = download_url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    percent_decode(raw)
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strict `x.y.z` (optional leading `v`, no pre-release) as a numeric triple.
pub fn parse_stable_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    let triple = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(triple)
}

pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    match (
        parse_stable_version(candidate),
        parse_stable_version(current),
    ) {
        (Some(next), Some(now)) => next > now,
        _ => false,
    }
}

/// The `key:value` fields of a Tauri signature's trusted comment. Only read
/// after the updater verified the signature, whose global signature covers
/// this comment.
pub fn signed_fields(signature: &str) -> std::collections::HashMap<String, String> {
    use base64::Engine;
    let text = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default();
    text.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("trusted comment: ")
                .map(str::to_string)
        })
        .unwrap_or_default()
        .split('\t')
        .filter_map(|field| {
            let (key, value) = field.split_once(':')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// Explicit restart/install shows the installer; background quit stays silent.
/// Relaunch the app
/// (`--force-run`) only for "重启并安装", not for an install on quit.
/// (`--updated` is not passed: this is a takeover, not an in-place upgrade.)
pub fn electron_installer_args(restart: bool) -> &'static [&'static str] {
    if restart {
        &["--force-run"]
    } else {
        &["/S"]
    }
}

/// Ordered, de-duplicated feed bases: last-known-good first, then direct, then
/// the prefix mirrors.
pub fn feed_base_candidates(direct: &str, last_good: Option<&str>) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    let mirrors = GITHUB_PROXIES
        .iter()
        .map(|proxy| format!("{proxy}/{direct}"));
    for candidate in last_good
        .map(str::to_string)
        .into_iter()
        .chain(std::iter::once(direct.to_string()))
        .chain(mirrors)
    {
        if !all.contains(&candidate) {
            all.push(candidate);
        }
    }
    all
}

/// The download URL routed through the same source the manifest came from:
/// a mirror base keeps its prefix, a direct base leaves the URL untouched.
pub fn route_download_url(download_url: &str, feed_base: &str, direct: &str) -> String {
    match feed_base.strip_suffix(direct) {
        Some(prefix) if !prefix.is_empty() && download_url.starts_with("https://github.com/") => {
            format!("{}/{download_url}", prefix.trim_end_matches('/'))
        }
        _ => download_url.to_string(),
    }
}

/// True when `download_url` is one of this repository's release assets
/// (`https://github.com/<owner>/<repo>/releases/download/...`).
pub fn is_release_asset(download_url: &str, repository: &str) -> bool {
    let repository = repository.trim_end_matches('/');
    let Ok(url) = url::Url::parse(download_url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.query().is_none()
        && url
            .as_str()
            .starts_with(&format!("{repository}/releases/download/"))
        && !url.path().contains("/../")
}

/// Result of asking every source for the manifest.
pub enum ProbeOutcome<T> {
    /// The best update any source announced, and that source.
    Update(String, T),
    /// Every answering source said there is nothing newer; the first of them.
    NoUpdate(String),
    /// No source answered.
    Failed(String),
}

/// Run every probe concurrently (each is time-limited) and keep the best
/// offer by `better`: manifests are unsigned, so a stale or replaying mirror
/// that answers first must not pin the client to an older release. "No
/// update" is reported only if no source announced one and at least one
/// source answered.
pub async fn race_probes<T, F>(
    probes: impl IntoIterator<Item = F>,
    better: impl Fn(&T, &T) -> bool,
) -> ProbeOutcome<T>
where
    F: std::future::Future<Output = Result<(String, Option<T>), String>>,
{
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let mut pending: FuturesUnordered<F> = probes.into_iter().collect();
    let mut best: Option<(String, T)> = None;
    let mut no_update: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();
    while let Some(result) = pending.next().await {
        match result {
            Ok((base, Some(update))) => {
                if best
                    .as_ref()
                    .is_none_or(|(_, current)| better(&update, current))
                {
                    best = Some((base, update));
                }
            }
            Ok((base, None)) => {
                no_update.get_or_insert(base);
            }
            Err(error) => errors.push(error),
        }
    }
    if let Some((base, update)) = best {
        return ProbeOutcome::Update(base, update);
    }
    match no_update {
        Some(base) => ProbeOutcome::NoUpdate(base),
        None => ProbeOutcome::Failed(if errors.is_empty() {
            "no update source".to_string()
        } else {
            errors.join("; ")
        }),
    }
}

/// Download-progress accumulator (electron-updater's percent / rate fields).
struct ProgressMeter {
    started: std::time::Instant,
    last_emit: Option<std::time::Instant>,
    transferred: u64,
}

impl ProgressMeter {
    fn new() -> Self {
        ProgressMeter {
            started: std::time::Instant::now(),
            last_emit: None,
            transferred: 0,
        }
    }

    /// Record a chunk; returns an event at most every 250 ms (and always on
    /// the final chunk) so a fast link cannot flood the renderer.
    fn record(&mut self, chunk: usize, total: Option<u64>) -> Option<UpdaterDriverEvent> {
        self.transferred += chunk as u64;
        let now = std::time::Instant::now();
        let finished = total.is_some_and(|total| self.transferred >= total);
        if !finished
            && self.last_emit.is_some_and(|last| {
                now.duration_since(last) < std::time::Duration::from_millis(250)
            })
        {
            return None;
        }
        self.last_emit = Some(now);
        let elapsed = now.duration_since(self.started).as_secs_f64().max(0.001);
        Some(UpdaterDriverEvent::DownloadProgress {
            percent: total
                .filter(|total| *total > 0)
                .map(|total| (self.transferred as f64 / total as f64 * 100.0).min(100.0))
                .unwrap_or(0.0),
            bytes_per_second: (self.transferred as f64 / elapsed) as u64,
            transferred: self.transferred,
            total,
        })
    }
}

/// A verified installer waiting for the app to exit.
struct ReadyUpdate {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    /// "tauri" (installed by the updater plugin) or "electron" (a switch back
    /// to the stable build, launched by [`launch_electron_installer`]).
    product: &'static str,
    file_name: String,
}

/// The verified installer, installed from `RunEvent::Exit` (electron-updater's
/// `autoInstallOnAppQuit`) so the ordered quit flow — restore the system
/// proxy, stop the kernel — always runs before the installer replaces files.
static READY_UPDATE: Mutex<Option<ReadyUpdate>> = Mutex::new(None);
/// Set by "重启并安装": relaunch Murge once the installer finishes.
static RESTART_AFTER_INSTALL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// Cleared when the session is ending (logoff/shutdown): an installer UAC
/// prompt must never block Windows from shutting down.
static INSTALL_ON_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Skip the pending install for this exit (session ending). The update stays
/// in the release feed and is picked up again on the next launch.
pub fn cancel_install_on_exit() {
    INSTALL_ON_EXIT.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Called from `RunEvent::Exit`: launch the verified installer, if any. On
/// Windows the plugin hands the installer to ShellExecute and terminates the
/// process, so this must be the last exit step.
pub fn install_ready_update_on_exit() {
    if !INSTALL_ON_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let Some(ready) = READY_UPDATE.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    let restart = RESTART_AFTER_INSTALL.load(std::sync::atomic::Ordering::SeqCst);
    if ready.product == "electron" {
        if let Err(error) = launch_electron_installer(&ready.file_name, &ready.bytes, restart) {
            crate::diag!("[updates] launching the stable installer failed: {error}");
            crate::file_log::flush_diagnostics_blocking();
        }
        return;
    }
    let update = ready.update.restart_after_install(restart);
    if let Err(error) = update.install(&ready.bytes) {
        crate::diag!("[updates] launching the installer failed: {error}");
        // The process exits right after this callback.
        crate::file_log::flush_diagnostics_blocking();
    }
}

/// How long the elevated helper waits for this process to finish exiting.
pub const PARENT_EXIT_TIMEOUT_SECONDS: u32 = 120;
/// How long the exit waits for the user to answer the administrator prompt.
const ELEVATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// A PowerShell single-quoted string literal.
pub fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `-EncodedCommand` payload: base64 of the UTF-16LE script.
pub fn encode_powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Script of the elevated helper: wait for Murge to exit, then run the
/// installer (already elevated, so no second prompt) with a visible window.
/// Values are embedded as literals: an elevated process does not inherit this
/// process's environment.
pub fn elevated_helper_script(
    installer: &str,
    args: &[&str],
    parent_pid: u32,
    trace: &str,
    failure: &str,
) -> String {
    let trace = ps_literal(trace);
    let argument_list = args
        .iter()
        .map(|arg| ps_literal(arg))
        .collect::<Vec<_>>()
        .join(",");
    let argument_list = if argument_list.is_empty() {
        String::new()
    } else {
        format!(" -ArgumentList {argument_list}")
    };
    let timeout = PARENT_EXIT_TIMEOUT_SECONDS;
    [
        "try {".to_string(),
        format!("  Add-Content -LiteralPath {trace} -Value 'Elevated helper started' -ErrorAction SilentlyContinue"),
        format!("  Wait-Process -Id {parent_pid} -Timeout {timeout} -ErrorAction SilentlyContinue"),
        format!("  if (Get-Process -Id {parent_pid} -ErrorAction SilentlyContinue) {{ throw 'Murge did not exit within {timeout} seconds' }}"),
        format!("  Add-Content -LiteralPath {trace} -Value 'Starting installer' -ErrorAction SilentlyContinue"),
        format!(
            "  $installer = Start-Process -FilePath {}{argument_list} -WindowStyle Normal -Wait -PassThru -ErrorAction Stop",
            ps_literal(installer)
        ),
        format!("  Add-Content -LiteralPath {trace} -Value ('Installer exit code: ' + $installer.ExitCode) -ErrorAction SilentlyContinue"),
        "  if ($installer.ExitCode -ne 0) { throw ('Installer exited with code ' + $installer.ExitCode) }".to_string(),
        "} catch {".to_string(),
        format!("  Set-Content -LiteralPath {} -Value $_.Exception.Message -Encoding UTF8", ps_literal(failure)),
        "}".to_string(),
    ]
    .join("\n")
}

/// Script run while Murge still exists: request elevation and start the
/// elevated helper. Exits 0 once it runs, 1 when elevation was refused.
pub fn elevation_request_script(
    helper: &str,
    powershell: &str,
    trace: &str,
    failure: &str,
) -> String {
    let helper_args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        &encode_powershell(helper),
    ]
    .iter()
    .map(|arg| ps_literal(arg))
    .collect::<Vec<_>>()
    .join(",");
    let trace = ps_literal(trace);
    [
        "try {".to_string(),
        format!("  Set-Content -LiteralPath {trace} -Value 'Requesting elevation' -ErrorAction SilentlyContinue"),
        format!(
            "  $null = Start-Process -FilePath {} -ArgumentList {helper_args} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop",
            ps_literal(powershell)
        ),
        format!("  Add-Content -LiteralPath {trace} -Value 'Elevated helper launched' -ErrorAction SilentlyContinue"),
        "  exit 0".to_string(),
        "} catch {".to_string(),
        format!(
            "  Set-Content -LiteralPath {} -Value ('Elevation failed: ' + $_.Exception.Message) -Encoding UTF8",
            ps_literal(failure)
        ),
        "  exit 1".to_string(),
        "}".to_string(),
    ]
    .join("\n")
}

/// Folder the switch-back installer and its diagnostics live in.
fn update_temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("murge-update")
}

/// Write the verified Electron installer to a temp folder and hand it to
/// Windows. A non-elevated child of this process does not reliably outlive
/// it (a login task tears its whole process tree down), so — while Murge
/// still runs — a short-lived PowerShell asks for elevation and starts an
/// elevated helper, which Windows creates outside this process tree. That
/// helper waits for Murge to exit and runs the installer. This blocks the
/// exit while the UAC prompt is up. The Electron installer removes this
/// installation first (keeping service, data and the startup task).
fn launch_electron_installer(file_name: &str, bytes: &[u8], restart: bool) -> Result<(), String> {
    let dir = update_temp_dir();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(file_name);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    let trace = dir.join("install-trace.txt");
    let failure = dir.join("install-failure.txt");
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let helper = elevated_helper_script(
        &path.to_string_lossy(),
        electron_installer_args(restart),
        std::process::id(),
        &trace.to_string_lossy(),
        &failure.to_string_lossy(),
    );
    let request = elevation_request_script(
        &helper,
        &powershell.to_string_lossy(),
        &trace.to_string_lossy(),
        &failure.to_string_lossy(),
    );
    let mut process = std::process::Command::new(&powershell);
    process
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encode_powershell(&request),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let deadline = std::time::Instant::now() + ELEVATION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                crate::diag!("[updates] elevated installer helper started");
                return Ok(());
            }
            Ok(Some(status)) => {
                return Err(format!(
                    "elevation was refused or failed ({status}); see {}",
                    failure.display()
                ))
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let reason = "no answer to the administrator prompt";
                let _ = std::fs::write(&failure, reason);
                return Err(reason.to_string());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Production driver: signed Tauri updater over GitHub Releases + mirrors.
pub struct TauriUpdaterDriver {
    inner: Arc<TauriUpdaterInner>,
}

struct TauriUpdaterInner {
    app: tauri::AppHandle,
    events: EventHub,
    supported: bool,
    /// `https://github.com/<owner>/<repo>`.
    repository: String,
    /// "stable" | "experimental".
    channel: Mutex<String>,
    /// Bumped on a channel switch; work started before it is discarded.
    generation: std::sync::atomic::AtomicU64,
    /// The feed base that worked most recently; tried first next time.
    last_good: Mutex<Option<String>>,
    /// The announced update, the feed base it came from, and its build.
    available: Mutex<Option<(tauri_plugin_updater::Update, String, &'static str)>>,
    /// Offers whose signature did not hold up, by [`offer_key`]. Manifests
    /// are unsigned, so one source can announce a version it cannot deliver;
    /// remembering the bad offer lets the next-best one through instead of
    /// failing on the same offer every round. Cleared when a check starts.
    rejected: Mutex<std::collections::HashSet<String>>,
    busy: std::sync::atomic::AtomicBool,
}

/// How one download attempt of the announced offer ended.
#[derive(Debug, PartialEq)]
enum DownloadOutcome {
    /// Verified and staged for install on exit.
    Staged,
    /// A channel switch made this download moot.
    Superseded,
    /// The offer itself is bad (its signature does not verify or names
    /// another version or file); it has been added to `rejected`.
    InvalidOffer(String),
    /// Every source failed for another reason (network, timeouts).
    Failed(String),
}

/// Identity of one manifest offer: the claimed version, installer and the
/// signature it came with. Not the source: mirrors serve the same manifest,
/// so one rejection covers every copy of it.
fn offer_key(update: &tauri_plugin_updater::Update) -> String {
    format!(
        "{}\n{}\n{}",
        update.version, update.download_url, update.signature
    )
}

/// The signed version and file must be the ones the manifest claims. Checked
/// before an offer is accepted; the signature itself is verified on download.
pub fn signed_fields_match(signature: &str, version: &str, file_name: &str) -> Result<(), String> {
    let fields = signed_fields(signature);
    let signed_version = fields.get("version").map(String::as_str);
    if signed_version.and_then(parse_stable_version) != parse_stable_version(version) {
        return Err(format!(
            "update manifest claims {version}, its signature names {}",
            signed_version.unwrap_or("(none)")
        ));
    }
    let signed_file = fields.get("file").map(String::as_str);
    if signed_file != Some(file_name) {
        return Err(format!(
            "update manifest names {file_name}, its signature names {}",
            signed_file.unwrap_or("(none)")
        ));
    }
    Ok(())
}

impl TauriUpdaterDriver {
    pub fn new(app: tauri::AppHandle, channel: &str) -> Self {
        let failure_file = update_temp_dir().join("install-failure.txt");
        if let Ok(reason) = std::fs::read_to_string(&failure_file) {
            crate::diag!(
                "[updates] previous installer launch failed: {}",
                reason.trim()
            );
            // Logged once; a stale file would repeat the line on every launch.
            let _ = std::fs::remove_file(&failure_file);
        }
        let repository = crate::brand::load_brand()
            .ok()
            .and_then(|brand| repository_base(&brand.repository_url));
        let pubkey_pinned = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|updater| updater.get("pubkey"))
            .and_then(Value::as_str)
            .is_some_and(|pubkey| !pubkey.trim().is_empty());
        // Installed Windows builds only: dev runs never touch the feed, and a
        // build without a pinned key has nothing to verify against.
        let supported =
            cfg!(windows) && !crate::paths::is_dev() && pubkey_pinned && repository.is_some();
        TauriUpdaterDriver {
            inner: Arc::new(TauriUpdaterInner {
                app,
                events: EventHub::new(),
                supported,
                repository: repository.unwrap_or_default(),
                channel: Mutex::new(channel.to_string()),
                generation: std::sync::atomic::AtomicU64::new(0),
                last_good: Mutex::new(None),
                available: Mutex::new(None),
                rejected: Mutex::new(std::collections::HashSet::new()),
                busy: std::sync::atomic::AtomicBool::new(false),
            }),
        }
    }
}

impl TauriUpdaterInner {
    fn emit(&self, event: UpdaterDriverEvent) {
        let value = serde_json::to_value(&event).expect("event serializes");
        self.events.emit(&value);
    }

    fn updater_for(&self, base: &str) -> Result<tauri_plugin_updater::Updater, String> {
        use tauri_plugin_updater::UpdaterExt;
        let endpoint = url::Url::parse(&format!("{base}/{MANIFEST_NAME}"))
            .map_err(|error| error.to_string())?;
        self.app
            .updater_builder()
            .endpoints(vec![endpoint])
            // Every offer comes back; `offer_for` applies the version rule,
            // which depends on the installer's build.
            .map(|builder| builder.version_comparator(|_, _| true))
            .and_then(|builder| builder.timeout(FEED_PROBE_TIMEOUT).build())
            .map_err(|error| error.to_string())
    }

    fn direct(&self) -> String {
        channel_feed_base(
            &self.repository,
            &self.channel.lock().expect("updater channel poisoned"),
        )
    }

    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// End a check or download started in `generation`. Work superseded by a
    /// channel switch leaves `busy` to the new channel's work.
    fn release_busy(&self, generation: u64) {
        if generation == self.generation() {
            self.busy.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// The build of a manifest's installer and whether it is an offer: it
    /// must be the build of the followed channel, and an installer of this
    /// build must be newer (and newer than one already staged); an Electron
    /// installer on the stable channel is a switch back, at any version.
    fn offer_for(
        &self,
        update: &tauri_plugin_updater::Update,
    ) -> Result<Option<&'static str>, String> {
        // The manifest is unsigned: never let it point the client at anything
        // but this repository's release assets.
        if !is_release_asset(update.download_url.as_str(), &self.repository) {
            return Err(format!(
                "update manifest points outside the release: {}",
                update.download_url
            ));
        }
        let Some(product) = installer_product(&installer_file_name(&update.download_url)) else {
            return Err(format!(
                "update manifest names an unexpected installer: {}",
                update.download_url
            ));
        };
        if !installer_matches_arch(
            &installer_file_name(&update.download_url),
            std::env::consts::ARCH,
        ) {
            return Err("更新安装包与当前应用架构不匹配".to_string());
        }
        let channel = self
            .channel
            .lock()
            .expect("updater channel poisoned")
            .clone();
        if product != channel_product(&channel) {
            return Err(format!(
                "update manifest of the {channel} channel names the other build: {}",
                update.download_url
            ));
        }
        if parse_stable_version(&update.version).is_none() {
            return Ok(None);
        }
        signed_fields_match(
            &update.signature,
            &update.version,
            &installer_file_name(&update.download_url),
        )?;
        if product == PRODUCT && !is_newer_version(&update.version, &update.current_version) {
            return Ok(None);
        }
        // Already downloaded and waiting for exit: nothing new to fetch.
        let staged = READY_UPDATE.lock().expect("ready update poisoned");
        if let Some(ready) = staged.as_ref() {
            if ready.product == product && !is_newer_version(&update.version, &ready.update.version)
            {
                return Ok(None);
            }
        }
        Ok(Some(product))
    }

    /// Ask every source for the manifest and keep the newest offer not yet
    /// rejected. "No update" is only concluded when no source announced one,
    /// so a stale mirror can neither hide nor roll back a release.
    async fn probe_sources(
        self: &Arc<Self>,
    ) -> ProbeOutcome<(tauri_plugin_updater::Update, &'static str)> {
        let last_good = self
            .last_good
            .lock()
            .expect("updater last_good poisoned")
            .clone();
        let direct = self.direct();
        let bases = feed_base_candidates(&direct, last_good.as_deref());
        let probes = bases.iter().map(|base| {
            let inner = self.clone();
            let base = base.clone();
            async move {
                let updater = inner.updater_for(&base)?;
                let found = updater.check().await.map_err(|error| error.to_string())?;
                let offer = match found {
                    Some(update) if inner.is_rejected(&update) => None,
                    Some(update) => inner.offer_for(&update)?.map(|product| (update, product)),
                    None => None,
                };
                Ok::<_, String>((base, offer))
            }
        });
        let better = |next: &(tauri_plugin_updater::Update, &'static str),
                      best: &(tauri_plugin_updater::Update, &'static str)| {
            is_newer_version(&next.0.version, &best.0.version)
        };
        race_probes(probes, better).await
    }

    fn is_rejected(&self, update: &tauri_plugin_updater::Update) -> bool {
        self.rejected
            .lock()
            .expect("updater rejected poisoned")
            .contains(&offer_key(update))
    }

    /// Check, announce the best offer and download it. An offer whose
    /// signature does not hold up is dropped and the sources are asked again,
    /// so one bad source cannot hold back a real release.
    async fn check(self: Arc<Self>) {
        let generation = self.generation();
        self.emit(UpdaterDriverEvent::Checking);
        // Rejections last for this check only. A manifest whose signature
        // names another version or file is refused before any download, so
        // what lands here is bytes that failed to verify: maybe one broken
        // mirror while the others were down, which must not hide a real
        // release until restart.
        self.rejected
            .lock()
            .expect("updater rejected poisoned")
            .clear();
        // Each round drops at most one offer per source.
        let mut rounds_left = GITHUB_PROXIES.len() + 2;
        // Why the last offer was dropped: with nothing valid left, that is
        // the answer, not "up to date".
        let mut dropped: Option<String> = None;
        loop {
            rounds_left -= 1;
            let outcome = self.probe_sources().await;
            if generation != self.generation() {
                return; // the channel changed while the sources answered
            }
            match outcome {
                ProbeOutcome::Update(base, (update, product)) => {
                    *self.last_good.lock().expect("updater last_good poisoned") =
                        Some(base.clone());
                    let version = update.version.clone();
                    let release_notes = update.body.clone();
                    // A newer release supersedes the staged installer: what
                    // runs on exit must match what the UI reports.
                    *READY_UPDATE.lock().expect("ready update poisoned") = None;
                    *self.available.lock().expect("updater available poisoned") =
                        Some((update, base, product));
                    self.emit(UpdaterDriverEvent::Available {
                        version,
                        release_notes,
                        product: Some(product.to_string()),
                    });
                    // electron-updater autoDownload parity.
                    match self.download_offer().await {
                        DownloadOutcome::InvalidOffer(message) if rounds_left > 0 => {
                            crate::diag!("[updates] dropped an update offer that failed verification: {message}");
                            dropped = Some(message);
                        }
                        outcome => {
                            self.report_download(outcome);
                            return;
                        }
                    }
                }
                ProbeOutcome::NoUpdate(base) => {
                    *self.last_good.lock().expect("updater last_good poisoned") = Some(base);
                    *self.available.lock().expect("updater available poisoned") = None;
                    match dropped {
                        Some(message) => {
                            self.report_download(DownloadOutcome::InvalidOffer(message))
                        }
                        None => self.emit(UpdaterDriverEvent::NotAvailable),
                    }
                    return;
                }
                ProbeOutcome::Failed(error) => {
                    *self.last_good.lock().expect("updater last_good poisoned") = None;
                    self.emit(UpdaterDriverEvent::Error {
                        message: format!("无法连接更新源，请检查网络或稍后重试（{error}）"),
                    });
                    return;
                }
            }
        }
    }

    /// Download the announced offer and report how it ended.
    async fn download(self: &Arc<Self>) {
        let outcome = self.download_offer().await;
        self.report_download(outcome);
    }

    fn report_download(&self, outcome: DownloadOutcome) {
        match outcome {
            DownloadOutcome::Staged | DownloadOutcome::Superseded => {}
            DownloadOutcome::InvalidOffer(message) => self.emit(UpdaterDriverEvent::Error {
                message: format!("更新包签名校验失败，已丢弃（{message}）"),
            }),
            DownloadOutcome::Failed(message) => self.emit(UpdaterDriverEvent::Error {
                message: format!("下载更新失败，请检查网络或稍后重试（{message}）"),
            }),
        }
    }

    /// Remember an offer that failed verification and say why.
    fn reject(&self, update: &tauri_plugin_updater::Update, message: String) -> DownloadOutcome {
        self.rejected
            .lock()
            .expect("updater rejected poisoned")
            .insert(offer_key(update));
        DownloadOutcome::InvalidOffer(message)
    }

    /// Download through the source the manifest came from, then every other
    /// source. The plugin verifies the signature (and the signed version)
    /// before returning bytes; bytes that fail verification are discarded and
    /// the next source is tried. A signature that fails on every source, or
    /// that names another version or file, rejects the offer.
    async fn download_offer(self: &Arc<Self>) -> DownloadOutcome {
        let generation = self.generation();
        let Some((update, base, product)) = self
            .available
            .lock()
            .expect("updater available poisoned")
            .clone()
        else {
            return DownloadOutcome::Superseded;
        };
        let direct = self.direct();
        let file_name = installer_file_name(&update.download_url);
        let last_good = Some(base.as_str());
        let mut last_error = String::new();
        let mut signature_failed = false;
        for source in feed_base_candidates(&direct, last_good) {
            if generation != self.generation() {
                return DownloadOutcome::Superseded;
            }
            let routed = route_download_url(update.download_url.as_str(), &source, &direct);
            let Ok(routed) = url::Url::parse(&routed) else {
                continue;
            };
            let mut attempt = update.clone();
            attempt.download_url = routed;
            attempt.timeout = Some(DOWNLOAD_TIMEOUT);
            let mut meter = ProgressMeter::new();
            let inner = self.clone();
            let result = attempt
                .download(
                    move |chunk, total| {
                        // A superseded download stays silent.
                        if inner.generation() != generation {
                            return;
                        }
                        if let Some(event) = meter.record(chunk, total) {
                            inner.emit(event);
                        }
                    },
                    || {},
                )
                .await;
            if generation != self.generation() {
                return DownloadOutcome::Superseded;
            }
            match result {
                Ok(bytes) => {
                    // The verified signature's trusted comment also names the
                    // file: an installer filed under another name (and so
                    // possibly another build) is refused.
                    let signed_file = signed_fields(&update.signature).remove("file");
                    if signed_file.as_deref() != Some(file_name.as_str()) {
                        let message = format!(
                            "signature names {}, manifest says {file_name}",
                            signed_file.as_deref().unwrap_or("(none)")
                        );
                        return self.reject(&update, message);
                    }
                    // Staged under the lock a channel switch takes to bump the
                    // generation, so a switch either happens first (and this
                    // download is dropped) or clears what is staged here.
                    let mut staged = READY_UPDATE.lock().expect("ready update poisoned");
                    if generation != self.generation() {
                        return DownloadOutcome::Superseded;
                    }
                    *staged = Some(ReadyUpdate {
                        update,
                        bytes,
                        product,
                        file_name,
                    });
                    self.emit(UpdaterDriverEvent::Downloaded);
                    return DownloadOutcome::Staged;
                }
                // Bytes that fail verification may be a broken or hostile
                // mirror: discard them and try the next source.
                Err(error @ tauri_plugin_updater::Error::Minisign(_)) => {
                    last_error = error.to_string();
                    signature_failed = true;
                }
                // The signature itself names another version (or none): the
                // offer is wrong on every source.
                Err(
                    error @ (tauri_plugin_updater::Error::SignedVersionMismatch { .. }
                    | tauri_plugin_updater::Error::MissingSignedVersion
                    | tauri_plugin_updater::Error::Base64(_)
                    | tauri_plugin_updater::Error::SignatureUtf8(_)),
                ) => {
                    return self.reject(&update, error.to_string());
                }
                // A network failure on a later source must not hide a
                // signature failure on an earlier one.
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }
        // No source delivered verified bytes and at least one delivered bytes
        // that failed verification: the offer's signature is not ours.
        if signature_failed {
            return self.reject(&update, last_error);
        }
        DownloadOutcome::Failed(last_error)
    }
}

impl UpdaterDriver for TauriUpdaterDriver {
    fn current_version(&self) -> String {
        self.inner.app.package_info().version.to_string()
    }

    fn supported(&self) -> bool {
        self.inner.supported
    }

    fn channels_supported(&self) -> bool {
        true
    }

    fn set_channel(&self, channel: &str) {
        {
            let mut current = self.inner.channel.lock().expect("updater channel poisoned");
            if *current == channel {
                return;
            }
            *current = channel.to_string();
        }
        {
            // Bumped under the staging lock: see `download`.
            let mut staged = READY_UPDATE.lock().expect("ready update poisoned");
            self.inner
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *staged = None;
        }
        *self
            .inner
            .available
            .lock()
            .expect("updater available poisoned") = None;
        *self
            .inner
            .last_good
            .lock()
            .expect("updater last_good poisoned") = None;
        self.inner
            .rejected
            .lock()
            .expect("updater rejected poisoned")
            .clear();
        // Work of the old channel may still be running; its results are
        // dropped by generation, so let the new check start now.
        self.inner
            .busy
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    fn configure(&self) {}

    fn check(&self) -> Result<(), String> {
        if !self.inner.supported {
            return Ok(());
        }
        if self
            .inner
            .busy
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        let inner = self.inner.clone();
        let generation = inner.generation();
        tauri::async_runtime::spawn(async move {
            inner.clone().check().await;
            inner.release_busy(generation);
        });
        Ok(())
    }

    fn download(&self) {
        if !self.inner.supported
            || self
                .inner
                .busy
                .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let inner = self.inner.clone();
        let generation = inner.generation();
        tauri::async_runtime::spawn(async move {
            inner.download().await;
            inner.release_busy(generation);
        });
    }

    /// "重启并安装": run the ordered quit flow; `RunEvent::Exit` then hands
    /// the verified installer to Windows and relaunches Murge afterwards.
    fn quit_and_install(&self) {
        if !self.inner.supported
            || READY_UPDATE
                .lock()
                .map(|slot| slot.is_none())
                .unwrap_or(true)
        {
            return;
        }
        RESTART_AFTER_INSTALL.store(true, std::sync::atomic::Ordering::SeqCst);
        INSTALL_ON_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
        let app = self.inner.app.clone();
        tauri::async_runtime::spawn(async move {
            crate::lifecycle::begin_application_shutdown(app, false).await;
        });
    }

    fn on_event(&self, listener: EventListener) -> i64 {
        self.inner.events.subscribe(listener)
    }

    fn dispose(&self) {}
}

/// Owns the application-update state machine. It wraps a narrow
/// [`UpdaterDriver`] and reduces its event stream into a single
/// [`UpdateState`] snapshot that is pushed to renderer windows and returned
/// from the narrow IPC commands.
#[derive(Clone)]
pub struct UpdateService {
    inner: Arc<UpdateServiceInner>,
}

struct UpdateServiceInner {
    driver: Arc<dyn UpdaterDriver>,
    state: Mutex<UpdateState>,
    listeners: EventHub,
    started: Mutex<bool>,
    poll_generation: std::sync::atomic::AtomicU64,
    /// A ready update remains installable while a newer feed check is in flight.
    downloaded_before_check: Mutex<Option<UpdateState>>,
}

impl UpdateService {
    pub fn new(driver: Arc<dyn UpdaterDriver>) -> Self {
        let state = default_update_state();
        UpdateService {
            inner: Arc::new(UpdateServiceInner {
                state: Mutex::new(UpdateState {
                    current_version: Some(driver.current_version()),
                    channels_supported: driver.supported() && driver.channels_supported(),
                    ..state
                }),
                driver,
                listeners: EventHub::new(),
                started: Mutex::new(false),
                poll_generation: std::sync::atomic::AtomicU64::new(0),
                downloaded_before_check: Mutex::new(None),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, UpdateState> {
        self.inner.state.lock().expect("update state poisoned")
    }

    /// Attach the driver and subscribe to its events. Call once after
    /// construction; idempotent.
    pub fn start(&self) {
        let mut started = self.inner.started.lock().expect("update started poisoned");
        if *started {
            return;
        }
        *started = true;
        drop(started);
        self.inner.driver.configure();
        let service = self.clone();
        self.inner.driver.on_event(Arc::new(move |event| {
            service.handle_event(event);
        }));
    }

    /// One poll tick: re-check unless a check/download is in flight. Split
    /// from the timer so tests can drive the cadence deterministically.
    pub async fn poll_tick(&self) {
        if !self.inner.driver.supported() {
            return;
        }
        let _ = self.check().await;
    }

    /// Poll the feed on a fixed cadence while the app is running (the
    /// mihomo-party / sparkle model), so a Release published mid-session is
    /// picked up without a restart. No-op when the build cannot self-update.
    /// `check()` already refuses to restart an in-flight check/download, so
    /// overlapping ticks are safe.
    pub fn start_polling(&self, poll_interval_ms: u64) {
        if !self.inner.driver.supported() {
            return;
        }
        let generation = self
            .inner
            .poll_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let service = self.clone();
        // Tauri's runtime, not tokio::spawn: setup() runs on the event-loop
        // thread, which has not entered a Tokio runtime.
        tauri::async_runtime::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_millis(poll_interval_ms));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await; // polling never fires the first check eagerly
            loop {
                ticker.tick().await;
                if service
                    .inner
                    .poll_generation
                    .load(std::sync::atomic::Ordering::SeqCst)
                    != generation
                {
                    return; // stopped or restarted
                }
                service.poll_tick().await;
            }
        });
    }

    pub fn stop_polling(&self) {
        self.inner
            .poll_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// The "自动检查更新" preference: poll while it is on, stop when it is
    /// turned off (Electron's `applyUpdatePolling`).
    pub fn apply_polling(&self, enabled: bool) {
        if enabled {
            self.start_polling(POLL_INTERVAL_MS);
        } else {
            self.stop_polling();
        }
    }

    pub fn get_state(&self) -> UpdateState {
        self.state().clone()
    }

    pub fn get_state_value(&self) -> Value {
        serde_json::to_value(self.get_state()).expect("update state serializes")
    }

    pub async fn check(&self) -> Result<UpdateState, IpcError> {
        if !self.inner.driver.supported() {
            self.transition(UpdateState {
                phase: "error".to_string(),
                error: Some(NOT_SUPPORTED.to_string()),
                can_install: false,
                ..self.get_state()
            });
            return Ok(self.get_state());
        }
        // Only coalesce work that is actually in flight. A downloaded update
        // is not terminal: a newer release may appear before the user
        // installs it, and the next manual/poll check must be allowed to
        // replace the stale package.
        {
            let current = self.state();
            if current.phase == "checking" || current.phase == "downloading" {
                return Ok(current.clone());
            }
        }
        {
            let mut pending = self
                .inner
                .downloaded_before_check
                .lock()
                .expect("update pending poisoned");
            *pending = if self.state().phase == "downloaded" {
                Some(self.get_state())
            } else {
                None
            };
        }
        self.transition(UpdateState {
            phase: "checking".to_string(),
            error: None,
            ..self.get_state()
        });
        match self.inner.driver.check() {
            Ok(()) => {}
            // A driver may fail synchronously (a pre-flight failure) WITHOUT
            // ever emitting an 'error' event. Without this the phase would
            // stay 'checking' forever and the guard above would reject every
            // later check. Reduce the failure into the same terminal 'error'
            // state the event path produces.
            Err(message) => {
                let restored = {
                    let mut pending = self
                        .inner
                        .downloaded_before_check
                        .lock()
                        .expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState {
                        error: Some(message),
                        ..restored
                    });
                } else {
                    self.transition(UpdateState {
                        phase: "error".to_string(),
                        error: Some(message),
                        can_install: false,
                        ..self.get_state()
                    });
                }
            }
        }
        Ok(self.get_state())
    }

    pub async fn download(&self) -> Result<UpdateState, IpcError> {
        if !self.inner.driver.supported() {
            return Ok(self.get_state());
        }
        if self.state().phase != "available" {
            return Ok(self.get_state());
        }
        self.transition(UpdateState {
            phase: "downloading".to_string(),
            error: None,
            ..self.get_state()
        });
        self.inner.driver.download();
        Ok(self.get_state())
    }

    /// Switch release channel: forget the old channel's offer and staged
    /// installer, then check the new channel at once (an explicit user
    /// choice, so it ignores the automatic-check preference).
    pub async fn set_channel(&self, channel: &str) {
        self.inner.driver.set_channel(channel);
        *self
            .inner
            .downloaded_before_check
            .lock()
            .expect("update pending poisoned") = None;
        self.transition(UpdateState {
            phase: "idle".to_string(),
            available_version: None,
            available_product: None,
            release_notes: None,
            progress: None,
            error: None,
            can_install: false,
            ..self.get_state()
        });
        if self.inner.driver.supported() {
            let _ = self.check().await;
        }
    }

    pub fn install(&self) {
        if self.inner.driver.supported() && self.state().can_install {
            self.inner.driver.quit_and_install();
        }
    }

    pub fn subscribe(&self, listener: EventListener) -> i64 {
        self.inner.listeners.subscribe(listener)
    }

    /// Dispose stops the poll timer and detaches the driver.
    #[allow(dead_code)] // wired into before-quit cleanup (before-quit slice)
    pub fn dispose(&self) {
        self.stop_polling();
        self.inner.driver.dispose();
    }

    /// serde tags the driver events kebab-case; the renderer-facing progress
    /// fields are camelCase. Accept both spellings on the boundary.
    fn field<'a>(event: &'a Value, camel: &str, kebab: &str) -> Option<&'a Value> {
        event.get(camel).or_else(|| event.get(kebab))
    }

    fn handle_event(&self, event: &Value) {
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match kind.as_str() {
            "checking" => {
                self.transition(UpdateState {
                    phase: "checking".to_string(),
                    error: None,
                    ..self.get_state()
                });
            }
            "not-available" => {
                let restored = {
                    let mut pending = self
                        .inner
                        .downloaded_before_check
                        .lock()
                        .expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState {
                        error: None,
                        ..restored
                    });
                } else {
                    self.transition(UpdateState {
                        phase: "not-available".to_string(),
                        available_version: None,
                        available_product: None,
                        release_notes: None,
                        progress: None,
                        can_install: false,
                        error: None,
                        ..self.get_state()
                    });
                }
            }
            "available" => {
                *self
                    .inner
                    .downloaded_before_check
                    .lock()
                    .expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "available".to_string(),
                    available_version: event
                        .get("version")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    release_notes: Self::field(event, "releaseNotes", "release_notes")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    available_product: Some(
                        event
                            .get("product")
                            .and_then(Value::as_str)
                            .unwrap_or(PRODUCT)
                            .to_string(),
                    ),
                    progress: None,
                    can_install: false,
                    error: None,
                    ..self.get_state()
                });
            }
            "download-progress" => {
                *self
                    .inner
                    .downloaded_before_check
                    .lock()
                    .expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "downloading".to_string(),
                    can_install: false,
                    progress: Some(UpdateProgress {
                        percent: event.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
                        bytes_per_second: Self::field(event, "bytesPerSecond", "bytes-per-second")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        transferred: event
                            .get("transferred")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        total: event.get("total").and_then(Value::as_u64),
                    }),
                    ..self.get_state()
                });
            }
            "downloaded" => {
                *self
                    .inner
                    .downloaded_before_check
                    .lock()
                    .expect("update pending poisoned") = None;
                self.transition(UpdateState {
                    phase: "downloaded".to_string(),
                    can_install: true,
                    progress: None,
                    error: None,
                    ..self.get_state()
                });
            }
            "error" => {
                let restored = {
                    let mut pending = self
                        .inner
                        .downloaded_before_check
                        .lock()
                        .expect("update pending poisoned");
                    pending.take()
                };
                if let Some(restored) = restored {
                    self.transition(UpdateState {
                        error: Some(
                            event
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        ),
                        ..restored
                    });
                } else {
                    self.transition(UpdateState {
                        phase: "error".to_string(),
                        error: Some(
                            event
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        ),
                        can_install: false,
                        ..self.get_state()
                    });
                }
            }
            _ => {}
        }
    }

    fn transition(&self, next: UpdateState) {
        *self.state() = next.clone();
        let value = serde_json::to_value(&next).expect("update state serializes");
        self.inner.listeners.emit(&value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    struct FakeDriver {
        supported: bool,
        configure_calls: AtomicUsize,
        check_calls: AtomicUsize,
        download_calls: AtomicUsize,
        install_calls: AtomicUsize,
        dispose_calls: AtomicUsize,
        check_fails: AtomicBool,
        events: EventHub,
    }

    impl FakeDriver {
        fn new(supported: bool) -> Arc<FakeDriver> {
            Arc::new(FakeDriver {
                supported,
                configure_calls: AtomicUsize::new(0),
                check_calls: AtomicUsize::new(0),
                download_calls: AtomicUsize::new(0),
                install_calls: AtomicUsize::new(0),
                dispose_calls: AtomicUsize::new(0),
                check_fails: AtomicBool::new(false),
                events: EventHub::new(),
            })
        }

        fn emit(&self, event: &UpdaterDriverEvent) {
            let value = serde_json::to_value(event).expect("event serializes");
            self.events.emit(&value);
        }
    }

    impl UpdaterDriver for FakeDriver {
        fn current_version(&self) -> String {
            "0.0.0-test".to_string()
        }
        fn supported(&self) -> bool {
            self.supported
        }
        fn configure(&self) {
            self.configure_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn check(&self) -> Result<(), String> {
            self.check_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.check_fails.load(std::sync::atomic::Ordering::SeqCst) {
                Err("feed descriptor missing".to_string())
            } else {
                Ok(())
            }
        }
        fn download(&self) {
            self.download_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn quit_and_install(&self) {
            self.install_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn on_event(&self, listener: EventListener) -> i64 {
            self.events.subscribe(listener)
        }
        fn dispose(&self) {
            self.dispose_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn counters(driver: &FakeDriver) -> (usize, usize, usize, usize, usize) {
        (
            driver
                .configure_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            driver.check_calls.load(std::sync::atomic::Ordering::SeqCst),
            driver
                .download_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            driver
                .install_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            driver
                .dispose_calls
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    #[tokio::test]
    async fn start_configures_the_driver_once_and_carries_the_version() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        assert_eq!(counters(&driver).0, 0);
        service.start();
        service.start();
        assert_eq!(counters(&driver).0, 1);
        assert_eq!(
            service.get_state().current_version.as_deref(),
            Some("0.0.0-test")
        );
        assert_eq!(service.get_state().phase, "idle");
    }

    #[tokio::test]
    async fn unsupported_check_reports_the_clear_copy_and_never_touches_the_driver() {
        let driver = FakeDriver::new(false);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "error");
        assert_eq!(
            state.error.as_deref(),
            Some("当前构建不支持自动更新（仅安装版可用）")
        );
        assert!(!state.can_install);
        assert_eq!(counters(&driver).1, 0);
        // Polling is a no-op on unsupported builds.
        service.start_polling(10);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(counters(&driver).1, 0);
    }

    #[tokio::test]
    async fn supported_check_transitions_to_checking() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "checking");
        assert_eq!(counters(&driver).1, 1);
        // The in-flight check is coalesced (no second driver call).
        let again = service.check().await.unwrap();
        assert_eq!(again.phase, "checking");
        assert_eq!(counters(&driver).1, 1);
        // The terminal event unblocks later checks.
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        let next = service.check().await.unwrap();
        assert_eq!(next.phase, "checking");
        assert_eq!(counters(&driver).1, 2);
    }

    #[tokio::test]
    async fn synchronous_check_failure_is_reduced_into_error() {
        let driver = FakeDriver::new(true);
        driver
            .check_fails
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let service = UpdateService::new(driver.clone());
        service.start();
        let state = service.check().await.unwrap();
        assert_eq!(state.phase, "error");
        assert_eq!(state.error.as_deref(), Some("feed descriptor missing"));
        // A later check must not be blocked by the previous stuck phase.
        driver
            .check_fails
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let next = service.check().await.unwrap();
        assert_eq!(next.phase, "checking");
    }

    #[tokio::test]
    async fn poll_ticks_coalesce_in_flight_checks() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        // Polling never fires the first check eagerly.
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 1);
        // The in-flight check is still 'checking', so the next tick coalesces.
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 1);
        // After the check resolves, the following tick checks again.
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        service.poll_tick().await;
        assert_eq!(counters(&driver).1, 2);
    }

    #[tokio::test]
    async fn downloaded_updates_are_not_terminal_for_checks() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.1".to_string(),
            release_notes: None,
            product: None,
        });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        let state = service.check().await.unwrap();
        assert_eq!(counters(&driver).1, 1);
        // The downloaded package stays installable while re-checking.
        assert_eq!(state.phase, "checking");
        assert_eq!(state.available_version.as_deref(), Some("1.0.1"));
        assert!(state.can_install);
        // A newer release replaces it.
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.2".to_string(),
            release_notes: None,
            product: None,
        });
        let state = service.get_state();
        assert_eq!(state.phase, "available");
        assert_eq!(state.available_version.as_deref(), Some("1.0.2"));
        assert!(!state.can_install);
        driver.emit(&UpdaterDriverEvent::DownloadProgress {
            percent: 10.0,
            bytes_per_second: 1,
            transferred: 1,
            total: Some(10),
        });
        let state = service.get_state();
        assert_eq!(state.phase, "downloading");
        assert_eq!(state.available_version.as_deref(), Some("1.0.2"));
    }

    #[tokio::test]
    async fn a_failed_newer_check_keeps_the_downloaded_update_installable() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.1".to_string(),
            release_notes: None,
            product: None,
        });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.check().await.unwrap();
        driver.emit(&UpdaterDriverEvent::Error {
            message: "feed unavailable".to_string(),
        });
        let state = service.get_state();
        assert_eq!(state.phase, "downloaded");
        assert_eq!(state.available_version.as_deref(), Some("1.0.1"));
        assert!(state.can_install);
        assert_eq!(state.error.as_deref(), Some("feed unavailable"));
    }

    #[tokio::test]
    async fn event_reduction_covers_progress_and_not_available() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        driver.emit(&UpdaterDriverEvent::Checking);
        assert_eq!(service.get_state().phase, "checking");
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.2.3".to_string(),
            release_notes: Some("notes".to_string()),
            product: None,
        });
        let state = service.get_state();
        assert_eq!(state.phase, "available");
        assert_eq!(state.available_version.as_deref(), Some("1.2.3"));
        assert!(!state.can_install);
        driver.emit(&UpdaterDriverEvent::DownloadProgress {
            percent: 42.0,
            bytes_per_second: 2048,
            transferred: 1024,
            total: Some(4096),
        });
        assert_eq!(
            service.get_state().progress,
            Some(UpdateProgress {
                percent: 42.0,
                bytes_per_second: 2048,
                transferred: 1024,
                total: Some(4096)
            })
        );
        driver.emit(&UpdaterDriverEvent::Downloaded);
        let state = service.get_state();
        assert_eq!(state.phase, "downloaded");
        assert!(state.can_install);
        assert_eq!(state.progress, None);
        driver.emit(&UpdaterDriverEvent::NotAvailable);
        let state = service.get_state();
        assert_eq!(state.phase, "not-available");
        assert_eq!(state.available_version, None);
        assert!(!state.can_install);
    }

    #[tokio::test]
    async fn download_only_starts_from_available_and_is_a_noop_when_done() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 0);
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.1".to_string(),
            release_notes: None,
            product: None,
        });
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 1);
        assert_eq!(service.get_state().phase, "downloading");
        // Already downloaded → no second download call.
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.download().await.unwrap();
        assert_eq!(counters(&driver).2, 1);
    }

    #[tokio::test]
    async fn install_requires_downloaded_and_the_gate_blocks_it() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        service.install();
        assert_eq!(counters(&driver).3, 0);
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.1".to_string(),
            release_notes: None,
            product: None,
        });
        service.install();
        assert_eq!(counters(&driver).3, 0);
        driver.emit(&UpdaterDriverEvent::Downloaded);
        service.install();
        assert_eq!(counters(&driver).3, 1);
        // The gated production driver never installs.
        let gated = UpdateService::new(Arc::new(GatedUpdaterDriver::new()));
        gated.start();
        gated.install();
        assert_eq!(gated.get_state().phase, "idle");
        assert_eq!(
            gated.get_state().current_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn installer_hand_off_elevates_before_exit_and_runs_installer_visibly() {
        use base64::Engine;
        assert_eq!(ps_literal("a'b"), "'a''b'");
        let helper = elevated_helper_script(
            "C:\\Users\\O'Neil\\Temp\\Murge-Setup-0.9.34-x64.exe",
            &["--force-run"],
            4242,
            "C:\\t\\install-trace.txt",
            "C:\\t\\install-failure.txt",
        );
        assert!(helper.contains("Wait-Process -Id 4242"));
        assert!(helper.contains("-FilePath 'C:\\Users\\O''Neil\\Temp\\Murge-Setup-0.9.34-x64.exe' -ArgumentList '--force-run'"));
        assert!(helper.contains("-WindowStyle Normal"));
        assert!(!helper.contains("RunAs"));
        let request = elevation_request_script(
            &helper,
            "C:\\ps.exe",
            "C:\\t\\install-trace.txt",
            "C:\\t\\install-failure.txt",
        );
        assert!(request.contains("-Verb RunAs"));
        let encoded = request
            .split("'-EncodedCommand','")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .expect("helper embedded");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), helper);
    }

    #[test]
    fn each_channel_delivers_one_build() {
        assert_eq!(channel_product("stable"), "electron");
        assert_eq!(channel_product("experimental"), "tauri");
        assert_eq!(electron_installer_args(true), ["--force-run"]);
        assert_eq!(electron_installer_args(false), ["/S"]);
        // A driver without channels does not offer the setting.
        let service = UpdateService::new(FakeDriver::new(true));
        assert!(!service.get_state().channels_supported);
        assert_eq!(service.get_state_value()["channelsSupported"], false);
    }

    #[test]
    fn channel_feeds_are_derived_from_the_brand_repository() {
        assert_eq!(
            repository_base("https://github.com/RoaycL/Murge").as_deref(),
            Some("https://github.com/RoaycL/Murge")
        );
        assert_eq!(
            repository_base("https://github.com/RoaycL/Murge.git/").as_deref(),
            Some("https://github.com/RoaycL/Murge")
        );
        assert_eq!(repository_base("https://github.com/RoaycL"), None);
        assert_eq!(repository_base("not a url"), None);
        let brand = crate::brand::load_brand().unwrap();
        assert!(repository_base(&brand.repository_url).is_some());
        assert_eq!(
            channel_feed_base("https://github.com/o/r", "stable"),
            "https://github.com/o/r/releases/download/channel-stable"
        );
        assert_eq!(
            channel_feed_base("https://github.com/o/r", "experimental"),
            "https://github.com/o/r/releases/download/channel-experimental"
        );
    }

    #[test]
    fn feed_candidates_put_last_good_first_without_duplicates() {
        let direct = "https://github.com/o/r/releases/download/channel-experimental";
        assert_eq!(
            feed_base_candidates(direct, None),
            vec![
                direct.to_string(),
                format!("https://gh-proxy.org/{direct}"),
                format!("https://ghfast.top/{direct}"),
            ]
        );
        let mirror = format!("https://ghfast.top/{direct}");
        assert_eq!(
            feed_base_candidates(direct, Some(&mirror)),
            vec![
                mirror.clone(),
                direct.to_string(),
                format!("https://gh-proxy.org/{direct}")
            ]
        );
    }

    #[test]
    fn downloads_follow_the_manifest_source() {
        let direct = "https://github.com/o/r/releases/download/channel-experimental";
        let asset = "https://github.com/o/r/releases/download/v1.0.0/App_1.0.0_x64-setup.exe";
        assert_eq!(route_download_url(asset, direct, direct), asset);
        assert_eq!(
            route_download_url(asset, &format!("https://ghfast.top/{direct}"), direct),
            format!("https://ghfast.top/{asset}")
        );
        // Only GitHub assets are re-routed through a mirror.
        let elsewhere = "https://example.com/App.exe";
        assert_eq!(
            route_download_url(elsewhere, &format!("https://ghfast.top/{direct}"), direct),
            elsewhere
        );
    }

    #[test]
    fn only_this_repositorys_release_assets_are_downloadable() {
        let repository = "https://github.com/o/r";
        assert!(is_release_asset(
            "https://github.com/o/r/releases/download/v1.0.0/App_1.0.0_x64-setup.exe",
            repository
        ));
        for url in [
            "http://github.com/o/r/releases/download/v1.0.0/a.exe",
            "https://github.com:8443/o/r/releases/download/v1.0.0/a.exe",
            "https://github.com/other/r/releases/download/v1.0.0/a.exe",
            "https://github.com/o/r-evil/releases/download/v1.0.0/a.exe",
            "https://github.com/o/r/releases/download/v1.0.0/a.exe?x=1",
            "https://127.0.0.1:9090/o/r/releases/download/v1.0.0/a.exe",
            "https://ghfast.top/https://github.com/o/r/releases/download/v1.0.0/a.exe",
            "not a url",
        ] {
            assert!(!is_release_asset(url, repository), "{url}");
        }
    }

    #[test]
    fn installers_are_told_apart_by_name_and_versions_compare_strictly() {
        assert_eq!(installer_product("App_0.9.31_x64-setup.exe"), Some("tauri"));
        assert_eq!(
            installer_product("App_0.9.31_arm64-setup.exe"),
            Some("tauri")
        );
        assert_eq!(
            installer_product("App-Setup-0.9.31-x64.exe"),
            Some("electron")
        );
        assert_eq!(
            installer_product("App-Setup-0.9.31-arm64.exe"),
            Some("electron")
        );
        assert_eq!(installer_product("App-0.9.31.exe"), None);
        let url = url::Url::parse(
            "https://github.com/o/r/releases/download/v1/App%20X_1.0.0_x64-setup.exe",
        )
        .unwrap();
        assert_eq!(installer_file_name(&url), "App X_1.0.0_x64-setup.exe");
        assert!(is_newer_version("1.0.0", "0.9.31"));
        assert!(is_newer_version("v0.10.0", "0.9.31"));
        assert!(!is_newer_version("0.9.31", "0.9.31"));
        assert!(!is_newer_version("1.0.0-beta.1", "0.9.31"));
        assert!(!is_newer_version("1.0", "0.9.31"));
    }

    #[test]
    fn signed_fields_read_the_trusted_comment() {
        use base64::Engine;
        let text = "untrusted comment: signature from tauri secret key\nRUQ=\ntrusted comment: timestamp:1\tfile:App-Setup-1.0.0-x64.exe\tversion:1.0.0\nAA==\n";
        let signature = base64::engine::general_purpose::STANDARD.encode(text);
        let fields = signed_fields(&signature);
        assert_eq!(
            fields.get("file").map(String::as_str),
            Some("App-Setup-1.0.0-x64.exe")
        );
        assert_eq!(fields.get("version").map(String::as_str), Some("1.0.0"));
        assert!(signed_fields("not base64").is_empty());
    }

    #[test]
    fn an_offer_must_claim_the_version_and_file_its_signature_names() {
        use base64::Engine;
        let text = "untrusted comment: signature from tauri secret key\nRUQ=\ntrusted comment: timestamp:1\tfile:Murge_0.9.31_x64-setup.exe\tversion:0.9.31\nAA==\n";
        let signature = base64::engine::general_purpose::STANDARD.encode(text);
        assert!(signed_fields_match(&signature, "0.9.31", "Murge_0.9.31_x64-setup.exe").is_ok());
        assert!(signed_fields_match(&signature, "v0.9.31", "Murge_0.9.31_x64-setup.exe").is_ok());
        // A source that inflates the version of a real release is refused.
        assert!(signed_fields_match(&signature, "99.0.0", "Murge_0.9.31_x64-setup.exe").is_err());
        assert!(signed_fields_match(&signature, "0.9.31", "Murge_0.9.31_arm64-setup.exe").is_err());
        assert!(signed_fields_match("not base64", "0.9.31", "Murge_0.9.31_x64-setup.exe").is_err());
    }

    #[tokio::test]
    async fn the_best_offer_wins_whoever_answers_first() {
        use std::time::Duration;
        type Probe = std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(String, Option<u32>), String>> + Send>,
        >;
        let higher = |next: &u32, best: &u32| next > best;
        let probes: Vec<Probe> = vec![
            Box::pin(async { Ok(("stale-mirror".to_string(), None)) }),
            Box::pin(async { Ok(("replaying-mirror".to_string(), Some(3))) }),
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(("direct".to_string(), Some(7)))
            }),
            Box::pin(async { Err("timed out".to_string()) }),
        ];
        match race_probes(probes, higher).await {
            ProbeOutcome::Update(base, update) => {
                assert_eq!(base, "direct");
                assert_eq!(update, 7);
            }
            _ => panic!("expected the update"),
        }
        let none: Vec<Probe> = vec![
            Box::pin(async { Err("refused".to_string()) }),
            Box::pin(async { Ok(("direct".to_string(), None)) }),
        ];
        assert!(
            matches!(race_probes(none, higher).await, ProbeOutcome::NoUpdate(base) if base == "direct")
        );
        let failed: Vec<Probe> = vec![
            Box::pin(async { Err("a".to_string()) }),
            Box::pin(async { Err("b".to_string()) }),
        ];
        assert!(
            matches!(race_probes(failed, higher).await, ProbeOutcome::Failed(error) if error == "a; b")
        );
    }

    #[tokio::test]
    async fn offers_carry_notes_and_build_and_a_channel_switch_rechecks() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        assert_eq!(service.get_state().current_product, "tauri");
        driver.emit(&UpdaterDriverEvent::Available {
            version: "0.9.31".to_string(),
            release_notes: Some("- 修复".to_string()),
            product: Some("electron".to_string()),
        });
        let state = service.get_state_value();
        assert_eq!(state["releaseNotes"], "- 修复");
        assert_eq!(state["availableProduct"], "electron");
        assert_eq!(state["currentProduct"], "tauri");
        driver.emit(&UpdaterDriverEvent::Downloaded);
        assert!(service.get_state().can_install);
        service.set_channel("experimental").await;
        let state = service.get_state();
        assert_eq!(state.phase, "checking");
        assert!(!state.can_install);
        assert_eq!(state.available_product, None);
        assert_eq!(counters(&driver).1, 1);
    }

    #[tokio::test]
    async fn polling_follows_the_auto_check_preference() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        service.start();
        service.apply_polling(false);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(counters(&driver).1, 0);
        service.start_polling(5);
        service.apply_polling(false);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(counters(&driver).1, 0);
    }

    #[test]
    fn progress_meter_reports_percent_and_always_the_final_chunk() {
        let mut meter = ProgressMeter::new();
        let first = meter.record(25, Some(100)).expect("first chunk reports");
        match first {
            UpdaterDriverEvent::DownloadProgress {
                percent,
                transferred,
                total,
                ..
            } => {
                assert_eq!(percent, 25.0);
                assert_eq!(transferred, 25);
                assert_eq!(total, Some(100));
            }
            other => panic!("unexpected {other:?}"),
        }
        // Throttled inside the 250 ms window …
        assert!(meter.record(25, Some(100)).is_none());
        // … but the completing chunk always reports.
        match meter.record(50, Some(100)).expect("final chunk reports") {
            UpdaterDriverEvent::DownloadProgress { percent, .. } => assert_eq!(percent, 100.0),
            other => panic!("unexpected {other:?}"),
        }
        // Unknown length never divides by zero.
        let mut unknown = ProgressMeter::new();
        match unknown.record(10, None).unwrap() {
            UpdaterDriverEvent::DownloadProgress { percent, total, .. } => {
                assert_eq!(percent, 0.0);
                assert_eq!(total, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn updater_config_pins_signature_policy() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["requireSignedVersion"], json!(true));
        // The pinned release key: a base64-wrapped minisign Ed25519 public key.
        use base64::Engine;
        let pubkey = updater["pubkey"].as_str().expect("pubkey is pinned");
        let text = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(pubkey)
                .unwrap(),
        )
        .unwrap();
        let key_line = text.lines().nth(1).expect("key line");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(key_line)
            .unwrap();
        assert_eq!(raw.len(), 42);
        assert_eq!(&raw[..2], b"Ed");
        assert_eq!(updater["windows"]["installMode"], json!("passive"));
        // Downgrades stay forbidden and no insecure transport is allowed.
        assert!(updater.get("allowDowngrades").is_none());
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
        assert!(updater.get("dangerousAcceptInvalidCerts").is_none());
    }

    #[test]
    fn install_on_exit_without_a_ready_update_is_a_noop() {
        install_ready_update_on_exit();
        cancel_install_on_exit();
        install_ready_update_on_exit();
        INSTALL_ON_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    #[test]
    fn coerce_update_state_falls_back_field_wise() {
        assert_eq!(coerce_update_state(&json!(null)), default_update_state());
        assert_eq!(
            coerce_update_state(&json!({ "phase": "bogus" })),
            default_update_state()
        );
        let state = coerce_update_state(&json!({
            "phase": "downloading",
            "currentVersion": "1.0.0",
            "availableVersion": "1.0.1",
            "progress": { "percent": 12.5, "bytesPerSecond": 8, "transferred": 3 },
            "error": "x",
            "canInstall": true
        }));
        assert_eq!(state.phase, "downloading");
        assert_eq!(state.current_version.as_deref(), Some("1.0.0"));
        assert_eq!(state.progress.as_ref().map(|p| p.percent), Some(12.5));
        assert_eq!(state.progress.as_ref().and_then(|p| p.total), None);
        assert!(state.can_install);
    }

    #[tokio::test]
    async fn state_events_reach_subscribers() {
        let driver = FakeDriver::new(true);
        let service = UpdateService::new(driver.clone());
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        service.subscribe(Arc::new(move |value| {
            sink.lock()
                .unwrap()
                .push(value["phase"].as_str().unwrap_or_default().to_string());
        }));
        service.start();
        driver.emit(&UpdaterDriverEvent::Available {
            version: "1.0.1".to_string(),
            release_notes: None,
            product: None,
        });
        driver.emit(&UpdaterDriverEvent::Downloaded);
        assert_eq!(
            seen.lock().unwrap().clone(),
            vec!["available".to_string(), "downloaded".to_string()]
        );
        service.dispose();
        assert_eq!(counters(&driver).4, 1);
    }
    #[test]
    fn signed_installers_must_match_the_current_cpu_on_both_channels() {
        for (arch, other) in [("x86_64", "aarch64"), ("aarch64", "x86_64")] {
            let suffix = if arch == "x86_64" { "x64" } else { "arm64" };
            for file in [
                format!("Murge_0.9.32_{suffix}-setup.exe"),
                format!("Murge-Setup-0.9.32-{suffix}.exe"),
            ] {
                assert!(installer_matches_arch(&file, arch));
                assert!(!installer_matches_arch(&file, other));
                assert!(!installer_matches_arch(&file, "unsupported"));
            }
        }
    }
}
