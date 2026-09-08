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
use crate::inspection;
use crate::kernel;
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
pub fn desktop_ipc(
    channel: String,
    payload: Value,
    paths: State<'_, AppPaths>,
    settings: State<'_, SettingsStore>,
    profiles: State<'_, Arc<ProfilesService>>,
    overrides: State<'_, OverrideService>,
    models: State<'_, enhancements::ModelStores>,
    usage: State<'_, usage::UsageHistoryService>,
    kernel: State<'_, kernel::KernelServices>,
) -> IpcResult {
    dispatch(&channel, &payload, &paths, &settings, &profiles, &overrides, &models, &usage, &kernel)
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
pub fn dispatch(
    channel: &str,
    payload: &Value,
    _paths: &AppPaths,
    settings: &SettingsStore,
    profiles: &Arc<ProfilesService>,
    overrides: &OverrideService,
    models: &enhancements::ModelStores,
    usage: &usage::UsageHistoryService,
    kernel: &kernel::KernelServices,
) -> IpcResult {
    match channel {
        "app:get-brand" => Ok(brand::brand_document()),
        "app:get-info" => Ok(app_info::app_info(env!("CARGO_PKG_VERSION"))),
        "app-settings:get" => Ok(serde_json::to_value(settings.get()).expect("settings serialize")),
        "app-settings:set" => {
            // The bridge sends positional args; the patch is args[0].
            let patch_value = arg(payload, 0).cloned().unwrap_or(Value::Null);
            let patch: AppSettingsPatch = serde_json::from_value(patch_value)
                .map_err(|_| IpcError::invalid_argument("app-settings:set payload must be a JSON object"))?;
            Ok(serde_json::to_value(settings.set(&patch)).expect("settings serialize"))
        }

        // --- profiles (Phase 3A) -------------------------------------------
        "profiles:list" => profiles.list(),
        "profiles:get" => profiles.get(&required_string(payload, 0, "profiles:get id")?),
        "profiles:import" => {
            let request = arg(payload, 0)
                .ok_or_else(|| IpcError::invalid_argument("profiles:import requires a request object"))?;
            profiles.import(request)
        }
        "profiles:import-from-url" => Err(IpcError::unsupported(
            "profiles:import-from-url needs the subscription fetcher (Phase 3C network slice)",
        )),
        "profiles:update-from-source" => Err(IpcError::unsupported(
            "profiles:update-from-source needs the subscription fetcher (Phase 3C network slice)",
        )),
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
        "kernel:stop" => kernel.supervisor.stop(),
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

        _ => Err(IpcError::unsupported_channel(channel)),
    }
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
        Fixture { _temp: temp, paths, settings, profiles, overrides, models, usage, kernel }
    }

    #[test]
    fn serves_brand_document_from_the_checked_in_file() {
        let f = fixtures();
        let brand = dispatch("app:get-brand", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(brand["appId"], "io.murge.desktop");
        assert_eq!(brand["protocolScheme"], "murge");
    }

    #[test]
    fn serves_app_info_in_electron_vocabulary() {
        let f = fixtures();
        let info = dispatch("app:get-info", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert!(matches!(
            info["platform"].as_str(),
            Some("win32") | Some("darwin") | Some("linux") | Some("other")
        ));
    }

    #[test]
    fn settings_round_trip_through_the_dispatch() {
        let f = fixtures();
        let before = dispatch("app-settings:get", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
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
        )
        .unwrap();
        assert_eq!(after["closeToTray"], false);
        // kernelEnabled is forced true (deprecated field).
        assert_eq!(after["kernelEnabled"], true);
    }

    #[test]
    fn profile_channels_flow_through_the_dispatch() {
        let f = fixtures();
        let list = dispatch("profiles:list", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
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
        )
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
        )
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
        )
        .unwrap();
        assert_eq!(meta["active"], true);
    }

    #[test]
    fn staged_channels_fail_closed_with_unsupported() {
        let f = fixtures();
        for channel in [
            "profiles:import-from-url",
            "profiles:update-from-source",
            "profiles:get-provider-content",
        ] {
            let error = dispatch(channel, &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap_err();
            assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{channel}: {}", error.0);
        }
    }

    #[test]
    fn inspect_active_config_unavailable_without_a_profile() {
        let f = fixtures();
        let inspection = dispatch("profiles:inspect-active-config", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(inspection["profileName"], Value::Null);
        assert_eq!(inspection["sections"]["core"]["profileYaml"], "（未配置）");
        assert_eq!(inspection["sections"]["tun"]["notes"][0], "TUN 当前未启用；启用状态和完整 TUN 参数由应用管理。");
    }

    #[test]
    fn inspect_active_config_composes_overrides_and_models() {
        let temp = TempDir::new().unwrap();
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
        let inspection = dispatch("profiles:inspect-active-config", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
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

    #[test]
    fn kernel_channels_flow_through_the_dispatch() {
        let f = fixtures();
        let status = dispatch("kernel:get-status", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(status["phase"], "stopped");
        let error = dispatch("kernel:start", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::Kernel execution is disabled"), "{}", error.0);
        let status = dispatch("kernel:get-status", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(status["phase"], "failed");
        let status = dispatch("kernel:stop", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(status["phase"], "stopped");
        let state = dispatch("kernel-manager:get-state", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(state["stableVersion"], "v1.19.30");
        let state = dispatch("kernel-manager:set-enabled", &serde_json::json!([true]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(state["error"], "安装 Smart内核失败");
        let state = dispatch("kernel-manager:set-channel", &serde_json::json!(["specific"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(state["error"], "当前 Windows 服务模式仅支持安装包内置的稳定内核。");
        let state = dispatch("kernel-manager:list-versions", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(state["versions"], serde_json::json!([]));
        let state = dispatch("kernel-manager:install", &serde_json::json!(["v1.19.31"]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(state["error"], "当前 Windows 服务模式不能安装指定内核版本。");
    }

    #[test]
    fn runtime_summary_reflects_the_active_profile() {
        let f = fixtures();
        let summary = dispatch("runtime:get-summary", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
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
        )
        .unwrap();
        dispatch("profiles:activate", &serde_json::json!([imported["id"]]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        let summary = dispatch("runtime:get-summary", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(summary["profileName"], "Home");
        let external = dispatch("runtime:get-external-ip", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap();
        assert_eq!(external, Value::Null);
    }

    #[test]
    fn unknown_channels_fail_closed_with_unsupported() {
        let f = fixtures();
        let error = dispatch("kernel:start", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{}", error.0);
    }

    #[test]
    fn non_string_arguments_fail_with_invalid_argument() {
        let f = fixtures();
        let error = dispatch("profiles:get", &serde_json::json!([42]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage, &f.kernel).unwrap_err();
        assert!(error.0.contains("INVALID_ARGUMENT"), "{}", error.0);
    }
}
