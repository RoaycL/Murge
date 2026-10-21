//! Windows Electron OSCrypt v10 compatibility. No credentials enter errors.
use super::{
    archive::{decode, Result},
    managed::{self, SecretCodec},
};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use std::path::PathBuf;

pub struct Codec {
    pub root: PathBuf,
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>> {
    #[repr(C)]
    struct Blob {
        size: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let input = Blob {
        size: input.len().try_into().map_err(|_| "系统安全存储不可用")?,
        data: input.as_ptr().cast_mut(),
    };
    let mut output = Blob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    // SAFETY: blobs remain live for the call; DPAPI owns the returned allocation,
    // which is copied before being released with LocalFree on the same thread.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("系统安全存储不可用".into());
        }
        let bytes = std::slice::from_raw_parts(output.data, output.size as usize).to_vec();
        LocalFree(output.data.cast());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err("系统安全存储不可用".into())
}

impl Codec {
    fn key(&self, create: bool) -> Result<Vec<u8>> {
        managed::safe(&self.root, "Local State")?;
        let path = self.root.join("Local State");
        let mut state = if path.exists() {
            serde_json::from_slice::<serde_json::Value>(&managed::read(&path, 16 * 1024 * 1024)?)
                .map_err(|_| "系统安全存储不可用")?
        } else {
            serde_json::json!({})
        };
        if let Some(key) = state["os_crypt"]["encrypted_key"].as_str() {
            let encrypted = decode(key)?;
            let encrypted = encrypted
                .strip_prefix(b"DPAPI")
                .ok_or("系统安全存储不可用")?;
            let key = dpapi(encrypted, false)?;
            if key.len() != 32 {
                return Err("系统安全存储不可用".into());
            }
            return Ok(key);
        }
        if !create {
            return Err("系统安全存储不可用，无法备份订阅地址".into());
        }
        let mut key = [0; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let mut wrapped = b"DPAPI".to_vec();
        wrapped.extend(dpapi(&key, true)?);
        if !state.is_object() {
            return Err("系统安全存储不可用".into());
        }
        if state.get("os_crypt").is_none() {
            state["os_crypt"] = serde_json::json!({});
        }
        if !state["os_crypt"].is_object() {
            return Err("系统安全存储不可用".into());
        }
        state["os_crypt"]["encrypted_key"] = serde_json::json!(STANDARD.encode(wrapped));
        managed::atomic_write(
            &path,
            &serde_json::to_vec(&state).map_err(|_| "系统安全存储不可用")?,
        )?;
        Ok(key.to_vec())
    }
}

impl SecretCodec for Codec {
    fn encrypt(&self, value: &str) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(&self.key(true)?)
            .map_err(|_| "系统安全存储不可用，无法恢复订阅地址")?;
        let mut iv = [0; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&iv), value.as_bytes())
            .map_err(|_| "系统安全存储不可用，无法恢复订阅地址")?;
        let mut bytes = b"v10".to_vec();
        bytes.extend(iv);
        bytes.extend(ciphertext);
        Ok(bytes)
    }
    fn decrypt(&self, value: &[u8]) -> Result<String> {
        if !value.starts_with(b"v10") || value.len() < 31 {
            return Err("无法解密订阅地址".into());
        }
        let cipher =
            Aes256Gcm::new_from_slice(&self.key(false)?).map_err(|_| "无法解密订阅地址")?;
        let bytes = cipher
            .decrypt(Nonce::from_slice(&value[3..15]), &value[15..])
            .map_err(|_| "无法解密订阅地址")?;
        String::from_utf8(bytes).map_err(|_| "无法解密订阅地址".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_oscrypt_fails_without_echoing_secret() {
        let root = tempfile::tempdir().unwrap();
        let codec = Codec {
            root: root.path().into(),
        };
        let error = codec.decrypt(b"v20private-token").unwrap_err();
        assert!(!error.contains("private-token"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_oscrypt_roundtrip() {
        let root = tempfile::tempdir().unwrap();
        let codec = Codec {
            root: root.path().into(),
        };
        let bytes = codec.encrypt("https://example.com/?token=secret").unwrap();
        assert!(bytes.starts_with(b"v10"));
        assert_eq!(
            codec.decrypt(&bytes).unwrap(),
            "https://example.com/?token=secret"
        );
    }
}
