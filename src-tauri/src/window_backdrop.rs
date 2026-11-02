//! Frosted window backdrop (the Surge-style translucent sidebar/background).
//!
//! The main window is created `transparent` (tauri.conf.json) so a DWM system
//! backdrop can show through the parts of the UI the renderer leaves
//! translucent. Which backdrop is used depends only on the Windows build:
//!
//! * Windows 11 22H2+ (build >= 22523): Acrylic, i.e. the documented
//!   `DWMSBT_TRANSIENTWINDOW` system backdrop — a live blur of whatever is
//!   behind the window, closest to the macOS vibrancy Surge uses.
//! * Windows 11 21H2 (build 22000..22522): Mica through the undocumented
//!   `DWMWA_MICA_EFFECT` attribute. Acrylic would fall back to the legacy
//!   `SetWindowCompositionAttribute` path there, which lags on drag/resize.
//! * Windows 10 and anything else: no backdrop. The window gets an opaque
//!   background color and the renderer keeps its opaque gradient.
//!
//! The thresholds mirror the checks `window-vibrancy` makes internally, so the
//! decision here and the effect DWM actually applies agree. The renderer learns
//! the decision through an initialization script (`window.__MURGE_BACKDROP__`)
//! that runs before any page script, so the first paint is already right and
//! an unsupported system never renders a see-through UI.

use once_cell::sync::OnceCell;

/// First Windows 11 build (21H2).
const WINDOWS_11_BUILD: u32 = 22_000;
/// First build with the documented `DWMWA_SYSTEMBACKDROP_TYPE` attribute.
const SYSTEM_BACKDROP_BUILD: u32 = 22_523;
/// The light-theme gradient start (`--app-background-start`), used as the
/// native window color when no backdrop is available.
const OPAQUE_FALLBACK: (u8, u8, u8) = (0xee, 0xf3, 0xf8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backdrop {
    Acrylic,
    Mica,
    None,
}

impl Backdrop {
    pub fn as_str(self) -> &'static str {
        match self {
            Backdrop::Acrylic => "acrylic",
            Backdrop::Mica => "mica",
            Backdrop::None => "none",
        }
    }
}

/// The backdrop a given Windows build supports (`None` = not Windows).
pub fn backdrop_for_build(build: Option<u32>) -> Backdrop {
    match build {
        Some(build) if build >= SYSTEM_BACKDROP_BUILD => Backdrop::Acrylic,
        Some(build) if build >= WINDOWS_11_BUILD => Backdrop::Mica,
        _ => Backdrop::None,
    }
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    // RtlGetVersion reports the real build; GetVersionEx is manifest-shimmed.
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let status = unsafe { RtlGetVersion(&mut info) };
    status.is_ok().then_some(info.dwBuildNumber)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// The backdrop for this machine, decided once per process.
pub fn current() -> Backdrop {
    static BACKDROP: OnceCell<Backdrop> = OnceCell::new();
    *BACKDROP.get_or_init(|| backdrop_for_build(windows_build()))
}

/// The initialization script that tells the renderer which backdrop is live.
pub fn init_script(backdrop: Backdrop) -> String {
    format!(
        "Object.defineProperty(window, '__MURGE_BACKDROP__', {{ value: '{}', configurable: false, writable: false }});",
        backdrop.as_str()
    )
}

/// A command-less plugin whose only job is the initialization script.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("murge-backdrop")
        .js_init_script(init_script(current()))
        .build()
}

/// Apply the backdrop to the main window (called from setup, before show).
pub fn apply<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::window::{Color, Effect, EffectsBuilder};
    let backdrop = current();
    let result = match backdrop {
        Backdrop::Acrylic => {
            window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build())
        }
        Backdrop::Mica => window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build()),
        Backdrop::None => {
            let (r, g, b) = OPAQUE_FALLBACK;
            window.set_background_color(Some(Color(r, g, b, 255)))
        }
    };
    if let Err(error) = result {
        crate::diag!("[window] backdrop {} failed: {error}", backdrop.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_backdrop_by_windows_build() {
        assert_eq!(backdrop_for_build(None), Backdrop::None);
        assert_eq!(backdrop_for_build(Some(19_045)), Backdrop::None); // Windows 10 22H2
        assert_eq!(backdrop_for_build(Some(22_000)), Backdrop::Mica); // Windows 11 21H2
        assert_eq!(backdrop_for_build(Some(22_522)), Backdrop::Mica);
        assert_eq!(backdrop_for_build(Some(22_621)), Backdrop::Acrylic); // 22H2
        assert_eq!(backdrop_for_build(Some(26_100)), Backdrop::Acrylic); // 24H2
    }

    #[test]
    fn init_script_exposes_a_read_only_flag() {
        let script = init_script(Backdrop::Acrylic);
        assert!(script.contains("'__MURGE_BACKDROP__'"));
        assert!(script.contains("value: 'acrylic'"));
        assert!(script.contains("writable: false"));
    }
}
