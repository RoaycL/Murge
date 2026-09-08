//! Brand configuration — single source of truth is `brand.config.json` at the
//! repository root. The Rust side parses the SAME document the Electron shell
//! uses (`src/shared/brand.ts` re-exports it verbatim), so branding parity is
//! structural rather than copied.

use serde::{Deserialize, Serialize};

pub const BRAND_JSON: &str = include_str!("../../brand.config.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandConfig {
    pub product_name: String,
    pub short_name: String,
    pub description: String,
    pub app_id: String,
    pub executable_name: String,
    pub protocol_scheme: String,
    pub default_profile_name: String,
    pub company_name: String,
    pub repository_url: String,
    pub support_url: String,
    pub copyright: String,
    pub legacy_product_names: Vec<String>,
    pub legacy_app_data_namespaces: Vec<String>,
}

/// Parse and validate the brand document. Mirrors the Electron
/// `parseBrandConfig` gate: an invalid document is a startup failure, never a
/// silent default.
pub fn load_brand() -> Result<BrandConfig, String> {
    let parsed: BrandConfig = serde_json::from_str(BRAND_JSON)
        .map_err(|error| format!("[brand] invalid brand configuration: {error}"))?;
    if parsed.product_name.trim().is_empty() || parsed.app_id.trim().is_empty() {
        return Err("[brand] invalid brand configuration: productName and appId are required".into());
    }
    Ok(parsed)
}

/// The parsed brand document, safe to hand to IPC handlers.
pub fn brand_document() -> serde_json::Value {
    // load_brand() already ran at startup; a panic here would be a build bug.
    serde_json::to_value(load_brand().expect("brand document validated at startup"))
        .expect("brand document serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_checked_in_brand_document() {
        let brand = load_brand().expect("brand must parse");
        assert_eq!(brand.app_id, "io.murge.desktop");
        assert_eq!(brand.product_name, "Murge");
        assert_eq!(brand.protocol_scheme, "murge");
        assert_eq!(brand.executable_name, "murge");
    }
}
