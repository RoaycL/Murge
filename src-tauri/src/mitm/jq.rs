//! jq body rewrites (`http-response-jq`, Loon `response-body-json-jq`), run
//! with jaq, a pure-Rust jq implementation. Compiled filters hold `Rc`s, so
//! they are cached per thread instead of being stored in the shared rules.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Ctx, Native, RcIter};
use jaq_json::Val;

type Filter = jaq_core::Filter<Native<Val>>;

const CACHE_LIMIT: usize = 256;

thread_local! {
    static CACHE: RefCell<HashMap<String, Rc<Filter>>> = RefCell::new(HashMap::new());
}

fn compile(code: &str) -> Result<Filter, String> {
    let loader = Loader::new(jaq_std::defs().chain(jaq_json::defs()));
    let arena = Arena::default();
    let modules = loader
        .load(&arena, File { code, path: () })
        .map_err(|errors| format!("jq 语法错误：{}", describe(&errors)))?;
    jaq_core::Compiler::default()
        .with_funs(jaq_std::funs().chain(jaq_json::funs()))
        .compile(modules)
        .map_err(|errors| format!("jq 编译失败：{}", describe(&errors)))
}

fn describe<T: std::fmt::Debug>(errors: &T) -> String {
    let text = format!("{errors:?}");
    text.chars().take(200).collect()
}

fn cached(code: &str) -> Result<Rc<Filter>, String> {
    CACHE.with(|cache| {
        if let Some(filter) = cache.borrow().get(code) {
            return Ok(filter.clone());
        }
        let filter = Rc::new(compile(code)?);
        let mut cache = cache.borrow_mut();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(code.to_string(), filter.clone());
        Ok(filter)
    })
}

/// Check a filter at parse time so a broken rule surfaces as a module warning.
pub fn validate(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("缺少 jq 表达式".into());
    }
    cached(code).map(|_| ())
}

/// Run `code` on a JSON body. Like Surge, the first output replaces the body;
/// a non-JSON body, a runtime error or no output leaves the body unchanged.
pub fn apply(code: &str, body: &str) -> Option<String> {
    use hifijson::token::Lex;
    // jaq's own parser keeps object key order (serde_json would sort keys).
    let input = hifijson::SliceLexer::new(body.as_bytes())
        .exactly_one(Val::parse)
        .ok()?;
    let filter = cached(code).ok()?;
    let inputs = RcIter::new(core::iter::empty());
    let mut out = filter.run((Ctx::new([], &inputs), input));
    let value = out.next()?.ok()?;
    Some(value.to_string())
}

/// Strip one pair of surrounding single or double quotes from a filter.
pub fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    for quote in ['\'', '"'] {
        if raw.len() >= 2 && raw.starts_with(quote) && raw.ends_with(quote) {
            return raw[1..raw.len() - 1].to_string();
        }
    }
    raw.to_string()
}

/// The raw text after the first `skip` whitespace-separated tokens, so that
/// quotes and spaces inside the jq expression survive.
pub fn tail_after_tokens(line: &str, skip: usize) -> &str {
    let mut rest = line.trim_start();
    for _ in 0..skip {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest = rest[end..].trim_start();
    }
    rest.trim_end()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jq_deletes_and_updates_fields() {
        let body = r#"{"data":{"ads":[1,2],"vip":false,"items":[{"ad":true},{"ad":false}]}}"#;
        let out = apply(
            r#"del(.data.ads) | .data.vip = true | .data.items |= map(select(.ad != true))"#,
            body,
        )
        .unwrap();
        // jaq may reorder keys after `del`; JSON objects are unordered.
        let out: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            out,
            serde_json::json!({"data":{"vip":true,"items":[{"ad":false}]}})
        );
    }

    #[test]
    fn jq_leaves_non_json_and_errors_alone() {
        assert!(apply(".a", "not json").is_none());
        assert!(apply("error(\"x\")", "{}").is_none());
        assert!(apply("empty", "{}").is_none());
        assert!(validate("del(.a").is_err());
        assert!(validate("").is_err());
        assert!(validate(r#".a |= ascii_downcase | tostring | test("x")"#).is_ok());
    }

    #[test]
    fn raw_tail_keeps_quotes_and_spaces() {
        let line = r#"http-response-jq ^https://a\.com 'select(.a == "x y")'"#;
        assert_eq!(
            unquote(tail_after_tokens(line, 2)),
            r#"select(.a == "x y")"#
        );
    }
}
