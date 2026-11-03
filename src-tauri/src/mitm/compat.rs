//! M2 module compatibility (docs/MITM_REWRITE.md §6):
//! - `[Rule]` / QX `[filter_local]` lines → mihomo rules (and rule
//!   providers for `RULE-SET` / `DOMAIN-SET` URLs),
//! - Loon `[Rewrite]` and Quantumult X `rewrite_local` lines → the same
//!   compiled rewrite types the Surge sections produce,
//! - Surge `#!arguments` defaults + per-module overrides.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::rules::{
    compile, split_args, to_rust_replacement, BodyRewrite, HeaderOp, HeaderRewrite, MapLocal,
    Phase, RejectKind, UrlAction, UrlRewrite, TINY_GIF,
};

// ---------------------------------------------------------------------------
// [Rule] → mihomo
// ---------------------------------------------------------------------------

/// A converted module rule.
#[derive(Debug, Clone)]
pub enum RuleItem {
    /// A ready mihomo rule line.
    Plain(String),
    /// `RULE-SET` / `DOMAIN-SET` with a URL: a rule provider + its rule.
    Provider {
        name: String,
        behavior: &'static str,
        url: String,
        rule: String,
    },
    /// `URL-REGEX,…,REJECT`: mihomo cannot match URLs, the engine can.
    UrlReject(UrlRewrite),
}

impl PartialEq for RuleItem {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RuleItem::Plain(a), RuleItem::Plain(b)) => a == b,
            (
                RuleItem::Provider {
                    name,
                    behavior,
                    url,
                    rule,
                },
                RuleItem::Provider {
                    name: n,
                    behavior: b,
                    url: u,
                    rule: r,
                },
            ) => name == n && behavior == b && url == u && rule == r,
            (RuleItem::UrlReject(a), RuleItem::UrlReject(b)) => {
                a.pattern.as_str() == b.pattern.as_str() && a.action == b.action
            }
            _ => false,
        }
    }
}

/// Policies a module may target. Module rules cannot name the user's proxy
/// groups (they differ per profile and mihomo refuses unknown targets).
fn map_policy(policy: &str) -> Result<(&'static str, Option<RejectKind>), String> {
    match policy.trim().to_ascii_uppercase().as_str() {
        "DIRECT" => Ok(("DIRECT", None)),
        "REJECT" | "REJECT-NO-DROP" => Ok(("REJECT", Some(RejectKind::NotFound))),
        "REJECT-TINYGIF" | "REJECT-IMG" => Ok(("REJECT", Some(RejectKind::Img))),
        "REJECT-DICT" => Ok(("REJECT", Some(RejectKind::Dict))),
        "REJECT-ARRAY" => Ok(("REJECT", Some(RejectKind::Array))),
        "REJECT-200" => Ok(("REJECT", Some(RejectKind::Ok))),
        "REJECT-DROP" => Ok(("REJECT-DROP", Some(RejectKind::NotFound))),
        _ => Err(format!(
            "策略 {} 无法在模块中使用，只支持 DIRECT 与 REJECT 系列",
            policy.trim()
        )),
    }
}

fn map_type(kind: &str) -> Option<&'static str> {
    Some(match kind.to_ascii_uppercase().as_str() {
        "DOMAIN" | "HOST" => "DOMAIN",
        "DOMAIN-SUFFIX" | "HOST-SUFFIX" => "DOMAIN-SUFFIX",
        "DOMAIN-KEYWORD" | "HOST-KEYWORD" => "DOMAIN-KEYWORD",
        "DOMAIN-WILDCARD" | "HOST-WILDCARD" => "DOMAIN-WILDCARD",
        "DOMAIN-REGEX" => "DOMAIN-REGEX",
        "IP-CIDR" => "IP-CIDR",
        "IP-CIDR6" | "IP6-CIDR" => "IP-CIDR6",
        "IP-ASN" => "IP-ASN",
        "GEOIP" => "GEOIP",
        "DST-PORT" | "DEST-PORT" => "DST-PORT",
        "PROCESS-NAME" => "PROCESS-NAME",
        _ => return None,
    })
}

fn safe_value(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("规则内容为空".into());
    }
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, ',' | '\'' | '"' | '#'))
    {
        return Err("规则内容包含非法字符".into());
    }
    Ok(value)
}

/// Split a logic rule `AND,((A,x),(B,y)),POLICY[,opts]` at its top level.
fn split_logic(line: &str) -> Option<(String, String)> {
    let mut depth = 0i32;
    let mut close = None;
    for (index, ch) in line.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                }
                if depth < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    let close = close?;
    let head = line[..=close].to_string();
    let rest = line[close + 1..].trim_start_matches(',').to_string();
    Some((head, rest))
}

fn provider_name(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    format!(
        "murge-module-{}",
        digest[..6]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// Convert one Surge/Loon `[Rule]` or QX `filter_local` line.
pub fn convert_rule(line: &str) -> Result<RuleItem, String> {
    let line = line.trim();
    let upper = line.to_ascii_uppercase();
    if upper.starts_with("AND,") || upper.starts_with("OR,") || upper.starts_with("NOT,") {
        let (head, rest) = split_logic(line).ok_or("逻辑规则括号不匹配")?;
        if head.contains('\'') || head.contains('"') || head.contains('#') {
            return Err("规则内容包含非法字符".into());
        }
        let policy = rest.split(',').next().unwrap_or_default();
        let (policy, _) = map_policy(policy)?;
        return Ok(RuleItem::Plain(format!("{head},{policy}")));
    }
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 3 {
        return Err("格式应为：类型,内容,策略".into());
    }
    let kind = parts[0].to_ascii_uppercase();
    let options: Vec<&str> = parts[3..]
        .iter()
        .copied()
        .filter(|option| option.eq_ignore_ascii_case("no-resolve"))
        .collect();
    let suffix = if options.is_empty() {
        ""
    } else {
        ",no-resolve"
    };
    match kind.as_str() {
        "URL-REGEX" => {
            let (_, reject) = map_policy(parts[2])?;
            let kind = reject.ok_or("URL-REGEX 只支持 REJECT 系列策略")?;
            Ok(RuleItem::UrlReject(UrlRewrite {
                pattern: compile(parts[1])?,
                replacement: String::new(),
                action: UrlAction::Reject(kind),
            }))
        }
        "RULE-SET" | "DOMAIN-SET" => {
            let url = parts[1];
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(format!("{kind} 只支持链接（内置 {url} 不可用）"));
            }
            let url = safe_value(url)?.to_string();
            let (policy, _) = map_policy(parts[2])?;
            let name = provider_name(&url);
            Ok(RuleItem::Provider {
                rule: format!("RULE-SET,{name},{policy}{suffix}"),
                behavior: if kind == "RULE-SET" {
                    "classical"
                } else {
                    "domain"
                },
                url,
                name,
            })
        }
        _ => {
            let mapped = map_type(&kind).ok_or(format!("规则类型 {kind} 暂不支持"))?;
            let value = safe_value(parts[1])?;
            let (policy, _) = map_policy(parts[2])?;
            Ok(RuleItem::Plain(format!(
                "{mapped},{value},{policy}{suffix}"
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Loon [Rewrite] / Quantumult X rewrite_local
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum RewriteItem {
    Url(UrlRewrite),
    Header(HeaderRewrite),
    Body(BodyRewrite),
    Map(MapLocal),
}

fn reject_kind(token: &str) -> Option<RejectKind> {
    Some(match token {
        "reject" | "reject-drop" | "reject-no-drop" => RejectKind::NotFound,
        "reject-200" => RejectKind::Ok,
        "reject-img" | "reject-tinygif" | "reject-video" => RejectKind::Img,
        "reject-dict" => RejectKind::Dict,
        "reject-array" => RejectKind::Array,
        _ => return None,
    })
}

/// One Loon (`regex action args…`) or QX (`regex url action args…`) line.
pub fn parse_compat_rewrite(line: &str) -> Result<RewriteItem, String> {
    let args = split_args(line);
    if args.len() < 2 {
        return Err("无法识别".into());
    }
    let pattern = compile(&args[0])?;
    let (action, rest) = if args[1] == "url" {
        (
            args.get(2)
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default(),
            args.get(3..).unwrap_or(&[]).to_vec(),
        )
    } else {
        (args[1].to_ascii_lowercase(), args[2..].to_vec())
    };
    if let Some(kind) = reject_kind(&action) {
        return Ok(RewriteItem::Url(UrlRewrite {
            pattern,
            replacement: String::new(),
            action: UrlAction::Reject(kind),
        }));
    }
    let first = || rest.first().cloned().ok_or_else(|| "缺少参数".to_string());
    // Loon: `regex response-body-json-jq 'filter'` (raw text keeps quotes).
    if let Some(kind) = action.strip_suffix("-body-json-jq") {
        let phase = match kind {
            "response" => Phase::Response,
            "request" => Phase::Request,
            _ => return Err(format!("不支持的操作 {action}")),
        };
        let skip = if args[1] == "url" { 3 } else { 2 };
        let code = super::jq::unquote(super::jq::tail_after_tokens(line, skip));
        super::jq::validate(&code)?;
        return Ok(RewriteItem::Body(BodyRewrite {
            phase,
            pattern,
            pairs: Vec::new(),
            jq: Some(code),
        }));
    }
    match action.as_str() {
        "302" | "307" | "301" | "308" => Ok(RewriteItem::Url(UrlRewrite {
            pattern,
            replacement: to_rust_replacement(&first()?),
            action: UrlAction::Redirect(action.parse().unwrap_or(302)),
        })),
        "header" => Ok(RewriteItem::Url(UrlRewrite {
            pattern,
            replacement: to_rust_replacement(&first()?),
            action: UrlAction::Header,
        })),
        "header-add"
        | "header-del"
        | "header-replace"
        | "request-header-add"
        | "request-header-del"
        | "request-header-replace"
        | "response-header-add"
        | "response-header-del"
        | "response-header-replace" => {
            let phase = if action.starts_with("response-") {
                Phase::Response
            } else {
                Phase::Request
            };
            let name = first()?;
            let value = rest.get(1).cloned();
            let op = if action.ends_with("-del") {
                HeaderOp::Del(name)
            } else {
                let value = value.ok_or("缺少头的值")?;
                if action.ends_with("-add") {
                    HeaderOp::Add(name, value)
                } else {
                    HeaderOp::Replace(name, value)
                }
            };
            Ok(RewriteItem::Header(HeaderRewrite { phase, pattern, op }))
        }
        "request-body-replace-regex" | "response-body-replace-regex" => {
            if rest.len() < 2 || rest.len() % 2 != 0 {
                return Err("格式应为：正则 替换 [正则 替换 …]".into());
            }
            let mut pairs = Vec::new();
            for pair in rest.chunks(2) {
                pairs.push((compile(&pair[0])?, to_rust_replacement(&pair[1])));
            }
            Ok(RewriteItem::Body(BodyRewrite {
                phase: if action.starts_with("response") {
                    Phase::Response
                } else {
                    Phase::Request
                },
                pattern,
                pairs,
                jq: None,
            }))
        }
        // QX: `url response-body A response-body B`.
        "response-body" | "request-body" => {
            let phase = if action == "response-body" {
                Phase::Response
            } else {
                Phase::Request
            };
            if rest.len() != 3 || rest[1] != action {
                return Err(format!("格式应为：url {action} 原文 {action} 替换"));
            }
            Ok(RewriteItem::Body(BodyRewrite {
                phase,
                pattern,
                pairs: vec![(compile(&rest[0])?, to_rust_replacement(&rest[2]))],
                jq: None,
            }))
        }
        // Loon: `regex mock-response-body data-type=json data="…" status-code=200`.
        "mock-response-body" => {
            let mut data_type = "text".to_string();
            let mut data = String::new();
            let mut status = 200u16;
            for arg in &rest {
                if let Some((key, value)) = arg.split_once('=') {
                    match key {
                        "data-type" => data_type = value.to_ascii_lowercase(),
                        "data" => data = value.to_string(),
                        "status-code" => status = value.parse().unwrap_or(200),
                        _ => {}
                    }
                }
            }
            let (content_type, body) = match data_type.as_str() {
                "json" => ("application/json", data.into_bytes()),
                "tiny-gif" => ("image/gif", TINY_GIF.to_vec()),
                "text" | "html" => ("text/plain; charset=utf-8", data.into_bytes()),
                other => return Err(format!("不支持的 data-type {other}")),
            };
            Ok(RewriteItem::Map(MapLocal {
                pattern,
                status,
                content_type: content_type.to_string(),
                body,
                headers: Vec::new(),
            }))
        }
        a if a.starts_with("script") => Err("暂不支持脚本".into()),
        "echo-response" => Err("暂不支持 echo-response".into()),
        other => Err(format!("不支持的操作 {other}")),
    }
}

// ---------------------------------------------------------------------------
// #!arguments
// ---------------------------------------------------------------------------

/// `#!arguments=a:1,b:"x, y"` → ordered (name, default) pairs.
pub fn parse_arguments(value: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut items = Vec::new();
    for ch in value.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => items.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    items.push(current);
    for item in items {
        let Some((key, default)) = item.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || out.iter().any(|(k, _): &(String, String)| k == key) {
            continue;
        }
        out.push((key.to_string(), default.trim().to_string()));
    }
    out
}

/// Replace `{{{name}}}` with the override, else the declared default.
pub fn substitute_arguments(
    text: &str,
    declared: &[(String, String)],
    overrides: &BTreeMap<String, String>,
) -> String {
    let mut out = text.to_string();
    for (key, default) in declared {
        let value = overrides.get(key).unwrap_or(default);
        out = out.replace(&format!("{{{{{{{key}}}}}}}"), value);
    }
    out
}

/// The declared arguments of a module text (empty when none).
pub fn declared_arguments(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("#!arguments="))
        .map(parse_arguments)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loon_and_qx_json_jq_rewrites() {
        for line in [
            r#"^https://a\.com/v1 response-body-json-jq 'del(.ad)'"#,
            r#"^https://a\.com/v1 url response-body-json-jq 'del(.ad)'"#,
        ] {
            let RewriteItem::Body(rule) = parse_compat_rewrite(line).unwrap() else {
                panic!("{line}");
            };
            assert!(matches!(rule.phase, Phase::Response));
            assert_eq!(rule.jq.as_deref(), Some("del(.ad)"));
        }
        assert!(parse_compat_rewrite(r#"^https://a response-body-json-jq 'del(.a'"#).is_err());
    }

    #[test]
    fn converts_surge_loon_and_qx_rules() {
        assert_eq!(
            convert_rule("DOMAIN-SUFFIX,ads.com,REJECT-TINYGIF").unwrap(),
            RuleItem::Plain("DOMAIN-SUFFIX,ads.com,REJECT".into())
        );
        assert_eq!(
            convert_rule("host-keyword, track, reject").unwrap(),
            RuleItem::Plain("DOMAIN-KEYWORD,track,REJECT".into())
        );
        assert_eq!(
            convert_rule("IP-CIDR,1.2.3.0/24,REJECT-DROP,no-resolve,extended-matching").unwrap(),
            RuleItem::Plain("IP-CIDR,1.2.3.0/24,REJECT-DROP,no-resolve".into())
        );
        assert_eq!(
            convert_rule("AND,((DOMAIN,a.com),(DST-PORT,443)),REJECT").unwrap(),
            RuleItem::Plain("AND,((DOMAIN,a.com),(DST-PORT,443)),REJECT".into())
        );
        match convert_rule("RULE-SET,https://x.com/ad.list,REJECT").unwrap() {
            RuleItem::Provider {
                name,
                behavior,
                url,
                rule,
            } => {
                assert!(name.starts_with("murge-module-"));
                assert_eq!(behavior, "classical");
                assert_eq!(url, "https://x.com/ad.list");
                assert_eq!(rule, format!("RULE-SET,{name},REJECT"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            convert_rule("URL-REGEX,^https?://a\\.com/ad,REJECT-IMG").unwrap(),
            RuleItem::UrlReject(_)
        ));
        assert!(convert_rule("DOMAIN,a.com,Proxy")
            .unwrap_err()
            .contains("Proxy"));
        assert!(convert_rule("RULE-SET,SYSTEM,DIRECT").is_err());
        assert!(convert_rule("USER-AGENT,x*,REJECT").is_err());
        assert!(convert_rule("DOMAIN,a'b.com,REJECT").is_err());
        assert!(convert_rule("AND,((DOMAIN,a.com),REJECT").is_err());
    }

    #[test]
    fn parses_loon_and_qx_rewrites() {
        let RewriteItem::Url(rule) =
            parse_compat_rewrite("^https?://a\\.com/ad reject-dict").unwrap()
        else {
            panic!()
        };
        assert_eq!(rule.action, UrlAction::Reject(RejectKind::Dict));
        let RewriteItem::Url(rule) =
            parse_compat_rewrite("^https?://a\\.com/(.*) url 302 https://b.com/$1").unwrap()
        else {
            panic!()
        };
        assert_eq!(rule.action, UrlAction::Redirect(302));
        assert_eq!(rule.replacement, "https://b.com/${1}");
        let RewriteItem::Header(rule) =
            parse_compat_rewrite("^https://a\\.com response-header-del Set-Cookie").unwrap()
        else {
            panic!()
        };
        assert_eq!(rule.phase, Phase::Response);
        let RewriteItem::Body(rule) = parse_compat_rewrite(
            r#"^https://a\.com/v1 url response-body "vip":false response-body "vip":true"#,
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(rule.pairs.len(), 1);
        let RewriteItem::Body(rule) =
            parse_compat_rewrite(r#"^https://a\.com/v1 response-body-replace-regex a b c d"#)
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(rule.pairs.len(), 2);
        let RewriteItem::Map(rule) = parse_compat_rewrite(
            r#"^https://a\.com/ads mock-response-body data-type=json data="{}" status-code=200"#,
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(rule.body, b"{}");
        assert!(parse_compat_rewrite("^x url script-response-body a.js").is_err());
    }

    #[test]
    fn substitutes_module_arguments() {
        let declared = parse_arguments(r#"region:hk,blocked:"a, b",empty:"#);
        assert_eq!(
            declared,
            vec![
                ("region".to_string(), "hk".to_string()),
                ("blocked".to_string(), "a, b".to_string()),
                ("empty".to_string(), String::new()),
            ]
        );
        let mut overrides = BTreeMap::new();
        overrides.insert("region".to_string(), "jp".to_string());
        assert_eq!(
            substitute_arguments(
                "x={{{region}}} y={{{blocked}}} z={{{other}}}",
                &declared,
                &overrides
            ),
            "x=jp y=a, b z={{{other}}}"
        );
        assert_eq!(
            declared_arguments("#!name=a\n#!arguments=k:v\n"),
            vec![("k".into(), "v".into())]
        );
    }
}
