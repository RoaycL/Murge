//! Application information exposed through the compatibility bridge.
//!
//! Byte-compatible with the Electron `appGetInfo` payload (see
//! `src/shared/app-info.ts`): `platform` uses Electron's process.platform
//! vocabulary (`win32`/`darwin`/`linux`/`other`) and `arch` uses Node's
//! (`x64`/`arm64`/`ia32`/`arm`), so renderer branching needs no shell checks.

use serde_json::json;

pub fn app_info(version: &str) -> serde_json::Value {
    json!({
        "version": version,
        "platform": platform(),
        "arch": arch()
    })
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_arch_to_node_vocabulary() {
        // On every supported target the mapping must land on a Node arch name,
        // never the raw Rust triple.
        assert!(matches!(arch(), "x64" | "arm64" | "ia32" | "arm"));
    }

    #[test]
    fn app_info_shape_matches_shared_contract() {
        let info = app_info("0.0.0-test");
        assert_eq!(info["version"], "0.0.0-test");
        assert!(matches!(
            info["platform"].as_str(),
            Some("win32") | Some("darwin") | Some("linux") | Some("other")
        ));
    }
}
