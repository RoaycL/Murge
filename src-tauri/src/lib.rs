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
mod file_log;
mod js_sandbox;
mod lifecycle;
mod tray;
mod tray_view;
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
mod tun_service;
mod privileged_kernel;
mod tun_profile;
mod tun_hot_switch;
mod updates;
mod mihomo_artifact;
mod kernel_config_validation;
mod live_config;
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
            let usage = usage::UsageHistoryService::with_stores(
                usage::UsageHistoryStore::for_app_data_base(paths.app_data_root.clone()),
                usage::ProcessUsageStore::for_app_data_base(paths.app_data_root.clone()),
            );
            // Kernel supervisor + version manager. The composition follows
            // the TS three-way split: dev resolves the harmless fixture,
            // packaged Windows resolves the verified real mihomo artifact,
            // and any other production environment stays fail-closed.
            let is_dev = paths.app_data_root.is_none();
            // The version manager owns the per-version workspaces and the
            // GitHub metadata client; every composition shares it.
            let mut manager = kernel::KernelManagerService::for_workspace(
                paths.kernel_root().unwrap_or_else(|| std::env::temp_dir().join("murge-kernel-versions")),
            );
            // The `applyInstalledKernelVersionFinal` port: restart a live
            // kernel through the profile-reload coordinator and PROVE the
            // selected version took effect; a mismatch rolls the durable
            // channel selection back and restarts on it (the TS contract).
            {
                let handle = app.handle().clone();
                manager.apply_installed_version =
                    Some(std::sync::Arc::new(move |version, previous_channel, previous_specific| {
                        let handle = handle.clone();
                        Box::pin(async move {
                            let _gate = kernel::RUNTIME_UPDATE.lock().await;
                            let kernel_state = handle.state::<std::sync::Arc<crate::kernel::KernelServices>>();
                            let status = kernel_state.get_status_value();
                            if status["phase"].as_str() != Some("running")
                                && status["phase"].as_str() != Some("starting")
                            {
                                return Ok(());
                            }
                            let rollback: crate::live_config::RollbackActiveFn = {
                                let handle = handle.clone();
                                let previous_channel = previous_channel.clone();
                                let previous_specific = previous_specific.clone();
                                std::sync::Arc::new(move || {
                                    let handle = handle.clone();
                                    let previous_channel = previous_channel.clone();
                                    let previous_specific = previous_specific.clone();
                                    Box::pin(async move {
                                        let settings = handle.state::<std::sync::Arc<crate::settings::SettingsStore>>();
                                        settings.set(&crate::settings::AppSettingsPatch(
                                            serde_json::json!({
                                                "kernelChannel": previous_channel,
                                                "kernelSpecificVersion": previous_specific.unwrap_or_default()
                                            }),
                                        ));
                                        Ok(())
                                    })
                                })
                            };
                            let system_proxy = handle.state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>();
                            let profiles =
                                handle.state::<std::sync::Arc<profile_service::ProfilesService>>();
                            let overrides = handle.state::<std::sync::Arc<crate::override_service::OverrideService>>();
                            let models = handle.state::<std::sync::Arc<crate::enhancements::ModelStores>>();
                            crate::live_config::reload_active_profile_with_rollback(
                                &profiles, &overrides, &models, &kernel_state, &system_proxy,
                                Some(rollback.clone()),
                            )
                            .await?;
                            // The verification only applies to release tags
                            // (the TS `/^v\d+\.\d+\.\d+$/` gate).
                            let version_tag = regex::Regex::new(r"^v\d+\.\d+\.\d+$")
                                .expect("version tag regex");
                            if version_tag.is_match(&version) {
                                let applied = kernel_state.get_status_value();
                                let requested = version.trim_start_matches('v');
                                let effective =
                                    applied["version"].as_str().map(|v| v.trim_start_matches('v'));
                                if effective != Some(requested) {
                                    // Roll the durable selection back and
                                    // restart on it (best-effort).
                                    (rollback)().await.ok();
                                    let _ = crate::live_config::reload_active_profile(
                                        &profiles, &overrides, &models, &kernel_state, &system_proxy,
                                    )
                                    .await;
                                    return Err(crate::error::IpcError::code(
                                        crate::error::code::ARTIFACT_HASH_MISMATCH,
                                        format!(
                                            "内核版本未生效：请求 {version}，实际 {}",
                                            effective.unwrap_or("未知")
                                        ),
                                    ));
                                }
                            }
                            Ok(())
                        })
                    }));
            }
            let manager = std::sync::Arc::new(manager);
            let kernel = if is_dev {
                kernel::KernelServices::for_development(manager)
            } else if cfg!(windows) {
                // The controller secret is user-configurable and stable
                // across restarts; a fresh install receives a strong value
                // exactly once (the when-ready.ts seeding).
                let core_model = enhancements::coerce_core_settings(&models.core.get());
                let secret = if core_model["controllerSecret"].as_str().map(str::is_empty).unwrap_or(true) {
                    let generated = crate::kernel_process::random_secret();
                    let mut updated = core_model.clone();
                    updated["controllerSecret"] = serde_json::json!(generated);
                    let _ = models.core.set(&updated, enhancements::coerce_core_settings);
                    generated
                } else {
                    core_model["controllerSecret"].as_str().unwrap_or_default().to_string()
                };
                let ports = enhancements::coerce_core_settings(&models.core.get());
                // The controller-ready probe: one authenticated /version
                // through the SAME loopback URL the streams endpoint binds.
                let probe = crate::mihomo::MihomoClient::new(
                    ports["controllerPort"].as_i64().unwrap_or(9090),
                    &secret,
                )
                .ok()
                .map(|client| {
                    std::sync::Arc::new(kernel_process::MihomoVersionProbe { client })
                        as std::sync::Arc<dyn kernel_process::VersionProbe>
                });
                // The enhanced-document closure (the TS resolveEnhancedActiveDocument):
                // read through managed state at call time, after setup completes.
                let handle_for_doc = app.handle().clone();
                let resolve_active_document: std::sync::Arc<dyn Fn() -> Option<String> + Send + Sync> =
                    std::sync::Arc::new(move || {
                        let profiles = handle_for_doc
                            .state::<std::sync::Arc<crate::profile_service::ProfilesService>>();
                        let overrides = handle_for_doc.state::<std::sync::Arc<crate::override_service::OverrideService>>();
                        let models = handle_for_doc.state::<std::sync::Arc<crate::enhancements::ModelStores>>();
                        crate::live_config::resolve_enhanced_document(&profiles, &overrides, &models)
                            .ok()
                            .flatten()
                    });
                let handle_for_core = app.handle().clone();
                let resolve_core: std::sync::Arc<dyn Fn() -> serde_json::Value + Send + Sync> =
                    std::sync::Arc::new(move || {
                        handle_for_core.state::<std::sync::Arc<crate::enhancements::ModelStores>>().core.get()
                    });
                let handle_for_geodata = app.handle().clone();
                let resolve_geodata: std::sync::Arc<dyn Fn() -> serde_json::Value + Send + Sync> =
                    std::sync::Arc::new(move || {
                        handle_for_geodata.state::<std::sync::Arc<crate::enhancements::ModelStores>>().geodata.get()
                    });
                let handle_for_selection = app.handle().clone();
                let version_selection: kernel_process::VersionSelectionFn =
                    std::sync::Arc::new(move || {
                        let settings = handle_for_selection.state::<std::sync::Arc<crate::settings::SettingsStore>>();
                        let current = settings.get();
                        let specific = {
                            let raw = current.kernel_specific_version.trim();
                            if raw.is_empty() { None } else { Some(raw.to_string()) }
                        };
                        (current.kernel_channel.clone(), specific)
                    });
                let mut services = kernel::KernelServices::for_real_kernel(
                    paths.kernel_root().unwrap_or_default(),
                    None, // staged: bundled archive dir with the installer slice
                    secret,
                    ports,
                    Some(resolve_active_document),
                    Some(resolve_core),
                    Some(resolve_geodata),
                    std::sync::Arc::new(|| true), // isEnabled: always true
                    manager,
                    Some(version_selection.clone()),
                    probe,
                );
                // Packaged Windows: the installed LocalSystem service owns the
                // only mihomo process (ordinary and TUN modes alike). The
                // `--kernel-smoke` probe keeps the direct supervisor.
                if !std::env::args().any(|arg| arg == "--kernel-smoke") {
                    services.privileged = compose_privileged_kernel(app.handle().clone(), version_selection);
                    if let Some(privileged) = &services.privileged {
                        let client = privileged.client().clone();
                        let install_handle = app.handle().clone();
                        let _ = services.manager.install_version.set(std::sync::Arc::new(move |version| {
                            let client = client.clone();
                            let mixed_port = install_handle
                                .try_state::<std::sync::Arc<enhancements::ModelStores>>()
                                .and_then(|models| enhancements::coerce_core_settings(&models.core.get())["mixedPort"].as_i64())
                                .and_then(|port| u16::try_from(port).ok());
                            Box::pin(async move { client.install_version(&version, mixed_port).await })
                        }));
                    }
                }
                services
            } else {
                // Non-Windows production: fail-closed (the disabled resolver).
                kernel::KernelServices::with_manager(manager)
            };
            // The bounded daily log files (bootstrap.ts `fileLogs`): app log
            // under the stable namespace, dev keeps an ephemeral directory.
            let log_directory = match &paths.app_data_root {
                Some(root) => root.join("logs"),
                None => std::env::temp_dir().join(format!("murge-dev-logs-{}", std::process::id())),
            };
            let file_logs = file_log::FileLogService::new(log_directory);
            // The startup line (bootstrap.ts, module `startup`).
            file_logs.write_app(
                file_log::FileLogLevel::Info,
                &format!(
                    "version={} platform={} arch={}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
                "startup",
            );
            app.manage(file_logs.clone());
            // Mihomo controller services: log retention + selection cache.
            let mihomo = mihomo::MihomoServices::new(Some(paths.app_data_root.clone().unwrap_or_default()));
            // Push-stream transports + event forwarders. The endpoint binds
            // the coerced core-settings controller (rebuilt on kernel
            // transitions by the Phase 3D slice), exactly like the REST client.
            let streams = events::MihomoStreams::new(mihomo.logs.clone());
            events::start_forwarding(app.handle().clone(), &streams, &kernel, file_logs.clone());
            // Usage history collects from the push streams for the whole app
            // lifetime, independent of which page is mounted.
            {
                use tauri::Manager;
                let traffic_handle = app.handle().clone();
                streams.subscribe(
                    events::StreamKind::Traffic,
                    std::sync::Arc::new(move |value| {
                        let sample = usage::UsageSample {
                            up: value["up"].as_f64().unwrap_or(0.0),
                            down: value["down"].as_f64().unwrap_or(0.0),
                        };
                        if let Some(usage) = traffic_handle.try_state::<std::sync::Arc<crate::usage::UsageHistoryService>>() {
                            if let Err(error) = usage.record(&sample, None) {
                                eprintln!("[usage-history] background persistence failed: {error:?}");
                            }
                        }
                    }),
                );
                let connections_handle = app.handle().clone();
                streams.subscribe(
                    events::StreamKind::Connections,
                    std::sync::Arc::new(move |value| {
                        if let Some(usage) = connections_handle.try_state::<std::sync::Arc<crate::usage::UsageHistoryService>>() {
                            if let Err(error) = usage.record_connection_snapshot(value, usage::epoch_millis_now()) {
                                eprintln!("[usage-history] background persistence failed: {error:?}");
                            }
                        }
                    }),
                );
            }
            let core = enhancements::coerce_core_settings(&models.core.get());
            streams.ensure(&events::ControllerEndpoint {
                port: core["controllerPort"].as_i64().unwrap_or(9090),
                secret: core["controllerSecret"].as_str().unwrap_or_default().to_string(),
            });
            app.manage(std::sync::Arc::new(store));
            app.manage(profiles);
            app.manage(std::sync::Arc::new(overrides));
            app.manage(std::sync::Arc::new(models));
            app.manage(std::sync::Arc::new(usage));
            app.manage(std::sync::Arc::new(kernel));
            app.manage(std::sync::Arc::new(mihomo));
            app.manage(streams);
            // Desktop integration channels (icons + network interfaces).
            let icon_cache_root = match &paths.app_data_root {
                Some(root) => root.clone().join("icon-cache"),
                None => std::env::temp_dir().join(format!("murge-dev-icon-cache-{}", std::process::id())),
            };
            app.manage(std::sync::Arc::new(icons::DesktopServices::new(icon_cache_root)));
            // Egress metadata: resolved through the LIVE mixed port (kernel
            // down fails closed with the kernel-not-running copy), cached in
            // memory only.
            app.manage(std::sync::Arc::new(NetworkMetadataService::for_app(app.handle().clone())));
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
            app.manage(std::sync::Arc::new(startup_service));
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
                on_log: {
                    // The TS `onLog` wiring: worker output lands in the
                    // bounded substore log file (best-effort, never blocks).
                    let file_logs = file_logs.clone();
                    Some(std::sync::Arc::new(move |stream: &str, text: &str| {
                        file_logs.write_substore(stream, text)
                    }))
                },
                get_mixed_port: {
                    let app = app.handle().clone();
                    Box::new(move || {
                        use tauri::Manager;
                        app.try_state::<std::sync::Arc<crate::enhancements::ModelStores>>().and_then(|models| {
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
                            app.try_state::<std::sync::Arc<crate::settings::SettingsStore>>()
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
                    match hydration_app.try_state::<std::sync::Arc<crate::settings::SettingsStore>>() {
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
            app.manage(std::sync::Arc::new(substore_service));
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
                            .try_state::<std::sync::Arc<crate::kernel::KernelServices>>()
                            .map(|services| services.get_status_value()["phase"].as_str().unwrap_or("stopped").to_string())
                            .unwrap_or_else(|| "stopped".to_string())
                    },
                    move || {
                        use tauri::Manager;
                        probe_app_client
                            .try_state::<std::sync::Arc<crate::enhancements::ModelStores>>()
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
            app.manage(std::sync::Arc::new(system_proxy_service));
            // TUN: the coordinator is fully ported. The mutation adapter is
            // the controller hot-switch (controller REST only, platform
            // independent) when the build can run a kernel at all; dev and
            // non-Windows keep the fail-closed gate — the same boundary this
            // Electron build ships (the privileged service composition lands
            // with the real-kernel slice).
            let tun_supported = !is_dev && cfg!(windows);
            // The TS composition root (`tunSupported ? hotSwitch : Gated`):
            // the hot-switch adapter talks ONLY controller REST; dev and
            // non-Windows keep the fail-closed gate (the privileged service
            // composition lands with the real-kernel slice).
            let tun_adapter: std::sync::Arc<dyn tun::TunMutationAdapter> = if tun_supported {
                let handle = app.handle().clone();
                let client_factory: tun_hot_switch::ControllerClientFactory = {
                    let handle = handle.clone();
                    std::sync::Arc::new(move || {
                        let handle = handle.clone();
                        Box::pin(async move {
                            let core = enhancements::coerce_core_settings(
                                &handle.state::<std::sync::Arc<crate::enhancements::ModelStores>>().core.get(),
                            );
                            let port = core["controllerPort"].as_i64().unwrap_or(9090);
                            let secret = core["controllerSecret"].as_str().unwrap_or_default().to_string();
                            crate::mihomo::MihomoClient::new(port, &secret)
                        })
                    })
                };
                let read_tun_config = {
                    let handle = handle.clone();
                    move || {
                        let handle = handle.clone();
                        Box::pin(async move {
                            enhancements::coerce_tun_config(
                                &handle.state::<std::sync::Arc<crate::enhancements::ModelStores>>().tun_config.get(),
                            )
                        }) as tun_hot_switch::BoxFutValue
                    }
                };
                // The authoritative DNS-enabled flag: read from the SAME
                // enhanced document the kernel materializes (overrides → DNS
                // → sniffer); no profile → no DNS module → false.
                let read_dns_enabled = move || {
                    let handle = handle.clone();
                    Box::pin(async move {
                        let profiles =
                            handle.state::<std::sync::Arc<crate::profile_service::ProfilesService>>();
                        let overrides = handle.state::<std::sync::Arc<crate::override_service::OverrideService>>();
                        let models = handle.state::<std::sync::Arc<crate::enhancements::ModelStores>>();
                        crate::live_config::resolve_enhanced_document(&profiles, &overrides, &models)
                            .ok()
                            .flatten()
                    }) as tun_hot_switch::BoxFutDocument
                };
                std::sync::Arc::new(
                    tun_hot_switch::MihomoHotSwitchTunAdapter::new(
                        client_factory,
                        read_tun_config,
                        read_dns_enabled,
                    )
                    // The TS externalTunInUse probe: the fixed 28.0.0.1/30
                    // TUN adapter is shared mihomo real estate — a foreign
                    // owner (name match or either fixed address) makes enable
                    // a conflict instead of killing the shared core. The
                    // TS localeCompare(sensitivity: 'accent') approximation
                    // is a case-insensitive name match (device names carry no
                    // accent-sensitive distinctions in practice).
                    .with_external_tun_in_use(|device| {
                        Box::pin(async move {
                            if_addrs::get_if_addrs().map(|interfaces| {
                                let wanted = device.to_lowercase();
                                interfaces.iter().any(|interface| {
                                    let name_match =
                                        interface.name.to_lowercase() == wanted;
                                    let ip = interface.addr.ip();
                                    let addr_match = ip
                                        == std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                                            28, 0, 0, 1,
                                        ))
                                        || ip
                                            == std::net::IpAddr::V6(
                                                "fdfe:dcba:9876::1"
                                                    .parse()
                                                    .unwrap_or_else(|_| {
                                                        std::net::Ipv6Addr::UNSPECIFIED.into()
                                                    }),
                                            );
                                    name_match || addr_match
                                })
                            }).unwrap_or(false)
                        })
                    }),
                )
            } else {
                std::sync::Arc::new(tun::GatedTunMutationAdapter)
            };
            let tun_coordinator = tun::TunCoordinator::new(tun_adapter, tun_supported);
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
            app.manage(std::sync::Arc::new(tun_coordinator));
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
            app.manage(std::sync::Arc::new(updates_service));
            // The ordered-kernel-gateway crash hook: when the supervisor
            // reports `failed` while the system proxy is owned, restore it
            // immediately (the proxy must never outlive a dead listener).
            let recovery_app = app.handle().clone();
            let kernel_services = app.state::<std::sync::Arc<crate::kernel::KernelServices>>();
            kernel_services.status_listeners().subscribe(std::sync::Arc::new(move |value| {
                if value["phase"].as_str() == Some("failed") {
                    use tauri::Manager;
                    let recovery_app = recovery_app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(system_proxy) = recovery_app.try_state::<std::sync::Arc<crate::system_proxy::SystemProxyService>>() {
                            let _ = system_proxy.restore_before_kernel_unavailable().await;
                        }
                    });
                }
            }));
            if let Some(privileged) = kernel_services.privileged.clone() {
                start_privileged_monitor(app.handle().clone(), privileged);
            }
            app.manage(paths);

            // The tray slice: construct the native tray + controller with the
            // exact dependency set the TS tray adapter wired. Initialization
            // never gates startup (the TS `trayReady` contract): a headless
            // session (or a failed tray) logs and continues tray-less.
            match tray::wire_tray(app.handle().clone()) {
                Ok(()) => {}
                Err(error) => eprintln!("[tray] initialization failed (continuing tray-less): {error}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::desktop_ipc])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            use tauri::Manager;
            match event {
                // The `before-quit` equivalent (lifecycle-adapter.ts): the FIRST
                // user-interaction exit request is prevented, and the one
                // idempotent ordered flow runs instead — restore the owned
                // system proxy, stop the kernel, dispose services, flush logs,
                // then really exit. `code: Some(_)` comes from OUR
                // `AppHandle::exit(0)` (or a restart) and passes straight
                // through; a second user request while the flow is in flight
                // is also prevented, but the idempotency flag makes it a no-op.
                tauri::RunEvent::ExitRequested { code, api, .. }
                    if code.is_none() =>
                {
                    // `window-all-closed` on non-darwin is the TS default
                    // behavior — Tauri's exit-on-last-window-closed IS that
                    // path, so the ordered flow covers it too.
                    api.prevent_exit();
                    if !lifecycle::is_quitting() {
                        let app = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            lifecycle::begin_application_shutdown(app, false).await;
                        });
                    }
                }
                // The process-teardown residual (RunEvent::Exit): dispose
                // whatever the async flow could no longer reach. A spawned
                // async task could be dropped before the process exits, so
                // this stays synchronous.
                tauri::RunEvent::Exit => {
                    if let Some(substore) = app_handle.try_state::<std::sync::Arc<crate::substore::SubStoreService>>() {
                        substore.dispose();
                    }
                }
                _ => {}
            }
        });
}

/// The persisted controller endpoint `(port, secret)`, read at call time so a
/// kernel restart follows the network settings without an app restart.
fn current_controller(handle: &tauri::AppHandle) -> (i64, String) {
    use tauri::Manager;
    let core = handle
        .try_state::<std::sync::Arc<enhancements::ModelStores>>()
        .map(|models| enhancements::coerce_core_settings(&models.core.get()))
        .unwrap_or_default();
    (
        core["controllerPort"].as_i64().unwrap_or(9090),
        core["controllerSecret"].as_str().unwrap_or_default().to_string(),
    )
}

/// The privileged-service kernel gateway (when-ready.ts `privilegedKernel`):
/// one named-pipe client shared by start/stop, liveness and the exit monitor,
/// so ownership never splits across handles.
fn compose_privileged_kernel(
    handle: tauri::AppHandle,
    version_selection: kernel_process::VersionSelectionFn,
) -> Option<std::sync::Arc<privileged_kernel::PrivilegedKernelGateway>> {
    use tauri::Manager;
    let app_id = brand::load_brand().map(|brand| brand.app_id).unwrap_or_else(|_| "io.murge.desktop".to_string());
    let pipe_name = tun_service::tun_service_identity(&app_id).pipe_name;
    let transport = tun_service::NamedPipeTunServiceTransport::new(&pipe_name).ok()?;
    let client = std::sync::Arc::new(tun_service::TunServiceClient::new(Box::new(transport)));
    let profile_handle = handle.clone();
    let build_profile: privileged_kernel::ProfileBuilder = std::sync::Arc::new(move || {
        let profiles = profile_handle.state::<std::sync::Arc<profile_service::ProfilesService>>();
        let overrides = profile_handle.state::<std::sync::Arc<override_service::OverrideService>>();
        let models = profile_handle.state::<std::sync::Arc<enhancements::ModelStores>>();
        live_config::build_service_profile(&profiles, &overrides, &models)
    });
    let readiness_handle = handle.clone();
    let readiness: privileged_kernel::ReadinessProbe = std::sync::Arc::new(move || {
        let (controller_port, secret) = current_controller(&readiness_handle);
        Box::pin(async move {
            let client = mihomo::MihomoClient::new(controller_port, &secret)?;
            let version = client.get_version().await?;
            Ok(version["version"].as_str().map(str::to_string))
        })
    });
    Some(std::sync::Arc::new(privileged_kernel::PrivilegedKernelGateway::new(
        client,
        build_profile,
        readiness,
        std::sync::Arc::new(|| true),
        std::sync::Arc::new(move || version_selection()),
        privileged_kernel::PrivilegedKernelOptions {
            controller_port: std::sync::Arc::new(move || current_controller(&handle).0),
            ..Default::default()
        },
    )))
}

/// Reconcile the service-owned core once, then run the five-second exit
/// monitor (when-ready.ts `createPrivilegedExitMonitorTick` + setInterval).
fn start_privileged_monitor(
    handle: tauri::AppHandle,
    kernel: std::sync::Arc<privileged_kernel::PrivilegedKernelGateway>,
) {
    use tauri::Manager;
    let alive_handle = handle.clone();
    let start_handle = handle.clone();
    let start_kernel: std::sync::Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<(), error::IpcError>> + Send + Sync> =
        std::sync::Arc::new(move || {
            let handle = start_handle.clone();
            Box::pin(async move {
                if lifecycle::is_quitting() {
                    return Ok(());
                }
                let services = handle.state::<std::sync::Arc<kernel::KernelServices>>().inner().clone();
                services.start().await.map(|_| ())
            })
        });
    let wake_start = start_kernel.clone();
    let tun_handle = handle.clone();
    let proxy_handle = handle.clone();
    let settings_handle = handle.clone();
    let deps = privileged_kernel::ExitMonitorDeps {
        kernel: kernel.clone(),
        handle_host_exit: std::sync::Arc::new(move || {
            let handle = tun_handle.clone();
            Box::pin(async move {
                if let Some(tun) = handle.try_state::<std::sync::Arc<tun::TunCoordinator>>() {
                    let tun = tun.inner().clone();
                    tun.handle_host_exit().await;
                }
            })
        }),
        restore_system_proxy: std::sync::Arc::new(move || {
            let handle = proxy_handle.clone();
            Box::pin(async move {
                match handle.try_state::<std::sync::Arc<system_proxy::SystemProxyService>>() {
                    Some(proxy) => {
                        let proxy = proxy.inner().clone();
                        proxy.restore_before_kernel_unavailable().await
                    }
                    None => Ok(()),
                }
            })
        }),
        read_settings: std::sync::Arc::new(move || {
            settings_handle
                .try_state::<std::sync::Arc<settings::SettingsStore>>()
                .map(|store| {
                    let current = store.get();
                    (current.auto_start_kernel, current.tun_desired, current.system_proxy_desired)
                })
                .unwrap_or((false, false, false))
        }),
        start_kernel,
        // No durable intent-recovery loop exists in this shell yet: recreate
        // the core and let the user re-enable TUN / proxy.
        wake_intent_recovery: std::sync::Arc::new(move || {
            let start = wake_start.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start().await {
                    eprintln!("[kernel] privileged core recovery start: {}", error.extract_message());
                }
            });
        }),
        cancel_intent_recovery: std::sync::Arc::new(|| {}),
        is_controller_alive: std::sync::Arc::new(move || {
            let (controller_port, secret) = current_controller(&alive_handle);
            Box::pin(async move {
                match mihomo::MihomoClient::new(controller_port, &secret) {
                    Ok(client) => client.get_version().await.is_ok(),
                    Err(_) => false,
                }
            })
        }),
        is_suspended: std::sync::Arc::new(lifecycle::is_quitting),
        on_error: std::sync::Arc::new(|message, step| eprintln!("[kernel] privileged core exit {step}: {message}")),
        now_ms: std::sync::Arc::new(|| usage::epoch_millis_now().max(0) as u64),
    };
    let monitor = privileged_kernel::PrivilegedExitMonitor::new(deps);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = kernel.initialize().await {
            eprintln!("[kernel] privileged service reconcile failed: {}", error.extract_message());
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.tick().await;
        loop {
            interval.tick().await;
            monitor.tick().await;
        }
    });
}
