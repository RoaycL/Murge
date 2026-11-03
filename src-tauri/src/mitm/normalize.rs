//! Turn every supported module flavour into Surge module text before parsing,
//! and collect its user-editable arguments.
//!
//! - Surge `.sgmodule`: `#!arguments` / `#!arguments-desc` (spaces around
//!   `=` allowed, as DualSubs and many others write them).
//! - Loon `.plugin`: the `[Argument]` section (input / select / switch) and
//!   `argument=[{Name},…]` script arguments; Loon scripts receive `$argument`
//!   as an object, so those scripts are flagged `x-murge-argument-object`.
//! - Stash `.stoverride` (YAML): `http.mitm`, `http.rewrite` / `url-rewrite`,
//!   `http.header-rewrite`, `http.script` + `script-providers`, `rules`.
//! - Egern `.yaml`: `compat_arguments(_desc)`, `mitm.hostnames`, `rules`,
//!   `map_locals`, `scriptings`, `url_rewrites`.
//! - Quantumult X `.snippet`: already handled by the Surge parser.

use yaml_rust2::{Yaml, YamlLoader};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgumentMeta {
    pub name: String,
    /// `input`, `select` or `switch`.
    pub kind: String,
    /// The choices of a `select`.
    pub options: Vec<String>,
    /// Short label (Loon `tag=`).
    pub tag: String,
    /// Longer help (Loon `desc=`).
    pub desc: String,
}

#[derive(Debug, Clone, Default)]
pub struct Normalized {
    /// Surge module text.
    pub text: String,
    /// Declared arguments in order: (name, default).
    pub arguments: Vec<(String, String)>,
    /// `#!arguments-desc` with real newlines.
    pub arguments_desc: String,
    pub meta: Vec<ArgumentMeta>,
}

/// Script option the Loon conversion adds: hand `$argument` to the script as
/// an object (`{Name: value}`) instead of Surge's query string.
pub const ARGUMENT_OBJECT_KEY: &str = "x-murge-argument-object";

pub fn normalize(text: &str) -> Normalized {
    let surge = if looks_like_yaml(text) {
        convert_yaml(text).unwrap_or_else(|| text.to_string())
    } else {
        text.to_string()
    };
    let (surge, loon_meta) = convert_loon_arguments(&surge);
    let arguments = meta_value(&surge, "arguments")
        .map(|value| super::compat::parse_arguments(&value))
        .unwrap_or_default();
    let arguments_desc = meta_value(&surge, "arguments-desc")
        .map(|value| value.replace("\\n", "\n"))
        .unwrap_or_default();
    let meta = arguments
        .iter()
        .map(|(name, default)| {
            loon_meta
                .iter()
                .find(|meta| &meta.name == name)
                .cloned()
                .unwrap_or_else(|| ArgumentMeta {
                    name: name.clone(),
                    kind: if matches!(unquote(default).as_str(), "true" | "false") {
                        "switch".into()
                    } else {
                        "input".into()
                    },
                    options: Vec::new(),
                    tag: String::new(),
                    desc: String::new(),
                })
        })
        .collect();
    Normalized {
        text: surge,
        arguments,
        arguments_desc,
        meta,
    }
}

/// `#!key = value` / `#!key=value` (first match).
fn meta_value(text: &str, wanted: &str) -> Option<String> {
    text.lines().map(str::trim).find_map(|line| {
        let meta = line.strip_prefix("#!")?;
        let (key, value) = meta.split_once('=')?;
        (key.trim() == wanted).then(|| value.trim().to_string())
    })
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
        .to_string()
}

// ---------------------------------------------------------------------------
// Loon [Argument]
// ---------------------------------------------------------------------------

/// Split on commas outside double quotes.
fn split_top(value: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in value.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ',' if !quoted => items.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    items.push(current);
    items
}

fn parse_loon_argument(line: &str) -> Option<(ArgumentMeta, String)> {
    let (name, rest) = line.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut parts = split_top(rest).into_iter().map(|p| p.trim().to_string());
    let kind = parts.next()?.to_ascii_lowercase();
    let mut values = Vec::new();
    let mut tag = String::new();
    let mut desc = String::new();
    for part in parts {
        if let Some(value) = part.strip_prefix("tag=") {
            tag = unquote(value);
        } else if let Some(value) = part.strip_prefix("desc=") {
            desc = unquote(value);
        } else {
            values.push(unquote(&part));
        }
    }
    let kind = match kind.as_str() {
        "select" | "switch" => kind,
        _ => "input".to_string(),
    };
    let default = values.first().cloned().unwrap_or_default();
    let options = if kind == "select" { values } else { Vec::new() };
    Some((
        ArgumentMeta {
            name: name.to_string(),
            kind,
            options,
            tag,
            desc,
        },
        default,
    ))
}

/// Loon `[Argument]` → `#!arguments` / `#!arguments-desc`, and its
/// `argument=[{A},{B}]` script options → Surge `{{{A}}}` substitutions.
fn convert_loon_arguments(text: &str) -> (String, Vec<ArgumentMeta>) {
    let mut metas: Vec<(ArgumentMeta, String)> = Vec::new();
    let mut in_section = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_section = line[1..line.len() - 1]
                .trim()
                .eq_ignore_ascii_case("argument");
            continue;
        }
        if in_section && !line.is_empty() && !line.starts_with('#') {
            if let Some(parsed) = parse_loon_argument(line) {
                metas.push(parsed);
            }
        }
    }
    if metas.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let pattern = regex::Regex::new(r"argument\s*=\s*\[([^\]]*)\]").expect("loon argument regex");
    let names: Vec<String> = metas.iter().map(|(meta, _)| meta.name.clone()).collect();
    let mut body = String::new();
    for raw in text.lines() {
        let line = pattern.replace_all(raw, |caps: &regex::Captures| {
            let mut pairs = Vec::new();
            for (index, item) in caps[1].split(',').enumerate() {
                let item = item.trim();
                let token = item.strip_prefix('{').and_then(|v| v.strip_suffix('}'));
                match token {
                    Some(name) if names.iter().any(|n| n == name) => {
                        pairs.push(format!("{name}=\"{{{{{{{name}}}}}}}\""))
                    }
                    _ => pairs.push(format!("arg{index}=\"{}\"", unquote(item))),
                }
            }
            format!("argument={}, {ARGUMENT_OBJECT_KEY}=1", pairs.join("&"))
        });
        body.push_str(&line);
        body.push('\n');
    }
    let mut header = String::new();
    if meta_value(text, "arguments").is_none() {
        let declared: Vec<String> = metas
            .iter()
            .map(|(meta, default)| format!("{}:\"{}\"", meta.name, default.replace('"', "")))
            .collect();
        header.push_str(&format!("#!arguments={}\n", declared.join(",")));
        if meta_value(text, "arguments-desc").is_none() {
            let desc: Vec<String> = metas
                .iter()
                .filter(|(meta, _)| !meta.tag.is_empty() || !meta.desc.is_empty())
                .map(|(meta, _)| {
                    format!("{}: {}\\n{}", meta.name, meta.tag, meta.desc)
                        .trim_end_matches("\\n")
                        .to_string()
                })
                .collect();
            if !desc.is_empty() {
                header.push_str(&format!("#!arguments-desc={}\n", desc.join("\\n\\n")));
            }
        }
    }
    (
        format!("{header}{body}"),
        metas.into_iter().map(|(meta, _)| meta).collect(),
    )
}

// ---------------------------------------------------------------------------
// Stash / Egern YAML
// ---------------------------------------------------------------------------

fn looks_like_yaml(text: &str) -> bool {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'));
    let Some(first) = first else { return false };
    if first.starts_with('[') || first.contains(" = ") {
        return false;
    }
    let key = regex::Regex::new(r"^[A-Za-z_][\w-]*:(\s|$)").expect("yaml key regex");
    key.is_match(first)
}

fn s(yaml: &Yaml) -> Option<String> {
    match yaml {
        Yaml::String(v) | Yaml::Real(v) => Some(v.clone()),
        Yaml::Integer(v) => Some(v.to_string()),
        Yaml::Boolean(v) => Some(v.to_string()),
        _ => None,
    }
}

fn truthy(yaml: &Yaml) -> bool {
    match yaml {
        Yaml::Boolean(v) => *v,
        Yaml::Integer(v) => *v != 0,
        Yaml::String(v) => matches!(v.as_str(), "true" | "1" | "yes"),
        _ => false,
    }
}

fn list(yaml: &Yaml) -> Vec<&Yaml> {
    match yaml {
        Yaml::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn surge_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

#[derive(Default)]
struct Out {
    meta: Vec<String>,
    mitm: Vec<String>,
    url: Vec<String>,
    header: Vec<String>,
    map: Vec<String>,
    script: Vec<String>,
    rule: Vec<String>,
}

impl Out {
    fn render(self) -> String {
        let mut text = self.meta.join("\n");
        text.push('\n');
        for (name, lines) in [
            ("Rule", self.rule),
            ("URL Rewrite", self.url),
            ("Header Rewrite", self.header),
            ("Map Local", self.map),
            ("Script", self.script),
        ] {
            if !lines.is_empty() {
                text.push_str(&format!("\n[{name}]\n{}\n", lines.join("\n")));
            }
        }
        if !self.mitm.is_empty() {
            text.push_str(&format!(
                "\n[MITM]\nhostname = %APPEND% {}\n",
                self.mitm.join(", ")
            ));
        }
        text
    }
}

#[allow(clippy::too_many_arguments)]
fn script_line(
    name: &str,
    phase: &str,
    pattern: &str,
    path: &str,
    requires_body: bool,
    binary: bool,
    max_size: Option<String>,
    timeout: Option<String>,
    argument: Option<String>,
) -> String {
    let mut line = format!("{name} = type=http-{phase},pattern={pattern}");
    if requires_body {
        line.push_str(",requires-body=1");
    }
    if binary {
        line.push_str(",binary-body-mode=1");
    }
    if let Some(size) = max_size {
        line.push_str(&format!(",max-size={size}"));
    }
    if let Some(timeout) = timeout {
        line.push_str(&format!(",timeout={timeout}"));
    }
    line.push_str(&format!(",script-path={path}"));
    if let Some(argument) = argument.filter(|a| !a.is_empty()) {
        line.push_str(&format!(",argument={argument}"));
    }
    line
}

/// Egern/Stash rule maps (`{domain_suffix: {match, policy}}`) and Stash rule
/// strings → Surge `[Rule]` lines, or a URL reject for `url_regex`.
fn convert_rule(rule: &Yaml, out: &mut Out) {
    if let Some(line) = s(rule) {
        out.rule.push(line);
        return;
    }
    let Yaml::Hash(map) = rule else { return };
    for (kind, body) in map {
        let Some(kind) = s(kind) else { continue };
        let pattern = s(&body["match"]).unwrap_or_default();
        let policy = s(&body["policy"]).unwrap_or_else(|| "REJECT".into());
        if pattern.is_empty() {
            continue;
        }
        if kind == "url_regex" {
            let action = match policy.to_ascii_uppercase().as_str() {
                "REJECT-TINYGIF" | "REJECT-IMG" => "reject-img",
                "REJECT-DICT" => "reject-dict",
                "REJECT-ARRAY" => "reject-array",
                "REJECT-200" => "reject-200",
                _ => "reject",
            };
            out.url.push(format!("{pattern} - {action}"));
        } else {
            out.rule.push(format!(
                "{},{pattern},{policy}",
                kind.to_ascii_uppercase().replace('_', "-")
            ));
        }
    }
}

fn convert_yaml(text: &str) -> Option<String> {
    let docs = YamlLoader::load_from_str(text).ok()?;
    let doc = docs.into_iter().next()?;
    if !matches!(doc, Yaml::Hash(_)) {
        return None;
    }
    let mut out = Out::default();
    if let Some(name) = s(&doc["name"]) {
        out.meta.push(format!("#!name={name}"));
    }
    if let Some(desc) = s(&doc["desc"]).or_else(|| s(&doc["description"])) {
        out.meta.push(format!("#!desc={}", desc.replace('\n', " ")));
    }
    // Egern: Surge-compatible arguments.
    if let Yaml::Hash(args) = &doc["compat_arguments"] {
        let declared: Vec<String> = args
            .iter()
            .filter_map(|(k, v)| {
                Some(format!(
                    "{}:{}",
                    s(k)?,
                    surge_quote(&s(v).unwrap_or_default())
                ))
            })
            .collect();
        if !declared.is_empty() {
            out.meta.push(format!("#!arguments={}", declared.join(",")));
        }
    }
    if let Some(desc) = s(&doc["compat_arguments_desc"]) {
        out.meta.push(format!(
            "#!arguments-desc={}",
            desc.trim_end().replace('\n', "\\n")
        ));
    }

    // MITM hostnames: Stash `http.mitm`, Egern `mitm.hostnames.includes/excludes`.
    for host in list(&doc["http"]["mitm"]) {
        if let Some(host) = s(host) {
            out.mitm.push(host);
        }
    }
    for host in list(&doc["mitm"]["hostnames"]["includes"]) {
        if let Some(host) = s(host) {
            out.mitm.push(host);
        }
    }
    for host in list(&doc["mitm"]["hostnames"]["excludes"]) {
        if let Some(host) = s(host) {
            out.mitm.push(format!("-{host}"));
        }
    }

    // Stash http.*
    for key in ["rewrite", "url-rewrite"] {
        for line in list(&doc["http"][key]) {
            if let Some(line) = s(line) {
                out.url.push(line);
            }
        }
    }
    for line in list(&doc["http"]["header-rewrite"]) {
        if let Some(line) = s(line) {
            out.header.push(line);
        }
    }
    for script in list(&doc["http"]["script"]) {
        let name = s(&script["name"]).unwrap_or_default();
        let Some(pattern) = s(&script["match"]) else {
            continue;
        };
        let path = s(&doc["script-providers"][name.as_str()]["url"])
            .or_else(|| s(&script["script-path"]))
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let phase = match s(&script["type"]).as_deref() {
            Some("response") => "response",
            _ => "request",
        };
        out.script.push(script_line(
            &name,
            phase,
            &pattern,
            &path,
            truthy(&script["require-body"]),
            truthy(&script["binary-mode"]),
            s(&script["max-size"]),
            s(&script["timeout"]),
            s(&script["argument"]),
        ));
    }

    // Rules (Stash strings or Egern maps).
    for rule in list(&doc["rules"]) {
        convert_rule(rule, &mut out);
    }

    // Egern url_rewrites / map_locals / scriptings.
    for rewrite in list(&doc["url_rewrites"]) {
        let (Some(pattern), Some(location)) = (s(&rewrite["match"]), s(&rewrite["location"]))
        else {
            continue;
        };
        let status = s(&rewrite["status_code"]).unwrap_or_else(|| "302".into());
        out.url.push(format!("{pattern} {location} {status}"));
    }
    for local in list(&doc["map_locals"]) {
        let Some(pattern) = s(&local["match"]) else {
            continue;
        };
        let mut line = pattern;
        if let Some(body) = s(&local["body"]) {
            line.push_str(&format!(" data-type=text data={}", surge_quote(&body)));
        } else if let Some(to) = s(&local["to"]) {
            line.push_str(&format!(" data-type=file data={}", surge_quote(&to)));
        } else {
            line.push_str(" data-type=text data=\"\"");
        }
        if let Some(status) = s(&local["status_code"]) {
            line.push_str(&format!(" status-code={status}"));
        }
        if let Yaml::Hash(headers) = &local["headers"] {
            let pairs: Vec<String> = headers
                .iter()
                .filter_map(|(k, v)| Some(format!("{}:{}", s(k)?, s(v)?)))
                .collect();
            if !pairs.is_empty() {
                line.push_str(&format!(" header={}", surge_quote(&pairs.join("|"))));
            }
        }
        out.map.push(line);
    }
    for item in list(&doc["scriptings"]) {
        for (key, phase) in [("http_request", "request"), ("http_response", "response")] {
            let script = &item[key];
            if script.is_badvalue() || matches!(script, Yaml::Null) {
                continue;
            }
            let (Some(pattern), Some(path)) = (s(&script["match"]), s(&script["script_url"]))
            else {
                continue;
            };
            let argument =
                s(&script["env"]["_compat.$argument"]).or_else(|| s(&script["argument"]));
            out.script.push(script_line(
                &s(&script["name"]).unwrap_or_else(|| "script".into()),
                phase,
                &pattern,
                &path,
                truthy(&script["body_required"]),
                truthy(&script["binary_body"]),
                s(&script["max_size"]),
                s(&script["timeout"]),
                argument,
            ));
        }
    }
    Some(out.render())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surge_arguments_allow_spaces_around_equals() {
        let n = normalize(
            "#!name = X\n#!arguments = Type:\"Official\",AutoCC:true\n#!arguments-desc = a\\nb\n",
        );
        assert_eq!(
            n.arguments,
            vec![
                ("Type".into(), "Official".into()),
                ("AutoCC".into(), "true".into())
            ]
        );
        assert_eq!(n.arguments_desc, "a\nb");
        assert_eq!(n.meta[1].kind, "switch");
    }

    #[test]
    fn loon_arguments_become_surge_arguments() {
        let plugin = "#!name = X\n[Argument]\nType = select,\"Official\",\"Translate\",tag=字幕,desc=选择\nAutoCC = switch,true,tag=自动\nTypes = input,\"Translate\"\n[Script]\nhttp-request ^https://a\\.com/ script-path=https://s/a.js, tag=a, argument=[{Type},{AutoCC}]\n";
        let n = normalize(plugin);
        assert_eq!(
            n.arguments,
            vec![
                ("Type".into(), "Official".into()),
                ("AutoCC".into(), "true".into()),
                ("Types".into(), "Translate".into())
            ]
        );
        assert_eq!(n.meta[0].kind, "select");
        assert_eq!(
            n.meta[0].options,
            vec!["Official".to_string(), "Translate".to_string()]
        );
        assert_eq!(n.meta[0].tag, "字幕");
        assert_eq!(n.meta[1].kind, "switch");
        assert!(n.text.contains(
            "argument=Type=\"{{{Type}}}\"&AutoCC=\"{{{AutoCC}}}\", x-murge-argument-object=1"
        ));
    }

    #[test]
    fn stash_override_converts_to_surge() {
        let stash = "name: \"S\"\ndesc: |-\n  d\nhttp:\n  mitm:\n    - \"a.com\"\n  rewrite:\n    - ^https?://ad\\.a\\.com - reject\n  script:\n    - match: ^https://a\\.com/x\n      name: s1\n      type: response\n      require-body: true\n      binary-mode: true\n      argument: k=v\nscript-providers:\n  s1:\n    url: https://s/a.js\n    interval: 86400\n";
        let n = normalize(stash);
        assert!(n.text.contains("#!name=S"));
        assert!(n.text.contains("[MITM]\nhostname = %APPEND% a.com"));
        assert!(n.text.contains("^https?://ad\\.a\\.com - reject"));
        assert!(n.text.contains("s1 = type=http-response,pattern=^https://a\\.com/x,requires-body=1,binary-body-mode=1,script-path=https://s/a.js,argument=k=v"));
    }

    #[test]
    fn egern_yaml_converts_to_surge_with_arguments() {
        let egern = "name: 'E'\ndescription: d\ncompat_arguments:\n  Type: Official\n  AutoCC: 'true'\ncompat_arguments_desc: |\n  Type: t\nrules:\n- url_regex:\n    match: ^https?://x\\.com/ad\n    policy: REJECT\nscriptings:\n- http_request:\n    name: r\n    match: ^https://a\\.com/\n    script_url: https://s/r.js\n    env:\n      _compat.$argument: Type=\"{{{Type}}}\"\n    body_required: true\nmitm:\n  hostnames:\n    includes:\n    - a.com\n    excludes:\n    - b.a.com\n";
        let n = normalize(egern);
        assert_eq!(
            n.arguments,
            vec![
                ("Type".into(), "Official".into()),
                ("AutoCC".into(), "true".into())
            ]
        );
        assert_eq!(n.arguments_desc, "Type: t");
        assert!(n.text.contains("^https?://x\\.com/ad - reject"));
        assert!(n.text.contains("r = type=http-request,pattern=^https://a\\.com/,requires-body=1,script-path=https://s/r.js,argument=Type=\"{{{Type}}}\""));
        assert!(n.text.contains("hostname = %APPEND% a.com, -b.a.com"));
    }

    /// Run against the real DualSubs files: `MURGE_DUALSUBS_DIR=<dir> cargo test --lib normalize::tests::dualsubs -- --nocapture`.
    #[test]
    fn dualsubs_live_modules() {
        let Ok(dir) = std::env::var("MURGE_DUALSUBS_DIR") else {
            return;
        };
        for ext in ["sgmodule", "plugin", "stoverride", "yaml", "snippet"] {
            let Ok(text) = std::fs::read_to_string(format!("{dir}/m.{ext}")) else {
                continue;
            };
            let parsed = super::super::rules::parse_module(&text);
            println!(
                "{ext}: args={:?} scripts={} url={} map={} rules={} hosts={} warnings={:?}",
                parsed.arguments.iter().map(|(k, _)| k).collect::<Vec<_>>(),
                parsed.scripts.len(),
                parsed.url_rewrites.len(),
                parsed.map_locals.len(),
                parsed.rules.len(),
                parsed.hostnames.len(),
                parsed.warnings
            );
            if let Some(script) = parsed.scripts.iter().find(|s| s.argument.contains("Type")) {
                println!(
                    "  argument: {} object={}",
                    script.argument, script.argument_object
                );
            }
        }
    }
}
