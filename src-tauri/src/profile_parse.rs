//! Profile parsing helpers — Rust ports of `proxy-group-order.ts` and
//! `provider-configs.ts`.
//!
//! The mihomo external controller CANNOT supply group/provider declaration
//! order: `GET /proxies` is a Go map (sorted keys) and `GET /group` iterates a
//! Go map (randomized order). The app owns the active profile document, so the
//! DOCUMENT is the source of truth for "groups render in config-file order"
//! and for the 外部资源 viewer's declared URLs. Both parsers are tolerant by
//! design: missing/empty/invalid sections yield empty results and the UI falls
//! back to controller metadata.

use serde::Serialize;
use yaml_rust2::Yaml;

/// Ordered `proxy-groups` names from a raw profile document (document order).
pub fn parse_proxy_group_order(document: &str) -> Vec<String> {
    if document.trim().is_empty() {
        return Vec::new();
    }
    let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(document) else {
        return Vec::new();
    };
    let Some(Yaml::Hash(root)) = docs.into_iter().next() else {
        return Vec::new();
    };
    let Some(Yaml::Array(groups)) = root.get(&Yaml::String("proxy-groups".into())) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in groups {
        let Yaml::Hash(entry) = entry else {
            continue;
        };
        if let Some(Yaml::String(name)) = entry.get(&Yaml::String("name".into())) {
            if !name.is_empty() {
                names.push(name.clone());
            }
        }
    }
    names
}

/// One `proxy-providers` / `rule-providers` declaration
/// (`shared/profiles.ts` `ProfileProviderConfig`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileProviderConfig {
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_url: Option<String>,
}

/// Provider catalog (`shared/profiles.ts` `ProfileProviderCatalog`).
#[derive(Debug, Clone, Serialize)]
pub struct ProfileProviderCatalog {
    pub proxy: Vec<ProfileProviderConfig>,
    pub rule: Vec<ProfileProviderConfig>,
}

/// `proxy-providers` / `rule-providers` declarations from a raw profile
/// document. Both sections are mihomo MAPS (provider name → config), so the
/// YAML key IS the provider name — there is no `name:` field to read.
pub fn parse_provider_catalog(document: &str) -> ProfileProviderCatalog {
    let empty = || ProfileProviderCatalog { proxy: Vec::new(), rule: Vec::new() };
    if document.trim().is_empty() {
        return empty();
    }
    let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(document) else {
        return empty();
    };
    let Some(Yaml::Hash(root)) = docs.into_iter().next() else {
        return empty();
    };
    ProfileProviderCatalog {
        proxy: parse_provider_section(&root, "proxy-providers", "proxy"),
        rule: parse_provider_section(&root, "rule-providers", "rule"),
    }
}

fn parse_provider_section(root: &yaml_rust2::yaml::Hash, key: &str, kind: &'static str) -> Vec<ProfileProviderConfig> {
    let Some(Yaml::Hash(section)) = root.get(&Yaml::String(key.into())) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name_node, config_node) in section.iter() {
        let Yaml::String(name) = name_node else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let Yaml::Hash(config) = config_node else {
            continue;
        };
        let mut provider = ProfileProviderConfig {
            name: name.clone(),
            kind,
            url: None,
            path: None,
            interval: None,
            behavior: None,
            format: None,
            test_url: None,
        };
        provider.url = scalar_string(config, "url");
        provider.path = scalar_string(config, "path");
        provider.interval = scalar_number(config, "interval");
        provider.behavior = scalar_string(config, "behavior");
        provider.format = scalar_string(config, "format");
        if let Some(Yaml::Hash(health)) = config.get(&Yaml::String("health-check".into())) {
            provider.test_url = scalar_string(health, "url");
        }
        out.push(provider);
    }
    out
}

fn scalar_string(config: &yaml_rust2::yaml::Hash, key: &str) -> Option<String> {
    match config.get(&Yaml::String(key.into())) {
        Some(Yaml::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn scalar_number(config: &yaml_rust2::yaml::Hash, key: &str) -> Option<f64> {
    match config.get(&Yaml::String(key.into())) {
        Some(Yaml::Real(value)) => value.parse::<f64>().ok().filter(|n| n.is_finite()),
        Some(Yaml::Integer(value)) => Some(*value as f64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_order_follows_document_order() {
        let document = "proxy-groups:\n  - name: 节点选择\n    type: select\n  - name: 自动选择\n    type: url-test\n  - name: fallback\n";
        assert_eq!(parse_proxy_group_order(document), vec!["节点选择", "自动选择", "fallback"]);
    }

    #[test]
    fn group_order_tolerates_missing_and_malformed() {
        assert!(parse_proxy_group_order("").is_empty());
        assert!(parse_proxy_group_order("mode: rule\n").is_empty());
        assert!(parse_proxy_group_order("proxy-groups: not-a-list\n").is_empty());
        // Entries without a scalar name are skipped, not fatal.
        let partial = "proxy-groups:\n  - type: select\n  - name: ok\n";
        assert_eq!(parse_proxy_group_order(partial), vec!["ok"]);
    }

    #[test]
    fn provider_catalog_reads_both_sections() {
        let document = "\
proxy-providers:
  provider-a:
    url: https://example.com/a
    path: ./a.yaml
    interval: 86400
    behavior: classical
    health-check:
      url: https://example.com/health
rule-providers:
  rules-b:
    behavior: domain
    format: text
    path: ./b.txt
";
        let catalog = parse_provider_catalog(document);
        assert_eq!(catalog.proxy.len(), 1);
        assert_eq!(catalog.proxy[0].name, "provider-a");
        assert_eq!(catalog.proxy[0].kind, "proxy");
        assert_eq!(catalog.proxy[0].url.as_deref(), Some("https://example.com/a"));
        assert_eq!(catalog.proxy[0].interval, Some(86400.0));
        assert_eq!(catalog.proxy[0].behavior.as_deref(), Some("classical"));
        assert_eq!(catalog.proxy[0].test_url.as_deref(), Some("https://example.com/health"));
        assert_eq!(catalog.rule.len(), 1);
        assert_eq!(catalog.rule[0].name, "rules-b");
        assert_eq!(catalog.rule[0].kind, "rule");
        assert_eq!(catalog.rule[0].format.as_deref(), Some("text"));
        assert_eq!(catalog.rule[0].interval, None);
    }

    #[test]
    fn provider_catalog_serializes_camel_case_test_url() {
        let document = "proxy-providers:\n  p:\n    health-check:\n      url: https://h\n";
        let catalog = parse_provider_catalog(document);
        let json = serde_json::to_value(&catalog).unwrap();
        assert_eq!(json["proxy"][0]["testUrl"], "https://h");
        assert!(json["proxy"][0].get("path").is_none(), "absent fields are omitted");
    }

    #[test]
    fn provider_catalog_tolerates_missing_sections() {
        let catalog = parse_provider_catalog("mode: rule\n");
        assert!(catalog.proxy.is_empty());
        assert!(catalog.rule.is_empty());
    }
}
