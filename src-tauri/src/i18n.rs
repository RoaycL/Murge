//! Interface language for text the shell itself draws: the tray menu (native
//! and popup), the tooltip and system notifications. The window's own text
//! lives in the renderer (`src/shared/i18n`).
//!
//! Messages are flat `namespace.name` keys in `locales/<locale>.json`;
//! `zh-CN` is the source language and every locale carries the same keys.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    ZhCn,
    En,
}

const ZH_CN: &str = include_str!("../locales/zh-CN.json");
const EN: &str = include_str!("../locales/en.json");

type Messages = HashMap<String, String>;

fn parse(document: &str) -> Messages {
    serde_json::from_str(document).expect("locale file is a flat string map")
}

fn messages(locale: Locale) -> &'static Messages {
    static TABLES: OnceLock<(Messages, Messages)> = OnceLock::new();
    let tables = TABLES.get_or_init(|| (parse(ZH_CN), parse(EN)));
    match locale {
        Locale::ZhCn => &tables.0,
        Locale::En => &tables.1,
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn current() -> Locale {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Locale::En,
        _ => Locale::ZhCn,
    }
}

fn set_current(locale: Locale) {
    CURRENT.store(
        match locale {
            Locale::ZhCn => 0,
            Locale::En => 1,
        },
        Ordering::Relaxed,
    );
}

/// Map a BCP 47 / POSIX tag (`zh-Hans-CN`, `en_GB.UTF-8`) to a shipped locale.
pub fn match_locale(tag: &str) -> Option<Locale> {
    let lower = tag.trim().to_ascii_lowercase();
    let primary = lower.split(['-', '_', '.']).next().unwrap_or_default();
    match primary {
        "zh" => Some(Locale::ZhCn),
        "en" => Some(Locale::En),
        _ => None,
    }
}

/// The persisted `AppSettings.language` resolved against the system language
/// (`system_tag`): "system" takes the system language when we ship it and
/// English otherwise; with no system language known the source language.
pub fn resolve(setting: &str, system_tag: Option<&str>) -> Locale {
    match setting {
        "zh-CN" => Locale::ZhCn,
        "en" => Locale::En,
        _ => match system_tag {
            Some(tag) if !tag.trim().is_empty() => match_locale(tag).unwrap_or(Locale::En),
            _ => Locale::ZhCn,
        },
    }
}

/// The Windows display language (what the shell and WebView2 follow).
#[cfg(windows)]
fn system_tag() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    // Primary language id: the low 10 bits of the LANGID.
    let primary = unsafe { GetUserDefaultUILanguage() } & 0x3ff;
    Some(
        match primary {
            0x04 => "zh",
            0x09 => "en",
            _ => "und",
        }
        .to_string(),
    )
}

#[cfg(not(windows))]
fn system_tag() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| {
            let primary = value.split(['.', '_', '-']).next().unwrap_or_default();
            !primary.is_empty() && primary != "C" && primary != "POSIX"
        })
}

type Listener = Box<dyn Fn() + Send + Sync>;

fn listeners() -> &'static Mutex<Vec<Listener>> {
    static LISTENERS: OnceLock<Mutex<Vec<Listener>>> = OnceLock::new();
    LISTENERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Run `listener` whenever the language in effect changes (the tray redraws
/// its menu and tooltip).
pub fn on_change(listener: impl Fn() + Send + Sync + 'static) {
    listeners()
        .lock()
        .expect("i18n listeners mutex")
        .push(Box::new(listener));
}

/// Apply the persisted language preference; returns whether the language in
/// effect changed.
pub fn apply_setting(setting: &str) -> bool {
    // Unit tests share one process and assert on source-language text.
    if cfg!(test) {
        return false;
    }
    let next = resolve(setting, system_tag().as_deref());
    let changed = next != current();
    set_current(next);
    if changed {
        for listener in listeners().lock().expect("i18n listeners mutex").iter() {
            listener();
        }
    }
    changed
}

/// Message for `key` in `locale`, falling back to the source language and
/// then to the key itself.
pub fn translate(locale: Locale, key: &str) -> &'static str {
    messages(locale)
        .get(key)
        .or_else(|| messages(Locale::ZhCn).get(key))
        .map(String::as_str)
        .unwrap_or("")
}

/// Message for `key` in the current language.
pub fn t(key: &str) -> &'static str {
    translate(current(), key)
}

/// `t` with `{0}`, `{1}`… filled from `args`.
pub fn tf(key: &str, args: &[&str]) -> String {
    let mut text = t(key).to_string();
    for (index, value) in args.iter().enumerate() {
        text = text.replace(&format!("{{{index}}}"), value);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_locale_carries_the_same_keys() {
        let mut zh: Vec<&String> = messages(Locale::ZhCn).keys().collect();
        let mut en: Vec<&String> = messages(Locale::En).keys().collect();
        zh.sort();
        en.sort();
        assert_eq!(zh, en);
    }

    #[test]
    fn placeholders_match_between_locales() {
        let placeholders = |text: &str| -> Vec<String> {
            let mut found: Vec<String> = regex::Regex::new(r"\{\d+\}")
                .unwrap()
                .find_iter(text)
                .map(|m| m.as_str().to_string())
                .collect();
            found.sort();
            found
        };
        for (key, zh) in messages(Locale::ZhCn) {
            assert_eq!(
                placeholders(zh),
                placeholders(translate(Locale::En, key)),
                "{key}"
            );
        }
    }

    #[test]
    fn resolves_the_setting_against_the_system_language() {
        assert_eq!(resolve("zh-CN", Some("en-US")), Locale::ZhCn);
        assert_eq!(resolve("en", Some("zh-CN")), Locale::En);
        assert_eq!(resolve("system", Some("zh-Hans-CN")), Locale::ZhCn);
        assert_eq!(resolve("system", Some("zh_TW.UTF-8")), Locale::ZhCn);
        assert_eq!(resolve("system", Some("en-GB")), Locale::En);
        assert_eq!(resolve("system", Some("ja-JP")), Locale::En);
        assert_eq!(resolve("system", None), Locale::ZhCn);
        assert_eq!(resolve("garbage", Some("fr")), Locale::En);
    }

    #[test]
    fn translates_with_fallback_and_arguments() {
        assert_eq!(translate(Locale::En, "tray.show"), "Show main window");
        assert_eq!(translate(Locale::ZhCn, "tray.show"), "显示主窗口");
        assert_eq!(translate(Locale::En, "no.such.key"), "");
        // Tests run with the source language in effect.
        assert_eq!(tf("tray.modulesEnabled", &["1", "2"]), "模块 · 1/2 已启用");
    }
}
