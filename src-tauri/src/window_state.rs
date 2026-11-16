//! Remembers the main window's size between launches.
//!
//! Only the size (in logical pixels) and the maximized flag are kept; the
//! window is still centred on launch, so a saved position can never put it
//! on a display that is gone.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const FILE_NAME: &str = "window-state.json";
/// tauri.conf.json `minWidth` / `minHeight`.
const MIN_WIDTH: f64 = 848.0;
const MIN_HEIGHT: f64 = 640.0;
const SAVE_DELAY_MS: u64 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// A stored document is used only when it is a sane size; anything else
/// (corrupt file, a minimized 0×0 snapshot) falls back to the default.
pub fn parse(text: &str) -> Option<WindowState> {
    let state: WindowState = serde_json::from_str(text).ok()?;
    let sane = |value: f64, min: f64| value.is_finite() && value >= min && value <= 16384.0;
    (sane(state.width, MIN_WIDTH) && sane(state.height, MIN_HEIGHT)).then_some(state)
}

/// Never larger than the display the window opens on.
pub fn fit(state: WindowState, monitor: Option<(f64, f64)>) -> (f64, f64) {
    match monitor {
        Some((width, height)) => (
            state.width.min(width).max(MIN_WIDTH.min(width)),
            state.height.min(height).max(MIN_HEIGHT.min(height)),
        ),
        None => (state.width, state.height),
    }
}

/// What a resize leaves to remember: a maximized window keeps the size it
/// will restore to, and a minimized (0×0) one changes nothing.
pub fn after_resize(
    previous: Option<WindowState>,
    logical: (f64, f64),
    maximized: bool,
    minimized: bool,
) -> Option<WindowState> {
    if minimized || logical.0 < 1.0 || logical.1 < 1.0 {
        return previous;
    }
    if maximized {
        return previous.map(|state| WindowState {
            maximized: true,
            ..state
        });
    }
    Some(WindowState {
        width: logical.0.max(MIN_WIDTH),
        height: logical.1.max(MIN_HEIGHT),
        maximized: false,
    })
}

fn load(path: &Path) -> Option<WindowState> {
    parse(&std::fs::read_to_string(path).ok()?)
}

fn save(path: &Path, state: WindowState) {
    let Ok(body) = serde_json::to_vec(&state) else {
        return;
    };
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, body).is_ok() {
        let _ = std::fs::rename(&temp, path);
    }
}

struct Tracker {
    path: PathBuf,
    current: Mutex<Option<WindowState>>,
    generation: AtomicU64,
}

/// Restore the saved size (call before the window is shown) and keep the
/// file up to date as the user resizes.
pub fn attach(window: &tauri::WebviewWindow, app_data_root: Option<&Path>) {
    let Some(root) = app_data_root else {
        return;
    };
    let path = root.join(FILE_NAME);
    let saved = load(&path);
    if let Some(state) = saved {
        let monitor = window.current_monitor().ok().flatten().map(|monitor| {
            let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
            (size.width, size.height)
        });
        let (width, height) = fit(state, monitor);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let _ = window.center();
        if state.maximized {
            let _ = window.maximize();
        }
    }
    let tracker = std::sync::Arc::new(Tracker {
        path,
        current: Mutex::new(saved),
        generation: AtomicU64::new(0),
    });
    let target = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Resized(_)) {
            return;
        }
        let Ok(size) = target.inner_size() else {
            return;
        };
        let scale = target.scale_factor().unwrap_or(1.0);
        let logical = size.to_logical::<f64>(scale);
        let next = {
            let mut current = tracker.current.lock().unwrap_or_else(|e| e.into_inner());
            let next = after_resize(
                *current,
                (logical.width, logical.height),
                target.is_maximized().unwrap_or(false),
                target.is_minimized().unwrap_or(false),
            );
            if next == *current {
                return;
            }
            *current = next;
            next
        };
        let Some(next) = next else {
            return;
        };
        // A drag fires many events: only the last one in a burst is written.
        let generation = tracker.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let tracker = tracker.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(SAVE_DELAY_MS)).await;
            if tracker.generation.load(Ordering::SeqCst) == generation {
                let path = tracker.path.clone();
                let _ = tokio::task::spawn_blocking(move || save(&path, next)).await;
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(width: f64, height: f64, maximized: bool) -> WindowState {
        WindowState {
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn only_sane_documents_are_restored() {
        assert_eq!(
            parse(r#"{"width":1200,"height":800,"maximized":true}"#),
            Some(state(1200.0, 800.0, true))
        );
        assert_eq!(
            parse(r#"{"width":1200,"height":800}"#),
            Some(state(1200.0, 800.0, false))
        );
        assert_eq!(parse(r#"{"width":0,"height":0}"#), None);
        assert_eq!(parse(r#"{"width":100,"height":800}"#), None);
        assert_eq!(parse(r#"{"width":1e9,"height":800}"#), None);
        assert_eq!(parse("not json"), None);
    }

    #[test]
    fn the_restored_size_fits_the_display() {
        assert_eq!(
            fit(state(3000.0, 2000.0, false), Some((1920.0, 1080.0))),
            (1920.0, 1080.0)
        );
        assert_eq!(
            fit(state(1200.0, 800.0, false), Some((1920.0, 1080.0))),
            (1200.0, 800.0)
        );
        assert_eq!(fit(state(1200.0, 800.0, false), None), (1200.0, 800.0));
    }

    #[test]
    fn maximize_and_minimize_keep_the_normal_size() {
        let normal = after_resize(None, (1200.0, 800.0), false, false);
        assert_eq!(normal, Some(state(1200.0, 800.0, false)));
        let maximized = after_resize(normal, (1920.0, 1040.0), true, false);
        assert_eq!(maximized, Some(state(1200.0, 800.0, true)));
        assert_eq!(after_resize(maximized, (0.0, 0.0), false, true), maximized);
        assert_eq!(
            after_resize(maximized, (1000.0, 700.0), false, false),
            Some(state(1000.0, 700.0, false))
        );
        // Maximized on the very first run: nothing to restore to yet.
        assert_eq!(after_resize(None, (1920.0, 1040.0), true, false), None);
    }

    #[test]
    fn a_saved_state_round_trips_through_the_file() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join(FILE_NAME);
        assert_eq!(load(&path), None);
        save(&path, state(1100.0, 760.0, true));
        assert_eq!(load(&path), Some(state(1100.0, 760.0, true)));
    }
}
