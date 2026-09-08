//! The desktop bridge — Tauri command surface of the compatibility layer.
//!
//! The renderer keeps the exact `window.desktop` contract of the Electron
//! preload (`src/preload/index.ts`); the TS bridge installed before Vue mounts
//! funnels every call through this single dispatch command. Channel names are
//! the SAME `src/shared/ipc.ts` strings the Electron main process dispatches,
//! so Phase 3 slices add Rust handlers keyed by the channel constant.
//!
//! Error wire format: Electron can only carry an error string across IPC, so
//! `ProtocolError` is encoded as `PROTOCOL_ERROR:<CODE>::<message>`. Tauri
//! command errors keep the identical encoding (see `IpcError`) and the TS
//! bridge decodes with the SAME `decodeProtocolError` helper, so error
//! mapping is shell-independent.

use serde_json::Value;
use std::sync::Arc;
use tauri::State;

use crate::app_info;
use crate::enhancements;
use crate::icons;
use crate::network_metadata::NetworkMetadataService;
use crate::startup::StartupService;
use crate::inspection;
use crate::kernel;
use crate::mihomo;
use crate::usage;
use crate::brand;
use crate::error::IpcError;
use crate::override_service::OverrideService;
use crate::paths::AppPaths;
use crate::profile_service::ProfilesService;
use crate::settings::{AppSettingsPatch, SettingsStore};

pub type IpcResult = Result<Value, IpcError>;

/// The one command the webview is allowed to call. Everything else —
/// filesystem, registry, the privileged named pipe — stays in Rust.
#[tauri::command]
pub async fn desktop_ipc(
    channel: String,
    payload: Value,
    paths: State<'_, AppPaths>,
    settings: State<'_, SettingsStore>,
    profiles: State<'_, Arc<ProfilesService>>,
    overrides: State<'_, OverrideService>,
    models: State<'_, enhancements::ModelStores>,
    usage: State<'_, usage::UsageHistoryService>,
    kernel: State<'_, kernel::KernelServices>,
    mihomo: State<'_, mihomo::MihomoServices>,
    desktop: State<'_, icons::DesktopServices>,
    metadata: State<'_, NetworkMetadataService>,
    startup: State<'_, StartupService>,
    substore: State<'_, crate::substore::SubStoreService>,
    system_proxy: State<'_, crate::system_proxy::SystemProxyService>,
    tun: State<'_, crate::tun::TunCoordinator>,
) -> IpcResult {
    let startup_inner = startup.inner();
    dispatch(&channel, &payload, &paths, &settings, &profiles, &overrides, &models, &usage, &kernel, &mihomo, &desktop, &metadata, startup_inner, &substore, &system_proxy, &tun).await
}

/// Payload arrays arrive as a JSON array; positional access mirrors the
/// preload's argument order.
/// get() goes through the model coercion so a corrupt file can never leak an
/// unnormalized document to the renderer (the TS ensureLoaded does the same).
fn coerce(model: Value) -> Value {
    if model.is_null() {
        Value::Null
    } else {
        model
    }
}

/// The `{ enhancement: ... }` / `{ config: ... }` snapshot envelope.
fn json_envelope(key: &str, model: Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert(key.to_string(), model);
    Value::Object(object)
}

fn arg(payload: &Value, index: usize) -> Option<&Value> {
    payload.get(index)
}

fn string_arg(payload: &Value, index: usize) -> Option<String> {
    arg(payload, index).and_then(Value::as_str).map(str::to_string)
}

/// Channel dispatch table. Phase 3 slices extend this match; channels that do
/// not yet have a Rust handler fail closed with UNSUPPORTED (never silently
/// no-op), so the renderer sees an honest error during the migration. The
/// `paths` parameter is part of the stable dispatch signature from day one —
/// the log/usage slices (3A) consume it.
pub async fn dispatch(
    channel: &str,
    payload: &Value,
    _paths: &AppPaths,
    settings: &SettingsStore,
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
    usage: &usage::UsageHistoryService,
    kernel: &kernel::KernelServices,
    mihomo: &mihomo::MihomoServices,
    desktop: &icons::DesktopServices,
    metadata: &NetworkMetadataService,
    startup: &StartupService,
    substore: &crate::substore::SubStoreService,
    system_proxy: &crate::system_proxy::SystemProxyService,
    tun: &crate::tun::TunCoordinator,
) -> IpcResult {
    match channel {
        "app:get-brand" => Ok(brand::brand_document()),
        // Desktop integrations (Phase 3C): icons + network interfaces. The
        // TS handlers return null/[] quietly on invalid input — no errors.
        "app:get-process-icon" => Ok(desktop.get_process_icon(string_arg(payload, 0).as_deref())),
        "app:get-cached-icon" => {
            let key = string_arg(payload, 0);
            let url = string_arg(payload, 1);
            let refresh = payload.get(2).and_then(Value::as_bool).unwrap_or(false);
            Ok(desktop.icon_cache.get(key.as_deref(), url.as_deref(), refresh).await)
        }
        "app:list-network-interfaces" => Ok(desktop.list_network_interfaces()),
        // Network (egress) metadata — Phase 3C slice 13. State lives on the
        // app handle (cached, single-flight); the payload tail carries the
        // per-call argument.
        "network-metadata:get-providers" => {
            Ok(metadata.get_providers().await)
        }
        "network-metadata:get-state" => {
            Ok(metadata.get_state().await)
        }
        "network-metadata:select-provider" => {
            let id = crate::network_metadata::parse_provider_id(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(metadata.select_provider(&id).await?)
        }
        "network-metadata:resolve" => {
            let force = crate::subscription::parse_optional_boolean(arg(payload, 0), "force")?;
            Ok(metadata.resolve(force).await)
        }
        // Sub-Store lifecycle (初步接入) — Phase 3C slice 16.
        "substore:get-state" => Ok(substore.snapshot().await),
        "substore:ensure-running" => Ok(substore.ensure_running().await),
        "substore:stop" => Ok(substore.stop().await),
        "substore:check-update" => Ok(substore.check_update().await),
        "substore:open-external" => {
            let url = crate::substore::parse_sub_store_external_url(arg(payload, 0).unwrap_or(&Value::Null))?;
            substore.open_external(&url).await.map_err(|error| IpcError::code(crate::error::code::UPSTREAM_UNREACHABLE, error))?;
            Ok(Value::Null)
        }
        // 系统代理 — Phase 3D slice 17. The enable/disable handlers are
        // intent-first (the TS appSettings.set before the registry work), and
        // enable starts the kernel when it is not running.
        "system-proxy:get-status" => Ok(system_proxy.get_status_value()),
        "system-proxy:enable" => {
            settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({"systemProxyDesired": true})));
            if kernel.supervisor.get_status()["phase"].as_str() != Some("running") {
                kernel.supervisor.start()?;
            }
            Ok(serde_json::to_value(system_proxy.enable().await?).expect("status serializes"))
        }
        "system-proxy:disable" => {
            settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({"systemProxyDesired": false})));
            Ok(serde_json::to_value(system_proxy.disable().await?).expect("status serializes"))
        }
        "system-proxy:get-proxy-bypass" => Ok(system_proxy.get_proxy_bypass().await),
        "system-proxy:set-proxy-bypass" => {
            let policy = crate::system_proxy::parse_proxy_bypass_policy(arg(payload, 0))?;
            Ok(system_proxy.set_proxy_bypass(policy).await?)
        }
        "system-proxy:preview-proxy-bypass" => {
            let policy = crate::system_proxy::parse_proxy_bypass_policy(arg(payload, 0))?;
            Ok(Value::String(system_proxy.preview_proxy_bypass(&policy).await))
        }
        // TUN 生命周期 — Phase 3D slice 18. The coordinator is fully ported;
        // the privileged mutation stays behind the fail-closed gate (the same
        // boundary this Electron build ships). Enable/disable are intent-first.
        "tun:get-status" => Ok(tun.get_status_value()),
        "tun:enable" => {
            settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({"tunDesired": true})));
            let intent = serde_json::json!({
                "schemaVersion": 2,
                "device": format!("{} TUN", crate::brand::load_brand().map(|brand| brand.short_name).unwrap_or_else(|_| "Murge".to_string())),
                "stack": "mixed"
            });
            Ok(serde_json::to_value(tun.enable(&intent).await?).expect("tun status serializes"))
        }
        "tun:disable" => {
            settings.set(&crate::settings::AppSettingsPatch(serde_json::json!({"tunDesired": false})));
            Ok(serde_json::to_value(tun.emergency_disable().await).expect("tun status serializes"))
        }
        // OS login-item state (开机自启) — Phase 4 prep, invoke channels first.
        "startup:get-status" => Ok(startup.get_status().await),
        "startup:set-enabled" => {
            let enabled = arg(payload, 0)
                .and_then(Value::as_bool)
                .ok_or_else(|| IpcError::invalid_argument("startup enabled must be a boolean"))?;
            Ok(startup.set_enabled(enabled).await)
        }
        // 解锁测试 probes — Phase 3C slice 14. The transport goes through the
        // kernel's LIVE mixed port (kernel down fails closed with the typed
        // UPSTREAM_UNREACHABLE copy, never a DIRECT sample).
        "network:unlock-test-all" => {
            let port = resolve_mixed_port(models).await?;
            Ok(Value::Array(crate::unlock::sample(|_| crate::unlock::real_probe(port)).await))
        }
        "network:unlock-test-one" => {
            let name = crate::unlock::parse_unlock_service_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            let port = resolve_mixed_port(models).await?;
            Ok(Value::Array(vec![crate::unlock::result_to_value(
                &crate::unlock::detect_service(&name, crate::unlock::real_probe(port)).await,
            )]))
        }
        "network-metadata:resolve-all" => {
            let force = crate::subscription::parse_optional_boolean(arg(payload, 0), "force")?;
            Ok(metadata.resolve_all(force).await)
        }
        "app:get-info" => Ok(app_info::app_info(env!("CARGO_PKG_VERSION"))),
        "app-settings:get" => Ok(serde_json::to_value(settings.get()).expect("settings serialize")),
        "app-settings:set" => {
            // The bridge sends positional args; the patch is args[0].
            let patch_value = arg(payload, 0).cloned().unwrap_or(Value::Null);
            let patch: AppSettingsPatch = serde_json::from_value(patch_value)
                .map_err(|_| IpcError::invalid_argument("app-settings:set payload must be a JSON object"))?;
            let silent_launch_before = settings.get().silent_launch;
            let applied = settings.set(&patch);
            // The persisted silent-launch preference moved: the login item's
            // registered arguments must follow (the TS appSettings.onChange
            // hook), best-effort.
            if applied.silent_launch != silent_launch_before {
                startup.refresh_registration().await;
            }
            // The Sub-Store mirrors track every settings change; an actual
            // enable/proxy-mode flip drives stop/restart inside the service.
            substore.on_settings(applied.sub_store_enabled, applied.sub_store_use_proxy).await;
            Ok(serde_json::to_value(applied).expect("settings serialize"))
        }

        // --- profiles (Phase 3A) -------------------------------------------
        "profiles:list" => profiles.list(),
        "profiles:get" => profiles.get(&required_string(payload, 0, "profiles:get id")?),
        "profiles:import" => {
            let request = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("profiles:import requires a request object"))?;
            profiles.import(request)
        }
        "profiles:import-from-url" => {
            // Positional args: [name?, url, activate?] — the bridge forwards
            // the renderer's arg list; schema validation mirrors
            // shared/schemas/profiles.ts (parseOptionalImportName +
            // parseSubscriptionUrl + parseOptionalBoolean).
            let name = crate::subscription::parse_optional_import_name(string_arg(payload, 0).as_deref())?;
            let url = crate::subscription::parse_subscription_url(string_arg(payload, 1).as_deref())?;
            let activate = crate::subscription::parse_optional_boolean(payload.get(2), "activate")?;
            profiles.import_from_url(&name, &url, activate).await
        }
        "profiles:update-from-source" => {
            profiles
                .update_from_source(&required_string(payload, 0, "profiles:update-from-source id")?)
                .await
        }
        "profiles:activate" => profiles.activate(&required_string(payload, 0, "profiles:activate id")?),
        "profiles:delete" => profiles.delete(&required_string(payload, 0, "profiles:delete id")?),
        "profiles:rename" => profiles.rename(
            &required_string(payload, 0, "profiles:rename id")?,
            &string_arg(payload, 1).unwrap_or_default(),
        ),
        "profiles:edit-document" => {
            let raw_edits: Vec<serde_json::Value> = arg(payload, 1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let edits: Vec<crate::profiles::ConfigEdit> = raw_edits
                .iter()
                .filter_map(|edit| {
                    Some(crate::profiles::ConfigEdit {
                        key: edit.get("key")?.as_str()?.to_string(),
                        value: edit.get("value")?.as_str()?.to_string(),
                    })
                })
                .collect();
            profiles.edit_document(&required_string(payload, 0, "profiles:edit-document id")?, &edits)
        }
        "profiles:replace-document" => profiles.replace_document(
            &required_string(payload, 0, "profiles:replace-document id")?,
            &string_arg(payload, 1).unwrap_or_default(),
        ),
        "profiles:get-source-url" => profiles.get_source_url(&required_string(payload, 0, "profiles:get-source-url id")?),
        "profiles:set-source-url" => profiles.set_source_url(
            &required_string(payload, 0, "profiles:set-source-url id")?,
            &string_arg(payload, 1).unwrap_or_default(),
        ),
        "profiles:validate" => profiles.validate(&string_arg(payload, 0).unwrap_or_default()),
        "profiles:get-active-group-order" => profiles.get_active_group_order(),
        "profiles:get-active-provider-catalog" => profiles.get_active_provider_catalog(),
        "profiles:get-provider-content" => Err(IpcError::unsupported(
            "profiles:get-provider-content reads provider caches through the privileged Go service (Phase 3D)",
        )),
        "profiles:inspect-active-config" => {
            // The Electron composition: overrides -> DNS enhancement ->
            // sniffer enhancement -> buildProfileKernelConfig. TUN is disabled
            // inside the Rust shell until the Phase 3D privileged slice, so
            // the runtime config always follows the non-TUN branch (matching
            // Electron's tunEnabled=false behavior).
            let profile = profiles.get_active()?;
            if profile.is_null() {
                return Ok(inspection::inspect_active_profile_config(
                    None,
                    "",
                    "",
                    &serde_json::json!({
                        "coreOverride": false, "dnsOverride": false, "snifferOverride": false,
                        "geodataOverride": false, "tunEnabled": false
                    }),
                ));
            }
            let document = profile["document"].as_str().unwrap_or_default().to_string();
            let profile_id = profile["meta"]["id"].as_str().unwrap_or_default().to_string();
            let profile_name = profile["meta"]["name"].as_str().map(str::to_string);
            let overridden = overrides.apply_for_profile(&document, Some(&profile_id))?;
            let dns = enhancements::coerce_dns_enhancement(&models.dns.get());
            let (dns_text, _) = inspection::apply_dns_to_document(&overridden, &dns);
            let sniffer = enhancements::coerce_sniffer_enhancement(&models.sniffer.get());
            let (base, _) = inspection::apply_sniffer_to_document(&dns_text, &sniffer);
            let core = enhancements::coerce_core_settings(&models.core.get());
            let geodata = enhancements::coerce_geodata_settings(&models.geodata.get());
            // The kernel runtime knobs are staged with the Phase 3B/3D
            // supervisor; until then the core-settings model is the
            // authoritative source (the pre-kernel Electron fallbacks match:
            // mixed-port 7890, controller 9090, secret 64 zeros when absent).
            let secret = core["controllerSecret"].as_str().unwrap_or("");
            let secret = if regex::Regex::new(inspection::SECRET_PATTERN)
                .expect("secret pattern")
                .is_match(secret)
            {
                secret.to_string()
            } else {
                "0".repeat(64)
            };
            let runtime = serde_json::json!({
                "mixedPort": core["mixedPort"],
                "httpPort": if core["enabled"].as_bool() == Some(true) { core["httpPort"].clone() } else { serde_json::json!(0) },
                "socksPort": if core["enabled"].as_bool() == Some(true) { core["socksPort"].clone() } else { serde_json::json!(0) },
                "controllerPort": core["controllerPort"],
                "controllerHost": core["controllerHost"],
                "allowLan": core["allowLan"],
                "controllerPanel": core["controllerPanel"],
                "secret": secret,
                "core": core,
                "geodata": geodata
            });
            let effective = inspection::build_profile_kernel_config(&base, &runtime)?;
            Ok(inspection::inspect_active_profile_config(
                profile_name.as_deref(),
                &document,
                &effective,
                &serde_json::json!({
                    "coreOverride": core["enabled"].as_bool() == Some(true),
                    "dnsOverride": dns["enabled"].as_bool() == Some(true),
                    "snifferOverride": sniffer["enabled"].as_bool() == Some(true),
                    "geodataOverride": geodata["enabled"].as_bool() == Some(true),
                    "tunEnabled": false
                }),
            ))
        }

        // --- overrides (Phase 3A) -------------------------------------------
        "overrides:list" => overrides.list(),
        "overrides:create" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("overrides:create requires an input object"))?;
            overrides.create(input)
        }
        "overrides:update" => {
            let id = required_string(payload, 0, "overrides:update id")?;
            let input = arg(payload, 1)
                .ok_or_else(|| IpcError::invalid_argument("overrides:update requires an input object"))?;
            overrides.update(&id, input)
        }
        "overrides:remove" => overrides.remove(&required_string(payload, 0, "overrides:remove id")?),
        "overrides:set-enabled" => {
            let id = required_string(payload, 0, "overrides:set-enabled id")?;
            let enabled = arg(payload, 1)
                .and_then(Value::as_bool)
                .ok_or_else(|| IpcError::invalid_argument("overrides:set-enabled requires a boolean"))?;
            overrides.set_enabled(&id, enabled)
        }
        "overrides:move" => overrides.move_item(
            &required_string(payload, 0, "overrides:move id")?,
            &string_arg(payload, 1).unwrap_or_default(),
        ),
        "overrides:preview" => overrides.preview(),
        "overrides:validate" => overrides.validate(),
        "overrides:last-known-good" => overrides.last_known_good(),
        "overrides:reset-to-last-good" => overrides.reset_to_last_good(),

        // --- typed single-model stores (Phase 3A) ---------------------------
        // get/set return the same envelope shapes the Electron services use;
        // preview renders the block a model would produce (never writes).
        "core-settings:get" => Ok(coerce(enhancements::coerce_core_settings(&models.core.get()))),
        "core-settings:set" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("core-settings:set requires a settings object"))?;
            models.core.set(input, enhancements::coerce_core_settings)
        }
        "core-settings:preview" => {
            let input = arg(payload, 0).cloned().unwrap_or(Value::Null);
            Ok(Value::String(enhancements::core_preview_text(&input)))
        }
        "geodata-settings:get" => Ok(coerce(enhancements::coerce_geodata_settings(&models.geodata.get()))),
        "geodata-settings:set" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("geodata-settings:set requires a settings object"))?;
            models.geodata.set(input, enhancements::coerce_geodata_settings)
        }
        "geodata-settings:preview" => {
            let input = arg(payload, 0).cloned().unwrap_or(Value::Null);
            Ok(Value::String(enhancements::geodata_preview_text(&input)))
        }
        "dns:get" => Ok(json_envelope("enhancement", coerce(enhancements::coerce_dns_enhancement(&models.dns.get())))),
        "dns:set" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("dns:set requires an enhancement object"))?;
            models
                .dns
                .set(input, enhancements::coerce_dns_enhancement)
                .map(|model| json_envelope("enhancement", model))
        }
        "dns:preview" => {
            let input = arg(payload, 0).cloned().unwrap_or(Value::Null);
            Ok(Value::String(enhancements::dns_preview_text(&input)))
        }
        "sniffer:get" => Ok(json_envelope("enhancement", coerce(enhancements::coerce_sniffer_enhancement(&models.sniffer.get())))),
        "sniffer:set" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("sniffer:set requires an enhancement object"))?;
            models
                .sniffer
                .set(input, enhancements::coerce_sniffer_enhancement)
                .map(|model| json_envelope("enhancement", model))
        }
        "sniffer:preview" => {
            let input = arg(payload, 0).cloned().unwrap_or(Value::Null);
            Ok(Value::String(enhancements::sniffer_preview_text(&input)))
        }
        "tun-config:get" => Ok(json_envelope("config", coerce(enhancements::coerce_tun_config(&models.tun_config.get())))),
        "tun-config:set" => {
            let input = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("tun-config:set requires a config object"))?;
            models
                .tun_config
                .set(input, enhancements::coerce_tun_config)
                .map(|model| json_envelope("config", model))
        }
        "tun-config:preview" => {
            let input = arg(payload, 0).cloned().unwrap_or(Value::Null);
            Ok(Value::String(enhancements::tun_config_preview_text(&input)))
        }

        // --- usage history (Phase 3A) ---------------------------------------
        "usage-history:get-window" => usage.get_window(&required_string(payload, 0, "usage-history:get-window window")?),
        "usage-history:rank" => {
            let window = required_string(payload, 0, "usage-history:rank window")?;
            let ranking = required_string(payload, 1, "usage-history:rank ranking")?;
            let limit = arg(payload, 2).and_then(Value::as_u64).map(|value| value as usize);
            usage.rank(&window, &ranking, limit)
        }
        "usage-history:clear" => usage.clear().map(|()| Value::Null),
        "usage-history:get-capacity" => Ok(usage.get_capacity()),

        // --- kernel + runtime (Phase 3B) ------------------------------------
        // The supervisor runs with the DisabledKernelResolver port until the
        // artifact pipeline lands: start fails with the exact Electron copy
        // and the status records `failed` + lastError.
        "kernel:get-status" => Ok(kernel.supervisor.get_status()),
        "kernel:start" => kernel.supervisor.start(),
        "kernel:stop" => {
            // The ordered gateway (system-proxy precondition): a user stop,
            // mode switch or shutdown must never leave a dead-port proxy.
            system_proxy.restore_before_kernel_unavailable().await?;
            kernel.supervisor.stop()
        }
        "kernel-manager:get-state" => Ok(kernel.manager.get_state(settings)),
        "kernel-manager:set-enabled" => {
            let enabled = arg(payload, 0)
                .and_then(Value::as_bool)
                .ok_or_else(|| IpcError::invalid_argument("kernel-manager:set-enabled requires a boolean"))?;
            Ok(kernel.manager.set_enabled(settings, enabled))
        }
        "kernel-manager:set-channel" => {
            let channel = required_string(payload, 0, "kernel-manager:set-channel channel")?;
            Ok(kernel.manager.set_channel(settings, &channel))
        }
        "kernel-manager:list-versions" => Ok(kernel.manager.list_versions(settings)),
        "kernel-manager:install" => {
            let version = required_string(payload, 0, "kernel-manager:install version")?;
            Ok(kernel.manager.install(settings, &version))
        }
        "runtime:get-summary" => {
            let active = profiles.get_active()?;
            let profile_name = if active.is_null() {
                None
            } else {
                active["meta"]["name"].as_str().map(str::to_string)
            };
            Ok(kernel::build_runtime_summary(profile_name.as_deref()))
        }
        "runtime:get-external-ip" => Ok(kernel::resolve_external_ip(&kernel.supervisor.get_status())),

        // --- mihomo controller REST (Phase 3B) ------------------------------
        // The endpoint/secret come from the core-settings model; with no
        // running kernel the requests fail UPSTREAM_UNREACHABLE, which is the
        // exact typed error the renderer already handles for a stopped kernel.
        "mihomo:get-config" => Ok(controller_client(models)?.get_config().await?),
        "mihomo:patch-config" => {
            let patch = mihomo::parse_config_patch(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(controller_client(models)?.patch_config(&patch).await?)
        }
        "mihomo:get-proxies" => Ok(controller_client(models)?.get_proxies().await?),
        "mihomo:select-proxy" => {
            let (group, name) = mihomo::parse_proxy_selection(
                arg(payload, 0).unwrap_or(&Value::Null),
                arg(payload, 1).unwrap_or(&Value::Null),
            )?;
            let active = profiles.get_active().ok().filter(|profile| !profile.is_null());
            let profile_id = active
                .as_ref()
                .and_then(|profile| profile["meta"]["id"].as_str())
                .map(str::to_string);
            Ok(mihomo::select_proxy_gateway(mihomo, &controller_client(models)?, profile_id, &group, &name).await?)
        }
        "mihomo:get-rules" => Ok(controller_client(models)?.get_rules().await?),
        "mihomo:get-proxy-providers" => Ok(controller_client(models)?.get_proxy_providers().await?),
        "mihomo:refresh-proxy-provider" => {
            let name = mihomo::parse_mihomo_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(controller_client(models)?.refresh_proxy_provider(&name).await?)
        }
        "mihomo:health-check-proxy-provider" => {
            let name = mihomo::parse_mihomo_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(controller_client(models)?.health_check_proxy_provider(&name).await?)
        }
        "mihomo:get-rule-providers" => Ok(controller_client(models)?.get_rule_providers().await?),
        "mihomo:refresh-rule-provider" => {
            let name = mihomo::parse_mihomo_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(controller_client(models)?.refresh_rule_provider(&name).await?)
        }
        "mihomo:delay-test" => {
            let name = mihomo::parse_mihomo_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            let timeout = mihomo::parse_delay_options(arg(payload, 1))?.unwrap_or(mihomo::DEFAULT_DELAY_TIMEOUT_MS as i64);
            Ok(controller_client(models)?.delay_test(&name, None, timeout).await?)
        }
        "mihomo:group-member-delay-test" => {
            let (group, name) = mihomo::parse_proxy_selection(
                arg(payload, 0).unwrap_or(&Value::Null),
                arg(payload, 1).unwrap_or(&Value::Null),
            )?;
            let timeout = mihomo::parse_delay_options(arg(payload, 2))?.unwrap_or(mihomo::DEFAULT_DELAY_TIMEOUT_MS as i64);
            let urls = mihomo::get_group_test_urls_cached(mihomo, || {
                resolve_group_test_urls(profiles, overrides, models)
            });
            let app = settings.get();
            let global_scope = app.delay_test_url_scope == "global";
            let global_url = Some(app.delay_test_url.as_str()).filter(|url| !url.trim().is_empty());
            Ok(mihomo::group_member_delay_test_gateway(mihomo, &controller_client(models)?, &urls, global_scope, global_url, &group, &name, timeout).await?)
        }
        "mihomo:group-delay-test" => {
            let name = mihomo::parse_mihomo_name(arg(payload, 0).unwrap_or(&Value::Null))?;
            let timeout = mihomo::parse_delay_options(arg(payload, 1))?.unwrap_or(mihomo::DEFAULT_DELAY_TIMEOUT_MS as i64);
            Ok(controller_client(models)?.group_delay_test(&name, None, timeout).await?)
        }
        "mihomo:get-connections" => Ok(controller_client(models)?.get_connections().await?),
        "mihomo:close-connection" => {
            let id = mihomo::parse_connection_id(arg(payload, 0).unwrap_or(&Value::Null))?;
            Ok(controller_client(models)?.close_connection(&id).await?)
        }
        "mihomo:dns-query" => {
            let (name, kind) = mihomo::parse_dns_query(
                arg(payload, 0).unwrap_or(&Value::Null),
                arg(payload, 1).unwrap_or(&Value::Null),
            )?;
            Ok(controller_client(models)?.dns_query(&name, &kind).await?)
        }
        "mihomo:flush-dns-cache" => Ok(controller_client(models)?.flush_dns_cache().await?),
        "mihomo:flush-fakeip-cache" => Ok(controller_client(models)?.flush_fakeip_cache().await?),
        "mihomo:internet-latency" => {
            // The INTERNET 延迟 card: gateway RTT + kernel DNS + selected-node
            // chain RTT. Each slot degrades independently to null (never a
            // fake number, never a card-wide error).
            let client = controller_client(models)?;
            let active = profiles.get_active()?;
            let document = if active.is_null() {
                None
            } else {
                Some(active["document"].as_str().unwrap_or_default().to_string())
            };
            let sample = crate::internet_latency::sample(&client, document.as_deref()).await;
            Ok(crate::internet_latency::to_value(&sample))
        }
        "mihomo:logs-snapshot" => {
            let after_seq = mihomo::parse_log_after_seq(arg(payload, 0))?;
            Ok(mihomo.logs_snapshot(after_seq))
        }
        "mihomo:clear-logs" => Ok(serde_json::json!(mihomo.clear_logs())),

        _ => Err(IpcError::unsupported_channel(channel)),
    }
}

/// The controller endpoint: the TS production wiring hardcodes the host and
/// reads the port + secret from the persisted core settings (the kernel's
/// materialized config rebinds at the Phase 3D slice).
/// The kernel's LIVE mixed port for proxied probes — the TS
/// `resolveMixedPort` composition: `config['mixed-port'] ?? null`, every
/// failure (controller down, missing key, port <= 0) fails closed null.
async fn resolve_mixed_port(models: &enhancements::ModelStores) -> Result<u16, IpcError> {
    let client = controller_client(models)?;
    let Ok(config) = client.get_config().await else {
        return Err(IpcError::code(crate::error::code::UPSTREAM_UNREACHABLE, "内核未运行，无法通过当前节点执行解锁测试。"));
    };
    let port = config["mixed-port"].as_i64().unwrap_or(0);
    if port <= 0 || port > u16::MAX as i64 {
        return Err(IpcError::code(crate::error::code::UPSTREAM_UNREACHABLE, "内核未运行，无法通过当前节点执行解锁测试。"));
    }
    Ok(port as u16)
}

fn controller_client(models: &enhancements::ModelStores) -> Result<mihomo::MihomoClient, IpcError> {
    let core = enhancements::coerce_core_settings(&models.core.get());
    mihomo::MihomoClient::new(
        core["controllerPort"].as_i64().unwrap_or(9090),
        core["controllerSecret"].as_str().unwrap_or_default(),
    )
}

/// Group -> explicit probe URL from the ACTIVE enhanced document
/// (overrides -> DNS -> sniffer, exactly `resolveEnhancedActiveDocument`).
/// Every failure mode fails open to `{}` like the TS resolver.
fn resolve_group_test_urls(
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
) -> Value {
    let profile = match profiles.get_active() {
        Ok(profile) if !profile.is_null() => profile,
        _ => return serde_json::json!({}),
    };
    let document = profile["document"].as_str().unwrap_or_default().to_string();
    let profile_id = profile["meta"]["id"].as_str().unwrap_or_default().to_string();
    let overridden = match overrides.apply_for_profile(&document, Some(&profile_id)) {
        Ok(text) => text,
        Err(_) => return serde_json::json!({}),
    };
    let dns = enhancements::coerce_dns_enhancement(&models.dns.get());
    let (dns_text, _) = inspection::apply_dns_to_document(&overridden, &dns);
    let sniffer = enhancements::coerce_sniffer_enhancement(&models.sniffer.get());
    let (text, _) = inspection::apply_sniffer_to_document(&dns_text, &sniffer);
    mihomo::parse_proxy_group_test_urls(&text)
}

fn required_string(payload: &Value, index: usize, what: &'static str) -> Result<String, IpcError> {
    string_arg(payload, index)
        .ok_or_else(|| IpcError::invalid_argument(format!("{what} must be a string")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile_service::ProfilesService;
    use crate::settings::SettingsStore;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct Fixture {
        _temp: TempDir,
        paths: AppPaths,
        settings: SettingsStore,
        profiles: Arc<ProfilesService>,
        overrides: OverrideService,
        models: enhancements::ModelStores,
        usage: usage::UsageHistoryService,
        kernel: kernel::KernelServices,
        mihomo: mihomo::MihomoServices,
        desktop: icons::DesktopServices,
        metadata: NetworkMetadataService,
        startup: StartupService,
        substore: crate::substore::SubStoreService,
        system_proxy: crate::system_proxy::SystemProxyService,
        tun: crate::tun::TunCoordinator,
    }

    fn test_tun_coordinator() -> crate::tun::TunCoordinator {
        crate::tun::TunCoordinator::new(
            std::sync::Arc::new(crate::tun::GatedTunMutationAdapter),
            true,
        )
    }

    fn test_system_proxy_service() -> crate::system_proxy::SystemProxyService {
        crate::system_proxy::SystemProxyService::new(
            std::sync::Arc::new(crate::system_proxy::FakeSystemProxyAdapter::new()),
            crate::system_proxy::static_probe(crate::system_proxy::Target {
                host: crate::system_proxy::SYSTEM_PROXY_LOOPBACK_HOST.to_string(),
                port: 7890,
            }),
            std::sync::Arc::new(crate::system_proxy::InMemoryBackupStore::new()),
            std::sync::Arc::new(crate::system_proxy::InMemoryBypassStore::new()),
            "ipc-fixture".to_string(),
        )
    }

    fn test_substore_service() -> crate::substore::SubStoreService {
        crate::substore::SubStoreService::new(crate::substore::SubStoreDeps {
            base_dir: std::env::temp_dir().join("murge-substore-fixture"),
            brand_name: "Murge".to_string(),
            get_mixed_port: Box::new(|| None),
            create_worker: None,
            fetch_fn: Some(std::sync::Arc::new(|_request: crate::substore::FetchRequest| {
                Box::pin(async { Err("fixture transport disabled".to_string()) })
            })),
            find_free_port: None,
            settings: std::sync::Arc::new(|| {
                Box::pin(async { crate::settings::AppSettings::default() })
                    as futures_util::future::BoxFuture<'static, crate::settings::AppSettings>
            }),
            pinned_digests: (
                crate::substore::SUB_STORE_BACKEND_DEFAULT_DIGEST.to_string(),
                crate::substore::SUB_STORE_FRONTEND_DEFAULT_DIGEST.to_string(),
            ),
        })
    }

    fn test_startup_service() -> StartupService {
        StartupService::new(crate::startup::ScheduledTaskStartupAdapter::with_runner(
            false,
            std::sync::Arc::new(|_c: String, _a: Vec<String>| {
                Box::pin(async { Ok(crate::startup::RunResult::default()) })
            }),
            std::sync::Arc::new(|| false),
        ))
    }

    fn fixtures() -> Fixture {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths { app_data_root: None, profile_root: None };
        let settings = SettingsStore::new(None);
        let profiles = Arc::new(ProfilesService::for_development(&temp.path().to_path_buf()));
        let overrides = OverrideService::new(None);
        let models = enhancements::ModelStores::new(None);
        let usage = usage::UsageHistoryService::new(usage::UsageHistoryStore::in_memory());
        let kernel = kernel::KernelServices::new();
        let mihomo = mihomo::MihomoServices::new(temp.path().to_path_buf().into());
        let desktop = icons::DesktopServices::new(temp.path().to_path_buf().join("icon-cache"));
        Fixture { _temp: temp, paths, settings, profiles, overrides, models, usage, kernel, mihomo, desktop, metadata: NetworkMetadataService::new(), startup: test_startup_service(), substore: test_substore_service(), system_proxy: test_system_proxy_service(), tun: test_tun_coordinator() }
    }

    #[tokio::test]
    async fn serves_brand_document_from_the_checked_in_file() {
        let f = fixtures();
        let brand = dispatch("app:get-brand", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(brand["appId"], "io.murge.desktop");
        assert_eq!(brand["protocolScheme"], "murge");
    }

    #[tokio::test]
    async fn serves_app_info_in_electron_vocabulary() {
        let f = fixtures();
        let info = dispatch("app:get-info", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert!(matches!(
            info["platform"].as_str(),
            Some("win32") | Some("darwin") | Some("linux") | Some("other")
        ));
    }

    #[tokio::test]
    async fn settings_round_trip_through_the_dispatch() {
        let f = fixtures();
        let before = dispatch("app-settings:get", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(before["closeToTray"], true);
        let after = dispatch(
            "app-settings:set",
            &serde_json::json!([{ "closeToTray": false }]),
            &f.paths,
            &f.settings,
            &f.profiles,
            &f.overrides,
            &f.models,
            &f.usage,
            &f.kernel,
            &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await
        .unwrap();
        assert_eq!(after["closeToTray"], false);
        // kernelEnabled is forced true (deprecated field).
        assert_eq!(after["kernelEnabled"], true);
    }

    #[tokio::test]
    async fn profile_channels_flow_through_the_dispatch() {
        let f = fixtures();
        let list = dispatch("profiles:list", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(list, serde_json::json!([]));
        let meta = dispatch(
            "profiles:import",
            &serde_json::json!([{ "name": "Home", "document": "port: 7890\n", "source": { "type": "manual" } }]),
            &f.paths,
            &f.settings,
            &f.profiles,
            &f.overrides,
            &f.models,
            &f.usage,
            &f.kernel,
            &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await
        .unwrap();
        assert_eq!(meta["name"], "Home");
        let id = meta["id"].as_str().unwrap().to_string();
        let profile = dispatch(
            "profiles:get",
            &serde_json::json!([id]),
            &f.paths,
            &f.settings,
            &f.profiles,
            &f.overrides,
            &f.models,
            &f.usage,
            &f.kernel,
            &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await
        .unwrap();
        assert_eq!(profile["document"], "port: 7890\n");
        let meta = dispatch(
            "profiles:activate",
            &serde_json::json!([id]),
            &f.paths,
            &f.settings,
            &f.profiles,
            &f.overrides,
            &f.models,
            &f.usage,
            &f.kernel,
            &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await
        .unwrap();
        assert_eq!(meta["active"], true);
    }

    #[tokio::test]
    async fn subscription_channels_flow_through_the_dispatch() {
        use crate::subscription::SubscriptionFetcher;
        // A loopback stub answers both the import and the update fetch.
        let (base, _server) = crate::subscription::test_support::start_http_stub(
            200,
            // RFC 5987 extended form (percent-encoded, ASCII on the wire) —
            // what real providers send for non-ASCII filenames.
            vec![("content-disposition", "attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA%E8%AE%A2%E9%98%85.yaml".to_string())],
            "mixed-port: 7890\nproxies:\n  - name: node-01\n    server: 127.0.0.1\nrules:\n  - MATCH,DIRECT\n".to_string(),
        );
        let temp = TempDir::new().unwrap();
        let icon_root = temp.path().to_path_buf().join("icon-cache");
        let profiles = ProfilesService::for_development(&temp.path().to_path_buf()).with_fetcher(
            SubscriptionFetcher::for_testing(std::sync::Arc::new(|_| Vec::new()), 5000, 1024 * 1024),
        );
        let profiles = Arc::new(profiles);
        let f = Fixture {
            _temp: temp,
            paths: AppPaths { app_data_root: None, profile_root: None },
            settings: SettingsStore::new(None),
            profiles: profiles.clone(),
            overrides: OverrideService::new(None),
            models: enhancements::ModelStores::new(None),
            usage: usage::UsageHistoryService::new(usage::UsageHistoryStore::in_memory()),
            kernel: kernel::KernelServices::new(),
            mihomo: mihomo::MihomoServices::new(None),
            desktop: icons::DesktopServices::new(icon_root),
            metadata: NetworkMetadataService::new(),
            startup: StartupService::new(crate::startup::ScheduledTaskStartupAdapter::with_runner(
                false,
                std::sync::Arc::new(|_c: String, _a: Vec<String>| Box::pin(async { Ok(crate::startup::RunResult::default()) })),
                std::sync::Arc::new(|| false),
            )),
            substore: test_substore_service(),
            system_proxy: test_system_proxy_service(),
            tun: test_tun_coordinator(),
        };
        // Import from URL: the empty name falls back to the response filename.
        let meta = dispatch(
            "profiles:import-from-url",
            &serde_json::json!(["", format!("{base}/sub"), true]),
            &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await.unwrap();
        assert_eq!(meta["name"], "机场订阅");
        assert_eq!(meta["active"], true, "activate=true moved the pointer");
        assert_eq!(meta["source"]["type"], "url");
        // The private raw URL went to the source store; meta keeps the display form.
        let id = meta["id"].as_str().unwrap().to_string();
        assert_eq!(
            dispatch("profiles:get-source-url", &serde_json::json!([id]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap(),
            serde_json::json!(format!("{base}/sub"))
        );
        // Update from source: same channel chain replaces the document.
        let updated = dispatch(
            "profiles:update-from-source",
            &serde_json::json!([id]),
            &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await.unwrap();
        assert_eq!(updated["name"], "机场订阅");
        // Schema gate: a non-http URL is rejected before any fetch.
        let error = dispatch(
            "profiles:import-from-url",
            &serde_json::json!(["x", "ftp://example.com/sub"]),
            &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await.unwrap_err();
        assert!(error.0.contains("subscription URL must use http or https"), "{}", error.0);
    }

    #[tokio::test]
    async fn internet_latency_samples_through_the_mock_controller() {
        use crate::mihomo::mock_controller::MockServer;
        // The mock controller serves the proxy map + delay endpoint; DNS is
        // NOT served so the slot degrades to the system fallback (loopback CI
        // has no 1.1.1.1 route guarantee — the system probe returns false on
        // failure, and the slot reads null either way; the gateway slot is
        // environment-dependent and only shape-checked).
        let server = MockServer::start("s3cret", |method, path, _body| match (method, path) {
            ("GET", "/proxies") if !path.contains("/delay") && !path.contains("/dns") => (
                200,
                r#"{"proxies":{"节点选择":{"type":"Selector","name":"节点选择","now":"香港 01"},"香港 01":{"type":"Shadowsocks","name":"香港 01"}}}"#.to_string(),
            ),
            // The delay path carries a query string; prefix-match it.
            (_, p) if p.starts_with("/proxies/%E9%A6%99%E6%B8%AF%2001/delay") => (200, r#"{"delay":220}"#.to_string()),
            (_, p) if p.starts_with("/dns/query") => (500, String::new()),
            _ => (404, String::new()),
        });
        let temp = TempDir::new().unwrap();
        let profiles = ProfilesService::for_development(&temp.path().to_path_buf());
        profiles
            .import(&serde_json::json!({
                "name": "Home",
                "document": "mixed-port: 7890\nproxy-groups:\n  - name: 节点选择\n    type: select\n    proxies:\n      - 香港 01\n",
                "source": { "type": "manual" },
                "activate": true
            }))
            .unwrap();
        let mut core = enhancements::coerce_core_settings(&enhancements::ModelStores::new(None).core.get());
        if let Some(object) = core.as_object_mut() {
            object.insert("controllerPort".into(), serde_json::json!(server.port));
            object.insert("controllerSecret".into(), serde_json::json!("s3cret"));
        }
        let models = enhancements::ModelStores::new(None);
        models.core.set(&core, enhancements::coerce_core_settings).unwrap();
        let f = Fixture {
            _temp: temp,
            paths: AppPaths { app_data_root: None, profile_root: None },
            settings: SettingsStore::new(None),
            profiles: Arc::new(profiles),
            overrides: OverrideService::new(None),
            models,
            usage: usage::UsageHistoryService::new(usage::UsageHistoryStore::in_memory()),
            kernel: kernel::KernelServices::new(),
            mihomo: mihomo::MihomoServices::new(None),
            desktop: icons::DesktopServices::new(std::env::temp_dir().join("icon-cache-test")),
            metadata: NetworkMetadataService::new(),
            startup: StartupService::new(crate::startup::ScheduledTaskStartupAdapter::with_runner(
                false,
                std::sync::Arc::new(|_c: String, _a: Vec<String>| Box::pin(async { Ok(crate::startup::RunResult::default()) })),
                std::sync::Arc::new(|| false),
            )),
            substore: test_substore_service(),
            system_proxy: test_system_proxy_service(),
            tun: test_tun_coordinator(),
        };
        let sample = dispatch("mihomo:internet-latency", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        // The proxy slot followed the DECLARED order (节点选择 -> 香港 01) and
        // carries the controller-reported delay.
        assert_eq!(sample["proxyMs"], 220, "{}", sample);
        assert_eq!(sample["proxyNode"], "香港 01");
        // Gateway + DNS slots are present (numbers or nulls — environment
        // dependent on CI), never missing.
        for key in ["gatewayMs", "dnsMs", "proxyMs", "proxyNode"] {
            assert!(sample.get(key).is_some(), "missing {key}");
        }
        // Every numeric slot that IS present is a real number (never a fake
        // placeholder).
        for key in ["gatewayMs", "dnsMs", "proxyMs"] {
            assert!(sample[key].is_null() || sample[key].is_u64(), "{key}={}", sample[key]);
        }
    }

    #[tokio::test]
    async fn network_metadata_channels_flow_and_reject_bad_provider_ids() {
        let f = fixtures();
        // Registry: the three shipped providers, function-free wire shape.
        let providers = dispatch("network-metadata:get-providers", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        let ids: Vec<String> = providers.as_array().unwrap().iter().filter_map(|p| p["id"].as_str().map(str::to_string)).collect();
        assert_eq!(ids, vec!["ipwhois", "ipapi", "ipinfo"]);
        // Starts idle on the default provider.
        let state = dispatch("network-metadata:get-state", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["phase"], "idle");
        assert_eq!(state["provider"], "ipwhois");
        // Resolve with no kernel: the typed kernel-not-running error copy.
        let state = dispatch("network-metadata:resolve", &serde_json::json!([false]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["phase"], "error");
        assert_eq!(state["error"], "内核未运行，无法查询出口信息");
        // Whole-set resolve: every row degrades independently, display order kept.
        let snapshot = dispatch("network-metadata:resolve-all", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        let results = snapshot["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        for result in results {
            assert_eq!(result["state"]["phase"], "error");
        }
        // select-provider: unknown id -> the TS invalid-argument copy.
        let error = dispatch("network-metadata:select-provider", &serde_json::json!(["nope"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:INVALID_ARGUMENT::"), "{}", error.0);
        assert!(error.0.contains("invalid network metadata provider: ipwhois, ipapi, ipinfo"), "{}", error.0);
        // select-provider to a valid id resets to idle and reports it.
        let state = dispatch("network-metadata:select-provider", &serde_json::json!(["ipapi"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["provider"], "ipapi");
        assert_eq!(state["phase"], "idle");
    }

    #[tokio::test]
    async fn unlock_channels_fail_closed_and_degrade_to_error_rows() {
        use crate::mihomo::mock_controller::MockServer;
        let f = fixtures();
        // No controller: the typed fail-closed copy, never a DIRECT sample.
        let error = dispatch("network:unlock-test-all", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:UPSTREAM_UNREACHABLE::内核未运行，无法通过当前节点执行解锁测试。");
        // Invalid service name: the TS invalid-argument list copy.
        let error = dispatch("network:unlock-test-one", &serde_json::json!(["未知服务"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:INVALID_ARGUMENT::"), "{}", error.0);
        assert!(error.0.contains("invalid unlock service: ChatGPT, Gemini, Claude, Grok, Netflix, Disney+, TikTok, YouTube, GitHub, Spotify"), "{}", error.0);
        // With a live controller reporting a mixed port, the real probes run
        // through that port (a dead proxy degrades every row to `error` —
        // the honest verdict, never a throw and never a fabricated number).
        let server = MockServer::start("s3cret", |_method, path, _body| {
            if path.starts_with("/configs") {
                (200, r#"{"mixed-port":7897}"#.to_string())
            } else {
                (404, String::new())
            }
        });
        let mut core = enhancements::coerce_core_settings(&f.models.core.get());
        if let Some(object) = core.as_object_mut() {
            object.insert("controllerPort".into(), serde_json::json!(server.port));
            object.insert("controllerSecret".into(), serde_json::json!("s3cret"));
        }
        f.models.core.set(&core, enhancements::coerce_core_settings).unwrap();
        let results = dispatch("network:unlock-test-all", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        let rows = results.as_array().unwrap();
        assert_eq!(rows.len(), 10);
        let names: Vec<&str> = rows.iter().filter_map(|row| row["name"].as_str()).collect();
        assert_eq!(names, vec!["ChatGPT", "Gemini", "Claude", "Grok", "Netflix", "Disney+", "TikTok", "YouTube", "GitHub", "Spotify"]);
        for row in rows {
            assert!(row["status"].is_string(), "{}", row);
            assert!(row["region"].is_null() || row["region"].is_string(), "{}", row);
        }
    }

    #[tokio::test]
    async fn staged_channels_fail_closed_with_unsupported() {
        let f = fixtures();
        for channel in [
            "profiles:get-provider-content",
        ] {
            let error = dispatch(channel, &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
            assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{channel}: {}", error.0);
        }
    }

    #[tokio::test]
    async fn inspect_active_config_unavailable_without_a_profile() {
        let f = fixtures();
        let inspection = dispatch("profiles:inspect-active-config", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(inspection["profileName"], Value::Null);
        assert_eq!(inspection["sections"]["core"]["profileYaml"], "（未配置）");
        assert_eq!(inspection["sections"]["tun"]["notes"][0], "TUN 当前未启用；启用状态和完整 TUN 参数由应用管理。");
    }

    #[tokio::test]
    async fn inspect_active_config_composes_overrides_and_models() {
        let temp = TempDir::new().unwrap();
        let icon_root = temp.path().to_path_buf().join("icon-cache");
        let profiles = Arc::new(ProfilesService::for_development(&temp.path().to_path_buf()));
        let profiles_for_import = profiles.clone();
        let imported = profiles_for_import
            .import(&serde_json::json!({
                "name": "Home",
                "document": "proxies: []\nrules:\n  - \"MATCH,A\"\nmixed-port: 1\nsecret: bad\n",
                "source": { "type": "manual" }
            }))
            .unwrap();
        let id = imported["id"].as_str().unwrap().to_string();
        profiles.activate(&id).unwrap();
        let f = Fixture {
            _temp: temp,
            paths: AppPaths { app_data_root: None, profile_root: None },
            settings: SettingsStore::new(None),
            profiles,
            overrides: OverrideService::new(None),
            models: enhancements::ModelStores::new(None),
            usage: usage::UsageHistoryService::new(usage::UsageHistoryStore::in_memory()),
            kernel: kernel::KernelServices::new(),
            mihomo: mihomo::MihomoServices::new(None),
            desktop: icons::DesktopServices::new(icon_root),
            metadata: NetworkMetadataService::new(),
            startup: StartupService::new(crate::startup::ScheduledTaskStartupAdapter::with_runner(
                false,
                std::sync::Arc::new(|_c: String, _a: Vec<String>| Box::pin(async { Ok(crate::startup::RunResult::default()) })),
                std::sync::Arc::new(|| false),
            )),
            substore: test_substore_service(),
            system_proxy: test_system_proxy_service(),
            tun: test_tun_coordinator(),
        };
        // One global override the composition must apply (unified-delay is a
        // CORE_KEYS member, so the core excerpt proves the pipeline ran).
        f.overrides
            .create(&serde_json::json!({
                "name": "Port", "kind": "yaml", "scope": "global", "profileId": null,
                "content": "unified-delay: true\n"
            }))
            .unwrap();
        // DNS enhancement on: the composed effective config must carry it.
        f.models
            .dns
            .set(&serde_json::json!({ "enabled": true, "nameserver": ["tls://223.5.5.5"] }), enhancements::coerce_dns_enhancement)
            .unwrap();
        let inspection = dispatch("profiles:inspect-active-config", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(inspection["profileName"], "Home");
        let core = &inspection["sections"]["core"];
        assert!(core["effectiveYaml"].as_str().unwrap().contains("unified-delay: true"), "{}", core["effectiveYaml"]);
        assert!(core["effectiveYaml"].as_str().unwrap().contains("mixed-port: 7890"), "{}", core["effectiveYaml"]);
        // The section excerpt masks the secret (exercised by the unit test).
        assert!(core["effectiveYaml"].as_str().unwrap().contains("secret: \"********\""), "{}", core["effectiveYaml"]);
        // The DNS excerpt carries the enhancement's nameserver.
        assert!(
            inspection["sections"]["dns"]["effectiveYaml"].as_str().unwrap().contains("tls://223.5.5.5"),
            "{}",
            inspection["sections"]["dns"]["effectiveYaml"]
        );
        assert_eq!(core["effectiveYaml"].as_str().unwrap().contains("（未配置）"), false);
        assert_eq!(inspection["sections"]["dns"]["notes"][0], "DNS 覆写已启用，应用字段优先，未知字段保留。");
    }

    #[tokio::test]
    async fn kernel_channels_flow_through_the_dispatch() {
        let f = fixtures();
        let status = dispatch("kernel:get-status", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(status["phase"], "stopped");
        let error = dispatch("kernel:start", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::Kernel execution is disabled"), "{}", error.0);
        let status = dispatch("kernel:get-status", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(status["phase"], "failed");
        let status = dispatch("kernel:stop", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(status["phase"], "stopped");
        let state = dispatch("kernel-manager:get-state", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["stableVersion"], "v1.19.30");
        let state = dispatch("kernel-manager:set-enabled", &serde_json::json!([true]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["error"], "安装 Smart内核失败");
        let state = dispatch("kernel-manager:set-channel", &serde_json::json!(["specific"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["error"], "当前 Windows 服务模式仅支持安装包内置的稳定内核。");
        let state = dispatch("kernel-manager:list-versions", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["versions"], serde_json::json!([]));
        let state = dispatch("kernel-manager:install", &serde_json::json!(["v1.19.31"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(state["error"], "当前 Windows 服务模式不能安装指定内核版本。");
    }

    #[tokio::test]
    async fn runtime_summary_reflects_the_active_profile() {
        let f = fixtures();
        let summary = dispatch("runtime:get-summary", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(summary["profileName"], "Murge Default");
        let imported = dispatch(
            "profiles:import",
            &serde_json::json!([{ "name": "Home", "document": "port: 7890\n", "source": { "type": "manual" } }]),
            &f.paths,
            &f.settings,
            &f.profiles,
            &f.overrides,
            &f.models,
            &f.usage,
            &f.kernel,
            &f.mihomo, &f.desktop,
            &f.metadata,
            &f.startup,
            &f.substore,
            &f.system_proxy,
            &f.tun,
        ).await
        .unwrap();
        dispatch("profiles:activate", &serde_json::json!([imported["id"]]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        let summary = dispatch("runtime:get-summary", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(summary["profileName"], "Home");
        let external = dispatch("runtime:get-external-ip", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap();
        assert_eq!(external, Value::Null);
    }

    #[tokio::test]
    async fn unknown_channels_fail_closed_with_unsupported() {
        let f = fixtures();
        let error = dispatch("kernel:start", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{}", error.0);
    }

    #[tokio::test]
    async fn non_string_arguments_fail_with_invalid_argument() {
        let f = fixtures();
        let error = dispatch("profiles:get", &serde_json::json!([42]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel, &f.mihomo, &f.desktop, &f.metadata, &f.startup, &f.substore, &f.system_proxy, &f.tun).await.unwrap_err();
        assert!(error.0.contains("INVALID_ARGUMENT"), "{}", error.0);
    }
}
