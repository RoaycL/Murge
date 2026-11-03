//! The frosted tray popup — a borderless, always-on-top webview that replaces
//! the Win32 context menu on Windows (a native popup menu cannot be given an
//! Acrylic backdrop, rounded rows or the app's typography).
//!
//! Safety first: the popup only takes over once its page has loaded and
//! reported ready. Until then — and on any platform or build where the window
//! cannot be created — the native menu stays attached to the tray icon, so
//! 退出 is always reachable. The popup renders the exact same data tree the
//! native menu is built from (`tray::render_menu`), and an activation goes
//! through the same `TrayController::handle_menu` dispatcher, so the two
//! surfaces cannot drift.
//!
//! Layout is pure and unit-tested: the initial size is computed here from the
//! row metrics the page uses (no renderer round-trip before the first paint),
//! the page reports its measured height for drill-down pages, and placement
//! clamps the panel into the monitor's work area next to the cursor, opening
//! upward from a bottom taskbar like the system menu.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tray::{MenuKind, TrayMenuItem};

pub(crate) const POPUP_LABEL: &str = "tray-menu";
const POPUP_PAGE: &str = "tray-menu.html";

/// Row metrics shared with `TrayMenuApp.vue` (logical px).
pub(crate) const PANEL_WIDTH: f64 = 288.0;
const PANEL_PADDING: f64 = 6.0;
const HEADER_HEIGHT: f64 = 52.0;
const ROW_HEIGHT: f64 = 30.0;
const SEPARATOR_HEIGHT: f64 = 9.0;
const MAX_PANEL_HEIGHT: f64 = 600.0;
/// Margin kept between the panel and the work-area edge (logical px).
const EDGE_MARGIN: f64 = 8.0;
/// A blur that hid the popup this recently swallows the click that caused
/// it, so clicking the tray icon again closes instead of re-opening.
const REOPEN_DEBOUNCE: Duration = Duration::from_millis(300);

// ---------------------------------------------------------------------------
// Pure model + layout
// ---------------------------------------------------------------------------

fn item_json(item: &TrayMenuItem) -> Value {
    let kind = match item.kind {
        MenuKind::Separator => "separator",
        MenuKind::Checkbox => "checkbox",
        MenuKind::Radio => "radio",
        MenuKind::Normal if !item.children.is_empty() => "submenu",
        MenuKind::Normal => "normal",
    };
    json!({
        "id": item.id,
        "label": item.label,
        "enabled": item.enabled,
        "checked": item.checked,
        "kind": kind,
        "children": item.children.iter().map(item_json).collect::<Vec<_>>(),
    })
}

/// The page model: header (product, status, runtime accent, theme) + tree.
pub(crate) fn model_json(
    title: &str,
    status: &str,
    accent: &str,
    dark: bool,
    items: &[TrayMenuItem],
) -> Value {
    json!({
        "title": title,
        "status": status,
        "accent": accent,
        "theme": if dark { "dark" } else { "light" },
        "items": items.iter().map(item_json).collect::<Vec<_>>(),
    })
}

/// Height of the root page for `items`, before the work-area clamp.
pub(crate) fn root_height(items: &[TrayMenuItem]) -> f64 {
    let rows: f64 = items
        .iter()
        .map(|item| match item.kind {
            MenuKind::Separator => SEPARATOR_HEIGHT,
            _ => ROW_HEIGHT,
        })
        .sum();
    (HEADER_HEIGHT + PANEL_PADDING * 2.0 + rows).min(MAX_PANEL_HEIGHT)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Physical-pixel placement `(x, y, width, height)` of a `size` panel for a
/// click at `anchor`, inside `work`: left of the cursor and above it when
/// there is room (a taskbar at the bottom-right is the common case), flipped
/// otherwise, then clamped. A panel larger than the work area shrinks to it
/// (the page scrolls).
pub(crate) fn place(anchor: (f64, f64), size: (f64, f64), work: Rect, margin: f64) -> Rect {
    let width = size.0.min(work.width - 2.0 * margin).max(1.0);
    let height = size.1.min(work.height - 2.0 * margin).max(1.0);
    let left = work.x + margin;
    let top = work.y + margin;
    let right = work.x + work.width - margin;
    let bottom = work.y + work.height - margin;
    let x = if anchor.0 - width >= left {
        anchor.0 - width
    } else {
        anchor.0
    };
    let y = if anchor.1 - height >= top {
        anchor.1 - height
    } else {
        anchor.1
    };
    let x = x.min(right - width).max(left);
    let y = y.min(bottom - height).max(top);
    Rect {
        x: x.round(),
        y: y.round(),
        width: width.round(),
        height: height.round(),
    }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type Dispatch = Arc<dyn Fn(String) + Send + Sync>;

pub(crate) struct TrayPopup {
    app: tauri::AppHandle,
    ready: AtomicBool,
    model: Mutex<Value>,
    theme: Mutex<Option<bool>>,
    root_height: Mutex<f64>,
    /// Last click position (physical) the popup opened at.
    anchor: Mutex<Option<(f64, f64)>>,
    hidden_at: Mutex<Option<Instant>>,
    dispatch: Mutex<Option<Dispatch>>,
    /// Called once the page reports ready (detach the native menu).
    on_ready: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl TrayPopup {
    /// Build the hidden popup window. Windows only: elsewhere the native menu
    /// already matches the platform (and the page assumes the DWM backdrop).
    pub(crate) fn create(app: &tauri::AppHandle) -> Option<Arc<Self>> {
        if !cfg!(windows) {
            return None;
        }
        let built = tauri::WebviewWindowBuilder::new(
            app,
            POPUP_LABEL,
            tauri::WebviewUrl::App(POPUP_PAGE.into()),
        )
        .title("Murge")
        .inner_size(PANEL_WIDTH, 320.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build();
        let window = match built {
            Ok(window) => window,
            Err(error) => {
                crate::diag!("[tray] popup window unavailable, keeping the native menu: {error}");
                return None;
            }
        };
        crate::window_backdrop::apply(&window);
        let popup = Arc::new(TrayPopup {
            app: app.clone(),
            ready: AtomicBool::new(false),
            model: Mutex::new(Value::Null),
            theme: Mutex::new(None),
            root_height: Mutex::new(320.0),
            anchor: Mutex::new(None),
            hidden_at: Mutex::new(None),
            dispatch: Mutex::new(None),
            on_ready: Mutex::new(None),
        });
        let weak = Arc::downgrade(&popup);
        window.on_window_event(move |event| {
            let Some(popup) = weak.upgrade() else {
                return;
            };
            match event {
                tauri::WindowEvent::Focused(false) => popup.hide(),
                // Never let the popup be destroyed (Alt+F4): it is reused.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    popup.hide();
                }
                _ => {}
            }
        });
        Some(popup)
    }

    fn window(&self) -> Option<tauri::WebviewWindow> {
        use tauri::Manager;
        self.app.get_webview_window(POPUP_LABEL)
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub(crate) fn set_dispatch(&self, dispatch: Dispatch) {
        *self.dispatch.lock().expect("popup dispatch") = Some(dispatch);
    }

    pub(crate) fn set_on_ready(&self, on_ready: Box<dyn Fn() + Send + Sync>) {
        *self.on_ready.lock().expect("popup on_ready") = Some(on_ready);
    }

    /// Store and push the latest menu snapshot.
    pub(crate) fn update(&self, model: Value, items: &[TrayMenuItem]) {
        *self.root_height.lock().expect("popup height") = root_height(items);
        *self.model.lock().expect("popup model") = model.clone();
        if let Some(window) = self.window() {
            // The DWM backdrop tint follows the window theme; only touch it
            // when it moved (every render would re-send WM messages).
            let dark = model["theme"] == "dark";
            let mut last = self.theme.lock().expect("popup theme");
            if *last != Some(dark) {
                *last = Some(dark);
                let theme = if dark {
                    tauri::Theme::Dark
                } else {
                    tauri::Theme::Light
                };
                let _ = window.set_theme(Some(theme));
            }
            drop(last);
            let _ = tauri::Emitter::emit_to(
                &self.app,
                tauri::EventTarget::webview_window(POPUP_LABEL),
                "tray-menu:model",
                model,
            );
        }
    }

    /// The page loaded: hand it the snapshot and take over the right click.
    pub(crate) fn mark_ready(&self) -> Value {
        if !self.ready.swap(true, Ordering::SeqCst) {
            if let Some(on_ready) = self.on_ready.lock().expect("popup on_ready").as_ref() {
                on_ready();
            }
        }
        self.model.lock().expect("popup model").clone()
    }

    /// Right click on the tray icon (physical cursor position).
    pub(crate) fn toggle(&self, anchor: (f64, f64)) {
        let Some(window) = self.window() else {
            return;
        };
        if window.is_visible().unwrap_or(false) {
            self.hide();
            return;
        }
        if self
            .hidden_at
            .lock()
            .expect("popup hidden_at")
            .map(|at| at.elapsed() < REOPEN_DEBOUNCE)
            .unwrap_or(false)
        {
            return;
        }
        *self.anchor.lock().expect("popup anchor") = Some(anchor);
        let height = *self.root_height.lock().expect("popup height");
        let _ = tauri::Emitter::emit_to(
            &self.app,
            tauri::EventTarget::webview_window(POPUP_LABEL),
            "tray-menu:open",
            (),
        );
        self.layout(height);
        let _ = window.show();
        let _ = window.set_focus();
    }

    /// Size + place the panel for a logical `height` against the anchor.
    pub(crate) fn layout(&self, height: f64) {
        let Some(window) = self.window() else {
            return;
        };
        let Some(anchor) = *self.anchor.lock().expect("popup anchor") else {
            return;
        };
        let monitor = self
            .app
            .monitor_from_point(anchor.0, anchor.1)
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else {
            return;
        };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let work = Rect {
            x: area.position.x as f64,
            y: area.position.y as f64,
            width: area.size.width as f64,
            height: area.size.height as f64,
        };
        let height = height.clamp(ROW_HEIGHT, MAX_PANEL_HEIGHT);
        let size = (PANEL_WIDTH * scale, height * scale);
        let placed = place(anchor, size, work, EDGE_MARGIN * scale);
        let _ = window.set_size(tauri::PhysicalSize::new(
            placed.width as u32,
            placed.height as u32,
        ));
        let _ = window.set_position(tauri::PhysicalPosition::new(
            placed.x as i32,
            placed.y as i32,
        ));
    }

    pub(crate) fn hide(&self) {
        if let Some(window) = self.window() {
            if window.is_visible().unwrap_or(false) {
                *self.hidden_at.lock().expect("popup hidden_at") = Some(Instant::now());
            }
            let _ = window.hide();
        }
    }

    /// A row was picked: close first (instant feedback), then run it.
    pub(crate) fn activate(&self, id: String, keep_open: bool) {
        if !keep_open {
            self.hide();
        }
        let dispatch = self.dispatch.lock().expect("popup dispatch").clone();
        if let Some(dispatch) = dispatch {
            dispatch(id);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands (accepted only from the popup window)
// ---------------------------------------------------------------------------

fn popup_for(
    window: &tauri::WebviewWindow,
    state: &tauri::State<'_, PopupSlot>,
) -> Result<Arc<TrayPopup>, String> {
    if window.label() != POPUP_LABEL {
        return Err("tray menu commands are only available to the tray popup".to_string());
    }
    state
        .0
        .lock()
        .expect("popup slot")
        .clone()
        .ok_or_else(|| "tray popup is not available".to_string())
}

/// Managed from setup; filled once the tray is wired.
#[derive(Default)]
pub(crate) struct PopupSlot(pub(crate) Mutex<Option<Arc<TrayPopup>>>);

#[tauri::command]
pub(crate) fn tray_menu_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PopupSlot>,
) -> Result<Value, String> {
    Ok(popup_for(&window, &state)?.mark_ready())
}

#[tauri::command]
pub(crate) fn tray_menu_activate(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PopupSlot>,
    id: String,
    keep_open: Option<bool>,
) -> Result<(), String> {
    // Module toggles keep the page open so several can be flipped in a row.
    let keep_open = keep_open.unwrap_or(false) && id.starts_with("module:");
    popup_for(&window, &state)?.activate(id, keep_open);
    Ok(())
}

#[tauri::command]
pub(crate) fn tray_menu_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PopupSlot>,
    height: f64,
) -> Result<(), String> {
    if !height.is_finite() {
        return Err("invalid height".to_string());
    }
    popup_for(&window, &state)?.layout(height);
    Ok(())
}

#[tauri::command]
pub(crate) fn tray_menu_dismiss(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PopupSlot>,
) -> Result<(), String> {
    popup_for(&window, &state)?.hide();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: MenuKind) -> TrayMenuItem {
        TrayMenuItem {
            id: "x".into(),
            label: "x".into(),
            enabled: true,
            checked: false,
            kind,
            children: Vec::new(),
        }
    }

    #[test]
    fn root_height_follows_the_page_row_metrics() {
        let items = vec![
            item(MenuKind::Normal),
            item(MenuKind::Separator),
            item(MenuKind::Checkbox),
        ];
        assert_eq!(
            root_height(&items),
            HEADER_HEIGHT + PANEL_PADDING * 2.0 + ROW_HEIGHT * 2.0 + SEPARATOR_HEIGHT
        );
        let many = vec![item(MenuKind::Normal); 80];
        assert_eq!(
            root_height(&many),
            MAX_PANEL_HEIGHT,
            "long menus scroll inside the cap"
        );
    }

    #[test]
    fn submenus_serialize_with_their_children_and_kind() {
        let mut parent = item(MenuKind::Normal);
        parent.children = vec![item(MenuKind::Radio)];
        let model = model_json(
            "Murge",
            "Murge · 运行中",
            "tun",
            true,
            &[parent, item(MenuKind::Separator)],
        );
        assert_eq!(model["theme"], "dark");
        assert_eq!(model["items"][0]["kind"], "submenu");
        assert_eq!(model["items"][0]["children"][0]["kind"], "radio");
        assert_eq!(model["items"][1]["kind"], "separator");
    }

    const WORK: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1032.0,
    };

    #[test]
    fn a_bottom_right_tray_opens_up_and_left_of_the_cursor() {
        let placed = place((1800.0, 1050.0), (288.0, 400.0), WORK, 8.0);
        assert_eq!((placed.x, placed.y), (1512.0, 624.0));
    }

    #[test]
    fn the_panel_flips_and_clamps_into_the_work_area() {
        // Top-left taskbar: opens below/right of the cursor.
        let placed = place((20.0, 10.0), (288.0, 400.0), WORK, 8.0);
        assert_eq!((placed.x, placed.y), (20.0, 10.0));
        // Cursor at the very right edge: never spills past it.
        let placed = place((1919.0, 500.0), (288.0, 400.0), WORK, 8.0);
        assert!(placed.x + placed.width <= 1912.0);
        // Taller than the work area: shrinks to it inside the margins.
        let placed = place((900.0, 1000.0), (288.0, 2000.0), WORK, 8.0);
        assert_eq!((placed.y, placed.height), (8.0, 1016.0));
    }

    #[test]
    fn secondary_monitors_use_their_own_origin() {
        let work = Rect {
            x: -1440.0,
            y: 0.0,
            width: 1440.0,
            height: 860.0,
        };
        let placed = place((-40.0, 880.0), (288.0, 300.0), work, 8.0);
        assert_eq!((placed.x, placed.y), (-328.0, 552.0));
    }
}
