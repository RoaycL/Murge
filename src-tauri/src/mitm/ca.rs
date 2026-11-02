//! The local root CA (docs/MITM_REWRITE.md §4): generation, storage, leaf
//! issuance with a per-host cache, and the Windows current-user trust store.
//!
//! The CA certificate is public and lives in `<app-data>/mitm/ca.json`. The
//! private key lives in the Windows Credential Manager (`keyring`), with a
//! user-only file fallback; it never crosses the IPC boundary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType, SerialNumber,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

const CA_VALID_DAYS: i64 = 3650;
const LEAF_VALID_DAYS: i64 = 365;
const LEAF_CACHE_LIMIT: usize = 1024;
const KEYRING_USER: &str = "mitm-ca-key";

/// The persisted public half (`ca.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaRecord {
    pub cert_pem: String,
    pub common_name: String,
    /// Uppercase hex, no separators (certutil accepts it as a CertId).
    pub serial: String,
    pub not_before: i64,
    pub not_after: i64,
    /// SHA-256 of the DER, uppercase hex with colons (display only).
    pub fingerprint: String,
}

/// Where the private key is kept.
pub trait KeyVault: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, pem: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// File vault (non-Windows, dev and tests; Windows fallback).
pub struct FileVault {
    pub path: PathBuf,
}

impl KeyVault for FileVault {
    fn load(&self) -> Result<Option<String>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, pem: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_private(&self.path, pem.as_bytes()).map_err(|e| e.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // %APPDATA% is already per-user on Windows.
    std::fs::write(path, bytes)
}

/// Windows Credential Manager vault, falling back to a file when the
/// credential store is unavailable.
pub struct KeyringVault {
    pub service: String,
    pub fallback: FileVault,
}

impl KeyringVault {
    fn entry(&self) -> Option<keyring::Entry> {
        keyring::Entry::new(&self.service, KEYRING_USER).ok()
    }
}

impl KeyVault for KeyringVault {
    fn load(&self) -> Result<Option<String>, String> {
        if let Some(entry) = self.entry() {
            match entry.get_password() {
                Ok(pem) => return Ok(Some(pem)),
                Err(keyring::Error::NoEntry) => {}
                Err(_) => {}
            }
        }
        self.fallback.load()
    }

    fn save(&self, pem: &str) -> Result<(), String> {
        if let Some(entry) = self.entry() {
            if entry.set_password(pem).is_ok() {
                let _ = self.fallback.delete();
                return Ok(());
            }
        }
        self.fallback.save(pem)
    }

    fn delete(&self) -> Result<(), String> {
        if let Some(entry) = self.entry() {
            let _ = entry.delete_credential();
        }
        self.fallback.delete()
    }
}

/// A loaded CA able to sign leaves.
pub struct CaAuthority {
    pub record: CaRecord,
    ca_der: CertificateDer<'static>,
    issuer: rcgen::Certificate,
    issuer_key: KeyPair,
    leaf_key: KeyPair,
    leaf_signing: Arc<dyn rustls::sign::SigningKey>,
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

impl std::fmt::Debug for CaAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaAuthority")
            .field("record", &self.record)
            .finish_non_exhaustive()
    }
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn to_time(unix: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(unix).unwrap_or_else(|_| OffsetDateTime::now_utc())
}

fn ca_params(
    common_name: &str,
    serial: &[u8],
    not_before: i64,
    not_after: i64,
) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, common_name);
    dn.push(DnType::OrganizationName, "Murge");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.serial_number = Some(SerialNumber::from_slice(serial));
    params.not_before = to_time(not_before);
    params.not_after = to_time(not_after);
    params
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn parse_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .map(str::trim)
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

impl CaAuthority {
    /// Generate a fresh CA. Returns the authority and the key PEM to vault.
    pub fn generate(common_name: &str) -> Result<(Self, String), String> {
        let key =
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
        let mut serial = [0u8; 16];
        rand::Rng::fill(&mut rand::thread_rng(), &mut serial);
        serial[0] &= 0x7f; // positive INTEGER
        serial[0] |= 0x10; // no leading zero byte (stable hex)
        let not_before = now_unix() - 86_400;
        let not_after = not_before + CA_VALID_DAYS * 86_400;
        let cert = ca_params(common_name, &serial, not_before, not_after)
            .self_signed(&key)
            .map_err(|e| e.to_string())?;
        let der = cert.der().to_vec();
        let fingerprint = Sha256::digest(&der)
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        let record = CaRecord {
            cert_pem: cert.pem(),
            common_name: common_name.to_string(),
            serial: hex_upper(&serial),
            not_before,
            not_after,
            fingerprint,
        };
        let key_pem = key.serialize_pem();
        let authority = Self::load(record, &key_pem)?;
        Ok((authority, key_pem))
    }

    /// Rebuild a signing authority from the stored record + key. The issuer
    /// certificate object is re-derived from the same subject, serial,
    /// validity and key, which is all a leaf's issuer/AKI fields depend on;
    /// the served chain uses the stored original DER.
    pub fn load(record: CaRecord, key_pem: &str) -> Result<Self, String> {
        let issuer_key = KeyPair::from_pem(key_pem).map_err(|e| format!("CA 私钥无效：{e}"))?;
        let serial = parse_hex(&record.serial).ok_or("CA 序列号无效")?;
        let issuer = ca_params(
            &record.common_name,
            &serial,
            record.not_before,
            record.not_after,
        )
        .self_signed(&issuer_key)
        .map_err(|e| e.to_string())?;
        let ca_der = CertificateDer::from(pem_to_der(&record.cert_pem).ok_or("CA 证书无效")?);
        let leaf_key =
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
        let leaf_signing = rustls::crypto::ring::sign::any_supported_type(&PrivateKeyDer::Pkcs8(
            PrivatePkcs8KeyDer::from(leaf_key.serialize_der()),
        ))
        .map_err(|e| e.to_string())?;
        Ok(CaAuthority {
            record,
            ca_der,
            issuer,
            issuer_key,
            leaf_key,
            leaf_signing,
            cache: Mutex::new(HashMap::new()),
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn ca_der(&self) -> &CertificateDer<'static> {
        &self.ca_der
    }

    /// A cached leaf (chain: leaf, CA) for `host`.
    pub fn leaf_for(&self, host: &str) -> Result<Arc<CertifiedKey>, String> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if let Some(found) = self.cache.lock().expect("leaf cache").get(&host) {
            return Ok(found.clone());
        }
        let mut params = CertificateParams::default();
        let san = match host.parse::<std::net::IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) => SanType::DnsName(
                host.clone()
                    .try_into()
                    .map_err(|_| format!("主机名无效：{host}"))?,
            ),
        };
        params.subject_alt_names = vec![san];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, host.as_str());
        params.distinguished_name = dn;
        params.is_ca = IsCa::NoCa;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let mut serial = [0u8; 16];
        rand::Rng::fill(&mut rand::thread_rng(), &mut serial);
        serial[0] &= 0x7f;
        params.serial_number = Some(SerialNumber::from_slice(&serial));
        let not_before = now_unix() - 86_400;
        let not_after = (not_before + LEAF_VALID_DAYS * 86_400).min(self.record.not_after);
        params.not_before = to_time(not_before);
        params.not_after = to_time(not_after);
        params.use_authority_key_identifier_extension = true;
        let cert = params
            .signed_by(&self.leaf_key, &self.issuer, &self.issuer_key)
            .map_err(|e| e.to_string())?;
        let certified = Arc::new(CertifiedKey::new(
            vec![cert.der().clone(), self.ca_der.clone()],
            self.leaf_signing.clone(),
        ));
        let mut cache = self.cache.lock().expect("leaf cache");
        if cache.len() >= LEAF_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(host, certified.clone());
        Ok(certified)
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

pub fn load_record(dir: &Path) -> Option<CaRecord> {
    let text = std::fs::read_to_string(dir.join("ca.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_record(dir: &Path, record: &CaRecord) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())? + "\n";
    let tmp = dir.join(format!(".ca.json.{}.tmp", now_unix()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("ca.json")).map_err(|e| e.to_string())
}

pub fn delete_record(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("ca.json"));
}

// ---------------------------------------------------------------------------
// Trust store (Windows current user)
// ---------------------------------------------------------------------------

pub trait TrustStore: Send + Sync {
    /// None = this platform cannot tell.
    fn is_trusted(&self, record: &CaRecord) -> Option<bool>;
    fn install(&self, record: &CaRecord, temp_dir: &Path) -> Result<(), String>;
    fn uninstall(&self, record: &CaRecord) -> Result<(), String>;
}

pub struct SystemTrustStore;

#[cfg(windows)]
fn certutil(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    std::process::Command::new(format!(r"{system_root}\System32\certutil.exe"))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

impl TrustStore for SystemTrustStore {
    #[cfg(windows)]
    fn is_trusted(&self, record: &CaRecord) -> Option<bool> {
        let output = certutil(&["-user", "-store", "Root", &record.serial]).ok()?;
        Some(output.status.success())
    }

    #[cfg(not(windows))]
    fn is_trusted(&self, _record: &CaRecord) -> Option<bool> {
        None
    }

    #[cfg(windows)]
    fn install(&self, record: &CaRecord, temp_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(temp_dir).map_err(|e| e.to_string())?;
        let path = temp_dir.join("murge-ca.crt");
        std::fs::write(&path, &record.cert_pem).map_err(|e| e.to_string())?;
        // Adding to the CURRENT USER Root store needs no elevation; Windows
        // shows its own security confirmation, which the user must accept.
        let output = certutil(&["-user", "-addstore", "Root", &path.to_string_lossy()])
            .map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&path);
        let output = output?;
        if output.status.success() && self.is_trusted(record) == Some(true) {
            Ok(())
        } else {
            Err("证书未被信任（可能在系统确认框中选择了「否」）".into())
        }
    }

    #[cfg(not(windows))]
    fn install(&self, _record: &CaRecord, _temp_dir: &Path) -> Result<(), String> {
        Err("当前系统不支持自动安装证书，请导出后手动信任".into())
    }

    #[cfg(windows)]
    fn uninstall(&self, record: &CaRecord) -> Result<(), String> {
        let output =
            certutil(&["-user", "-delstore", "Root", &record.serial]).map_err(|e| e.to_string())?;
        if output.status.success() || self.is_trusted(record) == Some(false) {
            Ok(())
        } else {
            Err("移除证书失败（可能在系统确认框中选择了「否」）".into())
        }
    }

    #[cfg(not(windows))]
    fn uninstall(&self, _record: &CaRecord) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ca_round_trips_and_signs_verifiable_leaves() {
        let (authority, key_pem) = CaAuthority::generate("Murge Test CA").expect("generate");
        assert_eq!(authority.record.serial.len(), 32);
        assert!(authority.record.cert_pem.contains("BEGIN CERTIFICATE"));

        // Reload from the persisted halves and sign a leaf.
        let reloaded = CaAuthority::load(authority.record.clone(), &key_pem).expect("reload");
        let leaf = reloaded.leaf_for("api.example.com").expect("leaf");
        assert_eq!(leaf.cert.len(), 2);
        assert!(Arc::ptr_eq(
            &leaf,
            &reloaded.leaf_for("API.example.com.").unwrap()
        ));

        // The leaf verifies against the ORIGINAL stored CA certificate.
        let mut roots = rustls::RootCertStore::empty();
        roots.add(authority.ca_der().clone()).expect("root");
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier =
            rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .expect("verifier");
        use rustls::client::danger::ServerCertVerifier;
        let name = rustls::pki_types::ServerName::try_from("api.example.com").unwrap();
        verifier
            .verify_server_cert(
                &leaf.cert[0],
                &leaf.cert[1..],
                &name,
                &[],
                rustls::pki_types::UnixTime::now(),
            )
            .expect("leaf chains to the CA");
        let other = rustls::pki_types::ServerName::try_from("other.example.com").unwrap();
        assert!(verifier
            .verify_server_cert(
                &leaf.cert[0],
                &[],
                &other,
                &[],
                rustls::pki_types::UnixTime::now()
            )
            .is_err());
        assert!(reloaded.leaf_for("127.0.0.1").is_ok());
    }

    #[test]
    fn record_and_file_vault_persist() {
        let dir = tempfile::tempdir().unwrap();
        let (authority, key_pem) = CaAuthority::generate("Murge Test CA").unwrap();
        save_record(dir.path(), &authority.record).unwrap();
        assert_eq!(load_record(dir.path()), Some(authority.record.clone()));
        let vault = FileVault {
            path: dir.path().join("ca.key"),
        };
        assert_eq!(vault.load().unwrap(), None);
        vault.save(&key_pem).unwrap();
        assert_eq!(vault.load().unwrap().as_deref(), Some(key_pem.as_str()));
        vault.delete().unwrap();
        assert_eq!(vault.load().unwrap(), None);
        delete_record(dir.path());
        assert_eq!(load_record(dir.path()), None);
    }
}
