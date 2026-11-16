//! Custom UI style (accent colour, font, font size, user CSS).
//!
//! Mirror of `src/shared/ui-style.ts`: the same per-field normalization, so a
//! hand-edited or restored `ui-style.json` can never hand the renderer a value
//! the settings page could not have produced. The file lives in the app-data
//! root and is part of the configuration backup (`backup::archive::ROOT_FILES`).
//! Dev builds have no app-data root and keep an in-memory copy instead.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const UI_STYLE_FILE: &str = "ui-style.json";
pub const MAX_CUSTOM_CSS_LENGTH: usize = 64 * 1024;
const MAX_FONT_FAMILY_LENGTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStyle {
    pub accent: String,
    pub font_family: String,
    pub font_scale: String,
    pub custom_css: String,
    pub custom_css_enabled: bool,
}

impl Default for UiStyle {
    fn default() -> Self {
        UiStyle {
            accent: String::new(),
            font_family: String::new(),
            font_scale: "default".into(),
            custom_css: String::new(),
            custom_css_enabled: false,
        }
    }
}

pub fn normalize_accent(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let mut text = text.trim().to_ascii_lowercase();
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    if text.len() == 4 && text.starts_with('#') && hex(&text[1..]) {
        let c: Vec<char> = text[1..].chars().collect();
        text = format!("#{0}{0}{1}{1}{2}{2}", c[0], c[1], c[2]);
    }
    if text.len() == 7 && text.starts_with('#') && hex(&text[1..]) {
        text
    } else {
        String::new()
    }
}

pub fn normalize_font_family(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.chars().count() > MAX_FONT_FAMILY_LENGTH {
        return String::new();
    }
    if text.contains([';', '{', '}', '<', '>', '\\']) {
        return String::new();
    }
    let lower = text.to_ascii_lowercase();
    if lower
        .match_indices("url")
        .any(|(index, _)| lower[index + 3..].trim_start().starts_with('('))
    {
        return String::new();
    }
    if text.matches('"').count() % 2 != 0 || text.matches('\'').count() % 2 != 0 {
        return String::new();
    }
    text
}

fn normalize_font_scale(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(scale @ ("small" | "large" | "larger")) => scale.into(),
        _ => "default".into(),
    }
}

/// Truncate to the limit counted in UTF-16 units, like the renderer's
/// `String.slice` (so the two sides agree on where the cut lands).
fn normalize_custom_css(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > MAX_CUSTOM_CSS_LENGTH {
            return text[..index].to_string();
        }
    }
    text.to_string()
}

pub fn parse_ui_style(document: &Value) -> UiStyle {
    let Some(object) = document.as_object() else {
        return UiStyle::default();
    };
    UiStyle {
        accent: normalize_accent(object.get("accent")),
        font_family: normalize_font_family(object.get("fontFamily")),
        font_scale: normalize_font_scale(object.get("fontScale")),
        custom_css: normalize_custom_css(object.get("customCss")),
        custom_css_enabled: object
            .get("customCssEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Merge a partial patch over the current style; unknown keys are ignored and
/// every field is normalized again.
pub fn merge(current: &UiStyle, patch: &Map<String, Value>) -> UiStyle {
    let mut document = serde_json::to_value(current).expect("ui style serializes");
    if let Some(object) = document.as_object_mut() {
        for key in [
            "accent",
            "fontFamily",
            "fontScale",
            "customCss",
            "customCssEnabled",
        ] {
            if let Some(value) = patch.get(key) {
                object.insert(key.into(), value.clone());
            }
        }
    }
    parse_ui_style(&document)
}

pub struct UiStyleStore {
    path: Option<PathBuf>,
    memory: Mutex<UiStyle>,
}

impl UiStyleStore {
    pub fn new(app_data_root: Option<&Path>) -> Self {
        UiStyleStore {
            path: app_data_root.map(|root| root.join(UI_STYLE_FILE)),
            memory: Mutex::new(UiStyle::default()),
        }
    }

    pub fn get(&self) -> UiStyle {
        match &self.path {
            Some(path) => std::fs::read_to_string(path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .map(|document| parse_ui_style(&document))
                .unwrap_or_default(),
            None => self.memory.lock().expect("ui style lock").clone(),
        }
    }

    pub fn set(&self, patch: &Map<String, Value>) -> Result<UiStyle, String> {
        let next = merge(&self.get(), patch);
        match &self.path {
            Some(path) => write_atomic(path, &next)?,
            None => *self.memory.lock().expect("ui style lock") = next.clone(),
        }
        Ok(next)
    }
}

static STORE: std::sync::OnceLock<UiStyleStore> = std::sync::OnceLock::new();

/// The process-wide store, rooted at the app-data root the first time it is used.
pub fn store(app_data_root: Option<&Path>) -> &'static UiStyleStore {
    STORE.get_or_init(|| UiStyleStore::new(app_data_root))
}

fn write_atomic(path: &Path, style: &UiStyle) -> Result<(), String> {
    let mut body = serde_json::to_vec_pretty(style).map_err(|_| "无法保存界面样式")?;
    body.push(b'\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建应用数据目录")?;
    }
    let temp = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, body).map_err(|_| "无法保存界面样式")?;
    std::fs::rename(&temp, path).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "无法保存界面样式".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn malformed_documents_fall_back_to_defaults() {
        assert_eq!(parse_ui_style(&json!(null)), UiStyle::default());
        assert_eq!(parse_ui_style(&json!([1, 2])), UiStyle::default());
        assert_eq!(
            parse_ui_style(
                &json!({"accent": "red", "fontScale": "huge", "customCssEnabled": "yes", "customCss": 3})
            ),
            UiStyle::default()
        );
    }

    #[test]
    fn accent_accepts_only_hex_colors() {
        assert_eq!(normalize_accent(Some(&json!(" #3FB34F "))), "#3fb34f");
        assert_eq!(normalize_accent(Some(&json!("#abc"))), "#aabbcc");
        assert_eq!(normalize_accent(Some(&json!("#abcd"))), "");
        assert_eq!(normalize_accent(Some(&json!("rgb(0,0,0)"))), "");
    }

    #[test]
    fn font_family_cannot_escape_its_declaration() {
        assert_eq!(
            normalize_font_family(Some(&json!("  \"MiSans\",   sans-serif "))),
            "\"MiSans\", sans-serif"
        );
        for bad in [
            "a; } body { display: none",
            "x{",
            "url (http://x)",
            "\"unclosed",
            "a\\b",
            "</style>",
        ] {
            assert_eq!(normalize_font_family(Some(&json!(bad))), "", "{bad}");
        }
        assert_eq!(normalize_font_family(Some(&json!("a".repeat(201)))), "");
    }

    #[test]
    fn custom_css_is_capped_at_the_shared_limit() {
        let long = "a".repeat(MAX_CUSTOM_CSS_LENGTH + 10);
        assert_eq!(
            normalize_custom_css(Some(&json!(long))).len(),
            MAX_CUSTOM_CSS_LENGTH
        );
        // A non-BMP character counts as two units, as in JavaScript.
        let emoji = "😀".repeat(MAX_CUSTOM_CSS_LENGTH);
        assert_eq!(
            normalize_custom_css(Some(&json!(emoji))).chars().count(),
            MAX_CUSTOM_CSS_LENGTH / 2
        );
    }

    #[test]
    fn set_merges_patch_and_persists_normalized_values() {
        let dir = tempfile::tempdir().unwrap();
        let store = UiStyleStore::new(Some(dir.path()));
        assert_eq!(store.get(), UiStyle::default());
        let patch = json!({"accent": "#E0443E", "fontScale": "large", "unknown": 1});
        let saved = store.set(patch.as_object().unwrap()).unwrap();
        assert_eq!(saved.accent, "#e0443e");
        assert_eq!(saved.font_scale, "large");
        let patch = json!({"customCss": ".x{}", "customCssEnabled": true});
        let saved = store.set(patch.as_object().unwrap()).unwrap();
        assert_eq!(saved.accent, "#e0443e");
        assert!(saved.custom_css_enabled);
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(UI_STYLE_FILE)).unwrap())
                .unwrap();
        assert_eq!(on_disk["customCss"], ".x{}");
        assert_eq!(on_disk["fontScale"], "large");
        assert!(on_disk.get("unknown").is_none());
        assert_eq!(UiStyleStore::new(Some(dir.path())).get(), saved);
    }

    #[test]
    fn dev_store_keeps_values_in_memory() {
        let store = UiStyleStore::new(None);
        let patch = json!({"fontFamily": "Inter"});
        store.set(patch.as_object().unwrap()).unwrap();
        assert_eq!(store.get().font_family, "Inter");
    }
}
