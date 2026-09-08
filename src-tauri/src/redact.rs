//! Credential redaction — Rust port of `redactCredentials`
//! (`src/main/subscriptions/subscription-fetcher.ts`). Profile metadata keeps
//! only redacted URLs; the raw address lives in the OS credential store.
//!
//! Mirrored behavior, in order:
//! 1. Free-form text: redact each embedded URL individually.
//! 2. Parseable URL: strip userinfo (`user:pass@` -> `redacted@`), redact
//!    secret-looking query parameters (`***REDACTED***`), redact 20+ char
//!    hex/UUID-like path segments (`[UUID_REDACTED]`).
//! 3. Malformed target: fall back to regex redaction (inline userinfo,
//!    secret-looking query params, long hex paths) and strip leftover
//!    `user:pass@` sequences wherever they sit.

const SECRET_PARAM_NAMES: [&str; 16] = [
    "token", "uuid", "secret", "key", "auth", "password", "sub", "access_token",
    "apikey", "api_key", "bearer", "ticket", "session", "sid", "sess", "cid",
    // client_id/client_secret are covered by "cid"/"secret" prefix rules below.
];

fn is_secret_param(name: &str) -> bool {
    let lower = name.to_lowercase();
    SECRET_PARAM_NAMES.iter().any(|secret| lower.contains(secret))
}

/// True when a URL is a REDACTION ARTIFACT rather than a fetchable address.
/// The subscription-fetch slice (3C) uses this to refuse fetching redacted
/// display URLs during `update-from-source`.
#[allow(dead_code)]
pub fn is_redacted_url(url: &str) -> bool {
    url.contains("[UUID_REDACTED]")
        || url.contains("***REDACTED***")
        || regex::Regex::new(r"://(?:\[?redacted\]?):?[^/\s]*@")
            .expect("redacted-url regex compiles")
            .is_match(url)
}

/// Redact credentials from a URL or free-form text (display/log use only).
pub fn redact_credentials(url: &str) -> String {
    // Free-form text: redact each embedded URL individually instead of letting
    // the whole string fail to parse and fall through to the weaker regex path.
    if url.trim().chars().any(char::is_whitespace) {
        return regex::Regex::new(r"[a-zA-Z][a-zA-Z0-9+.-]*://\S+")
            .expect("url-list regex compiles")
            .replace_all(url, |captures: &regex::Captures| {
                redact_credentials(captures.get(0).map(|m| m.as_str()).unwrap_or(""))
            })
            .to_string();
    }

    match url::Url::parse(url) {
        Ok(mut parsed) => {
            // 1. Strip userinfo.
            if !parsed.username().is_empty() || parsed.password().is_some() {
                let _ = parsed.set_username("redacted");
                let _ = parsed.set_password(None);
            }

            // 2. Redact suspicious query parameters.
            let secret_params: Vec<String> = parsed
                .query_pairs()
                .filter(|(name, _)| is_secret_param(name))
                .map(|(name, _)| name.to_string())
                .collect();
            if !secret_params.is_empty() {
                let mut pairs: Vec<(String, String)> = parsed
                    .query_pairs()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
                for (name, value) in pairs.iter_mut() {
                    if is_secret_param(name) {
                        *value = "***REDACTED***".to_string();
                    }
                }
                let query = form_encode(&pairs);
                parsed.set_query(Some(&query));
            }

            // 3. Redact long hex/UUID-like path segments (20+ chars hex).
            let path = parsed.path().to_string();
            let segments: Vec<String> = path
                .split('/')
                .map(|segment| {
                    if is_long_hex(segment) {
                        "[UUID_REDACTED]".to_string()
                    } else {
                        segment.to_string()
                    }
                })
                .collect();
            parsed.set_path(&segments.join("/"));

            // A malformed target can resolve credentials into the PATH rather
            // than the authority, so username/password stay empty while the
            // credentials survive inside the string. Strip leftover
            // `user:pass@` sequences wherever they sit.
            strip_inline_userinfo(&parsed.to_string())
        }
        Err(_) => {
            // Not a parseable URL; fall back to regex-based redaction.
            let inline = regex::Regex::new(r"://([^@/]+)@")
                .expect("userinfo regex compiles")
                .replace_all(url, "://[redacted]@")
                .to_string();
            let params = regex::Regex::new(r"(\?|&)([^=&]+)=([^&]*)")
                .expect("query regex compiles")
                .replace_all(&inline, |captures: &regex::Captures| {
                    let prefix = captures.get(1).map(|m| m.as_str()).unwrap_or("");
                    let name = captures.get(2).map(|m| m.as_str()).unwrap_or("");
                    let secret = regex::Regex::new(r"token|uuid|secret|key|auth|password|sub|access_token|apikey|bearer")
                        .expect("secret regex compiles");
                    if secret.is_match(&name.to_lowercase()) {
                        format!("{prefix}{name}=***REDACTED***")
                    } else {
                        captures.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
                    }
                })
                .to_string();
            let hex = regex::Regex::new(r"/([0-9a-f]{20,})")
                .expect("hex regex compiles")
                .replace_all(&params, "/[UUID_REDACTED]")
                .to_string();
            strip_inline_userinfo(&hex)
        }
    }
}

/// Replace any remaining `user:password@host` sequence, wherever it sits.
fn strip_inline_userinfo(value: &str) -> String {
    regex::Regex::new(r"[^\s/:@]+:[^\s/@]+@")
        .expect("strip regex compiles")
        .replace_all(value, "[redacted]@")
        .to_string()
}

fn is_long_hex(segment: &str) -> bool {
    segment.len() >= 20 && segment.chars().all(|c| c.is_ascii_hexdigit())
}

/// Serialize pairs with `application/x-www-form-urlencoded`-style percent
/// encoding, matching what the URL spec produces for query strings.
fn form_encode(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'!' | b'$' | b'\'' | b'(' | b')' | b'*' | b',' | b';' | b'@');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_userinfo() {
        let redacted = redact_credentials("https://user:pass@example.com/path");
        assert!(!redacted.contains("pass"), "{redacted}");
        assert!(redacted.starts_with("https://redacted@example.com/path"), "{redacted}");
    }

    #[test]
    fn redacts_secret_query_parameters() {
        let redacted = redact_credentials("https://example.com/sub?token=abc123&keep=1");
        assert!(redacted.contains("token=***REDACTED***"), "{redacted}");
        assert!(redacted.contains("keep=1"), "{redacted}");
    }

    #[test]
    fn redacts_long_hex_path_segments() {
        let redacted = redact_credentials("https://example.com/0123456789abcdef01234567/profile");
        assert!(redacted.contains("[UUID_REDACTED]"), "{redacted}");
        assert!(redacted.ends_with("/profile"), "{redacted}");
    }

    #[test]
    fn short_hex_paths_survive() {
        let redacted = redact_credentials("https://example.com/abcdef/profile");
        assert!(!redacted.contains("[UUID_REDACTED]"), "{redacted}");
    }

    #[test]
    fn clean_urls_pass_through_unchanged() {
        let url = "https://example.com/plain";
        assert_eq!(redact_credentials(url), url);
    }

    #[test]
    fn malformed_url_falls_back_to_regex() {
        let redacted = redact_credentials("https://user:pass@host/a0123456789abcdef01234567?token=x");
        assert!(!redacted.contains("user:pass"), "{redacted}");
        assert!(redacted.contains("***REDACTED***"), "{redacted}");
    }

    #[test]
    fn free_form_text_redacts_embedded_urls() {
        let redacted = redact_credentials("see https://user:pass@example.com/a for details");
        assert!(!redacted.contains("pass"), "{redacted}");
        assert!(redacted.contains("for details"), "{redacted}");
    }

    #[test]
    fn is_redacted_url_detects_artifacts() {
        assert!(is_redacted_url("https://example.com/[UUID_REDACTED]/x"));
        assert!(is_redacted_url("https://example.com/sub?token=***REDACTED***"));
        assert!(is_redacted_url("https://redacted@example.com/x"));
        assert!(!is_redacted_url("https://example.com/plain"));
    }
}
