//! Surge-module parsing and the compiled rule set the MITM engine applies
//! (docs/MITM_REWRITE.md §2/§6).
//!
//! Supported sections: `[MITM]` (hostname), `[URL Rewrite]`,
//! `[Header Rewrite]`, `[Body Rewrite]`, `[Map Local]`. Everything else is
//! reported as a warning and skipped, so one unsupported line never disables
//! the rest of a module.

use base64::Engine as _;
use regex::Regex;

/// 1x1 transparent GIF (the `reject-img` / `tiny-gif` payload).
pub const TINY_GIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
];

/// Max length of one rule regex source (keeps a hostile module from shipping
/// a pathological pattern; the regex crate is linear-time anyway).
const MAX_PATTERN_LEN: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Request,
    Response,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectKind {
    /// 404, empty body.
    NotFound,
    /// 200, empty body.
    Ok,
    Img,
    Dict,
    Array,
}

impl RejectKind {
    pub fn label(self) -> &'static str {
        match self {
            RejectKind::NotFound => "reject",
            RejectKind::Ok => "reject-200",
            RejectKind::Img => "reject-img",
            RejectKind::Dict => "reject-dict",
            RejectKind::Array => "reject-array",
        }
    }

    /// (status, content-type, body)
    pub fn response(self) -> (u16, &'static str, &'static [u8]) {
        match self {
            RejectKind::NotFound => (404, "text/plain", b""),
            RejectKind::Ok => (200, "text/plain", b""),
            RejectKind::Img => (200, "image/gif", TINY_GIF),
            RejectKind::Dict => (200, "application/json", b"{}"),
            RejectKind::Array => (200, "application/json", b"[]"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlAction {
    Redirect(u16),
    Reject(RejectKind),
    /// Transparent rewrite: the request continues to the new URL.
    Header,
}

#[derive(Debug, Clone)]
pub struct UrlRewrite {
    pub pattern: Regex,
    pub replacement: String,
    pub action: UrlAction,
}

#[derive(Debug, Clone)]
pub enum HeaderOp {
    Add(String, String),
    Del(String),
    Replace(String, String),
    ReplaceRegex(String, Regex, String),
}

#[derive(Debug, Clone)]
pub struct HeaderRewrite {
    pub phase: Phase,
    pub pattern: Regex,
    pub op: HeaderOp,
}

#[derive(Debug, Clone)]
pub struct BodyRewrite {
    pub phase: Phase,
    pub pattern: Regex,
    pub pairs: Vec<(Regex, String)>,
    /// A jq filter applied to JSON bodies before the regex pairs.
    pub jq: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MapLocal {
    pub pattern: Regex,
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

/// One parsed module (before merging).
#[derive(Debug, Clone, Default)]
pub struct ParsedModule {
    pub name: Option<String>,
    pub description: Option<String>,
    pub hostnames: Vec<String>,
    pub url_rewrites: Vec<UrlRewrite>,
    pub header_rewrites: Vec<HeaderRewrite>,
    pub body_rewrites: Vec<BodyRewrite>,
    pub map_locals: Vec<MapLocal>,
    /// `[Rule]` lines converted to mihomo rules.
    pub rules: Vec<String>,
    /// Rule providers those rules reference: (name, behavior, url).
    pub providers: Vec<(String, &'static str, String)>,
    /// `#!arguments` declarations: (name, default).
    pub arguments: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

impl ParsedModule {
    pub fn rule_count(&self) -> usize {
        self.url_rewrites.len()
            + self.header_rewrites.len()
            + self.body_rewrites.len()
            + self.map_locals.len()
            + self.rules.len()
    }

    fn push_rewrite(&mut self, item: super::compat::RewriteItem) {
        use super::compat::RewriteItem;
        match item {
            RewriteItem::Url(rule) => self.url_rewrites.push(rule),
            RewriteItem::Header(rule) => self.header_rewrites.push(rule),
            RewriteItem::Body(rule) => self.body_rewrites.push(rule),
            RewriteItem::Map(rule) => self.map_locals.push(rule),
        }
    }

    fn push_rule(&mut self, line: &str) -> Result<(), String> {
        use super::compat::RuleItem;
        match super::compat::convert_rule(line)? {
            RuleItem::Plain(rule) => self.rules.push(rule),
            RuleItem::Provider {
                name,
                behavior,
                url,
                rule,
            } => {
                if !self
                    .providers
                    .iter()
                    .any(|(existing, _, _)| *existing == name)
                {
                    self.providers.push((name, behavior, url));
                }
                self.rules.push(rule);
            }
            RuleItem::UrlReject(rule) => self.url_rewrites.push(rule),
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

/// Split on ASCII whitespace, honoring double quotes (quotes are removed,
/// `\"` inside quotes is a literal quote).
pub fn split_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if in_quotes && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    out.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(current);
    }
    out
}

/// Surge/JS-style `$1` replacement → Rust regex `${1}` (so `$1abc` keeps its
/// meaning instead of naming a group `1abc`). `$$` stays a literal dollar.
pub fn to_rust_replacement(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    let bytes: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        if ch == '$' {
            if i + 1 < bytes.len() && bytes[i + 1] == '$' {
                out.push_str("$$");
                i += 2;
                continue;
            }
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 {
                out.push_str("${");
                out.extend(&bytes[i + 1..j]);
                out.push('}');
                i = j;
                continue;
            }
            if i + 1 < bytes.len() && bytes[i + 1] == '{' {
                out.push('$');
                i += 1;
                continue;
            }
            // A lone `$` that is not a group reference stays literal.
            out.push_str("$$");
            i += 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

pub(super) fn compile(pattern: &str) -> Result<Regex, String> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err("正则过长".into());
    }
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| format!("正则无效：{}", first_line(&error.to_string())))
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn short(line: &str) -> String {
    let trimmed: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

// ---------------------------------------------------------------------------
// Module parser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    None,
    Mitm,
    UrlRewrite,
    HeaderRewrite,
    BodyRewrite,
    MapLocal,
    Rule,
    /// Loon `[Rewrite]` / Quantumult X `[rewrite_local]`.
    Compat,
    Ignored,
    Unsupported,
}

/// Parse a Surge module (`.sgmodule`), Loon plugin, or Quantumult X snippet
/// with the declared argument defaults.
pub fn parse_module(text: &str) -> ParsedModule {
    parse_module_with(text, &std::collections::BTreeMap::new())
}

/// Parse with per-module `#!arguments` overrides applied first.
pub fn parse_module_with(
    text: &str,
    overrides: &std::collections::BTreeMap<String, String>,
) -> ParsedModule {
    let arguments = super::compat::declared_arguments(text);
    let substituted;
    let text = if arguments.is_empty() {
        text
    } else {
        substituted = super::compat::substitute_arguments(text, &arguments, overrides);
        substituted.as_str()
    };
    let mut module = ParsedModule {
        arguments,
        ..Default::default()
    };
    let mut section = Section::None;
    let mut warned_sections: Vec<String> = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(meta) = line.strip_prefix("#!") {
            if let Some((key, value)) = meta.split_once('=') {
                match key.trim() {
                    "name" => module.name = Some(value.trim().to_string()),
                    "desc" => module.description = Some(value.trim().to_string()),
                    _ => {}
                }
            }
            continue;
        }
        if line.starts_with('#') || line.starts_with(';') || line.starts_with("//") {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let name = line[1..line.len() - 1].trim().to_ascii_lowercase();
            section = match name.as_str() {
                "mitm" => Section::Mitm,
                "url rewrite" => Section::UrlRewrite,
                "header rewrite" => Section::HeaderRewrite,
                "body rewrite" => Section::BodyRewrite,
                "map local" => Section::MapLocal,
                "rule" | "filter_local" => Section::Rule,
                "rewrite" | "rewrite_local" => Section::Compat,
                "general" | "host" | "argument" | "plugin" | "general_local" => Section::Ignored,
                _ => {
                    if !warned_sections.contains(&name) {
                        module
                            .warnings
                            .push(format!("第 {line_no} 行：暂不支持 {line} 段，已跳过"));
                        warned_sections.push(name);
                    }
                    Section::Unsupported
                }
            };
            continue;
        }
        let result = match section {
            Section::Mitm => parse_mitm_line(line, &mut module),
            Section::UrlRewrite => {
                parse_url_rewrite(line).map(|rule| module.url_rewrites.push(rule))
            }
            Section::HeaderRewrite => {
                parse_header_rewrite(line).map(|rule| module.header_rewrites.push(rule))
            }
            Section::BodyRewrite => {
                parse_body_rewrite(line).map(|rule| module.body_rewrites.push(rule))
            }
            Section::MapLocal => parse_map_local(line).map(|rule| module.map_locals.push(rule)),
            Section::Rule => module.push_rule(line),
            Section::Compat => {
                super::compat::parse_compat_rewrite(line).map(|item| module.push_rewrite(item))
            }
            Section::Ignored | Section::Unsupported => Ok(()),
            // A bare Quantumult X snippet: `hostname = …` plus rewrite lines.
            Section::None => {
                if line.starts_with("hostname") && line.contains('=') {
                    parse_mitm_line(line, &mut module)
                } else {
                    super::compat::parse_compat_rewrite(line).map(|item| module.push_rewrite(item))
                }
            }
        };
        if let Err(message) = result {
            module
                .warnings
                .push(format!("第 {line_no} 行：{message}（{}）", short(line)));
        }
    }
    module
}

fn parse_mitm_line(line: &str, module: &mut ParsedModule) -> Result<(), String> {
    let Some((key, value)) = line.split_once('=') else {
        return Err("无法识别".into());
    };
    match key.trim() {
        "hostname" => {
            for host in value.split(',') {
                let host = host
                    .trim()
                    .trim_start_matches("%APPEND%")
                    .trim_start_matches("%INSERT%")
                    .trim();
                if host.is_empty() {
                    continue;
                }
                match validate_hostname_pattern(host) {
                    Ok(()) => module.hostnames.push(host.to_string()),
                    Err(message) => module.warnings.push(format!("主机名 {host}：{message}")),
                }
            }
            Ok(())
        }
        // Handled by the global switch; modules cannot turn verification off.
        "skip-server-cert-verify"
        | "tcp-connection"
        | "h2"
        | "hostname-disabled"
        | "client-source-address"
        | "auto-quic-block" => Ok(()),
        "ca-p12" | "ca-passphrase" => Err("模块不能指定根证书，已忽略".into()),
        other => Err(format!("未知选项 {other}")),
    }
}

/// A hostname pattern: optional leading `-` (exclusion), labels with `*`/`?`
/// wildcards, optional `:port`. A bare `*` is refused (decrypting everything
/// breaks pinned apps and is a footgun).
pub fn validate_hostname_pattern(raw: &str) -> Result<(), String> {
    let pattern = raw.strip_prefix('-').unwrap_or(raw);
    let (host, port) = split_host_port(pattern);
    if host.is_empty() {
        return Err("主机名为空".into());
    }
    if let Some(port) = port {
        if port != "*" && port.parse::<u16>().map(|p| p == 0).unwrap_or(true) {
            return Err("端口无效".into());
        }
    }
    if host.chars().all(|c| c == '*' || c == '.') {
        return Err("不支持解密所有主机".into());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '*' | '?' | '_'))
    {
        return Err("包含非法字符".into());
    }
    Ok(())
}

fn split_host_port(pattern: &str) -> (&str, Option<&str>) {
    match pattern.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (pattern, None),
    }
}

fn parse_url_rewrite(line: &str) -> Result<UrlRewrite, String> {
    let args = split_args(line);
    if args.len() < 3 {
        return Err("格式应为：正则 替换 类型".into());
    }
    let pattern = compile(&args[0])?;
    let action = match args[2].to_ascii_lowercase().as_str() {
        "302" => UrlAction::Redirect(302),
        "307" => UrlAction::Redirect(307),
        "301" => UrlAction::Redirect(301),
        "308" => UrlAction::Redirect(308),
        "reject" => UrlAction::Reject(RejectKind::NotFound),
        "reject-200" => UrlAction::Reject(RejectKind::Ok),
        "reject-img" | "reject-tinygif" => UrlAction::Reject(RejectKind::Img),
        "reject-dict" => UrlAction::Reject(RejectKind::Dict),
        "reject-array" => UrlAction::Reject(RejectKind::Array),
        "header" => UrlAction::Header,
        other => return Err(format!("不支持的类型 {other}")),
    };
    Ok(UrlRewrite {
        pattern,
        replacement: to_rust_replacement(&args[1]),
        action,
    })
}

fn parse_phase(token: &str) -> Option<Phase> {
    match token {
        "http-request" => Some(Phase::Request),
        "http-response" => Some(Phase::Response),
        _ => None,
    }
}

fn parse_header_rewrite(line: &str) -> Result<HeaderRewrite, String> {
    let args = split_args(line);
    let (phase, rest) = match args.first().and_then(|t| parse_phase(t)) {
        Some(phase) => (phase, &args[1..]),
        // Legacy syntax: `^url header-del Name` applies to requests.
        None => (Phase::Request, &args[..]),
    };
    if rest.len() < 3 {
        return Err("格式应为：[http-request|http-response] 正则 操作 头名 [值]".into());
    }
    let pattern = compile(&rest[0])?;
    let name = rest[2].clone();
    let value = rest.get(3).cloned();
    let need_value = || value.clone().ok_or_else(|| "缺少头的值".to_string());
    let op = match rest[1].as_str() {
        "header-add" => HeaderOp::Add(name, need_value()?),
        "header-del" => HeaderOp::Del(name),
        "header-replace" => HeaderOp::Replace(name, need_value()?),
        "header-replace-regex" => {
            let re = compile(&need_value()?)?;
            let replacement = rest.get(4).cloned().unwrap_or_default();
            HeaderOp::ReplaceRegex(name, re, to_rust_replacement(&replacement))
        }
        other => return Err(format!("不支持的操作 {other}")),
    };
    if let HeaderOp::Add(name, _) | HeaderOp::Del(name) | HeaderOp::Replace(name, _) = &op {
        if http::HeaderName::from_bytes(name.as_bytes()).is_err() {
            return Err(format!("头名无效 {name}"));
        }
    }
    Ok(HeaderRewrite { phase, pattern, op })
}

fn parse_body_rewrite(line: &str) -> Result<BodyRewrite, String> {
    let args = split_args(line);
    if let Some(kind) = args.first().and_then(|t| t.strip_suffix("-jq")) {
        let phase =
            parse_phase(kind).ok_or("第一个参数应为 http-request-jq 或 http-response-jq")?;
        let pattern = compile(args.get(1).ok_or("缺少 URL 正则")?)?;
        let raw = super::jq::tail_after_tokens(line, 2);
        if raw.starts_with("jq-path=") {
            return Err("暂不支持 jq-path（请改用内联 jq 表达式）".into());
        }
        let code = super::jq::unquote(raw);
        super::jq::validate(&code)?;
        return Ok(BodyRewrite {
            phase,
            pattern,
            pairs: Vec::new(),
            jq: Some(code),
        });
    }
    let Some(phase) = args.first().and_then(|t| parse_phase(t)) else {
        return Err("第一个参数应为 http-request 或 http-response".into());
    };
    if args.len() < 4 || (args.len() - 2) % 2 != 0 {
        return Err("格式应为：阶段 URL正则 正则1 替换1 [正则2 替换2 …]".into());
    }
    let pattern = compile(&args[1])?;
    let mut pairs = Vec::new();
    for pair in args[2..].chunks(2) {
        pairs.push((compile(&pair[0])?, to_rust_replacement(&pair[1])));
    }
    Ok(BodyRewrite {
        phase,
        pattern,
        pairs,
        jq: None,
    })
}

fn parse_map_local(line: &str) -> Result<MapLocal, String> {
    let args = split_args(line);
    let Some(first) = args.first() else {
        return Err("为空".into());
    };
    let pattern = compile(first)?;
    let mut data_type = "text".to_string();
    let mut data: Option<String> = None;
    let mut status = 200u16;
    let mut headers = Vec::new();
    for arg in &args[1..] {
        let Some((key, value)) = arg.split_once('=') else {
            continue;
        };
        match key {
            "data-type" => data_type = value.to_ascii_lowercase(),
            "data" => data = Some(value.to_string()),
            "status-code" => {
                status = value
                    .parse::<u16>()
                    .ok()
                    .filter(|code| (100..=599).contains(code))
                    .ok_or_else(|| "status-code 无效".to_string())?
            }
            "header" => {
                for pair in value.split('|') {
                    if let Some((name, value)) = pair.split_once(':') {
                        headers.push((name.trim().to_string(), value.trim().to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    let (content_type, body) = match data_type.as_str() {
        "text" => (
            "text/plain; charset=utf-8",
            data.unwrap_or_default().into_bytes(),
        ),
        "json" => ("application/json", data.unwrap_or_default().into_bytes()),
        "tiny-gif" => ("image/gif", TINY_GIF.to_vec()),
        "base64" => (
            "application/octet-stream",
            base64::engine::general_purpose::STANDARD
                .decode(data.unwrap_or_default().trim())
                .map_err(|_| "base64 数据无效".to_string())?,
        ),
        "file" => return Err("暂不支持 data-type=file（请改用内联 data）".into()),
        other => return Err(format!("不支持的 data-type {other}")),
    };
    let content_type = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| content_type.to_string());
    Ok(MapLocal {
        pattern,
        status,
        content_type,
        body,
        headers,
    })
}

// ---------------------------------------------------------------------------
// Hostname matching
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct HostPattern {
    exclude: bool,
    host: Regex,
    /// None = default (443 for TLS); Some(None) = any port.
    port: Option<Option<u16>>,
    source: String,
}

/// The decrypt decision: exclusions win, then includes; ports default to 443.
#[derive(Debug, Clone, Default)]
pub struct HostMatcher {
    patterns: Vec<HostPattern>,
}

fn glob_to_regex(glob: &str) -> String {
    let mut out = String::from("^");
    for ch in glob.chars() {
        match ch {
            '*' => out.push_str("[^:]*"),
            '?' => out.push('.'),
            c => out.push_str(&regex::escape(&c.to_string())),
        }
    }
    out.push('$');
    out
}

impl HostMatcher {
    pub fn new(patterns: &[String]) -> Self {
        let mut compiled = Vec::new();
        for raw in patterns {
            let raw = raw.trim();
            if validate_hostname_pattern(raw).is_err() {
                continue;
            }
            let exclude = raw.starts_with('-');
            let pattern = raw.trim_start_matches('-').to_ascii_lowercase();
            let (host, port) = split_host_port(&pattern);
            let port = port.map(|port| port.parse::<u16>().ok());
            let Ok(host_re) = Regex::new(&glob_to_regex(host)) else {
                continue;
            };
            compiled.push(HostPattern {
                exclude,
                host: host_re,
                port,
                source: raw.to_string(),
            });
        }
        HostMatcher { patterns: compiled }
    }

    pub fn is_empty(&self) -> bool {
        !self.patterns.iter().any(|p| !p.exclude)
    }

    fn port_matches(pattern: &HostPattern, port: u16) -> bool {
        match pattern.port {
            None => port == 443,
            Some(None) => true,
            Some(Some(expected)) => expected == port,
        }
    }

    /// Whether a TLS connection to `host:port` should be decrypted.
    pub fn should_decrypt(&self, host: &str, port: u16) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if self.patterns.iter().any(|p| {
            p.exclude && p.host.is_match(&host) && (p.port.is_none() || Self::port_matches(p, port))
        }) {
            return false;
        }
        self.patterns
            .iter()
            .any(|p| !p.exclude && p.host.is_match(&host) && Self::port_matches(p, port))
    }

    /// Whether plain-HTTP traffic for `host` is routed here at all (port
    /// ignored; exclusions still win).
    pub fn covers_host(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if self
            .patterns
            .iter()
            .any(|p| p.exclude && p.port.is_none() && p.host.is_match(&host))
        {
            return false;
        }
        self.patterns
            .iter()
            .any(|p| !p.exclude && p.host.is_match(&host))
    }

    /// The coarse mihomo routing filter: `DOMAIN` for literal hosts,
    /// `DOMAIN-SUFFIX` of the static tail for wildcard hosts. Superset of the
    /// precise decision — the engine passes through anything else.
    pub fn mihomo_filters(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for pattern in self.patterns.iter().filter(|p| !p.exclude) {
            let lowered = pattern.source.to_ascii_lowercase();
            let (host, _) = split_host_port(&lowered);
            let filter = if !host.contains('*') && !host.contains('?') {
                ("DOMAIN".to_string(), host.to_string())
            } else {
                let labels: Vec<&str> = host.split('.').collect();
                let last_wild = labels
                    .iter()
                    .rposition(|label| label.contains('*') || label.contains('?'))
                    .unwrap_or(0);
                let tail = labels[last_wild + 1..].join(".");
                if tail.is_empty() {
                    continue;
                }
                ("DOMAIN-SUFFIX".to_string(), tail)
            };
            if !out.contains(&filter) {
                out.push(filter);
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// The compiled rule set
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CompiledRules {
    pub hosts: HostMatcher,
    pub hostnames: Vec<String>,
    pub rewrite_enabled: bool,
    pub url_rewrites: Vec<UrlRewrite>,
    pub header_rewrites: Vec<HeaderRewrite>,
    pub body_rewrites: Vec<BodyRewrite>,
    pub map_locals: Vec<MapLocal>,
    pub mihomo_rules: Vec<String>,
    pub providers: Vec<(String, &'static str, String)>,
}

pub struct ModuleSource<'a> {
    pub content: &'a str,
    pub arguments: Option<&'a std::collections::BTreeMap<String, String>>,
}

impl<'a> ModuleSource<'a> {
    pub fn plain(content: &'a str) -> Self {
        ModuleSource {
            content,
            arguments: None,
        }
    }
}

impl CompiledRules {
    /// Merge the decrypt page's own hostnames with every enabled module.
    pub fn build(
        own_hostnames: &[String],
        modules: &[ModuleSource<'_>],
        rewrite_enabled: bool,
    ) -> Self {
        let mut hostnames: Vec<String> = own_hostnames
            .iter()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .collect();
        let mut rules = CompiledRules {
            rewrite_enabled,
            ..Default::default()
        };
        for module in modules {
            let parsed = match module.arguments {
                Some(arguments) => parse_module_with(module.content, arguments),
                None => parse_module(module.content),
            };
            for host in parsed.hostnames {
                if !hostnames.contains(&host) {
                    hostnames.push(host);
                }
            }
            if rewrite_enabled {
                rules.url_rewrites.extend(parsed.url_rewrites);
                rules.header_rewrites.extend(parsed.header_rewrites);
                rules.body_rewrites.extend(parsed.body_rewrites);
                rules.map_locals.extend(parsed.map_locals);
                for rule in parsed.rules {
                    if !rules.mihomo_rules.contains(&rule) {
                        rules.mihomo_rules.push(rule);
                    }
                }
                for provider in parsed.providers {
                    if !rules.providers.iter().any(|p| p.0 == provider.0) {
                        rules.providers.push(provider);
                    }
                }
            }
        }
        rules.hosts = HostMatcher::new(&hostnames);
        rules.hostnames = hostnames;
        rules
    }

    pub fn has_rewrites(&self) -> bool {
        self.rewrite_enabled
            && (!self.url_rewrites.is_empty()
                || !self.header_rewrites.is_empty()
                || !self.body_rewrites.is_empty()
                || !self.map_locals.is_empty())
    }

    pub fn find_url_rewrite(&self, url: &str) -> Option<(&UrlRewrite, String)> {
        if !self.rewrite_enabled {
            return None;
        }
        self.url_rewrites.iter().find_map(|rule| {
            rule.pattern.is_match(url).then(|| {
                (
                    rule,
                    rule.pattern
                        .replace(url, rule.replacement.as_str())
                        .into_owned(),
                )
            })
        })
    }

    pub fn find_map_local(&self, url: &str) -> Option<&MapLocal> {
        if !self.rewrite_enabled {
            return None;
        }
        self.map_locals
            .iter()
            .find(|rule| rule.pattern.is_match(url))
    }

    pub fn header_rules<'a>(
        &'a self,
        phase: Phase,
        url: &'a str,
    ) -> impl Iterator<Item = &'a HeaderRewrite> + 'a {
        let enabled = self.rewrite_enabled;
        self.header_rewrites
            .iter()
            .filter(move |rule| enabled && rule.phase == phase && rule.pattern.is_match(url))
    }

    pub fn body_rules<'a>(&'a self, phase: Phase, url: &'a str) -> Vec<&'a BodyRewrite> {
        if !self.rewrite_enabled {
            return Vec::new();
        }
        self.body_rewrites
            .iter()
            .filter(|rule| rule.phase == phase && rule.pattern.is_match(url))
            .collect()
    }
}

/// Apply header rules in order to a header map.
pub fn apply_header_rules<'a>(
    headers: &mut http::HeaderMap,
    rules: impl Iterator<Item = &'a HeaderRewrite>,
) -> bool {
    use http::header::{HeaderName, HeaderValue};
    let mut changed = false;
    for rule in rules {
        match &rule.op {
            HeaderOp::Add(name, value) => {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    headers.append(name, value);
                    changed = true;
                }
            }
            HeaderOp::Del(name) => {
                if let Ok(name) = HeaderName::from_bytes(name.as_bytes()) {
                    changed |= headers.remove(name).is_some();
                }
            }
            HeaderOp::Replace(name, value) => {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    if headers.contains_key(&name) {
                        headers.insert(name, value);
                        changed = true;
                    }
                }
            }
            HeaderOp::ReplaceRegex(name, re, replacement) => {
                let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
                    continue;
                };
                let current: Vec<String> = headers
                    .get_all(&name)
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_string))
                    .collect();
                if current.is_empty() {
                    continue;
                }
                headers.remove(&name);
                for value in current {
                    let next = re.replace_all(&value, replacement.as_str()).into_owned();
                    if next != value {
                        changed = true;
                    }
                    if let Ok(value) = HeaderValue::from_str(&next) {
                        headers.append(name.clone(), value);
                    }
                }
            }
        }
    }
    changed
}

/// Apply body rules; `None` when nothing changed.
pub fn apply_body_rules(body: &str, rules: &[&BodyRewrite]) -> Option<String> {
    let mut text = body.to_string();
    for rule in rules {
        if let Some(code) = &rule.jq {
            if let Some(next) = super::jq::apply(code, &text) {
                text = next;
            }
        }
        for (re, replacement) in &rule.pairs {
            text = re.replace_all(&text, replacement.as_str()).into_owned();
        }
    }
    (text != body).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surge_jq_body_rewrite_applies_to_json() {
        let module = parse_module(
            "[Body Rewrite]\nhttp-response-jq ^https://api\\.example\\.com/feed 'del(.ads) | .items |= map(select(.type != \"ad\"))'\nhttp-request-jq ^https://api\\.example\\.com 'del(.a'\n",
        );
        assert_eq!(module.body_rewrites.len(), 1, "{:?}", module.warnings);
        assert!(module.warnings.iter().any(|w| w.contains("jq")));
        let rule = &module.body_rewrites[0];
        let out = apply_body_rules(
            r#"{"ads":[1],"items":[{"type":"ad"},{"type":"post"}]}"#,
            &[rule],
        );
        assert_eq!(out.as_deref(), Some(r#"{"items":[{"type":"post"}]}"#));
        assert!(apply_body_rules("<html>", &[rule]).is_none());
    }

    #[test]
    fn split_args_honors_quotes() {
        assert_eq!(
            split_args(r#"http-response ^https://a "a b" "c \"d\"" e"#),
            vec!["http-response", "^https://a", "a b", "c \"d\"", "e"]
        );
        assert_eq!(split_args(r#"x """#), vec!["x", ""]);
    }

    #[test]
    fn replacement_dollars_are_braced() {
        assert_eq!(
            to_rust_replacement("https://b.com/$1abc"),
            "https://b.com/${1}abc"
        );
        assert_eq!(to_rust_replacement("$$5 and $"), "$$5 and $$");
        assert_eq!(to_rust_replacement("${2}"), "${2}");
    }

    const MODULE: &str = r#"#!name=Test Module
#!desc=Demo
[General]
force-http-engine-hosts = %APPEND% x.com
[URL Rewrite]
^https?://ad\.example\.com/(.*) https://cdn.example.com/$1 302
^https?://track\.example\.com - reject-img
^https?://old\.example\.com/(.*) https://new.example.com/$1 header
^https?://bad bad nope
[Header Rewrite]
http-request ^https://api\.example\.com header-add X-Test 1
^https://api\.example\.com header-del Cookie
http-response ^https://api\.example\.com header-replace-regex Set-Cookie "Secure" "Insecure"
[Body Rewrite]
http-response ^https://api\.example\.com/v1 "\"vip\":false" "\"vip\":true"
http-response-jq ^https://x jq-path="https://x/a.jq"
[Map Local]
^https://api\.example\.com/ads data-type=json data="{\"ads\":[]}" status-code=200 header="X-A:1|Content-Type:application/json; charset=utf-8"
[Script]
foo = type=http-response,pattern=^x,script-path=a.js
[MITM]
hostname = %APPEND% api.example.com, *.example.com, -safe.example.com, *
"#;

    #[test]
    fn parses_a_surge_module() {
        let module = parse_module(MODULE);
        assert_eq!(module.name.as_deref(), Some("Test Module"));
        assert_eq!(module.description.as_deref(), Some("Demo"));
        assert_eq!(module.url_rewrites.len(), 3);
        assert_eq!(module.url_rewrites[0].action, UrlAction::Redirect(302));
        assert_eq!(
            module.url_rewrites[1].action,
            UrlAction::Reject(RejectKind::Img)
        );
        assert_eq!(module.url_rewrites[2].action, UrlAction::Header);
        assert_eq!(module.header_rewrites.len(), 3);
        assert_eq!(module.header_rewrites[1].phase, Phase::Request);
        assert_eq!(module.header_rewrites[2].phase, Phase::Response);
        assert_eq!(module.body_rewrites.len(), 1);
        assert_eq!(module.map_locals.len(), 1);
        assert_eq!(module.map_locals[0].body, br#"{"ads":[]}"#);
        assert_eq!(
            module.map_locals[0].content_type,
            "application/json; charset=utf-8"
        );
        assert_eq!(
            module.hostnames,
            vec!["api.example.com", "*.example.com", "-safe.example.com"]
        );
        let warnings = module.warnings.join("\n");
        assert!(warnings.contains("不支持的类型 nope"), "{warnings}");
        assert!(warnings.contains("jq"), "{warnings}");
        assert!(warnings.contains("[Script]"), "{warnings}");
        assert!(module.rules.is_empty());
        assert!(warnings.contains("不支持解密所有主机"), "{warnings}");
    }

    #[test]
    fn host_matcher_handles_wildcards_exclusions_and_ports() {
        let matcher = HostMatcher::new(&[
            "*.example.com".into(),
            "-safe.example.com".into(),
            "api.test.com".into(),
            "alt.test.com:8443".into(),
            "any.test.com:*".into(),
        ]);
        assert!(matcher.should_decrypt("a.example.com", 443));
        assert!(matcher.should_decrypt("A.Example.com.", 443));
        assert!(!matcher.should_decrypt("example.com", 443));
        assert!(!matcher.should_decrypt("safe.example.com", 443));
        assert!(!matcher.should_decrypt("a.example.com", 8443));
        assert!(matcher.should_decrypt("api.test.com", 443));
        assert!(!matcher.should_decrypt("api.test.com.evil.com", 443));
        assert!(matcher.should_decrypt("alt.test.com", 8443));
        assert!(!matcher.should_decrypt("alt.test.com", 443));
        assert!(matcher.should_decrypt("any.test.com", 9999));
        assert!(matcher.covers_host("a.example.com"));
        assert!(!matcher.covers_host("safe.example.com"));
        assert_eq!(
            matcher.mihomo_filters(),
            vec![
                ("DOMAIN-SUFFIX".to_string(), "example.com".to_string()),
                ("DOMAIN".to_string(), "api.test.com".to_string()),
                ("DOMAIN".to_string(), "alt.test.com".to_string()),
                ("DOMAIN".to_string(), "any.test.com".to_string()),
            ]
        );
    }

    #[test]
    fn compiled_rules_apply_url_header_and_body_rewrites() {
        let rules = CompiledRules::build(&["x.com".into()], &[ModuleSource::plain(MODULE)], true);
        assert!(rules.hosts.should_decrypt("x.com", 443));
        assert!(rules.hosts.should_decrypt("api.example.com", 443));
        let (rule, target) = rules
            .find_url_rewrite("https://ad.example.com/img/1.png")
            .expect("redirect");
        assert_eq!(rule.action, UrlAction::Redirect(302));
        assert_eq!(target, "https://cdn.example.com/img/1.png");

        let mut headers = http::HeaderMap::new();
        headers.insert("cookie", "a=1".parse().unwrap());
        let changed = apply_header_rules(
            &mut headers,
            rules.header_rules(Phase::Request, "https://api.example.com/x"),
        );
        assert!(changed);
        assert!(headers.get("cookie").is_none());
        assert_eq!(headers.get("x-test").unwrap(), "1");

        let mut response = http::HeaderMap::new();
        response.append("set-cookie", "a=1; Secure".parse().unwrap());
        response.append("set-cookie", "b=2".parse().unwrap());
        apply_header_rules(
            &mut response,
            rules.header_rules(Phase::Response, "https://api.example.com/x"),
        );
        let cookies: Vec<_> = response.get_all("set-cookie").iter().collect();
        assert_eq!(cookies, vec!["a=1; Insecure", "b=2"]);

        let body_rules = rules.body_rules(Phase::Response, "https://api.example.com/v1/me");
        assert_eq!(
            apply_body_rules(r#"{"vip":false}"#, &body_rules).as_deref(),
            Some(r#"{"vip":true}"#)
        );
        assert!(apply_body_rules(r#"{"vip":true}"#, &body_rules).is_none());
        assert!(rules
            .find_map_local("https://api.example.com/ads?x")
            .is_some());

        let disabled = CompiledRules::build(&[], &[ModuleSource::plain(MODULE)], false);
        assert!(disabled
            .find_url_rewrite("https://ad.example.com/x")
            .is_none());
        assert!(!disabled.has_rewrites());
        // Hostnames from modules still decrypt when only rewriting is off.
        assert!(disabled.hosts.should_decrypt("api.example.com", 443));
    }

    #[test]
    fn rejects_bad_hostnames() {
        assert!(validate_hostname_pattern("*").is_err());
        assert!(validate_hostname_pattern("*.*").is_err());
        assert!(validate_hostname_pattern("a b.com").is_err());
        assert!(validate_hostname_pattern("a.com:0").is_err());
        assert!(validate_hostname_pattern("a.com:443").is_ok());
        assert!(validate_hostname_pattern("-a.com").is_ok());
    }
}
