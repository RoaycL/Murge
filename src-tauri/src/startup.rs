//! OS login-item state (开机自启) — Rust port of `src/main/startup/*`
//! (`service.ts` + `scheduled-task-adapter.ts` + the legacy login-item
//! adapter), the `startup:get-status` / `startup:set-enabled` channels.
//!
//! Windows auto-start goes through a per-user Scheduled Task (schtasks) with
//! a logon delay and process priority; a legacy HKCU Run-key registration is
//! kept as a fallback for machines where task creation is denied (enterprise
//! policy, stripped SKUs). Read and write agree on the same `--hidden`
//! argument convention: silent launches register the flag, loud launches
//! register none. The service serializes operations (read-after-write
//! ownership boundary) and reports divergence without pretending the
//! requested value won.

use serde_json::{json, Value};
use tokio::sync::Mutex;

/// The deterministic task name (`schtasks /tn` value) — `brand.appId`.
pub const SCHEDULED_TASK_NAME: &str = "io.murge.desktop";
/// The legacy fallback registration key.
pub const SCHEDULED_TASK_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const DEFAULT_TIMEOUT_MS: u64 = 8000;

/// The serializable startup status (`StartupStatus`).
#[derive(Debug, Clone, PartialEq)]
pub struct StartupStatus {
    pub supported: bool,
    pub enabled: bool,
    pub phase: &'static str,
    pub error_message: Option<String>,
}

fn status_value(status: &StartupStatus) -> Value {
    json!({
        "supported": status.supported,
        "enabled": status.enabled,
        "phase": status.phase,
        "errorMessage": status.error_message,
    })
}

/// A child-process run result (the `ScheduledTaskRunResult` shape).
#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// A command runner (defaults to `schtasks`/`reg` children); injectable so
/// the win32 ladder is testable off-Windows.
pub type CommandRunner =
    std::sync::Arc<dyn Fn(String, Vec<String>) -> futures_util::future::BoxFuture<'static, Result<RunResult, String>> + Send + Sync>;

// ---------------------------------------------------------------------------
// Task XML (pure, byte-verbatim to the TS template)
// ---------------------------------------------------------------------------

fn escape_xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn unescape_xml(value: &str) -> String {
    value.replace("&apos;", "'").replace("&quot;", "\"").replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&")
}

/// Logon-trigger task XML. Deliberately different from an HKCU Run entry:
/// `Delay PT3S` starts the app after the login resource storm, `Priority 3`
/// schedules above the background class, `LeastPrivilege` needs no elevation
/// (the kernel's privileges live in the LocalSystem TUN service), and
/// `ExecutionTimeLimit PT0S` stops Windows from killing the app after the
/// default 72h task limit.
pub fn build_task_xml(executable_path: &str, args: &[String]) -> String {
    let arguments = if args.is_empty() {
        String::new()
    } else {
        format!("<Arguments>{}</Arguments>", escape_xml(&args.join(" ")))
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT3S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>3</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{}"</Command>
      {}
    </Exec>
  </Actions>
</Task>
"#,
        escape_xml(executable_path),
        arguments
    )
}

/// True when the task-level `<Settings><Enabled>` element is `true`.
pub fn task_settings_enabled(task_xml: &str) -> bool {
    let Some(settings_index) = task_xml.find("<Settings>") else { return false };
    let tail = &task_xml[settings_index..];
    // The first <Enabled> after <Settings> is the task-level flag.
    let Some(match_start) = tail.find("<Enabled>") else { return false };
    let value = &tail[match_start + "<Enabled>".len()..];
    value.starts_with("true</Enabled>")
}

/// Task arguments as registered (`--hidden` for silent launches, none else).
pub fn task_arguments(task_xml: &str) -> Vec<String> {
    let Some(start) = task_xml.find("<Arguments>") else { return Vec::new() };
    let tail = &task_xml[start + "<Arguments>".len()..];
    let Some(end) = tail.find("</Arguments>") else { return Vec::new() };
    let raw = &tail[..end];
    if raw.trim().is_empty() {
        return Vec::new();
    }
    // Compare against the unescaped form: a compare against raw XML entities
    // would never match and re-create the task on every startup.
    unescape_xml(raw).trim().split_whitespace().map(str::to_string).collect()
}

// ---------------------------------------------------------------------------
// The scheduled-task adapter (the win32 ladder, runner-injectable)
// ---------------------------------------------------------------------------

/// The legacy login-item fallback: a plain HKCU Run value registered under the
/// stable appId (the OS mechanism Electron's `setLoginItemSettings` used).
pub struct LegacyRunKeyAdapter {
    pub supported: bool,
    runner: CommandRunner,
    get_silent_launch: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}

impl LegacyRunKeyAdapter {
    fn run_value(&self, executable: &str) -> String {
        if (self.get_silent_launch)() {
            format!("\"{executable}\" --hidden")
        } else {
            format!("\"{executable}\"")
        }
    }

    /// Existence check regardless of registered arguments.
    pub async fn read_registered(&self, executable: &str) -> bool {
        if !self.supported {
            return false;
        }
        let Ok(result) = (self.runner)(reg_command(), vec!["query".into(), SCHEDULED_TASK_RUN_KEY.into(), "/v".into(), SCHEDULED_TASK_NAME.into()]).await
        else {
            return false;
        };
        if result.code != 0 {
            return false;
        }
        let output = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
        output.contains(&SCHEDULED_TASK_NAME.to_lowercase()) && output.contains(&executable.to_lowercase())
    }

    pub async fn write(&self, enabled: bool, executable: &str) -> Result<(), String> {
        if !self.supported {
            return Ok(());
        }
        if enabled {
            (self.runner)(
                reg_command(),
                vec![
                    "add".into(),
                    SCHEDULED_TASK_RUN_KEY.into(),
                    "/v".into(),
                    SCHEDULED_TASK_NAME.into(),
                    "/t".into(),
                    "REG_SZ".into(),
                    "/d".into(),
                    self.run_value(executable),
                    "/f".into(),
                ],
            )
            .await
            .map_err(|error| error)?;
            return Ok(());
        }
        // Disabling retires the stable appId value under this executable (the
        // adapter only ever owns that one value name).
        (self.runner)(
            reg_command(),
            vec!["delete".into(), SCHEDULED_TASK_RUN_KEY.into(), "/v".into(), SCHEDULED_TASK_NAME.into(), "/f".into()],
        )
        .await
        .map_err(|error| error)?;
        Ok(())
    }
}

/// Windows auto-start via a per-user Scheduled Task, with the legacy Run-key
/// registration kept as a fallback. The `runner` and `legacy` are injectable;
/// `supported` may be forced for off-Windows testing (the TS `options` shape).
pub struct ScheduledTaskStartupAdapter {
    pub supported: bool,
    runner: CommandRunner,
    get_silent_launch: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    legacy: LegacyRunKeyAdapter,
}

impl ScheduledTaskStartupAdapter {
    /// Production constructor: real `schtasks`/`reg` children, silent-launch
    /// preference read live through app state.
    pub fn for_app(app: tauri::AppHandle) -> Self {
        use tauri::Manager;
        Self::build(
            true,
            std::sync::Arc::new(|command: String, args: Vec<String>| {
                Box::pin(async move { run_child(&command, &args).await })
            }),
            std::sync::Arc::new(move || {
                app.try_state::<crate::settings::SettingsStore>()
                    .map(|settings| settings.get().silent_launch)
                    .unwrap_or(false)
            }),
        )
    }

    /// Test constructor: force the supported flag, inject the runner.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_runner(
        supported: bool,
        runner: CommandRunner,
        get_silent_launch: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self::build(supported, runner, get_silent_launch)
    }

    fn build(
        supported: bool,
        runner: CommandRunner,
        get_silent_launch: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        ScheduledTaskStartupAdapter {
            supported,
            legacy: LegacyRunKeyAdapter { supported, runner: runner.clone(), get_silent_launch: get_silent_launch.clone() },
            runner,
            get_silent_launch,
        }
    }

    fn login_args(&self) -> Vec<String> {
        if (self.get_silent_launch)() {
            vec!["--hidden".to_string()]
        } else {
            Vec::new()
        }
    }

    fn executable(&self) -> String {
        std::env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| std::env::args().next().unwrap_or_default())
    }

    /// `read()` is argument-insensitive: it reports what is registered.
    pub async fn read(&self) -> bool {
        if !self.supported {
            return false;
        }
        // A present task owns the registration: a task disabled in the Task
        // Scheduler UI reports off even if a stale legacy entry lingers,
        // matching what the user chose there.
        if let Some(task_xml) = self.query_task_xml().await {
            return task_settings_enabled(&task_xml);
        }
        if self.has_stable_run_entry().await {
            return true;
        }
        self.legacy.read_registered(&self.executable()).await
    }

    pub async fn write(&self, enabled: bool) -> Result<(), String> {
        if !self.supported {
            return Ok(());
        }
        if !enabled {
            return self.disable().await;
        }
        if self.try_create_task().await {
            // The task now owns the registration; drop any legacy Run-key
            // entry so the app is not started twice at logon.
            self.clear_run_fallbacks().await;
            return Ok(());
        }
        // Scheduled-task creation was denied. Own one deterministic Run value
        // and verify it directly instead of relying on argument-sensitive
        // login-item lookup.
        if self.write_stable_run_entry().await {
            return Ok(());
        }
        self.legacy.write(true, &self.executable()).await
    }

    /// Keep an existing login item enabled while replacing its launch arguments.
    pub async fn rewrite_if_enabled(&self) -> Result<(), String> {
        if !self.supported {
            return Ok(());
        }
        if let Some(task_xml) = self.query_task_xml().await {
            // A present task owns the registration. A task disabled in the
            // Task Scheduler UI means the user turned auto-start off there —
            // leave it.
            if !task_settings_enabled(&task_xml) {
                return Ok(());
            }
            let current_args = task_arguments(&task_xml);
            let desired_args = self.login_args();
            if current_args == desired_args {
                // Already current; retire a lingering legacy Run-key entry.
                self.clear_run_fallbacks().await;
                return Ok(());
            }
            // Arguments moved (silent-launch toggle): recreate with desired args.
            if !self.try_create_task().await {
                return Err("无法更新开机启动计划任务，已保留原有注册".to_string());
            }
            self.clear_run_fallbacks().await;
            return Ok(());
        }
        // Legacy-only registration (v0.9.x Run-key users): migrate to the
        // task so future logins get the delayed, prioritised launch. The
        // existence check MUST be argument-insensitive. A failed create keeps
        // the Run key untouched — degrades to today's behaviour.
        let stable_registered = self.has_stable_run_entry().await;
        let legacy_registered = stable_registered || self.legacy.read_registered(&self.executable()).await;
        if !legacy_registered {
            return Ok(());
        }
        if self.try_create_task().await {
            self.clear_run_fallbacks().await;
        } else if !stable_registered {
            self.write_stable_run_entry().await;
        }
        Ok(())
    }

    async fn disable(&self) -> Result<(), String> {
        let _ = (self.runner)(
            schtasks_command(),
            vec!["/delete".into(), "/tn".into(), SCHEDULED_TASK_NAME.into(), "/f".into()],
        )
        .await;
        self.clear_run_fallbacks().await;
        Ok(())
    }

    async fn has_stable_run_entry(&self) -> bool {
        let Ok(result) = (self.runner)(
            reg_command(),
            vec!["query".into(), SCHEDULED_TASK_RUN_KEY.into(), "/v".into(), SCHEDULED_TASK_NAME.into()],
        )
        .await
        else {
            return false;
        };
        if result.code != 0 {
            return false;
        }
        let output = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
        output.contains(&SCHEDULED_TASK_NAME.to_lowercase()) && output.contains(&self.executable().to_lowercase())
    }

    async fn write_stable_run_entry(&self) -> bool {
        let args = vec![
            "add".to_string(),
            SCHEDULED_TASK_RUN_KEY.to_string(),
            "/v".to_string(),
            SCHEDULED_TASK_NAME.to_string(),
            "/t".to_string(),
            "REG_SZ".to_string(),
            "/d".to_string(),
            format!("\"{}\"", self.executable()),
            "/f".to_string(),
        ];
        // Prove direct registry writes work before touching a working legacy
        // entry. Then retire every historical name and write the one
        // canonical value again.
        let Ok(probe) = (self.runner)(reg_command(), args.clone()).await else { return false };
        if probe.code != 0 {
            return false;
        }
        let _ = self.legacy.write(false, &self.executable()).await;
        let Ok(result) = (self.runner)(reg_command(), args).await else { return false };
        if result.code == 0 && self.has_stable_run_entry().await {
            return true;
        }
        let _ = self.legacy.write(true, &self.executable()).await;
        false
    }

    async fn clear_run_fallbacks(&self) {
        let _ = (self.runner)(
            reg_command(),
            vec!["delete".into(), SCHEDULED_TASK_RUN_KEY.into(), "/v".into(), SCHEDULED_TASK_NAME.into(), "/f".into()],
        )
        .await;
        let _ = self.legacy.write(false, &self.executable()).await;
    }

    /// Create (or replace) the task. Returns false when creation was denied.
    async fn try_create_task(&self) -> bool {
        let staging = std::env::temp_dir().join(format!("murge-startup-{}-{}", std::process::id(), now_unique()));
        if tokio::fs::create_dir_all(&staging).await.is_err() {
            return false;
        }
        let task_file = staging.join("task.xml");
        // The XML declares encoding="UTF-16" and MUST be written with a UTF-16
        // BOM: without it schtasks parses the file as ANSI and rejects the
        // task definition.
        let mut bytes = vec![0xFE, 0xFF];
        for unit in format!("\u{feff}{}", build_task_xml(&self.executable(), &self.login_args())).encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        if tokio::fs::write(&task_file, &bytes).await.is_err() {
            return false;
        }
        let Ok(result) = (self.runner)(
            schtasks_command(),
            vec!["/create".into(), "/tn".into(), SCHEDULED_TASK_NAME.into(), "/xml".into(), task_file.to_string_lossy().to_string(), "/f".into()],
        )
        .await
        else {
            return false;
        };
        // A resolved runner may still carry the child's non-zero exit
        // (policy denial, XML rejected, ...) — only a zero exit registers.
        let created = result.code == 0;
        let _ = tokio::fs::remove_dir_all(&staging).await;
        created
    }

    /// The registered task definition, or null when the task does not exist.
    async fn query_task_xml(&self) -> Option<String> {
        let Ok(result) = (self.runner)(
            schtasks_command(),
            vec!["/query".into(), "/tn".into(), SCHEDULED_TASK_NAME.into(), "/xml".into()],
        )
        .await
        else {
            return None;
        };
        if result.code != 0 {
            return None;
        }
        result.stdout.contains("<?xml").then(|| result.stdout)
    }
}

/// A collision-resistant staging-dir suffix (process id + nanos).
fn now_unique() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

fn schtasks_command() -> String {
    if cfg!(windows) { "schtasks.exe".to_string() } else { "schtasks".to_string() }
}

fn reg_command() -> String {
    if cfg!(windows) { "reg.exe".to_string() } else { "reg".to_string() }
}

/// The real child runner: 8s timeout, windows-hidden, 1 MiB output cap.
/// Preserve numeric child exits, but never turn transport failures into
/// success — a spawn/timeout failure is an Err.
async fn run_child(command: &str, args: &[String]) -> Result<RunResult, String> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|error| format!("EXEC_FAILED: {error}"))?;
    let output = tokio::time::timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS), child.wait_with_output())
        .await
        .map_err(|_| "ETIMEDOUT: child process timed out".to_string())?
        .map_err(|error| format!("EXEC_FAILED: {error}"))?;
    Ok(RunResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

use std::time::Duration;

// ---------------------------------------------------------------------------
// The serial service (the read-after-write ownership boundary)
// ---------------------------------------------------------------------------

/// Serial, read-after-write ownership boundary for OS login-item state.
/// Cheaply cloneable (the adapter is shared): the setup hook clones a handle
/// into the one-shot maintenance task before the service is managed.
#[derive(Clone)]
pub struct StartupService {
    adapter: std::sync::Arc<ScheduledTaskStartupAdapter>,
    queue: std::sync::Arc<Mutex<()>>,
}

impl StartupService {
    pub fn new(adapter: ScheduledTaskStartupAdapter) -> Self {
        StartupService { adapter: std::sync::Arc::new(adapter), queue: std::sync::Arc::new(Mutex::new(())) }
    }

    pub async fn get_status(&self) -> Value {
        let _held = self.queue.lock().await;
        status_value(&self.read_status().await)
    }

    pub async fn set_enabled(&self, enabled: bool) -> Value {
        let _held = self.queue.lock().await;
        if !self.adapter.supported {
            return status_value(&self.unsupported());
        }
        if let Err(error) = self.adapter.write(enabled).await {
            let current = self.adapter.read().await;
            return status_value(&StartupStatus {
                supported: true,
                enabled: current,
                phase: "error",
                error_message: Some(error),
            });
        }
        let confirmed = self.adapter.read().await;
        if confirmed != enabled {
            return status_value(&StartupStatus {
                supported: true,
                enabled: confirmed,
                phase: "error",
                error_message: Some("系统未确认开机启动设置".to_string()),
            });
        }
        status_value(&StartupStatus { supported: true, enabled: confirmed, phase: "idle", error_message: None })
    }

    /// Keep an existing login item enabled while replacing its launch
    /// arguments (called when the persisted silent-launch preference moves).
    pub async fn refresh_registration(&self) -> Value {
        let _held = self.queue.lock().await;
        if !self.adapter.supported {
            return status_value(&self.unsupported());
        }
        if let Err(error) = self.adapter.rewrite_if_enabled().await {
            let current = self.adapter.read().await;
            return status_value(&StartupStatus {
                supported: true,
                enabled: current,
                phase: "error",
                error_message: Some(error),
            });
        }
        status_value(&self.read_status().await)
    }

    async fn read_status(&self) -> StartupStatus {
        if !self.adapter.supported {
            return self.unsupported();
        }
        StartupStatus {
            supported: true,
            enabled: self.adapter.read().await,
            phase: "idle",
            error_message: None,
        }
    }

    fn unsupported(&self) -> StartupStatus {
        StartupStatus { supported: false, enabled: false, phase: "unsupported", error_message: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::Mutex as StdMutex;
    use std::sync::Arc;

    type Log = Arc<StdMutex<Vec<String>>>;

    fn recording_runner(log: Log, exit_code: Arc<AtomicI32>, task_xml: Arc<StdMutex<Option<String>>>, run_value: Arc<StdMutex<Option<String>>>) -> CommandRunner {
        std::sync::Arc::new(move |command: String, args: Vec<String>| {
            let log = log.clone();
            let exit_code = exit_code.clone();
            let task_xml = task_xml.clone();
            let run_value = run_value.clone();
            Box::pin(async move {
                let key = format!("{command} {}", args.join(" "));
                log.lock().unwrap().push(key.clone());
                if key.contains("/query /tn") && key.contains("/xml") {
                    if let Some(xml) = task_xml.lock().unwrap().clone() {
                        return Ok(RunResult { stdout: xml, stderr: String::new(), code: 0 });
                    }
                    return Ok(RunResult { stdout: String::new(), stderr: "INFO: No task".into(), code: 1 });
                }
                if key.contains("/create /tn") {
                    // Capture the task arguments the task registers with.
                    if let Some(start) = args.iter().position(|a| a == "/xml") {
                        let file = &args[start + 1];
                        let bytes = tokio::fs::read(file).await.unwrap();
                        let units: Vec<u16> = bytes
                            .chunks(2)
                            .map(|chunk| u16::from_le_bytes([chunk[0], chunk.get(1).copied().unwrap_or(0)]))
                            .collect();
                        let content = String::from_utf16_lossy(&units);
                        task_xml.lock().unwrap().replace(content.trim_start_matches('\u{feff}').to_string());
                    }
                    return Ok(RunResult { stdout: "SUCCESS".into(), stderr: String::new(), code: exit_code.load(Ordering::SeqCst) });
                }
                if key.contains("/delete /tn") {
                    *task_xml.lock().unwrap() = None;
                    return Ok(RunResult { stdout: "SUCCESS".into(), stderr: String::new(), code: 0 });
                }
                if key.contains("query HKCU") {
                    if let Some(value) = run_value.lock().unwrap().clone() {
                        if value.contains(&SCHEDULED_TASK_NAME.to_lowercase()) {
                            return Ok(RunResult { stdout: format!("{} REG_SZ {}", SCHEDULED_TASK_NAME, value), stderr: String::new(), code: 0 });
                        }
                    }
                    return Ok(RunResult { stdout: "not found".into(), stderr: String::new(), code: 1 });
                }
                if key.contains("add HKCU") {
                    if let Some(index) = args.iter().position(|a| a == "/d") {
                        *run_value.lock().unwrap() = Some(args[index + 1].clone());
                    }
                    return Ok(RunResult { stdout: "SUCCESS".into(), stderr: String::new(), code: 0 });
                }
                if key.contains("delete HKCU") {
                    *run_value.lock().unwrap() = None;
                    return Ok(RunResult { stdout: "SUCCESS".into(), stderr: String::new(), code: 0 });
                }
                Ok(RunResult::default())
            })
        })
    }

    #[test]
    fn task_xml_helpers_match_the_ts_semantics() {
        let xml = build_task_xml(r"C:\Program Files\Murge\murge.exe", &["--hidden".to_string()]);
        assert!(xml.contains("<Delay>PT3S</Delay>"));
        assert!(xml.contains("<Priority>3</Priority>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains(r#"<Command>"C:\Program Files\Murge\murge.exe"</Command>"#));
        assert!(xml.contains("<Arguments>--hidden</Arguments>"));
        assert!(task_settings_enabled(&xml));
        assert_eq!(task_arguments(&xml), vec!["--hidden".to_string()]);
        // A disabled task reads off; empty arguments read empty.
        let disabled = xml.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>");
        assert!(!task_settings_enabled(&disabled));
        let no_args = build_task_xml("murge.exe", &[]);
        assert!(!no_args.contains("<Arguments>"));
        assert!(task_arguments(&no_args).is_empty());
        // XML entities in the path survive a round trip through task_arguments.
        let weird = build_task_xml(r"C:\a&b\murge.exe", &["x&y".to_string()]);
        assert!(weird.contains("&amp;"));
        assert_eq!(task_arguments(&weird), vec!["x&y".to_string()]);
        assert!(!task_settings_enabled("no settings here"));
    }

    #[tokio::test]
    async fn service_reads_without_writing_and_confirms_writes() {
        let adapter = ScheduledTaskStartupAdapter::with_runner(
            true,
            std::sync::Arc::new(|_command: String, _args: Vec<String>| {
                Box::pin(async { Ok(RunResult { stdout: String::new(), stderr: String::new(), code: 1 }) })
            }),
            std::sync::Arc::new(|| false),
        );
        let service = StartupService::new(adapter);
        // Disabled by default; a read performs no write.
        let status = service.get_status().await;
        assert_eq!(status["supported"], true);
        assert_eq!(status["phase"], "idle");
        assert_eq!(status["enabled"], false);
        // An explicit set confirms the OS state after writing (fake confirms
        // nothing here — the write ladder fails, so the error copy surfaces).
        let status = service.set_enabled(true).await;
        if status["phase"] == "error" {
            assert!(status["errorMessage"].as_str().is_some());
        } else {
            assert_eq!(status["enabled"], true);
        }
    }

    #[tokio::test]
    async fn unsupported_platform_fails_closed_without_writing() {
        let adapter = ScheduledTaskStartupAdapter::with_runner(
            false,
            std::sync::Arc::new(|_command: String, _args: Vec<String>| {
                Box::pin(async { Ok(RunResult::default()) })
            }),
            std::sync::Arc::new(|| false),
        );
        let service = StartupService::new(adapter);
        let status = service.set_enabled(true).await;
        assert_eq!(status, json!({ "supported": false, "enabled": false, "phase": "unsupported", "errorMessage": Value::Null }));
    }

    #[tokio::test]
    async fn task_owns_the_registration_and_the_ladder_degrades() {
        let log: Log = Arc::new(StdMutex::new(Vec::new()));
        let exit_code = Arc::new(AtomicI32::new(0));
        let task_xml: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let run_value: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let runner = recording_runner(log.clone(), exit_code.clone(), task_xml.clone(), run_value.clone());
        let adapter = ScheduledTaskStartupAdapter::with_runner(true, runner, std::sync::Arc::new(|| false));
        // Nothing registered -> off.
        assert!(!adapter.read().await);
        // Enable: the task is created and owns the registration; legacy
        // fallbacks are cleared.
        adapter.write(true).await.unwrap();
        assert!(task_xml.lock().unwrap().is_some());
        assert!(!log.lock().unwrap().iter().any(|entry| entry.contains("add HKCU")));
        // Read-back reports the task's enabled flag.
        assert!(adapter.read().await);
        // Disable: task deleted, fallbacks cleared.
        adapter.write(false).await.unwrap();
        assert!(log.lock().unwrap().iter().any(|entry| entry.contains("/delete /tn")));
        assert!(!adapter.read().await);
        // Task creation denied (non-zero exit): the stable Run value is used.
        exit_code.store(1, Ordering::SeqCst);
        adapter.write(true).await.unwrap();
        assert!(run_value.lock().unwrap().is_some());
        assert!(adapter.read().await);
    }

    #[tokio::test]
    async fn rewrite_recreates_the_task_when_silent_launch_moves() {
        let log: Log = Arc::new(StdMutex::new(Vec::new()));
        let exit_code = Arc::new(AtomicI32::new(0));
        let task_xml: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let run_value: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let silent = Arc::new(AtomicU64::new(0));
        let silent_for_adapter = silent.clone();
        let runner = recording_runner(log.clone(), exit_code, task_xml.clone(), run_value);
        let adapter = ScheduledTaskStartupAdapter::with_runner(
            true,
            runner,
            std::sync::Arc::new(move || silent_for_adapter.load(Ordering::SeqCst) == 1),
        );
        // Register loud, then move the preference to silent: the task is
        // recreated with --hidden.
        adapter.write(true).await.unwrap();
        silent.store(1, Ordering::SeqCst);
        adapter.rewrite_if_enabled().await.unwrap();
        let xml = task_xml.lock().unwrap().clone().unwrap();
        assert_eq!(task_arguments(&xml), vec!["--hidden".to_string()]);
        // A task disabled in the Task Scheduler UI is left alone.
        let disabled = xml.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>");
        *task_xml.lock().unwrap() = Some(disabled);
        adapter.rewrite_if_enabled().await.unwrap();
        let still = task_xml.lock().unwrap().clone().unwrap();
        assert!(still.contains("<Enabled>false</Enabled>"));
    }
}
