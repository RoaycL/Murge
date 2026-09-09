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
mod startup;
mod substore;
mod substore_zip;
mod system_proxy;
mod tun;
mod updates;
mod mihomo_artifact;
mod kernel_process;
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
            // OS login-item state (开机自启): serialized read-after-write
            // ownership over the Scheduled Task + Run-key ladder.
            let startup_service = startup::StartupService::new(startup::ScheduledTaskStartupAdapter::for_app(app.handle().clone()));
            // One-shot registration maintenance at startup: migrates v0.9.x
            // Run-key users to the scheduled task and rewrites stale
            // `--hidden` arguments. Best-effort and non-blocking; the toggle
            // still works either way.
            let maintenance_service = startup_service.clone();
            tauri::async_runtime::spawn(async move {
                let status = maintenance_service.refresh_registration().await;
                if status["phase"] == "error" {
                    eprintln!(
                        "[startup] registration maintenance skipped: {}",
                        status["errorMessage"].as_str().unwrap_or("系统未确认开机启动设置")
                    );
                }
            });
            app.manage(startup_service);
            // Sub-Store lifecycle owner: base dir + brand + live core-settings
            // mixed port. New installs default it on; the verified assets
            // are prepared in the background (the TS when-ready hydration).
            let substore_base = match &paths.app_data_root {
                Some(root) => root.join("substore"),
                None => std::env::temp_dir().join(format!("murge-dev-substore-{}", std::process::id())),
            };
            let brand_name = brand::load_brand().map(|brand| brand.product_name).unwrap_or_else(|_| "Murge".to_string());
            let substore_service = substore::SubStoreService::new(substore::SubStoreDeps {
                base_dir: substore_base,
                brand_name,
                get_mixed_port: {
                    let app = app.handle().clone();
                    Box::new(move || {
                        use tauri::Manager;
                        app.try_state::<enhancements::ModelStores>().and_then(|models| {
                            let core = enhancements::coerce_core_settings(&models.core.get());
                            core["mixedPort"].as_i64().filter(|port| *port > 0).map(|port| port as u16)
                        })
                    })
                },
                create_worker: None,
                fetch_fn: None,
                find_free_port: None,
                settings: {
                    // The TS AppSettingsGateway: the live persisted snapshot,
                    // resolved at call time through the managed store.
                    let app = app.handle().clone();
                    std::sync::Arc::new(move || {
                        let app = app.clone();
                        Box::pin(async move {
                            use tauri::Manager;
                            app.try_state::<settings::SettingsStore>()
                                .map(|store| store.get())
                                .unwrap_or_else(|| settings::AppSettings::default())
                        }) as futures_util::future::BoxFuture<'static, settings::AppSettings>
                    })
                },
                pinned_digests: (
                    substore::SUB_STORE_BACKEND_DEFAULT_DIGEST.to_string(),
                    substore::SUB_STORE_FRONTEND_DEFAULT_DIGEST.to_string(),
                ),
            });
            // Hydrate the persisted mirrors, then prepare the verified assets
            // in the background when the feature is on (the TS when-ready
            // hydration; non-blocking, failures surface in state).
            let hydration_service = substore_service.clone();
            let hydration_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Manager;
                let (enabled, use_proxy) = {
                    match hydration_app.try_state::<settings::SettingsStore>() {
                        Some(store) => {
                            let snapshot = store.get();
                            (snapshot.sub_store_enabled, snapshot.sub_store_use_proxy)
                        }
                        None => (false, false),
                    }
                };
                hydration_service.on_settings(enabled, use_proxy).await;
                if enabled {
                    let state = hydration_service.ensure_running().await;
                    if state["phase"] == "error" {
                        eprintln!("[substore] default asset preparation failed: {}", state["error"].as_str().unwrap_or_default());
                    }
                }
            });
            app.manage(substore_service);
            // System proxy: compose the controller for the current runtime —
            // the TS factory decision (dev → fake adapter + static probe +
            // memory stores; production → real registry adapter on Windows +
            // live kernel probe + durable file stores; elsewhere → the
            // fail-closed disabled adapter with the `unsupported` phase).
            let is_dev = paths.app_data_root.is_none();
            let adapter: std::sync::Arc<dyn system_proxy::SystemProxyAdapter> = if is_dev {
                std::sync::Arc::new(system_proxy::FakeSystemProxyAdapter::new())
            } else if cfg!(windows) {
                std::sync::Arc::new(system_proxy::WindowsSystemProxyAdapter::with_runner(
                    system_proxy::real_command_runner(),
                ))
            } else {
                std::sync::Arc::new(system_proxy::DisabledSystemProxyAdapter::new(std::env::consts::OS))
            };
            let probe: system_proxy::ProbeFn = if is_dev {
                system_proxy::static_probe(system_proxy::Target {
                    host: system_proxy::SYSTEM_PROXY_LOOPBACK_HOST.to_string(),
                    port: 7890,
                })
            } else {
                let probe_app_phase = app.handle().clone();
                let probe_app_client = app.handle().clone();
                system_proxy::live_probe(
                    move || {
                        use tauri::Manager;
                        probe_app_phase
                            .try_state::<kernel::KernelServices>()
                            .map(|services| services.supervisor.get_status()["phase"].as_str().unwrap_or("stopped").to_string())
                            .unwrap_or_else(|| "stopped".to_string())
                    },
                    move || {
                        use tauri::Manager;
                        probe_app_client
                            .try_state::<enhancements::ModelStores>()
                            .ok_or_else(|| crate::error::IpcError::code(crate::error::code::SYSTEM_PROXY_KERNEL_REQUIRED, "内核控制器未就绪，无法启用系统代理"))
                            .and_then(|models| {
                                let core = enhancements::coerce_core_settings(&models.core.get());
                                mihomo::MihomoClient::new(
                                    core["controllerPort"].as_i64().unwrap_or(9090),
                                    core["controllerSecret"].as_str().unwrap_or_default(),
                                )
                            })
                    },
                )
            };
            let (backup_store, bypass_store): (
                std::sync::Arc<dyn system_proxy::BackupStore>,
                std::sync::Arc<dyn system_proxy::ProxyBypassStore>,
            ) = match (&paths.app_data_root, is_dev) {
                (Some(root), false) => (
                    std::sync::Arc::new(system_proxy::FileSystemBackupStore::for_base_dir(root)),
                    std::sync::Arc::new(system_proxy::FileSystemBypassStore::for_base_dir(root)),
                ),
                _ => (
                    std::sync::Arc::new(system_proxy::InMemoryBackupStore::new()),
                    std::sync::Arc::new(system_proxy::InMemoryBypassStore::new()),
                ),
            };
            let system_proxy_service = system_proxy::SystemProxyService::new(
                adapter,
                probe,
                backup_store,
                bypass_store,
                system_proxy::new_uuid(),
            );
            // Forward system-proxy status transitions to every renderer window
            // (the register-ipc.ts `forward` for the status event).
            let status_app = app.handle().clone();
            system_proxy_service.listeners.subscribe(std::sync::Arc::new(move |value| {
                let _ = tauri::Emitter::emit(&status_app, "system-proxy:status-event", value.clone());
            }));
            app.manage(system_proxy_service);
            // TUN: the coordinator is fully ported; the mutation adapter is
            // the fail-closed gate (the same boundary this Electron build
            // ships — the privileged service lands with the G1 review).
            let tun_supported = !is_dev && cfg!(windows);
            let tun_coordinator =
                tun::TunCoordinator::new(std::sync::Arc::new(tun::GatedTunMutationAdapter), tun_supported);
            // Forward TUN status transitions to every renderer window.
            let tun_app = app.handle().clone();
            tun_coordinator.subscribe(std::sync::Arc::new(move |value| {
                let _ = tauri::Emitter::emit(&tun_app, "tun:status-event", value.clone());
            }));
            // Startup reconciliation of an interrupted TUN transaction (the
            // tunReconcile recovery layer; never a cached crash-time status).
            let reconcile_coordinator = tun_coordinator.clone();
            tauri::async_runtime::spawn(async move {
                reconcile_coordinator.initialize().await;
            });
            app.manage(tun_coordinator);
            // Updates: the gated driver honestly reports "not supported" in
            // this build; state transitions forward to every renderer window.
            let updates_service =
                updates::UpdateService::new(std::sync::Arc::new(updates::GatedUpdaterDriver::new()));
            updates_service.start();
            let updates_app = app.handle().clone();
            updates_service.subscribe(std::sync::Arc::new(move |value| {
                let _ = tauri::Emitter::emit(&updates_app, "updates:state-event", value.clone());
            }));
            // Mid-session feed polling (the mihomo-party / sparkle model); a
            // no-op on the gated driver.
            updates_service.start_polling(10 * 60 * 1000);
            app.manage(updates_service);
            // The ordered-kernel-gateway crash hook: when the supervisor
            // reports `failed` while the system proxy is owned, restore it
            // immediately (the proxy must never outlive a dead listener).
            let recovery_app = app.handle().clone();
            let kernel_services = app.state::<kernel::KernelServices>();
            kernel_services.supervisor.status_listeners.subscribe(std::sync::Arc::new(move |value| {
                if value["phase"].as_str() == Some("failed") {
                    use tauri::Manager;
                    let recovery_app = recovery_app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(system_proxy) = recovery_app.try_state::<system_proxy::SystemProxyService>() {
                            let _ = system_proxy.restore_before_kernel_unavailable().await;
                        }
                    });
                }
            }));
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::desktop_ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
