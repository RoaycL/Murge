//! OS login-item state (开机自启) — Rust port of `src/main/startup/*`
//! (`service.ts` + `scheduled-task-adapter.ts`), the `startup:get-status` /
//! `startup:set-enabled` channels.
//!
//! Windows auto-start goes through a per-user Scheduled Task that the
//! elevated installer registers (`resources/startup/register-task.ps1`):
//! disabled by default, with an ACL granting the signed-in user management
//! rights. The GUI never creates or deletes that task; it only flips its
//! enabled flag (`schtasks /change /enable|/disable`), which needs no UAC
//! prompt. A per-user HKCU Run value is kept as the fallback for machines
//! where the installer could not register the task, or where toggling it is
//! denied (enterprise policy, stripped SKUs). The service serializes
//! operations (read-after-write ownership boundary) and reports divergence
//! without pretending the requested value won.

use serde_json::{json, Value};
use tokio::sync::Mutex;

/// The deterministic task name (`schtasks /tn` value) — `brand.appId`. Also
/// the name of the HKCU Run fallback value.
pub const SCHEDULED_TASK_NAME: &str = "io.murge.desktop";
/// The Run-key fallback registration key.
pub const SCHEDULED_TASK_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// The Run value older Electron builds registered (`electron.app.<productName>`).
const LEGACY_RUN_VALUE: &str = "electron.app.Murge";
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
pub type CommandRunner = std::sync::Arc<
    dyn Fn(
            String,
            Vec<String>,
        ) -> futures_util::future::BoxFuture<'static, Result<RunResult, String>>
        + Send
        + Sync,
>;

// ---------------------------------------------------------------------------
// Task XML (pure)
// ---------------------------------------------------------------------------

/// True when the task-level `<Settings><Enabled>` flag is on. Windows omits
/// that element when it holds its default (`true`), so an absent element is
/// enabled; `<IdleSettings>` has no `<Enabled>` child, so the first one
/// inside `<Settings>` is the task-level flag.
pub fn task_settings_enabled(task_xml: &str) -> bool {
    let has_task_root = task_xml
        .match_indices("<Task")
        .any(|(index, _)| matches!(task_xml[index + 5..].chars().next(), Some(c) if c == '>' || c.is_whitespace()));
    if !has_task_root {
        return false;
    }
    let Some(settings) = settings_body(task_xml) else {
        return true;
    };
    let Some(start) = settings.find("<Enabled>") else {
        return true;
    };
    let tail = &settings[start + "<Enabled>".len()..];
    let Some(end) = tail.find("</Enabled>") else {
        return true;
    };
    matches!(tail[..end].trim(), "true" | "1")
}

/// The inner text of the `<Settings>` element (attributes allowed).
fn settings_body(task_xml: &str) -> Option<&str> {
    let mut search = 0;
    while let Some(found) = task_xml[search..].find("<Settings") {
        let open = search + found;
        let after = &task_xml[open + "<Settings".len()..];
        match after.chars().next() {
            Some('>') | Some(' ') | Some('\t') | Some('\r') | Some('\n') => {
                let body_start = open + "<Settings".len() + after.find('>')? + 1;
                let body_end = body_start + task_xml[body_start..].find("</Settings>")?;
                return Some(&task_xml[body_start..body_end]);
            }
            _ => search = open + "<Settings".len(),
        }
    }
    None
}

// ---------------------------------------------------------------------------
// The scheduled-task adapter (the win32 ladder, runner-injectable)
// ---------------------------------------------------------------------------

/// Windows auto-start via the installer-registered per-user Scheduled Task,
/// with an HKCU Run value as the fallback. The `runner` is injectable;
/// `supported` may be forced for off-Windows testing.
pub struct ScheduledTaskStartupAdapter {
    pub supported: bool,
    runner: CommandRunner,
    executable: std::sync::Arc<dyn Fn() -> String + Send + Sync>,
}

impl ScheduledTaskStartupAdapter {
    /// Production constructor: real `schtasks`/`reg` children.
    pub fn for_app(_app: tauri::AppHandle) -> Self {
        ScheduledTaskStartupAdapter {
            supported: cfg!(windows),
            runner: std::sync::Arc::new(|command: String, args: Vec<String>| {
                Box::pin(async move { run_child(&command, &args).await })
            }),
            executable: std::sync::Arc::new(current_executable),
        }
    }

    /// Test constructor: force the supported flag, inject the runner. The
    /// silent-launch provider is kept for call-site compatibility; every
    /// registration launches `--hidden`, matching the installer's task.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_runner(
        supported: bool,
        runner: CommandRunner,
        _get_silent_launch: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        ScheduledTaskStartupAdapter {
            supported,
            runner,
            executable: std::sync::Arc::new(|| r"C:\Program Files\Murge\murge.exe".to_string()),
        }
    }

    fn executable(&self) -> String {
        (self.executable)()
    }

    /// The Run fallback command line (always hidden, like the task action).
    fn run_value(&self) -> String {
        format!("\"{}\" --hidden", self.executable())
    }

    /// `read()` is argument-insensitive: it reports what is registered. An
    /// enabled task wins; otherwise a Run value may be the intentional
    /// fallback for a task the GUI could not enable.
    pub async fn read(&self) -> bool {
        if !self.supported {
            return false;
        }
        if let Ok(Some(task_xml)) = self.query_task_xml(false).await {
            if task_settings_enabled(&task_xml) {
                return true;
            }
        }
        self.has_run_entry(SCHEDULED_TASK_NAME).await || self.has_run_entry(LEGACY_RUN_VALUE).await
    }

    pub async fn write(&self, enabled: bool) -> Result<(), String> {
        if !self.supported {
            return Ok(());
        }
        if !enabled {
            return self.disable().await;
        }
        if let Ok(Some(task_xml)) = self.query_task_xml(false).await {
            if task_settings_enabled(&task_xml) {
                self.clear_run_fallbacks().await;
                return Ok(());
            }
            let toggled = (self.runner)(
                schtasks_command(),
                vec![
                    "/change".into(),
                    "/tn".into(),
                    SCHEDULED_TASK_NAME.into(),
                    "/enable".into(),
                ],
            )
            .await;
            if matches!(toggled, Ok(ref result) if result.code == 0) {
                if let Ok(Some(updated)) = self.query_task_xml(false).await {
                    if task_settings_enabled(&updated) {
                        // The task now owns the registration; drop the Run
                        // fallbacks so the app is not started twice at logon.
                        self.clear_run_fallbacks().await;
                        return Ok(());
                    }
                }
            }
        }
        // The installer has not registered a task yet, or enabling it was
        // denied. Keep a functional auto-start without a UAC prompt.
        if self.write_stable_run_entry().await {
            return Ok(());
        }
        Err("无法写入开机启动项，请检查启动项权限".to_string())
    }

    /// Maintain a working registration at startup: retire Run fallbacks once
    /// an enabled task owns auto-start, and move a legacy Electron Run value
    /// to the canonical one. Never touches the task definition — that is
    /// the installer's responsibility.
    pub async fn rewrite_if_enabled(&self) -> Result<(), String> {
        if !self.supported {
            return Ok(());
        }
        if let Ok(Some(task_xml)) = self.query_task_xml(false).await {
            if task_settings_enabled(&task_xml) {
                self.clear_run_fallbacks().await;
            }
            return Ok(());
        }
        let stable_registered = self.has_run_entry(SCHEDULED_TASK_NAME).await;
        if stable_registered || !self.has_run_entry(LEGACY_RUN_VALUE).await {
            return Ok(());
        }
        self.write_stable_run_entry().await;
        Ok(())
    }

    async fn disable(&self) -> Result<(), String> {
        let task_xml = self.query_task_xml(true).await?;
        if let Some(task_xml) = task_xml {
            if task_settings_enabled(&task_xml) {
                let result = (self.runner)(
                    schtasks_command(),
                    vec![
                        "/change".into(),
                        "/tn".into(),
                        SCHEDULED_TASK_NAME.into(),
                        "/disable".into(),
                    ],
                )
                .await
                .map_err(|error| format!("无法禁用开机启动计划任务：{error}"))?;
                if result.code != 0 {
                    return Err(format!(
                        "无法禁用开机启动计划任务：{}",
                        first_non_empty(&result, "Windows 错误码")
                    ));
                }
                match self.query_task_xml(true).await? {
                    Some(updated) if !task_settings_enabled(&updated) => {}
                    _ => return Err("无法禁用开机启动计划任务，请检查任务权限".to_string()),
                }
            }
        }
        self.clear_run_fallbacks().await;
        if self.has_run_entry(SCHEDULED_TASK_NAME).await
            || self.has_run_entry(LEGACY_RUN_VALUE).await
        {
            return Err("无法清除开机启动注册表项，请检查启动项权限".to_string());
        }
        Ok(())
    }

    /// True when `value_name` exists under the Run key and points at this
    /// executable. `reg.exe` prints in the console code page, so a non-ASCII
    /// install path is matched by its (ASCII) file name instead.
    async fn has_run_entry(&self, value_name: &str) -> bool {
        let Ok(result) = (self.runner)(
            reg_command(),
            vec![
                "query".into(),
                SCHEDULED_TASK_RUN_KEY.into(),
                "/v".into(),
                value_name.into(),
            ],
        )
        .await
        else {
            return false;
        };
        if result.code != 0 {
            return false;
        }
        let output = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
        if !output.contains(&value_name.to_lowercase()) {
            return false;
        }
        let executable = self.executable();
        if executable.is_ascii() {
            return output.contains(&executable.to_lowercase());
        }
        let file_name = std::path::Path::new(&executable)
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        !file_name.is_empty() && output.contains(&file_name)
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
            self.run_value(),
            "/f".to_string(),
        ];
        let Ok(result) = (self.runner)(reg_command(), args).await else {
            return false;
        };
        if result.code != 0 || !self.has_run_entry(SCHEDULED_TASK_NAME).await {
            return false;
        }
        // The canonical value is in place; retire the Electron-era name so
        // the app is not started twice.
        self.delete_run_value(LEGACY_RUN_VALUE).await;
        true
    }

    async fn clear_run_fallbacks(&self) {
        self.delete_run_value(SCHEDULED_TASK_NAME).await;
        self.delete_run_value(LEGACY_RUN_VALUE).await;
    }

    async fn delete_run_value(&self, value_name: &str) {
        if !self.has_run_entry(value_name).await {
            return;
        }
        let _ = (self.runner)(
            reg_command(),
            vec![
                "delete".into(),
                SCHEDULED_TASK_RUN_KEY.into(),
                "/v".into(),
                value_name.into(),
                "/f".into(),
            ],
        )
        .await;
    }

    /// The registered task definition, `Ok(None)` when the task does not
    /// exist. Non-strict reads treat every failure as absence; strict reads
    /// (before a disable) only accept absence once the task list proves it,
    /// because schtasks uses exit 1 for both a missing task and access denial.
    async fn query_task_xml(&self, strict: bool) -> Result<Option<String>, String> {
        let result = match (self.runner)(
            schtasks_command(),
            vec![
                "/query".into(),
                "/tn".into(),
                SCHEDULED_TASK_NAME.into(),
                "/xml".into(),
            ],
        )
        .await
        {
            Ok(result) => result,
            Err(error) if strict => return Err(error),
            Err(_) => return Ok(None),
        };
        if result.code != 0 {
            if !strict {
                return Ok(None);
            }
            if result.code != 1 {
                return Err(first_non_empty(&result, "Windows 错误码"));
            }
            let listing = (self.runner)(
                schtasks_command(),
                vec!["/query".into(), "/fo".into(), "CSV".into(), "/nh".into()],
            )
            .await?;
            let needle = format!("\\{}\"", SCHEDULED_TASK_NAME.to_lowercase());
            if listing.code != 0 || listing.stdout.to_lowercase().contains(&needle) {
                return Err(first_non_empty(&result, "无法读取开机启动计划任务"));
            }
            return Ok(None);
        }
        if result.stdout.contains("<?xml") || result.stdout.contains("<Task") {
            return Ok(Some(result.stdout));
        }
        if strict {
            return Err("Windows 返回的开机启动任务数据无效".to_string());
        }
        Ok(None)
    }
}

fn first_non_empty(result: &RunResult, fallback: &str) -> String {
    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = result.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    if fallback == "Windows 错误码" {
        format!("{fallback} {}", result.code)
    } else {
        fallback.to_string()
    }
}

fn current_executable() -> String {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| std::env::args().next().unwrap_or_default())
}

fn schtasks_command() -> String {
    if cfg!(windows) {
        "schtasks.exe".to_string()
    } else {
        "schtasks".to_string()
    }
}

fn reg_command() -> String {
    if cfg!(windows) {
        "reg.exe".to_string()
    } else {
        "reg".to_string()
    }
}

/// Decode child output: UTF-16LE when it carries a BOM or looks like it
/// (schtasks can emit the task XML as UTF-16), UTF-8 (lossy) otherwise.
fn decode_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 4 && bytes[0] != 0 && bytes[1] == 0 && bytes[3] == 0);
    if looks_utf16 {
        let body = bytes.strip_prefix(&[0xFF, 0xFE][..]).unwrap_or(bytes);
        let units: Vec<u16> = body
            .chunks(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk.get(1).copied().unwrap_or(0)]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
}

/// The real child runner: 8s timeout, windows-hidden.
/// Preserve numeric child exits, but never turn transport failures into
/// success — a spawn/timeout failure is an Err.
async fn run_child(command: &str, args: &[String]) -> Result<RunResult, String> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|error| format!("EXEC_FAILED: {error}"))?;
    let output = tokio::time::timeout(
        Duration::from_millis(DEFAULT_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "ETIMEDOUT: child process timed out".to_string())?
    .map_err(|error| format!("EXEC_FAILED: {error}"))?;
    Ok(RunResult {
        stdout: decode_output(&output.stdout),
        stderr: decode_output(&output.stderr),
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
        StartupService {
            adapter: std::sync::Arc::new(adapter),
            queue: std::sync::Arc::new(Mutex::new(())),
        }
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
        status_value(&StartupStatus {
            supported: true,
            enabled: confirmed,
            phase: "idle",
            error_message: None,
        })
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
        StartupStatus {
            supported: false,
            enabled: false,
            phase: "unsupported",
            error_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    /// A Windows-shaped task export: the installer registers it disabled, so
    /// Windows writes `<Enabled>false</Enabled>`; when enabled the element is
    /// omitted (its default).
    fn installer_task_xml(enabled: bool) -> String {
        let flag = if enabled {
            ""
        } else {
            "\n    <Enabled>false</Enabled>"
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>S-1-5-21-1-2-3-1001</UserId>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
    </IdleSettings>{flag}
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>3</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\Murge\murge.exe</Command>
      <Arguments>--hidden</Arguments>
    </Exec>
  </Actions>
</Task>
"#
        )
    }

    #[derive(Default)]
    struct FakeWindows {
        /// None = no task; Some(enabled).
        task: Option<bool>,
        /// `schtasks /change` is denied (task without the user's ACL).
        change_denied: bool,
        run_values: std::collections::BTreeMap<String, String>,
        log: Vec<String>,
    }

    fn fake_runner(state: Arc<StdMutex<FakeWindows>>) -> CommandRunner {
        Arc::new(move |command: String, args: Vec<String>| {
            let state = state.clone();
            Box::pin(async move {
                let mut fake = state.lock().unwrap();
                let key = format!("{command} {}", args.join(" "));
                fake.log.push(key.clone());
                let ok = |stdout: String| {
                    Ok(RunResult {
                        stdout,
                        stderr: String::new(),
                        code: 0,
                    })
                };
                let fail = |code| {
                    Ok(RunResult {
                        stdout: String::new(),
                        stderr: "ERROR".into(),
                        code,
                    })
                };
                if key.contains("/query /tn") {
                    return match fake.task {
                        Some(enabled) => ok(installer_task_xml(enabled)),
                        None => fail(1),
                    };
                }
                if key.contains("/query /fo CSV") {
                    return ok("\"\\Other\",\"N/A\",\"Ready\"\n".into());
                }
                if key.contains("/change") {
                    if fake.task.is_none() || fake.change_denied {
                        return fail(1);
                    }
                    fake.task = Some(key.contains("/enable"));
                    return ok("SUCCESS".into());
                }
                if key.contains("/create") || key.contains("/delete /tn") {
                    panic!("the GUI must never create or delete the installer task: {key}");
                }
                let value_name = args
                    .iter()
                    .position(|a| a == "/v")
                    .map(|i| args[i + 1].clone());
                if args.first().map(String::as_str) == Some("query") {
                    let name = value_name.unwrap();
                    return match fake.run_values.get(&name) {
                        Some(data) => ok(format!(
                            "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    {name}    REG_SZ    {data}\r\n"
                        )),
                        None => fail(1),
                    };
                }
                if args.first().map(String::as_str) == Some("add") {
                    let data = args
                        .iter()
                        .position(|a| a == "/d")
                        .map(|i| args[i + 1].clone());
                    fake.run_values.insert(value_name.unwrap(), data.unwrap());
                    return ok("SUCCESS".into());
                }
                if args.first().map(String::as_str) == Some("delete") {
                    fake.run_values.remove(&value_name.unwrap());
                    return ok("SUCCESS".into());
                }
                Ok(RunResult::default())
            })
        })
    }

    fn service_for(state: &Arc<StdMutex<FakeWindows>>) -> StartupService {
        StartupService::new(ScheduledTaskStartupAdapter::with_runner(
            true,
            fake_runner(state.clone()),
            Arc::new(|| true),
        ))
    }

    #[test]
    fn task_enabled_flag_follows_windows_defaults() {
        // Windows omits <Settings><Enabled> when the task is enabled.
        assert!(task_settings_enabled(&installer_task_xml(true)));
        // The trigger's <Enabled>true</Enabled> must not be mistaken for the
        // task-level flag of a disabled task.
        assert!(!task_settings_enabled(&installer_task_xml(false)));
        let explicit = installer_task_xml(false).replace(">false<", ">true<");
        assert!(task_settings_enabled(&explicit));
        assert!(!task_settings_enabled("no settings here"));
        assert!(!task_settings_enabled(
            "<Tasks><Settings></Settings></Tasks>"
        ));
    }

    #[test]
    fn utf16_child_output_is_decoded() {
        let text = "<?xml version=\"1.0\"?><Task>";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_output(&bytes), text);
        let without_bom: Vec<u8> = bytes[2..].to_vec();
        assert_eq!(decode_output(&without_bom), text);
        assert_eq!(decode_output(text.as_bytes()), text);
    }

    #[tokio::test]
    async fn enabling_flips_the_installer_task_and_confirms() {
        // The reported bug: the installer registered a disabled task; turning
        // the switch on must enable that task, not report "系统未确认".
        let state = Arc::new(StdMutex::new(FakeWindows {
            task: Some(false),
            ..Default::default()
        }));
        let service = service_for(&state);
        assert_eq!(service.get_status().await["enabled"], false);
        let status = service.set_enabled(true).await;
        assert_eq!(status["phase"], "idle", "{status}");
        assert_eq!(status["enabled"], true);
        assert_eq!(state.lock().unwrap().task, Some(true));
        assert!(state.lock().unwrap().run_values.is_empty());

        let status = service.set_enabled(false).await;
        assert_eq!(status["phase"], "idle", "{status}");
        assert_eq!(status["enabled"], false);
        assert_eq!(state.lock().unwrap().task, Some(false));
    }

    #[tokio::test]
    async fn denied_task_toggle_falls_back_to_the_run_value() {
        let state = Arc::new(StdMutex::new(FakeWindows {
            task: Some(false),
            change_denied: true,
            ..Default::default()
        }));
        let service = service_for(&state);
        let status = service.set_enabled(true).await;
        assert_eq!(status["phase"], "idle", "{status}");
        assert_eq!(status["enabled"], true);
        assert_eq!(
            state
                .lock()
                .unwrap()
                .run_values
                .get(SCHEDULED_TASK_NAME)
                .map(String::as_str),
            Some(r#""C:\Program Files\Murge\murge.exe" --hidden"#)
        );
        let status = service.set_enabled(false).await;
        assert_eq!(status["enabled"], false, "{status}");
        assert!(state.lock().unwrap().run_values.is_empty());
    }

    #[tokio::test]
    async fn without_a_task_the_run_value_carries_auto_start() {
        let state = Arc::new(StdMutex::new(FakeWindows::default()));
        let service = service_for(&state);
        let status = service.set_enabled(true).await;
        assert_eq!(status["phase"], "idle", "{status}");
        assert_eq!(status["enabled"], true);
        let status = service.set_enabled(false).await;
        assert_eq!(status["phase"], "idle", "{status}");
        assert_eq!(status["enabled"], false);
    }

    #[tokio::test]
    async fn maintenance_retires_fallbacks_and_migrates_electron_values() {
        // An enabled task owns auto-start: Run fallbacks are retired.
        let state = Arc::new(StdMutex::new(FakeWindows {
            task: Some(true),
            ..Default::default()
        }));
        state.lock().unwrap().run_values.insert(
            SCHEDULED_TASK_NAME.into(),
            r#""C:\Program Files\Murge\murge.exe" --hidden"#.into(),
        );
        let status = service_for(&state).refresh_registration().await;
        assert_eq!(status["enabled"], true);
        assert!(state.lock().unwrap().run_values.is_empty());

        // No task, Electron-era value: moved to the canonical value.
        let state = Arc::new(StdMutex::new(FakeWindows::default()));
        state.lock().unwrap().run_values.insert(
            LEGACY_RUN_VALUE.into(),
            r#""C:\Program Files\Murge\murge.exe""#.into(),
        );
        let status = service_for(&state).refresh_registration().await;
        assert_eq!(status["enabled"], true);
        let values = state.lock().unwrap().run_values.clone();
        assert!(values.contains_key(SCHEDULED_TASK_NAME));
        assert!(!values.contains_key(LEGACY_RUN_VALUE));

        // A disabled task with no Run values stays off and untouched.
        let state = Arc::new(StdMutex::new(FakeWindows {
            task: Some(false),
            ..Default::default()
        }));
        let status = service_for(&state).refresh_registration().await;
        assert_eq!(status["enabled"], false);
        assert_eq!(state.lock().unwrap().task, Some(false));
    }

    #[tokio::test]
    async fn unsupported_platform_fails_closed_without_writing() {
        let called = Arc::new(AtomicBool::new(false));
        let called_in_runner = called.clone();
        let adapter = ScheduledTaskStartupAdapter::with_runner(
            false,
            Arc::new(move |_command: String, _args: Vec<String>| {
                called_in_runner.store(true, Ordering::SeqCst);
                Box::pin(async { Ok(RunResult::default()) })
            }),
            Arc::new(|| false),
        );
        let service = StartupService::new(adapter);
        let status = service.set_enabled(true).await;
        assert_eq!(
            status,
            json!({ "supported": false, "enabled": false, "phase": "unsupported", "errorMessage": Value::Null })
        );
        assert!(!called.load(Ordering::SeqCst));
    }
}
