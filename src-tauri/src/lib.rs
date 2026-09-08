//! Murge — Tauri shell entry (Phase 2 side-by-side shell).
//!
//! The Electron shell remains the primary product until the Phase 7 cutover.
//! This crate hosts the same behavioral contract behind Tauri commands: the
//! renderer keeps calling `window.desktop` (identical shape to the Electron
//! preload), backed here by a single generic dispatch command so each Phase 3
//! vertical slice adds Rust handlers without touching the renderer contract.
//!
//! Security model: the webview never receives filesystem, shell or registry
//! access. Everything privileged stays in Rust (and, for the privileged core,
//! in the existing LocalSystem Go service — the renderer never calls it
//! directly, see docs/TAURI_MIGRATION_PLAN.md Phase 3D).

mod app_info;
mod brand;
mod ipc;
mod paths;
mod settings;

use tauri::Manager;

pub fn run() {
    // Startup gate: the brand document is a behavioral specification (the
    // Electron shell exits on an invalid brand). Parse it before anything else.
    // (The parsed document is also embedded into the binary via include_str!.)
    brand::load_brand().expect("invalid brand.config.json");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch reveals the existing window, mirroring the
            // Electron second-instance handler (restore -> show -> focus).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Deep-link argv delivery is wired with the deep-link slice
            // (Electron queues links; Phase 7 decides the UI reaction).
        }))
        .setup(|app| {
            // Dev builds never persist real user data: the settings store
            // stays in-memory when the probed paths are None.
            let paths = paths::AppPaths::probe();
            let store = settings::SettingsStore::for_environment(&paths);
            app.manage(paths);
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::desktop_ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
