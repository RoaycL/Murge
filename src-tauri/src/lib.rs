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
mod enhancements;
mod error;
mod inspection;
mod net_validators;
mod events;
mod ipc;
#[allow(dead_code)] // wired incrementally; the lint fires on staged-but-unwired items
mod mihomo;
mod kernel;
mod override_apply;
mod override_model;
mod override_service;
mod paths;
mod internet_latency;
mod network_metadata;
// Network metadata service: shared, cached, single-flight app state.
use network_metadata::NetworkMetadataService;
mod profile_parse;
mod unlock;
mod route_latency;
mod icons;
mod profile_service;
mod subscription;
mod profiles;
mod redact;
mod settings;
mod usage;
mod validate;

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
            // Dev builds never persist real user data: an ephemeral workspace
            // backs the profile store and secrets stay in memory. Production
            // uses the brand-stable app-data namespace + OS credential store.
            let paths = paths::AppPaths::probe();
            let store = settings::SettingsStore::for_environment(&paths);
            let profiles = std::sync::Arc::new(match &paths.profile_root {
                Some(root) => profile_service::ProfilesService::for_paths(
                    root,
                    &paths::app_data_namespace(),
                ),
                None => {
                    let temp = std::env::temp_dir().join(format!("murge-dev-profiles-{}", std::process::id()));
                    profile_service::ProfilesService::for_development(&temp)
                }
            });
            // Preview/validate resolve the base document from the ACTIVE
            // profile (document + id), mirroring the Electron composition.
            let overrides = {
                let profiles = profiles.clone();
                override_service::OverrideService::new(paths.app_data_root.clone())
                    .with_base_resolver(Box::new(move || {
                        profiles.get_active().ok().and_then(|profile| {
                            if profile.is_null() {
                                return None;
                            }
                            let document = profile["document"].as_str()?.to_string();
                            let profile_id = profile["meta"]["id"].as_str()?.to_string();
                            Some((document, Some(profile_id)))
                        })
                    }))
            };
            // Typed single-model stores (core/geodata/dns/sniffer/tun-config);
            // dev resolves to None -> memory-only stores.
            let models = enhancements::ModelStores::new(paths.app_data_root.clone());
            // Bounded usage history: file-backed in production, memory-only in
            // dev (the Electron app.isPackaged split).
            let usage = usage::UsageHistoryService::new(usage::UsageHistoryStore::for_app_data_base(
                paths.app_data_root.clone(),
            ));
            // Kernel supervisor + version manager (disabled-resolver milestone).
            let kernel = kernel::KernelServices::new();
            // Mihomo controller services: log retention + selection cache.
            let mihomo = mihomo::MihomoServices::new(Some(paths.app_data_root.clone().unwrap_or_default()));
            // Push-stream transports + event forwarders. The endpoint binds
            // the coerced core-settings controller (rebuilt on kernel
            // transitions by the Phase 3D slice), exactly like the REST client.
            let streams = events::MihomoStreams::new(mihomo.logs.clone());
            events::start_forwarding(app.handle().clone(), &streams, &kernel);
            let core = enhancements::coerce_core_settings(&models.core.get());
            streams.ensure(&events::ControllerEndpoint {
                port: core["controllerPort"].as_i64().unwrap_or(9090),
                secret: core["controllerSecret"].as_str().unwrap_or_default().to_string(),
            });
            app.manage(store);
            app.manage(profiles);
            app.manage(overrides);
            app.manage(models);
            app.manage(usage);
            app.manage(kernel);
            app.manage(mihomo);
            app.manage(streams);
            // Desktop integration channels (icons + network interfaces).
            let icon_cache_root = match &paths.app_data_root {
                Some(root) => root.clone().join("icon-cache"),
                None => std::env::temp_dir().join(format!("murge-dev-icon-cache-{}", std::process::id())),
            };
            app.manage(icons::DesktopServices::new(icon_cache_root));
            // Egress metadata: resolved through the LIVE mixed port (kernel
            // down fails closed with the kernel-not-running copy), cached in
            // memory only.
            app.manage(NetworkMetadataService::for_app(app.handle().clone()));
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::desktop_ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
