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
use tauri::State;

use crate::app_info;
use crate::brand;
use crate::settings::{AppSettingsPatch, SettingsStore};
use crate::paths::AppPaths;

/// A failed IPC call. Serialized to the ProtocolError wire string so the
/// renderer-side decoder stays the single error mapping for both shells.
#[derive(Debug)]
pub struct IpcError(pub String);

impl serde::Serialize for IpcError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        IpcError(format!("PROTOCOL_ERROR:{code}::{}", message.into()))
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message)
    }

    pub fn unsupported(channel: &str) -> Self {
        Self::new("UNSUPPORTED", format!("channel '{channel}' has no Tauri handler yet (planned Phase 3 slice)"))
    }
}

pub type IpcResult = Result<Value, IpcError>;

/// The one command the webview is allowed to call. Everything else —
/// filesystem, registry, the privileged named pipe — stays in Rust.
#[tauri::command]
pub fn desktop_ipc(
    channel: String,
    payload: Value,
    paths: State<'_, AppPaths>,
    settings: State<'_, SettingsStore>,
) -> IpcResult {
    dispatch(&channel, &payload, &paths, &settings)
}

/// Channel dispatch table. Phase 3 slices extend this match; channels that do
/// not yet have a Rust handler fail closed with UNSUPPORTED (never silently
/// no-op), so the renderer sees an honest error during the migration. The
/// `paths` parameter is part of the stable dispatch signature from day one —
/// the profile/log/usage slices (3A) consume it.
pub fn dispatch(
    channel: &str,
    payload: &Value,
    _paths: &AppPaths,
    settings: &SettingsStore,
) -> IpcResult {
    match channel {
        "app:get-brand" => Ok(brand::brand_document()),
        "app:get-info" => Ok(app_info::app_info(env!("CARGO_PKG_VERSION"))),
        "app-settings:get" => Ok(serde_json::to_value(settings.get()).expect("settings serialize")),
        "app-settings:set" => {
            let patch: AppSettingsPatch = serde_json::from_value(payload.clone())
                .map_err(|_| IpcError::invalid_argument("app-settings:set payload must be a JSON object"))?;
            Ok(serde_json::to_value(settings.set(&patch)).expect("settings serialize"))
        }
        _ => Err(IpcError::unsupported(channel)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::SettingsStore;

    fn fixtures() -> (AppPaths, SettingsStore) {
        (AppPaths { app_data_root: None, profile_root: None }, SettingsStore::new(None))
    }

    #[test]
    fn serves_brand_document_from_the_checked_in_file() {
        let (paths, settings) = fixtures();
        let brand = dispatch("app:get-brand", &Value::Null, &paths, &settings).unwrap();
        assert_eq!(brand["appId"], "io.murge.desktop");
        assert_eq!(brand["protocolScheme"], "murge");
    }

    #[test]
    fn serves_app_info_in_electron_vocabulary() {
        let (paths, settings) = fixtures();
        let info = dispatch("app:get-info", &Value::Null, &paths, &settings).unwrap();
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert!(matches!(
            info["platform"].as_str(),
            Some("win32") | Some("darwin") | Some("linux") | Some("other")
        ));
    }

    #[test]
    fn settings_round_trip_through_the_dispatch() {
        let (paths, settings) = fixtures();
        let before = dispatch("app-settings:get", &Value::Null, &paths, &settings).unwrap();
        assert_eq!(before["closeToTray"], true);
        let after = dispatch(
            "app-settings:set",
            &serde_json::json!({ "closeToTray": false }),
            &paths,
            &settings,
        )
        .unwrap();
        assert_eq!(after["closeToTray"], false);
        // kernelEnabled is forced true (deprecated field).
        assert_eq!(after["kernelEnabled"], true);
    }

    #[test]
    fn unknown_channels_fail_closed_with_unsupported() {
        let (paths, settings) = fixtures();
        let error = dispatch("kernel:start", &Value::Null, &paths, &settings).unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::"), "{}", error.0);
    }
}
