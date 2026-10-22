//! Keep the installed exe from being driven by its environment.
//!
//! The privileged TUN service trusts a pipe client by its executable path and
//! hash (`native/tun-service/main_windows.go` verifyClient). That only means
//! something if the trusted exe runs the code it shipped with. The Electron
//! build burned its fuses (runAsNode, NODE_OPTIONS, --inspect) for the same
//! reason. The Tauri equivalent is WebView2: these variables let any process
//! running as the user attach a debugger to the webview or load a different
//! browser runtime, and from there call the same IPC that reaches the service.
//! They are removed before any webview is created. Dev builds keep them so
//! `tauri dev` and WebDriver testing still work.

/// Environment variables that change what the webview runs or who can drive it.
pub const WEBVIEW_CONTROL_VARIABLES: [&str; 7] = [
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
    "WEBVIEW2_USER_DATA_FOLDER",
    "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
    "WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER",
    "TAURI_WEBVIEW_AUTOMATION",
];

/// Remove the webview control variables from this process (and so from every
/// child it spawns, including the WebView2 browser process). Must run on the
/// main thread before any other thread starts.
pub fn scrub_webview_environment() {
    if cfg!(debug_assertions) {
        return;
    }
    for name in WEBVIEW_CONTROL_VARIABLES {
        std::env::remove_var(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_debugger_and_runtime_overrides() {
        for name in [
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "TAURI_WEBVIEW_AUTOMATION",
        ] {
            assert!(WEBVIEW_CONTROL_VARIABLES.contains(&name), "{name}");
        }
    }
}
