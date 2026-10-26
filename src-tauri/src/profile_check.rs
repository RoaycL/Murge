//! The unprivileged `mihomo -t` profile gate.
//!
//! Checking a document is an ordinary config check: `mihomo -t` reads the file
//! and exits, it opens no port and touches no adapter, so the app runs it
//! itself with the binary the kernel resolver hands out (Mihomo Party does the
//! same). Importing a subscription therefore never depends on the privileged
//! TUN service being installed.
//!
//! Only a real core rejection gates a write (`INVALID_ARGUMENT`); a core that
//! cannot be run at all — no binary resolved yet, spawn refused, the check
//! timing out — carries another code and leaves the structural validator as
//! the only gate, exactly as before the gate existed.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::{code, IpcError};

/// The core's own `-t` budget (the service runtime uses the same 30s).
const VALIDATE_TIMEOUT_MS: u64 = 30_000;
/// Keep the tail of a long rejection, like the service does.
const MAX_MESSAGE_CHARS: usize = 3500;

/// The OS variables a console mihomo needs; never PATH, never secrets
/// (`safeWindowsEnvironment` in the service runtime keeps the same list).
#[cfg(windows)]
const OS_ENVIRONMENT: [&str; 4] = ["SystemRoot", "WINDIR", "TEMP", "TMP"];

/// Run `mihomo -t -d <home> -f <document>` and map the outcome:
/// `Ok(())` the core accepts the document, `INVALID_ARGUMENT` the core rejects
/// it (the message is the core's own output), any other code the check could
/// not run and must not gate anything.
pub async fn validate_with_core(
    command: &Path,
    env: &BTreeMap<String, String>,
    home_dir: &Path,
    work_dir: &Path,
    document: &str,
) -> Result<(), IpcError> {
    for dir in [home_dir, work_dir] {
        std::fs::create_dir_all(dir).map_err(|error| {
            IpcError::code(
                code::KERNEL_SPAWN_FAILED,
                format!("配置校验目录不可用：{error}"),
            )
        })?;
    }
    let config_path = work_dir.join(format!("validate-{}.yaml", unique_suffix()));
    std::fs::write(&config_path, document).map_err(|error| {
        IpcError::code(
            code::KERNEL_SPAWN_FAILED,
            format!("配置校验文件写入失败：{error}"),
        )
    })?;
    let outcome = run_check(command, env, home_dir, work_dir, &config_path).await;
    let _ = std::fs::remove_file(&config_path);
    outcome
}

async fn run_check(
    command: &Path,
    env: &BTreeMap<String, String>,
    home_dir: &Path,
    work_dir: &Path,
    config_path: &Path,
) -> Result<(), IpcError> {
    let mut process = tokio::process::Command::new(command);
    process
        .arg("-t")
        .arg("-d")
        .arg(home_dir)
        .arg("-f")
        .arg(config_path)
        .current_dir(work_dir)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for key in OS_ENVIRONMENT {
            if let Ok(value) = std::env::var(key) {
                process.env(key, value);
            }
        }
        // mihomo is a console program: without this a window flashes up.
        process.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(VALIDATE_TIMEOUT_MS),
        process.output(),
    )
    .await;
    let output = match output {
        Err(_) => {
            return Err(IpcError::code(
                code::KERNEL_START_TIMEOUT,
                "配置校验超时：内核未在 30 秒内完成检查",
            ))
        }
        Ok(Err(error)) => {
            return Err(IpcError::code(
                code::KERNEL_SPAWN_FAILED,
                format!("无法运行内核配置检查：{error}"),
            ))
        }
        Ok(Ok(output)) => output,
    };
    if output.status.success() {
        return Ok(());
    }
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let message = tail(combined.trim());
    if message.is_empty() {
        return Err(IpcError::invalid_argument(format!(
            "内核拒绝了这份配置（退出码 {}）",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "未知".to_string())
        )));
    }
    Err(IpcError::invalid_argument(message))
}

/// The last `MAX_MESSAGE_CHARS` characters (the core puts its reason last).
fn tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= MAX_MESSAGE_CHARS {
        return text.to_string();
    }
    text.chars().skip(count - MAX_MESSAGE_CHARS).collect()
}

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{nanos}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("murge-profile-check-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("fake-mihomo.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_accepted_document_leaves_no_temporary_file_behind() {
        let root = workspace("accepts");
        let command = script(&root, "exit 0");
        let work = root.join("validate");
        validate_with_core(
            &command,
            &BTreeMap::new(),
            &root.join("geodata"),
            &work,
            "proxies: []\n",
        )
        .await
        .expect("the core accepted the document");
        assert_eq!(
            std::fs::read_dir(&work).unwrap().count(),
            0,
            "the temporary document is removed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_rejection_carries_the_core_output_as_invalid_argument() {
        let root = workspace("rejects");
        let command = script(&root, "echo 'rules[0] invalid rule type' >&2\nexit 1");
        let error = validate_with_core(
            &command,
            &BTreeMap::new(),
            &root.join("geodata"),
            &root.join("validate"),
            "rules:\n  - bad\n",
        )
        .await
        .expect_err("the core rejected the document");
        assert_eq!(error.parts().0, code::INVALID_ARGUMENT);
        assert!(
            error.extract_message().contains("invalid rule type"),
            "the core's own words reach the user: {}",
            error.extract_message()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_document_reaches_the_core_as_written() {
        let root = workspace("passes-document");
        // The script fails when the file it was handed does not hold the text.
        let command = script(&root, "grep -q 'mixed-port: 7890' \"$5\" || exit 1\nexit 0");
        validate_with_core(
            &command,
            &BTreeMap::new(),
            &root.join("geodata"),
            &root.join("validate"),
            "mixed-port: 7890\n",
        )
        .await
        .expect("the core read the document body");
    }

    #[tokio::test]
    async fn a_core_that_cannot_be_run_never_gates_a_write() {
        let root = workspace("missing-core");
        let error = validate_with_core(
            &root.join("does-not-exist"),
            &BTreeMap::new(),
            &root.join("geodata"),
            &root.join("validate"),
            "proxies: []\n",
        )
        .await
        .expect_err("spawning a missing binary fails");
        assert_eq!(
            error.parts().0,
            code::KERNEL_SPAWN_FAILED,
            "not INVALID_ARGUMENT, so the gate stays open"
        );
    }

    #[test]
    fn a_long_rejection_keeps_its_tail() {
        let text = format!("{}结尾", "x".repeat(MAX_MESSAGE_CHARS));
        let kept = tail(&text);
        assert_eq!(kept.chars().count(), MAX_MESSAGE_CHARS);
        assert!(kept.ends_with("结尾"), "multi-byte tail stays intact");
    }
}
