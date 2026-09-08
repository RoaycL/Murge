//! Application-data paths — the Rust mirror of `src/main/storage/app-data.ts`.
//!
//! The stable namespace is the brand `appId` (`io.murge.desktop`), never the
//! product name, so a cosmetic rename can never orphan user data. Layout:
//! `<platform app-data>/io.murge.desktop/` with `profiles/` for the profile
//! workspace and `profiles/kernel` as the persistent kernel home (matching the
//! Electron `productionKernelRoot = join(profileRoot, 'kernel')`).

use std::path::PathBuf;

use crate::brand;

/// Canonical app-data folder name (product-name-free, brand-stable).
pub fn app_data_namespace() -> String {
    brand::load_brand().expect("brand validated at startup").app_id
}

/// Platform app-data root following Electron's per-user convention.
/// - Windows: `%APPDATA%` (Roaming)
/// - macOS: `~/Library/Application Support`
/// - Linux: `$XDG_CONFIG_HOME` or `~/.config` (Electron's fallback)
pub fn platform_app_data_root() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("APPDATA") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let mut path = PathBuf::from(home);
            path.push("Library/Application Support");
            return Some(path);
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg));
        }
    }
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".config"))
}

/// True when the Tauri shell runs in development mode (`tauri dev`). Dev
/// builds must never touch real user data — same rule as Electron.
pub fn is_dev() -> bool {
    // tauri-build injects DEV into the build script for dev profiles; the
    // env var check keeps unit-testability outside a Tauri context.
    cfg!(debug_assertions) && std::env::var("TAURI_ENV_DEBUG").map(|v| v == "true").unwrap_or(true)
        || std::env::var("MURGE_TAURI_DEV").map(|v| v == "1").unwrap_or(false)
}

/// Resolved application paths, shared with IPC handlers through Tauri state.
pub struct AppPaths {
    /// The stable namespace root (`…/io.murge.desktop`). Null in dev: dev uses
    /// an ephemeral workspace and never persists real user data.
    pub app_data_root: Option<PathBuf>,
    /// Profile workspace root (`app_data_root/profiles`).
    pub profile_root: Option<PathBuf>,
}

impl AppPaths {
    /// Resolve once at startup. In dev this intentionally yields None paths —
    /// Phase 3A handlers then serve from an in-memory store.
    pub fn probe() -> Self {
        if is_dev() {
            return AppPaths { app_data_root: None, profile_root: None };
        }
        let root = platform_app_data_root()
            .map(|base| base.join(app_data_namespace()));
        let profile_root = root.as_ref().map(|root| root.join("profiles"));
        AppPaths { app_data_root: root, profile_root }
    }

    /// The kernel home (`profile_root/kernel`), mirroring the Electron
    /// production layout (`…\io.murge.desktop\profiles\kernel`). Consumed by
    /// the Phase 3D privileged-core slice; the 3A profile slice consumes
    /// `profile_root` directly.
    #[allow(dead_code)]
    pub fn kernel_root(&self) -> Option<PathBuf> {
        self.profile_root.as_ref().map(|root| root.join("kernel"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_is_the_brand_app_id() {
        assert_eq!(app_data_namespace(), "io.murge.desktop");
    }

    #[test]
    fn dev_mode_never_yields_persistent_paths() {
        // In unit tests is_dev() may resolve either way; the invariant that
        // matters: dev => None paths (no real user data).
        let paths = AppPaths::probe();
        if is_dev() {
            assert!(paths.app_data_root.is_none());
            assert!(paths.profile_root.is_none());
        }
    }

    #[test]
    fn kernel_root_sits_under_profiles() {
        let paths = AppPaths::probe();
        if let (Some(profile), Some(kernel)) = (&paths.profile_root, paths.kernel_root()) {
            assert_eq!(kernel.parent(), Some(profile.as_path()));
            assert_eq!(kernel.file_name().and_then(|n| n.to_str()), Some("kernel"));
        }
    }
}
