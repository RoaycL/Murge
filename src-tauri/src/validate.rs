//! Config validation — Rust port of `src/main/profiles/config-validator.ts`
//! (the deterministic structural pass) and `profile-diagnostics.ts`
//! (non-blocking compatibility warnings).
//!
//! In packaged Windows builds the Electron shell follows this pass with
//! `mihomo -t` through the LocalSystem service; the Tauri shell will do the
//! same through the Phase 3D privileged path. Message text is preserved
//! verbatim (renderer tests and users see the same copy in both shells).

use crate::error::IpcError;

/// One validation issue (`shared/profiles.ts` `ValidationIssue`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

impl ValidationResult {
    fn from_issues(issues: Vec<ValidationIssue>) -> Self {
        ValidationResult { ok: issues.is_empty(), issues }
    }
}

/// The structural validator (`FakeConfigValidator` mirror). It intentionally
/// does NOT fully parse YAML; it rejects the malformation classes that are
/// cheap and unambiguous to detect and leaves full semantics to `mihomo -t`.
pub struct StructuralValidator {
    require_proxy_sections: bool,
}

impl StructuralValidator {
    pub fn new() -> Self {
        StructuralValidator { require_proxy_sections: false }
    }

    pub fn validate(&self, document: &str) -> ValidationResult {
        let mut issues: Vec<ValidationIssue> = Vec::new();

        if document.trim().is_empty() {
            issues.push(ValidationIssue {
                severity: "error",
                message: "配置文档为空".into(),
                line: Some(1),
            });
            return ValidationResult::from_issues(issues);
        }

        // The runtime kernel config parses with `uniqueKeys: true`, so a
        // document with a duplicated top-level key can pass import validation
        // yet still fail to start. Gate the same duplicate-key failure here.
        for (key, line) in find_duplicate_top_level_keys(document) {
            issues.push(ValidationIssue {
                severity: "error",
                message: format!("重复的顶层键：{key}"),
                line: Some(line),
            });
        }

        if let Some(line) = find_tab_indent(document) {
            issues.push(ValidationIssue {
                severity: "error",
                message: "YAML 不允许使用制表符缩进".into(),
                line: Some(line + 1),
            });
        }

        if let Some(flow) = find_unbalanced_flow(document) {
            issues.push(ValidationIssue {
                severity: "error",
                message: "存在未闭合的方括号或花括号".into(),
                line: Some(flow),
            });
        }

        let top_level = find_top_level_keys(document);
        if top_level.is_empty() {
            issues.push(ValidationIssue {
                severity: "error",
                message: "文档缺少顶层键".into(),
                line: None,
            });
        }

        if self.require_proxy_sections && !top_level.iter().any(|key| key == "proxies" || key == "proxy-groups") {
            issues.push(ValidationIssue {
                severity: "error",
                message: "文档缺少 proxies 或 proxy-groups 段".into(),
                line: None,
            });
        }

        ValidationResult::from_issues(issues)
    }
}

impl Default for StructuralValidator {
    fn default() -> Self {
        Self::new()
    }
}

const OBSOLETE_TOP_LEVEL_KEYS: [(&str, &str); 2] = [
    (
        "global-client-fingerprint",
        "global-client-fingerprint 已被当前 mihomo 移除，不会生效；如有需要，请在具体代理节点中设置 client-fingerprint。",
    ),
    (
        "udp",
        "顶层 udp 不是当前 mihomo 的有效全局设置，不会生效；UDP 能力由具体代理节点与 TUN 配置决定。",
    ),
];

/// Non-blocking compatibility diagnostics. Warnings never mutate or reject a
/// profile.
pub fn profile_compatibility_diagnostics(document: &str) -> Vec<ValidationIssue> {
    let Ok(parsed) = yaml_rust2::YamlLoader::load_from_str(document) else {
        return Vec::new();
    };
    let Some(doc) = parsed.into_iter().next() else {
        return Vec::new();
    };
    let yaml_rust2::Yaml::Hash(mapping) = doc else {
        return Vec::new();
    };
    let mut issues: Vec<ValidationIssue> = Vec::new();
    for (key, _) in mapping.iter() {
        let yaml_rust2::Yaml::String(key) = key else {
            continue;
        };
        // yaml-rust2 does not expose source ranges; the line is attributed when
        // a scan finds the key at column 0 (same warning, line optional per the
        // shared contract).
        let line = find_top_level_key_line(document, key);
        if let Some((_, message)) = OBSOLETE_TOP_LEVEL_KEYS.iter().find(|(obsolete, _)| obsolete == key) {
            issues.push(ValidationIssue {
                severity: "warning",
                message: message.to_string(),
                line,
            });
        }
    }
    issues
}

/// Combined validation (structural + diagnostics). The semantic `mihomo -t`
/// pass arrives with the Phase 3D privileged slice. Warnings never reject:
/// `ok` reflects the structural gate only, exactly like the TS service.
pub fn validate_document(document: &str) -> Result<ValidationResult, IpcError> {
    let structural = StructuralValidator::new().validate(document);
    if !structural.ok {
        return Ok(structural);
    }
    let mut issues = structural.issues;
    issues.extend(profile_compatibility_diagnostics(document));
    Ok(ValidationResult { ok: true, issues })
}

fn find_top_level_key_line(document: &str, key: &str) -> Option<usize> {
    document.split('\n').position(|line| line.starts_with(key) && line[key.len()..].trim_start().starts_with(':')).map(|i| i + 1)
}

fn find_tab_indent(document: &str) -> Option<usize> {
    document
        .split('\n')
        .position(|line| line.starts_with('\t') || regex::Regex::new(r"^\s+\t").unwrap().is_match(line))
}

fn find_top_level_keys(document: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in document.split('\n') {
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let trimmed = line;
        if let Some(captures) = regex::Regex::new(r"^([A-Za-z0-9_.-]+)\s*:(\s|$)")
            .expect("top-level regex compiles")
            .captures(trimmed)
        {
            keys.push(captures.get(1).map(|m| m.as_str()).unwrap_or("").to_string());
        }
    }
    keys
}

fn find_unbalanced_flow(document: &str) -> Option<usize> {
    let mut square: i64 = 0;
    let mut curly: i64 = 0;
    let mut in_single = false;
    let mut in_double = false;
    for (i, line) in document.split('\n').enumerate() {
        for ch in line.chars() {
            match ch {
                '\'' if !in_double => in_single = !in_single,
                '"' if !in_single => in_double = !in_double,
                '[' if !in_single && !in_double => square += 1,
                ']' if !in_single && !in_double => square -= 1,
                '{' if !in_single && !in_double => curly += 1,
                '}' if !in_single && !in_double => curly -= 1,
                _ => {}
            }
            if square < 0 || curly < 0 {
                return Some(i + 1);
            }
        }
    }
    if square != 0 || curly != 0 {
        return Some(document.split('\n').count());
    }
    None
}

/// Detect duplicated top-level mapping keys. yaml-rust2 rejects duplicate keys
/// outright (load error), so the detection is a lexical scan of top-level
/// mapping lines — the same shape the kernel config gate rejects.
fn find_duplicate_top_level_keys(document: &str) -> Vec<(String, usize)> {
    let mut duplicates: Vec<(String, usize)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let pattern = regex::Regex::new(r"^([A-Za-z0-9_.-]+)\s*:(\s|$)").expect("key regex compiles");
    for (index, line) in document.split('\n').enumerate() {
        if line.starts_with('#') || line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some(captures) = pattern.captures(line) {
            let key = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            if !seen.insert(key.to_string()) {
                duplicates.push((key.to_string(), index + 1));
            }
        }
    }
    duplicates
}

/// Format a failed validation as the user-facing error the TS service throws
/// (`配置校验失败：<issues joined by ；>`).
pub fn throw_if_invalid(result: &ValidationResult) -> Result<(), IpcError> {
    if result.ok {
        return Ok(());
    }
    let detail = result
        .issues
        .iter()
        .map(|issue| issue.message.as_str())
        .collect::<Vec<_>>()
        .join("；");
    Err(IpcError::invalid_argument(format!("配置校验失败：{detail}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_document_is_rejected() {
        let result = validate_document("   ").unwrap();
        assert!(!result.ok);
        assert_eq!(result.issues[0].message, "配置文档为空");
        assert_eq!(result.issues[0].line, Some(1));
    }

    #[test]
    fn duplicate_top_level_key_is_rejected_with_line() {
        let result = validate_document("port: 1\nmode: rule\nport: 2\n").unwrap();
        assert!(!result.ok);
        assert!(result.issues.iter().any(|i| i.message == "重复的顶层键：port" && i.line == Some(3)));
    }

    #[test]
    fn tab_indent_is_rejected() {
        let result = validate_document("proxies:\n\t- name: a\n").unwrap();
        assert!(!result.ok);
        assert!(result.issues.iter().any(|i| i.message == "YAML 不允许使用制表符缩进" && i.line == Some(2)));
    }

    #[test]
    fn unbalanced_flow_is_rejected() {
        let result = validate_document("rules: ['a', 'b'\n").unwrap();
        assert!(!result.ok);
        assert!(result.issues.iter().any(|i| i.message == "存在未闭合的方括号或花括号"));
    }

    #[test]
    fn missing_top_level_key_is_rejected() {
        let result = validate_document("- just\n- a list\n").unwrap();
        assert!(!result.ok);
        assert!(result.issues.iter().any(|i| i.message == "文档缺少顶层键"));
    }

    #[test]
    fn clean_document_passes_without_issues() {
        let result = validate_document("port: 7890\nmode: rule\nproxies: []\nrules: []\n").unwrap();
        assert!(result.ok, "{:?}", result.issues.iter().map(|i| &i.message).collect::<Vec<_>>());
    }

    #[test]
    fn obsolete_keys_produce_warnings_not_errors() {
        let result = validate_document("udp: true\nmode: rule\n").unwrap();
        assert!(result.ok, "warnings never reject");
        assert!(result.issues.iter().any(|i| i.severity == "warning" && i.message.contains("顶层 udp")));
        let result2 = validate_document("global-client-fingerprint: xx\nmode: rule\n").unwrap();
        assert!(result2.ok);
        assert!(result2.issues.iter().any(|i| i.severity == "warning" && i.message.contains("global-client-fingerprint")));
    }

    #[test]
    fn invalid_error_uses_the_shared_copy() {
        let result = validate_document("   ").unwrap();
        let error = throw_if_invalid(&result).unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:INVALID_ARGUMENT::配置校验失败：配置文档为空");
    }
}
