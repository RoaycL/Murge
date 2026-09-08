//! Network value validators — Rust port of `src/shared/net.ts`.
//!
//! Used by the typed DNS/sniffer/TUN-config models: IPs, CIDRs, hostnames,
//! domain patterns (mihomo wildcard forms) and the composite validators.

fn is_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.into_iter().all(|part| {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
        part.parse::<u16>().map(|n| n <= 255).unwrap_or(false)
    })
}

fn is_ipv6(value: &str) -> bool {
    // The TS implementation delegates to a permissive RFC-style scan: no empty
    // groups except a single `::`, at most one `::`, hex groups only.
    if value.contains(":::") {
        return false;
    }
    let (head, tail) = match value.split_once("::") {
        Some((head, tail)) => (head, Some(tail)),
        None => (value, None),
    };
    let count_groups = |section: &str| -> Option<usize> {
        if section.is_empty() {
            return Some(0);
        }
        let groups: Vec<&str> = section.split(':').collect();
        for group in &groups {
            if group.is_empty() || group.len() > 4 || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
        }
        Some(groups.len())
    };
    let head_count = match count_groups(head) {
        Some(count) => count,
        None => return false,
    };
    match tail {
        Some(tail) => {
            let tail_count = match count_groups(tail) {
                Some(count) => count,
                None => return false,
            };
            // IPv4-embedded tails are allowed by mihomo configs (`::ffff:1.2.3.4`).
            if tail.contains('.') {
                return head_count <= 6 && is_ipv4(tail);
            }
            head_count + tail_count <= 7
        }
        None => {
            if value.contains('.') {
                // Bare IPv4-mapped form without `::` is not an IPv6 literal.
                return false;
            }
            head_count == 8
        }
    }
}

/// An IPv4 or IPv6 address (brackets stripped).
pub fn is_valid_ip(value: &str) -> bool {
    let stripped = value
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(value);
    is_ipv4(stripped) || is_ipv6(stripped)
}

/// A CIDR (`address/prefix`) of a single IP family.
pub fn is_valid_cidr(value: &str) -> bool {
    let Some(slash) = value.rfind('/') else {
        return false;
    };
    if slash == 0 {
        return false;
    }
    let ip = &value[..slash];
    let prefix = &value[slash + 1..];
    if prefix.is_empty() || prefix.len() > 3 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let bits: u32 = match prefix.parse() {
        Ok(bits) => bits,
        Err(_) => return false,
    };
    if is_ipv4(ip) {
        bits <= 32
    } else if is_ipv6(ip) {
        bits <= 128
    } else {
        false
    }
}

fn is_valid_domain_label(label: &str) -> bool {
    if label == "*" {
        return true;
    }
    let bytes = label.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let is_alnum = |b: u8| b.is_ascii_alphanumeric();
    if !is_alnum(bytes[0]) || !is_alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    bytes.len() <= 63
        && (bytes.len() == 1 || bytes[1..bytes.len() - 1].iter().all(|b| is_alnum(*b) || *b == b'-'))
}

/// A plain DNS-style hostname label sequence (no wildcard prefixes).
pub fn is_valid_hostname(value: &str) -> bool {
    if value.len() > 253 || value.is_empty() {
        return false;
    }
    value.split('.').all(is_valid_domain_label)
}

/// A domain pattern used by DNS `fake-ip-filter`/`nameserver-policy` keys or
/// the sniffer `skip-domain`/`force-domain`: a plain hostname, a `*.`/`+.`
/// wildcard prefix, a mid-domain single-label wildcard (`time.*.com`), or a
/// `geosite:`/`geoip:` rule expression.
#[allow(dead_code)] // the Electron zod IPC schema uses this; the schema-validation slice (3B) consumes it
pub fn is_valid_domain_or_rule(value: &str) -> bool {
    if value.starts_with("geosite:") || value.starts_with("geoip:") {
        return value.len() > "geosite:".len();
    }
    if value == "*" {
        return true;
    }
    if (value.starts_with("*.") || value.starts_with("+.")) && value.len() > 1 {
        return is_valid_hostname(&value[2..]);
    }
    if value.len() > 253 {
        return false;
    }
    value.split('.').all(is_valid_domain_label)
}

/// An address list entry that may be a bare IP or a CIDR (`skip-src-address`).
pub fn is_valid_address_or_cidr(value: &str) -> bool {
    is_valid_ip(value) || is_valid_cidr(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_addresses_and_rejections() {
        assert!(is_valid_ip("127.0.0.1"));
        assert!(is_valid_ip("198.18.0.1"));
        assert!(!is_valid_ip("256.1.1.1"));
        assert!(!is_valid_ip("01.2.3.4"), "leading zeros rejected like the TS impl");
        assert!(!is_valid_ip("1.2.3"));
        assert!(!is_valid_ip(""));
    }

    #[test]
    fn ipv6_addresses_and_rejections() {
        assert!(is_valid_ip("2001:db8::1"));
        assert!(is_valid_ip("::1"));
        assert!(is_valid_ip("[::1]"), "bracketed form");
        assert!(is_valid_ip("2001:67c:4e8::/48".split('/').next().unwrap()));
        assert!(!is_valid_ip("::::"));
        assert!(!is_valid_ip("1:2:3:4:5:6:7:8:9"));
    }

    #[test]
    fn cidrs_of_both_families() {
        assert!(is_valid_cidr("198.18.0.0/16"));
        assert!(is_valid_cidr("2001:67c:4e8::/48"));
        assert!(!is_valid_cidr("198.18.0.0/33"));
        assert!(!is_valid_cidr("198.18.0.0"));
        assert!(!is_valid_cidr("198.18.0.0/-1"));
    }

    #[test]
    fn hostnames_and_domain_rules() {
        assert!(is_valid_hostname("example.com"));
        assert!(!is_valid_hostname("-bad.com"));
        assert!(!is_valid_hostname("bad-.com"));
        assert!(is_valid_domain_or_rule("+.push.apple.com"));
        assert!(is_valid_domain_or_rule("*.example.com"));
        assert!(is_valid_domain_or_rule("time.*.com"));
        assert!(is_valid_domain_or_rule("*"));
        assert!(is_valid_domain_or_rule("geosite:category-ads"));
        assert!(!is_valid_domain_or_rule("geosite:"));
        assert!(!is_valid_domain_or_rule("+."));
        assert!(!is_valid_domain_or_rule("a..b"));
    }

    #[test]
    fn address_or_cidr_accepts_both() {
        assert!(is_valid_address_or_cidr("10.0.0.1"));
        assert!(is_valid_address_or_cidr("10.0.0.0/8"));
        assert!(!is_valid_address_or_cidr("example.com"));
    }
}
