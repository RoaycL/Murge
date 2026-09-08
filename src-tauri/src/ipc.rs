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
) -> IpcResult {
    dispatch(&channel, &payload, &paths, &settings, &profiles, &overrides, &models, &usage)
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
        "profiles:inspect-active-config" => Err(IpcError::unsupported(
            "profiles:inspect-active-config composes the effective document with overrides + TUN (Phase 3 slices)",
        )),

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
    }

    fn fixtures() -> Fixture {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths { app_data_root: None, profile_root: None };
        let settings = SettingsStore::new(None);
        let profiles = Arc::new(ProfilesService::for_development(&temp.path().to_path_buf()));
        let overrides = OverrideService::new(None);
        let models = enhancements::ModelStores::new(None);
        let usage = usage::UsageHistoryService::new(usage::UsageHistoryStore::in_memory());
        Fixture { _temp: temp, paths, settings, profiles, overrides, models, usage }
    }

    #[test]
    fn serves_brand_document_from_the_checked_in_file() {
        let f = fixtures();
        let brand = dispatch("app:get-brand", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap();
        assert_eq!(brand["appId"], "io.murge.desktop");
        assert_eq!(brand["protocolScheme"], "murge");
    }

    #[test]
    fn serves_app_info_in_electron_vocabulary() {
        let f = fixtures();
        let info = dispatch("app:get-info", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap();
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert!(matches!(
            info["platform"].as_str(),
            Some("win32") | Some("darwin") | Some("linux") | Some("other")
        ));
    }

    #[test]
    fn settings_round_trip_through_the_dispatch() {
        let f = fixtures();
        let before = dispatch("app-settings:get", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap();
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
        )
        .unwrap();
        assert_eq!(after["closeToTray"], false);
        // kernelEnabled is forced true (deprecated field).
        assert_eq!(after["kernelEnabled"], true);
    }

    #[test]
    fn profile_channels_flow_through_the_dispatch() {
        let f = fixtures();
        let list = dispatch("profiles:list", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap();
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
            "profiles:inspect-active-config",
        ] {
            let error = dispatch(channel, &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap_err();
            assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{channel}: {}", error.0);
        }
    }

    #[test]
    fn unknown_channels_fail_closed_with_unsupported() {
        let f = fixtures();
        let error = dispatch("kernel:start", &Value::Null, &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{}", error.0);
    }

    #[test]
    fn non_string_arguments_fail_with_invalid_argument() {
        let f = fixtures();
        let error = dispatch("profiles:get", &serde_json::json!([42]), &f.paths, &f.settings, &f.profiles, &f.overrides, &f.models, &f.usage).unwrap_err();
        assert!(error.0.contains("INVALID_ARGUMENT"), "{}", error.0);
    }
}
