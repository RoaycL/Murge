//! The native tray view — the Tauri/tray-icon implementation of the TS
//! `TrayView` seam (`src/main/tray/electron-tray.ts`).
//!
//! Differences (documented):
//! - Electron packs a native menu in one call and keeps it; muda menus are
//!   rebuilt per render — the controller's `set_menu` contract maps onto
//!   rebuilding and re-attaching the menu.
//! - Icon: the pre-rasterized 32px assets (`tray-{dark|light}-{accent}.png`)
//!   are reused; Tauri rescales at paint time (the Electron multi-scale
//!   representation dance is a notification-area HICON workaround).
//! - Group icons (per-policy data URLs) are not attached: muda's icon items
//!   need per-item native images and the TS contract degrades gracefully
//!   without them (icons are decorative).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIcon;
use tauri::AppHandle;
use tauri::Manager;

use crate::tray::{MenuKind, TrayMenuItem, TrayView};
use crate::tray_popup::TrayPopup;

/// Which built-in asset the accent maps to.
fn icon_file(accent: &str, dark: bool) -> &'static str {
    match (dark, accent) {
        (true, "proxy") => "tray-dark-proxy.png",
        (true, "tun") => "tray-dark-tun.png",
        (false, "proxy") => "tray-light-proxy.png",
        (false, "tun") => "tray-light-tun.png",
        (_, _) => {
            if dark {
                "tray-dark-idle.png"
            } else {
                "tray-light-idle.png"
            }
        }
    }
}

pub struct NativeTrayView {
    app: AppHandle,
    tray: Mutex<Option<TrayIcon>>,
    icon_root: Mutex<Option<PathBuf>>,
    dark: Mutex<bool>,
    accent: Mutex<String>,
    /// The frosted popup (Windows). While it is absent or not ready yet, the
    /// native menu stays attached so the tray is never menu-less.
    popup: Mutex<Option<Arc<TrayPopup>>>,
    tooltip: Mutex<String>,
    items: Mutex<Vec<TrayMenuItem>>,
}

impl NativeTrayView {
    /// Create the tray with the idle icon; the menu follows the first render.
    pub fn create(app: AppHandle, icon_root: Option<PathBuf>) -> Result<Self, tauri::Error> {
        let dark = dark_theme(&app);
        let accent = "idle";
        let view = Self {
            app: app.clone(),
            tray: Mutex::new(None),
            icon_root: Mutex::new(icon_root),
            dark: Mutex::new(dark),
            accent: Mutex::new(accent.to_string()),
            popup: Mutex::new(None),
            tooltip: Mutex::new("Murge".to_string()),
            items: Mutex::new(Vec::new()),
        };
        let (icon, _dark, _accent) = view.current_icon();
        let mut builder = tauri::tray::TrayIconBuilder::with_id("main")
            .icon(icon)
            .tooltip("Murge");
        if dark {
            builder = builder.icon_as_template(false);
        }
        let tray = builder.build(&app)?;
        let _ = tray.set_show_menu_on_left_click(false);
        *view.tray.lock().expect("tray mutex") = Some(tray);
        Ok(view)
    }

    fn current_icon(&self) -> (tauri::image::Image<'static>, bool, String) {
        let dark = *self.dark.lock().expect("dark mutex");
        let accent = self.accent.lock().expect("accent mutex").clone();
        let icon = match self.icon_root.lock().expect("icon root mutex").as_ref() {
            Some(root) => {
                let path = root.join(icon_file(&accent, dark));
                // The assets are PNG files: decode them (passing the file
                // bytes as raw RGBA painted garbage or nothing at all).
                match tauri::image::Image::from_path(&path) {
                    Ok(image) => tauri::image::Image::new_owned(
                        image.rgba().to_vec(),
                        image.width(),
                        image.height(),
                    ),
                    Err(_) => default_icon(&self.app),
                }
            }
            None => default_icon(&self.app),
        };
        (icon, dark, accent)
    }

    /// Re-paint the icon after an accent/theme change.
    pub fn set_runtime_appearance(&self, accent: &str, dark: bool) {
        *self.accent.lock().expect("accent mutex") = accent.to_string();
        *self.dark.lock().expect("dark mutex") = dark;
        let (icon, _, _) = self.current_icon();
        if let Some(tray) = self.tray.lock().expect("tray mutex").as_ref() {
            let _ = tray.set_icon(Some(icon));
        }
    }

    pub(crate) fn attach_popup(&self, popup: Arc<TrayPopup>) {
        *self.popup.lock().expect("popup mutex") = Some(popup);
    }

    fn popup(&self) -> Option<Arc<TrayPopup>> {
        self.popup.lock().expect("popup mutex").clone()
    }

    /// The popup page is live: right click opens it instead of the native
    /// menu (a native menu stays attached until this point).
    pub(crate) fn detach_native_menu(&self) {
        if let Some(tray) = tray_guard(self).as_ref() {
            let _ = tray.set_menu(None::<Menu<tauri::Wry>>);
        }
        self.push_popup_model();
    }

    /// Re-send the snapshot (menu, status line, accent, theme) to the popup.
    fn push_popup_model(&self) {
        let Some(popup) = self.popup() else {
            return;
        };
        let tooltip = self.tooltip.lock().expect("tooltip mutex").clone();
        let (title, status) = tooltip
            .split_once(" · ")
            .map(|(title, status)| (title.to_string(), status.to_string()))
            .unwrap_or_else(|| (tooltip.clone(), String::new()));
        let accent = self.accent.lock().expect("accent mutex").clone();
        let dark = *self.dark.lock().expect("dark mutex");
        let items = self.items.lock().expect("items mutex").clone();
        let model = crate::tray_popup::model_json(&title, &status, &accent, dark, &items);
        popup.update(model, &items);
    }

    /// Repaint only when the accent or theme actually moved (the cadence
    /// would otherwise re-upload the HICON every tick).
    fn appearance_changed(&self, accent: &str, dark: bool) -> bool {
        *self.accent.lock().expect("accent mutex") != accent
            || *self.dark.lock().expect("dark mutex") != dark
    }
}

/// The TS `nativeTheme.shouldUseDarkColors`: the OS app theme, read through
/// the main window (the tray has no direct query). Dark when unknown.
pub(crate) fn dark_theme(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .next()
        .and_then(|window| window.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(true)
}

fn default_icon(app: &AppHandle) -> tauri::image::Image<'static> {
    let owned = app
        .default_window_icon()
        .cloned()
        .expect("tauri default icon present");
    // The borrowed icon's lifetime is tied to the app handle; re-own the RGBA
    // buffer so the tray keeps it independently.
    let (rgba, width, height) = (owned.rgba().to_vec(), owned.width(), owned.height());
    tauri::image::Image::new_owned(rgba, width, height)
}

fn tray_guard(view: &NativeTrayView) -> std::sync::MutexGuard<'_, Option<TrayIcon>> {
    view.tray.lock().expect("tray mutex")
}

impl TrayView for NativeTrayView {
    fn set_tooltip(&self, value: &str) {
        *self.tooltip.lock().expect("tooltip mutex") = value.to_string();
        if let Some(tray) = tray_guard(self).as_ref() {
            let _ = tray.set_tooltip(Some(value));
        }
    }

    fn set_menu(&self, items: Vec<TrayMenuItem>) {
        *self.items.lock().expect("items mutex") = items.clone();
        let popup_ready = self.popup().map(|popup| popup.is_ready()).unwrap_or(false);
        if popup_ready {
            self.push_popup_model();
            return;
        }
        {
            let guard = tray_guard(self);
            let Some(tray) = guard.as_ref() else {
                return;
            };
            // A failed rebuild preserves the previous menu and the tray.
            if let Ok(menu) = build_menu(&self.app, &items) {
                let _ = tray.set_menu(Some(menu));
            }
        }
        // Keep a loading page current too.
        self.push_popup_model();
    }

    fn set_runtime_appearance(&self, accent: &str, dark: bool) {
        if self.appearance_changed(accent, dark) {
            NativeTrayView::set_runtime_appearance(self, accent, dark);
            self.push_popup_model();
        }
    }
}

/// Recursively build a muda menu from the data tree. Group-member items carry
/// a NUL-separated member in their id (see `tray.rs`); muda ids keep it.
fn build_menu(app: &AppHandle, items: &[TrayMenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    build_menu_inner(app, items)
}

fn build_menu_inner(app: &AppHandle, items: &[TrayMenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for item in items {
        match item.kind {
            MenuKind::Separator => {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
            MenuKind::Normal => {
                if !item.children.is_empty() {
                    let submenu =
                        Submenu::with_id_and_items(app, &item.id, &item.label, item.enabled, &[])?;
                    append_children(app, &submenu, &item.children)?;
                    menu.append(&submenu)?;
                } else {
                    menu.append(&MenuItem::with_id(
                        app,
                        &item.id,
                        &item.label,
                        item.enabled,
                        None::<&str>,
                    )?)?;
                }
            }
            MenuKind::Checkbox | MenuKind::Radio => {
                menu.append(&CheckMenuItem::with_id(
                    app,
                    &item.id,
                    &item.label,
                    item.enabled,
                    item.checked,
                    None::<&str>,
                )?)?;
            }
        }
    }
    Ok(menu)
}

fn append_children(
    app: &AppHandle,
    parent: &Submenu<tauri::Wry>,
    items: &[TrayMenuItem],
) -> tauri::Result<()> {
    for item in items {
        match item.kind {
            MenuKind::Separator => {
                parent.append(&PredefinedMenuItem::separator(app)?)?;
            }
            MenuKind::Normal => {
                if !item.children.is_empty() {
                    let submenu =
                        Submenu::with_id_and_items(app, &item.id, &item.label, item.enabled, &[])?;
                    append_children(app, &submenu, &item.children)?;
                    parent.append(&submenu)?;
                } else {
                    parent.append(&MenuItem::with_id(
                        app,
                        &item.id,
                        &item.label,
                        item.enabled,
                        None::<&str>,
                    )?)?;
                }
            }
            MenuKind::Checkbox | MenuKind::Radio => {
                parent.append(&CheckMenuItem::with_id(
                    app,
                    &item.id,
                    &item.label,
                    item.enabled,
                    item.checked,
                    None::<&str>,
                )?)?;
            }
        }
    }
    Ok(())
}
