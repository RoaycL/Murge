//! Headless entry points the NSIS installer runs against the installed exe
//! (`src-tauri/nsis/hooks.nsh`). They run before the Tauri builder exists, so
//! they never open a window, take the single-instance lock or start a kernel.
//!
//! `--restore-system-proxy` is the Rust port of the Electron
//! `runSystemProxyRestore` (`src/main/electron/ci-probes-adapter.ts`): read the
//! owned backup from the brand-stable app-data namespace and put the HKCU
//! Internet Settings values back only if the registry still matches what the
//! app wrote. Exit 0 when restored, when nothing was owned, and when the
//! registry was edited externally (a safe conflict, left untouched); exit 1
//! only when an owned proxy could not be put back.

use std::sync::Arc;

use crate::paths::AppPaths;
use crate::system_proxy::{self, BackupStore, ProxyBypassStore, SystemProxyAdapter};

pub const RESTORE_SYSTEM_PROXY_ARG: &str = "--restore-system-proxy";

/// Run a headless installer command named on the command line. Returns the
/// process exit code when one ran; `None` means a normal GUI launch.
pub fn run_from_args(args: impl IntoIterator<Item = String>) -> Option<i32> {
    if !args
        .into_iter()
        .skip(1)
        .any(|arg| arg == RESTORE_SYSTEM_PROXY_ARG)
    {
        return None;
    }
    Some(tauri::async_runtime::block_on(restore_system_proxy(
        AppPaths::probe(),
    )))
}

async fn restore_system_proxy(paths: AppPaths) -> i32 {
    // Dev builds never persist a backup (memory stores only): nothing to do.
    let Some(root) = paths.app_data_root else {
        return 0;
    };
    // The file store reads any I/O failure as "no backup". Here that would
    // let the uninstaller remove the app while it still owns the proxy, so a
    // backup that exists but cannot be read fails the restore.
    if let Err(error) = backup_readable(&root) {
        println!(
            "[restore-system-proxy] {}",
            serde_json::json!({ "phase": "error", "ok": false, "errorMessage": error })
        );
        return 1;
    }
    // Same native registry adapter the app uses: no reg.exe/PowerShell child
    // processes while the uninstaller waits on us.
    #[cfg(windows)]
    let adapter: Arc<dyn SystemProxyAdapter> =
        Arc::new(system_proxy::NativeWindowsSystemProxyAdapter::win32());
    #[cfg(not(windows))]
    let adapter: Arc<dyn SystemProxyAdapter> = Arc::new(
        system_proxy::DisabledSystemProxyAdapter::new(std::env::consts::OS),
    );
    let outcome = restore_with(
        adapter,
        Arc::new(system_proxy::FileSystemBackupStore::for_base_dir(&root)),
        Arc::new(system_proxy::FileSystemBypassStore::for_base_dir(&root)),
    )
    .await;
    // Release builds have no console; the line is for CI runs and logs.
    println!("[restore-system-proxy] {}", outcome.report);
    if outcome.ok {
        0
    } else {
        1
    }
}

/// Ok when the owned backup is absent or readable.
fn backup_readable(app_data_root: &std::path::Path) -> Result<(), String> {
    let path = app_data_root
        .join(system_proxy::SYSTEM_PROXY_BACKUP_SUBDIR)
        .join(system_proxy::SYSTEM_PROXY_BACKUP_FILE);
    match std::fs::read(&path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

pub struct RestoreOutcome {
    pub ok: bool,
    pub report: serde_json::Value,
}

/// The restore decision, with injectable adapter and stores. `init()` already
/// performs the ownership-checked restore; this maps its end phase onto the
/// uninstaller's exit-code contract.
pub async fn restore_with(
    adapter: Arc<dyn SystemProxyAdapter>,
    backup: Arc<dyn BackupStore>,
    bypass: Arc<dyn ProxyBypassStore>,
) -> RestoreOutcome {
    let service = system_proxy::SystemProxyService::new(
        adapter,
        // init() never probes the kernel; the target is unused.
        system_proxy::static_probe(system_proxy::Target {
            host: system_proxy::SYSTEM_PROXY_LOOPBACK_HOST.to_string(),
            port: 7890,
        }),
        backup,
        bypass,
        "restore-cli".to_string(),
    );
    let status = service.init().await;
    let ok = match status.phase.as_str() {
        // Restored, or nothing owned. A corrupt backup also lands here, but
        // with an error message: it cannot be trusted, so restore failed.
        "disabled" => status.error_message.is_none(),
        // The registry no longer matches what the app wrote: an external edit,
        // deliberately left alone. Removal may continue.
        "conflict" => true,
        // Nothing this platform can own.
        "unsupported" => true,
        _ => false,
    };
    RestoreOutcome {
        ok,
        report: serde_json::json!({
            "phase": status.phase,
            "ok": ok,
            "errorMessage": status.error_message,
            "conflictDetail": status.conflict_detail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_proxy::{
        FakeSystemProxyAdapter, InMemoryBackupStore, InMemoryBypassStore, RegistryState,
        RegistryValue, SystemProxyService,
    };

    fn arg_list(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn original_registry() -> RegistryState {
        RegistryState {
            proxy_enable: RegistryValue::dword(0),
            proxy_server: RegistryValue::absent(),
            proxy_override: RegistryValue::absent(),
        }
    }

    /// Enable through the real service so the backup has the production shape.
    async fn enabled_fixture() -> (
        Arc<FakeSystemProxyAdapter>,
        Arc<InMemoryBackupStore>,
        Arc<InMemoryBypassStore>,
    ) {
        let adapter = Arc::new(FakeSystemProxyAdapter::new());
        adapter.set_registry(original_registry());
        let backup = Arc::new(InMemoryBackupStore::new());
        let bypass = Arc::new(InMemoryBypassStore::new());
        let service = SystemProxyService::new(
            adapter.clone(),
            system_proxy::static_probe(system_proxy::Target {
                host: system_proxy::SYSTEM_PROXY_LOOPBACK_HOST.to_string(),
                port: 7890,
            }),
            backup.clone(),
            bypass.clone(),
            "gui".to_string(),
        );
        assert_eq!(service.enable().await.unwrap().phase, "enabled");
        (adapter, backup, bypass)
    }

    #[test]
    fn only_the_restore_flag_selects_a_headless_run() {
        assert!(run_from_args(arg_list(&["murge.exe"])).is_none());
        assert!(run_from_args(arg_list(&["murge.exe", "--hidden"])).is_none());
        // argv[0] is never treated as a flag.
        assert!(run_from_args(arg_list(&["--restore-system-proxy"])).is_none());
    }

    #[test]
    fn an_unreadable_backup_is_not_mistaken_for_no_backup() {
        let root = tempfile::tempdir().unwrap();
        assert!(backup_readable(root.path()).is_ok());
        let backup = root.path().join("system-proxy").join("owned-backup.json");
        std::fs::create_dir_all(&backup).unwrap(); // a directory cannot be read as a file
        assert!(backup_readable(root.path()).is_err());
        std::fs::remove_dir(&backup).unwrap();
        std::fs::write(&backup, b"{}").unwrap();
        assert!(backup_readable(root.path()).is_ok());
    }

    #[tokio::test]
    async fn restores_an_owned_proxy_and_drops_the_backup() {
        let (adapter, backup, bypass) = enabled_fixture().await;
        let outcome = restore_with(adapter.clone(), backup.clone(), bypass).await;
        assert!(outcome.ok, "{}", outcome.report);
        assert_eq!(outcome.report["phase"], "disabled");
        assert_eq!(adapter.read().await.unwrap(), original_registry());
        assert!(backup.read().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn nothing_owned_is_success() {
        let outcome = restore_with(
            Arc::new(FakeSystemProxyAdapter::new()),
            Arc::new(InMemoryBackupStore::new()),
            Arc::new(InMemoryBypassStore::new()),
        )
        .await;
        assert!(outcome.ok);
    }

    #[tokio::test]
    async fn an_external_edit_is_left_alone_and_does_not_block_removal() {
        let (adapter, backup, bypass) = enabled_fixture().await;
        let edited = RegistryState {
            proxy_enable: RegistryValue::dword(1),
            proxy_server: RegistryValue::string("10.0.0.1:3128"),
            proxy_override: RegistryValue::absent(),
        };
        adapter.set_registry(edited.clone());
        let outcome = restore_with(adapter.clone(), backup, bypass).await;
        assert!(outcome.ok, "{}", outcome.report);
        assert_eq!(outcome.report["phase"], "conflict");
        assert_eq!(adapter.read().await.unwrap(), edited);
    }

    #[tokio::test]
    async fn a_corrupt_backup_fails() {
        let backup = Arc::new(InMemoryBackupStore::new());
        backup
            .write(&serde_json::json!({ "schemaVersion": 999 }))
            .await
            .unwrap();
        let outcome = restore_with(
            Arc::new(FakeSystemProxyAdapter::new()),
            backup,
            Arc::new(InMemoryBypassStore::new()),
        )
        .await;
        assert!(!outcome.ok, "{}", outcome.report);
    }

    #[tokio::test]
    async fn a_failed_restore_fails() {
        let (adapter, backup, bypass) = enabled_fixture().await;
        adapter.fail_restore(true);
        let outcome = restore_with(adapter, backup, bypass).await;
        assert!(!outcome.ok, "{}", outcome.report);
        assert_eq!(outcome.report["phase"], "restore-failed");
    }
}
