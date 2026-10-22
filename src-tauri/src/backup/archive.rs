//! Electron's version-1 encrypted JSON format (not a ZIP container).
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_FILE: usize = 16 * 1024 * 1024;
pub const MAX_CONTENT: usize = 32 * 1024 * 1024;
pub const MAX_ARCHIVE: usize = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 500;
pub const ROOT_FILES: &[&str] = &[
    "app-settings.json",
    "core-settings.json",
    "dns-enhancement.json",
    "sniffer-enhancement.json",
    "tun-config.json",
    "geodata-settings.json",
    "overrides.json",
    "proxy-selections.json",
    "proxy-bypass-policy.json",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub app_id: String,
    pub app_version: String,
    pub created_at: String,
    pub files: BTreeMap<String, String>,
    pub source_urls: BTreeMap<String, String>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_backup_path(path: &str) -> bool {
    if ROOT_FILES.contains(&path)
        || matches!(path, "substore/root.json" | "substore/sub-store.json")
    {
        return true;
    }
    if let Some(name) = path.strip_prefix("profiles/") {
        return name == "active.json"
            || [".yaml", ".meta.json"]
                .iter()
                .any(|suffix| name.strip_suffix(suffix).is_some_and(valid_id));
    }
    let Some(tail) = path.strip_prefix("substore/data/") else {
        return false;
    };
    let parts: Vec<_> = tail.split('/').collect();
    parts.len() <= 6
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.encode_utf16().count() <= 128
                && !matches!(*p, "." | "..")
                && !p
                    .chars()
                    .any(|c| c <= '\u{1f}' || matches!(c, '\\' | '/' | ':'))
        })
}

pub fn is_restore_path(path: &str) -> bool {
    is_backup_path(path)
        || path
            .strip_prefix("profiles/.sources/")
            .and_then(|p| p.strip_suffix(".source.enc"))
            .is_some_and(valid_id)
}

pub fn password(value: &str) -> Result<()> {
    if !(8..=256).contains(&value.encode_utf16().count()) {
        return Err("备份密码需要 8 至 256 个字符".into());
    }
    Ok(())
}

pub fn decode(value: &str) -> Result<Vec<u8>> {
    let bytes = STANDARD.decode(value).map_err(|_| "备份文件内容无效")?;
    if STANDARD.encode(&bytes) != value {
        return Err("备份文件内容无效".into());
    }
    Ok(bytes)
}

pub fn validate(payload: &Payload) -> Result<()> {
    if payload.app_id != crate::brand::load_brand()?.app_id
        || chrono::DateTime::parse_from_rfc3339(&payload.created_at).is_err()
    {
        return Err("备份来源或版本无效".into());
    }
    if payload.files.len() > MAX_FILES {
        return Err("备份文件数量超过上限".into());
    }
    let mut total = 0;
    for (path, encoded) in &payload.files {
        if !is_backup_path(path) {
            return Err("备份包含不允许的路径".into());
        }
        let bytes = decode(encoded)?;
        if bytes.len() > MAX_FILE {
            return Err("单个配置文件超过上限".into());
        }
        total += bytes.len();
    }
    if total > MAX_CONTENT {
        return Err("备份内容超过上限".into());
    }
    if payload.source_urls.len() > MAX_FILES {
        return Err("订阅来源数量超过上限".into());
    }
    for (id, url) in &payload.source_urls {
        if !valid_id(id) || url.encode_utf16().count() > 16384 {
            return Err("订阅来源内容无效".into());
        }
    }
    Ok(())
}

fn version(value: &str) -> Option<[u64; 3]> {
    let re = regex::Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$").ok()?;
    let captures = re.captures(value)?;
    Some([
        captures[1].parse().ok()?,
        captures[2].parse().ok()?,
        captures[3].parse().ok()?,
    ])
}

pub fn compatibility(source: &str, current: &str) -> (bool, &'static str) {
    let (Some(source), Some(current)) = (version(source), version(current)) else {
        return (false, "无法识别版本号，已阻止恢复");
    };
    if source[0] != current[0] {
        return (false, "主版本不同，已阻止恢复");
    }
    if source[0] == 0 && source[1] != current[1] {
        return (false, "0.x 版本的次版本不同，无法安全恢复");
    }
    if source > current {
        return (false, "备份来自更新的应用版本，请先升级应用");
    }
    (
        true,
        if source == current {
            "版本一致"
        } else {
            "旧版本备份，恢复后将按当前版本读取"
        },
    )
}

fn key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut key = [0; 32];
    // node:crypto.scryptSync defaults: N=16384, r=8, p=1, dkLen=32.
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|_| "备份加密参数无效")?;
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key).map_err(|_| "备份加密参数无效")?;
    Ok(key)
}

pub fn encrypt(payload: &Payload, pass: &str) -> Result<Vec<u8>> {
    password(pass)?;
    validate(payload)?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| "备份内容格式无效")?;
    if plaintext.len() > MAX_CONTENT * 2 {
        return Err("备份内容超过上限".into());
    }
    let mut salt = [0; 16];
    let mut iv = [0; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(&key(pass, &salt)?).map_err(|_| "备份加密参数无效")?;
    let mut ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_slice())
        .map_err(|_| "备份加密失败")?;
    let tag = ciphertext.split_off(ciphertext.len() - 16);
    let archive = serde_json::to_vec(&json!({"format":"murge-config-backup", "schemaVersion":1,
        "kdf":"scrypt", "salt":STANDARD.encode(salt), "iv":STANDARD.encode(iv),
        "tag":STANDARD.encode(tag), "ciphertext":STANDARD.encode(ciphertext)}))
    .map_err(|_| "备份文件格式无效")?;
    if archive.len() > MAX_ARCHIVE {
        return Err("备份文件超过上限".into());
    }
    Ok(archive)
}

pub fn inspect(archive: &[u8], pass: &str, current: &str) -> Result<(Payload, Value)> {
    password(pass)?;
    if archive.len() > MAX_ARCHIVE {
        return Err("备份文件超过上限".into());
    }
    let value: Value = serde_json::from_slice(archive).map_err(|_| "备份文件格式无效")?;
    if !value.is_object() {
        return Err("备份文件格式无效".into());
    }
    if value["format"] != "murge-config-backup"
        || value["schemaVersion"] != 1
        || value["kdf"] != "scrypt"
    {
        return Err("备份格式版本不兼容".into());
    }
    let field = |name: &str| decode(value[name].as_str().ok_or("备份文件内容无效")?);
    let (salt, iv, tag, mut ciphertext) = (
        field("salt")?,
        field("iv")?,
        field("tag")?,
        field("ciphertext")?,
    );
    if salt.len() != 16 || iv.len() != 12 || tag.len() != 16 {
        return Err("备份加密参数无效".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key(pass, &salt)?).map_err(|_| "备份加密参数无效")?;
    ciphertext.extend(tag);
    let decrypt = || -> Result<Payload> {
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
            .map_err(|_| "密码错误或备份文件已损坏")?;
        let payload = serde_json::from_slice(&plaintext).map_err(|_| "备份内容格式无效")?;
        validate(&payload)?;
        Ok(payload)
    };
    let payload = decrypt().map_err(|_| "密码错误或备份文件已损坏")?;
    let (compatible, message) = compatibility(&payload.app_version, current);
    let preview = json!({"createdAt":payload.created_at,"appVersion":payload.app_version,
        "compatible":compatible,"compatibilityMessage":message,
        "profileCount":payload.files.keys().filter(|p| p.starts_with("profiles/") && p.ends_with(".meta.json")).count(),
        "subscriptionSourceCount":payload.source_urls.len(),"includesOverrides":payload.files.contains_key("overrides.json"),
        "includesSubStore":payload.files.keys().any(|p| p.starts_with("substore/")),"fileCount":payload.files.len()});
    Ok((payload, preview))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Payload {
        Payload {
            app_id: crate::brand::load_brand().unwrap().app_id,
            app_version: "0.9.20".into(),
            created_at: "2026-09-29T00:00:00.000Z".into(),
            files: BTreeMap::from([
                (
                    "substore/root.json".into(),
                    STANDARD.encode(b"{\"root\":true}"),
                ),
                ("substore/sub-store.json".into(), STANDARD.encode(b"{}")),
            ]),
            source_urls: BTreeMap::from([(
                "id".into(),
                "https://example.com/?token=private".into(),
            )]),
        }
    }
    #[test]
    fn encrypted_roundtrip_and_wrong_password() {
        let bytes = encrypt(&payload(), "correct-password").unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private"));
        let (decoded, preview) = inspect(&bytes, "correct-password", "0.9.30").unwrap();
        assert_eq!(decoded.files.len(), 2);
        assert_eq!(preview["includesSubStore"], true);
        assert!(inspect(&bytes, "wrong-password", "0.9.30").is_err());
    }
    #[test]
    fn rejects_traversal_absolute_and_unmanaged_paths() {
        for path in [
            "/app-settings.json",
            "../app-settings.json",
            "profiles/../x.yaml",
            "C:/x",
            "substore/data/../x",
            "substore/data/a\\b",
            "logs/app.log",
            "substore/assets/file",
            "substore/data/a/b/c/d/e/f/g",
        ] {
            assert!(!is_backup_path(path), "{path}");
        }
        assert!(is_backup_path("substore/root.json"));
        assert!(is_backup_path("substore/sub-store.json"));
        assert!(is_backup_path("profiles/a-b_1.meta.json"));
        assert!(is_backup_path("substore/data/a/b/c/d/e/f"));
    }
    #[test]
    fn versions_passwords_and_canonical_base64() {
        assert!(!compatibility("0.10.0", "0.9.30").0);
        assert!(!compatibility("0.8.9", "0.9.30").0);
        assert!(!compatibility("0.9.31", "0.9.30").0);
        assert!(compatibility("0.9.20", "0.9.30").0);
        assert!(password("1234567").is_err());
        assert!(password(&"😀".repeat(129)).is_err());
        assert!(decode("Zh==").is_err());
        assert!(decode("Zg").is_err());
    }
    #[test]
    fn enforces_file_count_and_size_limits() {
        let mut value = payload();
        value.files.insert(
            "profiles/large.yaml".into(),
            STANDARD.encode(vec![b'x'; MAX_FILE + 1]),
        );
        assert!(validate(&value).is_err());
        value.files = (0..501)
            .map(|id| (format!("profiles/{id}.yaml"), String::new()))
            .collect();
        assert!(validate(&value).is_err());
    }

    #[test]
    fn electron_node_crypto_and_rust_read_each_others_archives() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        // Execute the Electron implementation's exact primitives in Node.
        // Node is a test prerequisite only; it is never a production sidecar.
        const JS: &str = r#"
const fs=require('node:fs'),c=require('node:crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(input.encrypt){
 const salt=c.randomBytes(16),iv=c.randomBytes(12),key=c.scryptSync('correct-password',salt,32);
 const cipher=c.createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(input.payload)),cipher.final()]);
 process.stdout.write(JSON.stringify({format:'murge-config-backup',schemaVersion:1,kdf:'scrypt',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
}else{
 const a=input.archive,decipher=c.createDecipheriv('aes-256-gcm',c.scryptSync('correct-password',Buffer.from(a.salt,'base64'),32),Buffer.from(a.iv,'base64'));
 decipher.setAuthTag(Buffer.from(a.tag,'base64'));
 process.stdout.write(Buffer.concat([decipher.update(Buffer.from(a.ciphertext,'base64')),decipher.final()]));
}
"#;
        let run = |input: Value| {
            let node =
                std::env::var("MURGE_KERNEL_FIXTURE_COMMAND").unwrap_or_else(|_| "node".into());
            let mut child = Command::new(node)
                .args(["-e", JS])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("Node is required for Electron archive interoperability tests");
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            output.stdout
        };
        let original = payload();
        let bytes = run(json!({"encrypt":true,"payload":original}));
        let (decoded, _) = inspect(&bytes, "correct-password", "0.9.30").unwrap();
        assert_eq!(decoded.source_urls, original.source_urls);
        let bytes = encrypt(&original, "correct-password").unwrap();
        let decoded: Payload = serde_json::from_slice(&run(
            json!({"archive":serde_json::from_slice::<Value>(&bytes).unwrap()}),
        ))
        .unwrap();
        assert_eq!(decoded.files, original.files);
        let mut invalid = original;
        invalid
            .files
            .insert("../app-settings.json".into(), STANDARD.encode(b"escape"));
        let bytes = run(json!({"encrypt":true,"payload":invalid}));
        assert!(inspect(&bytes, "correct-password", "0.9.30").is_err());
    }

    #[test]
    fn accepts_full_subscription_sized_profile_and_rejects_aggregate_overflow() {
        let mut value = payload();
        let content = STANDARD.encode(vec![b'x'; MAX_FILE]);
        value
            .files
            .insert("profiles/large.yaml".into(), content.clone());
        assert!(validate(&value).is_ok());
        value.files.insert("profiles/second.yaml".into(), content);
        assert!(validate(&value).is_err()); // plus the two Sub-Store state files
    }
}
