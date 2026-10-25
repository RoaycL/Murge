//! YAML <-> object model used for every subscription document the app
//! transforms (runtime kernel config, TUN profile, overrides, DNS/sniffer
//! enhancements, live reload).
//!
//! It mirrors what the Electron build gets from the `yaml` package
//! (`parseDocument(text, { merge: true, uniqueKeys: true }).toJS()` and
//! `stringify`), so both builds hand mihomo the same values:
//! - YAML 1.2 core schema for plain scalars (`yes`/`on` stay strings, `0x1F`
//!   and `0o17` are integers, `Null`/`~`/empty are null) and the standard
//!   `!!str`/`!!int`/`!!float`/`!!bool`/`!!null` tags;
//! - anchors and aliases are expanded, merge keys (`<<: *a`, `<<: [*a, *b]`)
//!   resolve with explicit keys winning and earlier merge sources winning;
//! - duplicate keys are rejected, a leading BOM is ignored, and only the first
//!   document is read (mihomo itself ignores any later one).
//!
//! The emitter writes block YAML and, like the `yaml` package, quotes a string
//! only when the core schema would read the plain form as something else.
//! YAML 1.1 boolean words (`yes`, `on`, ...) stay plain on purpose: mihomo's
//! go-yaml still accepts them for boolean fields, and a quoted `"yes"` would
//! fail to decode there. JSON has no infinity/NaN, so `.inf`/`.nan` are held
//! as strings and written back plain, which mihomo reads as the float again.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

const MERGE_KEY: &str = "<<";

/// Parse the first YAML document into a value. `Err` carries a short reason.
pub fn parse_value(text: &str) -> Result<Value, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut builder = Builder::default();
    let mut parser = Parser::new_from_str(text);
    parser
        .load(&mut builder, false)
        .map_err(|error| error.to_string())?;
    if let Some(error) = builder.error {
        return Err(error);
    }
    Ok(builder.root.unwrap_or(Value::Null))
}

/// Parse the first YAML document, requiring a top-level mapping.
pub fn parse_object(text: &str) -> Option<Map<String, Value>> {
    match parse_value(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `YamlLoader::load_from_str` drop-in for readers written against
/// yaml-rust2's tree: same parse rules as [`parse_value`], one document.
pub fn load_as_yaml(text: &str) -> Result<Vec<yaml_rust2::Yaml>, String> {
    parse_value(text).map(|value| vec![value_to_yaml(value)])
}

fn value_to_yaml(value: Value) -> yaml_rust2::Yaml {
    use yaml_rust2::Yaml;
    match value {
        Value::Null => Yaml::Null,
        Value::Bool(b) => Yaml::Boolean(b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Yaml::Integer(i),
            None => Yaml::Real(n.to_string()),
        },
        Value::String(s) => Yaml::String(s),
        Value::Array(items) => Yaml::Array(items.into_iter().map(value_to_yaml).collect()),
        Value::Object(map) => Yaml::Hash(
            map.into_iter()
                .map(|(key, value)| (Yaml::String(key), value_to_yaml(value)))
                .collect(),
        ),
    }
}

/// Serialize a value as block YAML.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    match value {
        Value::Object(map) if !map.is_empty() => emit_map(&mut out, map, 0),
        Value::Array(items) if !items.is_empty() => emit_seq(&mut out, items, 0),
        other => {
            out.push_str(&scalar_repr(other));
            out.push('\n');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

enum Frame {
    Seq {
        items: Vec<Value>,
        anchor: usize,
    },
    Map {
        entries: Vec<(Option<String>, Value, bool)>,
        pending: Option<(Option<String>, bool)>,
        anchor: usize,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: HashMap<usize, Value>,
    root: Option<Value>,
    error: Option<String>,
}

impl Builder {
    fn fail(&mut self, message: String) {
        if self.error.is_none() {
            self.error = Some(message);
        }
    }

    /// `key` is the text form of a scalar key plus whether it is a merge key;
    /// it is only consulted when the value lands in a mapping key slot.
    fn complete(&mut self, value: Value, anchor: usize, key: Option<(String, bool)>) {
        if anchor > 0 {
            self.anchors.insert(anchor, value.clone());
        }
        match self.stack.last_mut() {
            None => {
                if self.root.is_none() {
                    self.root = Some(value);
                }
            }
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map {
                entries, pending, ..
            }) => match pending.take() {
                Some((name, merge)) => entries.push((name, value, merge)),
                None => {
                    // Non-scalar keys have no JSON form; the entry is dropped
                    // like the `yaml` package does for composite keys in toJS.
                    let (name, merge) = match key {
                        Some((name, merge)) => (Some(name), merge),
                        None => (key_text(&value), false),
                    };
                    *pending = Some((name, merge));
                }
            },
        }
    }

    fn finish_map(&mut self, entries: Vec<(Option<String>, Value, bool)>) -> Value {
        let mut explicit = HashSet::new();
        for (name, _, merge) in &entries {
            if *merge {
                continue;
            }
            if let Some(name) = name {
                if !explicit.insert(name.clone()) {
                    self.fail(format!("duplicate mapping key: {name}"));
                }
            }
        }
        let mut object = Map::new();
        for (name, value, merge) in entries {
            if merge {
                let sources = match value {
                    Value::Object(_) => vec![value],
                    Value::Array(items) if items.iter().all(Value::is_object) => items,
                    other => {
                        // Not a mapping: keep it as an ordinary key.
                        object.insert(MERGE_KEY.into(), other);
                        continue;
                    }
                };
                for source in sources {
                    if let Value::Object(fields) = source {
                        for (field, field_value) in fields {
                            if !explicit.contains(&field) && !object.contains_key(&field) {
                                object.insert(field, field_value);
                            }
                        }
                    }
                }
                continue;
            }
            if let Some(name) = name {
                object.insert(name, value);
            }
        }
        Value::Object(object)
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, event: Event, _mark: Marker) {
        match event {
            Event::Scalar(raw, style, anchor, tag) => {
                let plain = style == TScalarStyle::Plain;
                let core_tag = tag.as_ref().and_then(core_tag_name);
                let value = match core_tag {
                    Some("str") => Value::String(raw.clone()),
                    Some("null") => Value::Null,
                    Some("float") => match resolve_plain(&raw) {
                        Value::Number(n) => n
                            .as_f64()
                            .and_then(Number::from_f64)
                            .map(Value::Number)
                            .unwrap_or(Value::Number(n)),
                        other => other,
                    },
                    Some("bool" | "int") => resolve_plain(&raw),
                    _ if plain => resolve_plain(&raw),
                    _ => Value::String(raw.clone()),
                };
                let merge = raw == MERGE_KEY && core_tag != Some("str");
                let key = key_text(&value).map(|name| (name, merge));
                self.complete(value, anchor, key);
            }
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(value) => self.complete(value, 0, None),
                None => self.fail("unknown YAML anchor".into()),
            },
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq {
                items: Vec::new(),
                anchor,
            }),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                entries: Vec::new(),
                pending: None,
                anchor,
            }),
            Event::SequenceEnd | Event::MappingEnd => match self.stack.pop() {
                Some(Frame::Seq { items, anchor }) => {
                    self.complete(Value::Array(items), anchor, None)
                }
                Some(Frame::Map {
                    mut entries,
                    pending,
                    anchor,
                }) => {
                    // `key:` followed by nothing more in the mapping.
                    if let Some((name, merge)) = pending {
                        entries.push((name, Value::Null, merge));
                    }
                    let value = self.finish_map(entries);
                    self.complete(value, anchor, None);
                }
                None => {}
            },
            _ => {}
        }
    }
}

fn core_tag_name(tag: &Tag) -> Option<&str> {
    if tag.handle == "tag:yaml.org,2002:" || tag.handle == "!!" {
        Some(tag.suffix.as_str())
    } else {
        None
    }
}

/// Map keys follow the `yaml` package's toJS: scalars become their text,
/// null becomes the empty string, composite keys have no form.
fn key_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn is_float_syntax(s: &str) -> bool {
    let body = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some((int, frac)) => {
            int.bytes().all(|b| b.is_ascii_digit())
                && frac.bytes().all(|b| b.is_ascii_digit())
                && !(int.is_empty() && frac.is_empty())
        }
        None => !mantissa.is_empty() && mantissa.bytes().all(|b| b.is_ascii_digit()),
    };
    let exponent_ok = match exponent {
        None => true,
        Some(exp) => {
            let digits = exp.strip_prefix(['-', '+']).unwrap_or(exp);
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        }
    };
    mantissa_ok && exponent_ok
}

/// YAML 1.2 core schema resolution of a plain scalar.
fn resolve_plain(s: &str) -> Value {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    let digits = s.strip_prefix(['-', '+']).unwrap_or(s);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(int) = s.parse::<i64>() {
            return Value::Number(int.into());
        }
        if let Ok(uint) = s.trim_start_matches('+').parse::<u64>() {
            return Value::Number(uint.into());
        }
    }
    let radix = |prefix: &str, radix: u32| {
        s.strip_prefix(prefix)
            .filter(|rest| !rest.is_empty())
            .and_then(|rest| i64::from_str_radix(rest, radix).ok())
    };
    if let Some(int) = radix("0x", 16).or_else(|| radix("0o", 8)) {
        return Value::Number(int.into());
    }
    if is_float_syntax(s) {
        if let Some(number) = s.parse::<f64>().ok().and_then(Number::from_f64) {
            return Value::Number(number);
        }
    }
    Value::String(s.to_string())
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

fn emit_map(out: &mut String, map: &Map<String, Value>, indent: usize) {
    for (key, value) in map {
        push_indent(out, indent);
        out.push_str(&string_repr(key));
        out.push(':');
        emit_child(out, value, indent + 2, true);
    }
}

fn emit_seq(out: &mut String, items: &[Value], indent: usize) {
    for item in items {
        push_indent(out, indent);
        out.push('-');
        emit_child(out, item, indent + 2, false);
    }
}

/// Emits `value` after a `key:` or `-` that is already written. Nested
/// mappings under a key start on the next line; under `-` they continue on
/// the same line (`- name: a`). Sequences under a key are indented by two.
fn emit_child(out: &mut String, value: &Value, indent: usize, under_key: bool) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            if under_key {
                out.push('\n');
                emit_map(out, map, indent);
            } else {
                let mut nested = String::new();
                emit_map(&mut nested, map, indent);
                out.push(' ');
                out.push_str(&nested[indent..]);
            }
        }
        Value::Array(items) if !items.is_empty() => {
            if under_key {
                out.push('\n');
                emit_seq(out, items, indent);
            } else {
                let mut nested = String::new();
                emit_seq(&mut nested, items, indent);
                out.push(' ');
                out.push_str(&nested[indent..]);
            }
        }
        scalar => {
            out.push(' ');
            out.push_str(&scalar_repr(scalar));
            out.push('\n');
        }
    }
}

fn push_indent(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

fn scalar_repr(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => string_repr(s),
        Value::Object(_) => "{}".into(),
        Value::Array(_) => "[]".into(),
    }
}

/// YAML 1.1 boolean words: strings under the core schema, but go-yaml (and
/// therefore mihomo) still decodes the PLAIN form into boolean fields.
const LEGACY_BOOL_WORDS: [&str; 16] = [
    "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "on", "On", "ON", "off", "Off",
    "OFF",
];

fn string_repr(s: &str) -> String {
    if LEGACY_BOOL_WORDS.contains(&s) || !needs_quotes(s) {
        return s.to_string();
    }
    let mut quoted = String::with_capacity(s.len() + 2);
    quoted.push('"');
    for c in s.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}') => {
                quoted.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// Whether the plain form would read back as something other than this
/// string under the core schema, or would not parse as a plain scalar.
/// Forms only go-yaml treats specially (`1_000`, `0b101`, timestamps, `.inf`)
/// stay plain exactly like the `yaml` package's output, so mihomo reads them
/// the same way from either build (and the same way as the original file).
fn needs_quotes(s: &str) -> bool {
    if s.is_empty() || s == MERGE_KEY || s.starts_with("...") {
        return true;
    }
    if !matches!(resolve_plain(s), Value::String(_)) {
        return true;
    }
    let first = s.chars().next().unwrap_or(' ');
    let last = s.chars().last().unwrap_or(' ');
    // `-x` is a valid plain scalar (`-.inf`, `-foo`); `- x` and `---` are not.
    let dash_ok = first == '-'
        && !s.starts_with("---")
        && s.chars().nth(1).is_some_and(|c| !c.is_whitespace());
    if ("-?:,[]{}#&*!|>'\"%@`".contains(first) && !dash_ok)
        || first.is_whitespace()
        || last.is_whitespace()
    {
        return true;
    }
    if last == ':'
        || s.contains(": ")
        || s.contains(" #")
        || s.chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{85}'))
    {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(text: &str) -> Value {
        parse_value(text).unwrap()
    }

    #[test]
    fn plain_scalars_follow_the_core_schema() {
        let data = parse(
            "a: yes\nb: True\nc: Null\nd: ~\ne:\nf: 0x1F\ng: 0o17\nh: 017\ni: 1_000\nj: 1e3\nk: 1.5\nl: \"08\"\nm: 9223372036854775807\nn: 2001-12-14\n",
        );
        assert_eq!(
            data,
            json!({
                "a": "yes", "b": true, "c": null, "d": null, "e": null, "f": 31, "g": 15,
                "h": 17, "i": "1_000", "j": 1000.0, "k": 1.5, "l": "08",
                "m": 9223372036854775807i64, "n": "2001-12-14"
            })
        );
    }

    #[test]
    fn core_tags_are_applied() {
        let data =
            parse("a: !!str 123\nb: !!int \"5\"\nc: !!bool \"true\"\nd: !!null x\ne: !custom v\n");
        assert_eq!(
            data,
            json!({"a": "123", "b": 5, "c": true, "d": null, "e": "v"})
        );
    }

    #[test]
    fn merge_keys_aliases_and_bom_resolve() {
        let text = "\u{feff}a: &a {x: 1, y: 2}\nb: &b {y: 3, z: 4}\nl: &l [p, q]\none:\n  <<: *a\n  y: 9\nmany:\n  <<: [*a, *b]\nlist: *l\n";
        let data = parse(text);
        assert_eq!(data["one"], json!({"x": 1, "y": 9}));
        assert_eq!(data["many"], json!({"x": 1, "y": 2, "z": 4}));
        assert_eq!(data["list"], json!(["p", "q"]));
        assert!(data.get("a").is_some());
    }

    #[test]
    fn duplicate_keys_are_rejected_and_only_the_first_document_is_read() {
        assert!(parse_value("a: 1\na: 2\n").is_err());
        assert_eq!(parse("a: 1\n---\na: 2\n"), json!({"a": 1}));
    }

    #[test]
    fn strings_round_trip_with_their_type() {
        let original = json!({
            "bools": ["yes", "no", "on", "off", "y", "N"],
            "numbers": ["08", "1_000", "0b101", "0x1F", "1e3", ".5", "+1", "-0", "1.0", "true", "null", "~", ""],
            "dates": ["2001-12-14", "2001-12-14t21:59:43.10-05:00"],
            "syntax": [
                "a#b", "c #d", "a: b", "end:", "- dash", "*star", "&amp", "!bang", "%pct", "@at",
                "`tick", "{brace}", "[bracket]", "'single'", "\"double\"", "-plain", "-", "-.Inf", " lead", "trail ",
                "line\nbreak", "tab\there", "back\\slash", "<<", "...", "---", ".inf", "-.Inf"
            ],
            "plain": ["https://a.example/b?c=d#e", "DOMAIN-SUFFIX,a.com,Proxy", "198.18.0.1/16", "(?i)港|HK", "🇭🇰 香港", "1.2.3.4"],
            "🇭🇰 key": {"nested": [{"a": 1, "b": [1, [2, 3]]}, [], {}]},
            "numbers2": [1, -2, 1.5, 18446744073709551615u64],
            "null": null,
            "bool": false
        });
        let text = stringify(&original);
        assert_eq!(parse(&text), original, "{text}");
        assert!(text.contains("- yes\n"), "{text}");
        assert!(text.contains("- 198.18.0.1/16\n"), "{text}");
        assert!(text.contains("- 1_000\n"), "{text}");
    }
}
