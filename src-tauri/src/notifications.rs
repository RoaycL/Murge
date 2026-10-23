//! Native update notifications — the `notify()` half of
//! `src/main/updates/electron-updater-driver.ts`.
//!
//! Electron toasts when an update is found and again when it is downloaded;
//! clicking either opens the main window at /about. Here the notifier listens
//! to the `UpdateService` state stream instead of the driver, so it toasts on
//! the transition INTO `available` / `downloaded`, once per (phase, version):
//! a state replay (a re-check that restores a ready download, a renderer
//! refresh) never repeats a toast the user already saw.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// One toast to show: the dedupe key plus the Electron copy, byte for byte.
#[derive(Debug, PartialEq, Eq)]
pub struct UpdateToast {
    pub key: String,
    pub title: String,
    pub body: String,
}

/// The toast an update-state snapshot calls for, if any.
pub fn toast_for_state(state: &Value) -> Option<UpdateToast> {
    let phase = state["phase"].as_str()?;
    let version = state["availableVersion"]
        .as_str()
        .filter(|version| !version.is_empty())?;
    let (title, body) = match phase {
        "available" => (
            format!("发现新版本 v{version}"),
            "正在后台下载，退出应用时自动安装。".to_string(),
        ),
        "downloaded" => (
            format!("新版本 v{version} 已就绪"),
            "退出应用时自动安装，或点击“重启并安装”立即更新。".to_string(),
        ),
        _ => return None,
    };
    Some(UpdateToast {
        key: format!("{phase}:{version}"),
        title,
        body,
    })
}

/// Remembers which (phase, version) toasts were already shown.
#[derive(Default)]
pub struct UpdateNotifier {
    shown: Mutex<HashSet<String>>,
}

impl UpdateNotifier {
    /// The toast to show for this snapshot, or None when it is not a
    /// notifying phase or was already shown.
    pub fn take(&self, state: &Value) -> Option<UpdateToast> {
        let toast = toast_for_state(state)?;
        let mut shown = self.shown.lock().expect("notifier mutex poisoned");
        shown.insert(toast.key.clone()).then_some(toast)
    }
}

/// Bring the main window up on /about (the Electron
/// `windowAdapter.showMainWindowAt('/about')`).
fn open_about(app: &tauri::AppHandle) {
    crate::lifecycle::reveal_main_window(app);
    let _ = tauri::Emitter::emit(app, "app:navigate-event", "/about");
}

#[cfg(windows)]
fn show(app: &tauri::AppHandle, toast: UpdateToast) {
    use tauri_winrt_notification::Toast;
    // The same AUMID rule tauri-plugin-notification uses: an installed exe
    // toasts as the app (the installer's Start-menu shortcut registers the
    // identifier); a cargo-run build borrows PowerShell's id, since an
    // unregistered AUMID is dropped silently.
    let dev_build = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .map(|dir| dir.ends_with("target/debug") || dir.ends_with("target/release"))
        .unwrap_or(false);
    let app_id = if dev_build {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let click_app = app.clone();
    // WinRT activation may block briefly; never on the event loop or a
    // state listener.
    std::thread::spawn(move || {
        let result = Toast::new(&app_id)
            .title(&toast.title)
            .text1(&toast.body)
            .on_activated(move |_| {
                open_about(&click_app);
                Ok(())
            })
            .show();
        // A failing toast must never take down the update stream.
        if let Err(error) = result {
            crate::diag!("[notifications] update toast failed: {error}");
        }
    });
}

#[cfg(not(windows))]
fn show(app: &tauri::AppHandle, toast: UpdateToast) {
    // Murge ships on Windows only; other builds just log.
    let _ = app;
    crate::diag!("[notifications] {}: {}", toast.title, toast.body);
    let _ = open_about;
}

/// Subscribe the notifier to the update service (call once at startup).
pub fn start(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(service) = app.try_state::<Arc<crate::updates::UpdateService>>() else {
        return;
    };
    let notifier = Arc::new(UpdateNotifier::default());
    let app = app.clone();
    service.subscribe(Arc::new(move |state| {
        if let Some(toast) = notifier.take(state) {
            show(&app, toast);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn electron_copy_for_available_and_downloaded() {
        let found =
            toast_for_state(&json!({ "phase": "available", "availableVersion": "1.2.3" })).unwrap();
        assert_eq!(found.title, "发现新版本 v1.2.3");
        assert_eq!(found.body, "正在后台下载，退出应用时自动安装。");
        let ready = toast_for_state(&json!({ "phase": "downloaded", "availableVersion": "1.2.3" }))
            .unwrap();
        assert_eq!(ready.title, "新版本 v1.2.3 已就绪");
        assert_eq!(
            ready.body,
            "退出应用时自动安装，或点击“重启并安装”立即更新。"
        );
    }

    #[test]
    fn other_phases_and_missing_versions_stay_silent() {
        for phase in ["idle", "checking", "downloading", "not-available", "error"] {
            assert!(
                toast_for_state(&json!({ "phase": phase, "availableVersion": "1.2.3" })).is_none()
            );
        }
        assert!(
            toast_for_state(&json!({ "phase": "available", "availableVersion": null })).is_none()
        );
        assert!(
            toast_for_state(&json!({ "phase": "downloaded", "availableVersion": "" })).is_none()
        );
    }

    #[test]
    fn each_phase_and_version_toasts_once() {
        let notifier = UpdateNotifier::default();
        let available = json!({ "phase": "available", "availableVersion": "1.2.3" });
        let downloading = json!({ "phase": "downloading", "availableVersion": "1.2.3" });
        let downloaded = json!({ "phase": "downloaded", "availableVersion": "1.2.3" });
        assert!(notifier.take(&available).is_some());
        assert!(notifier.take(&available).is_none());
        assert!(notifier.take(&downloading).is_none());
        assert!(notifier.take(&downloaded).is_some());
        // A re-check restoring the ready download does not toast again.
        assert!(notifier
            .take(&json!({ "phase": "checking", "availableVersion": "1.2.3" }))
            .is_none());
        assert!(notifier.take(&downloaded).is_none());
        // A newer release toasts afresh.
        assert!(notifier
            .take(&json!({ "phase": "available", "availableVersion": "1.2.4" }))
            .is_some());
    }
}
