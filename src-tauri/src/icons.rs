//! Desktop integration channels — Rust port of the icon + network-interface
//! handlers in `src/main/ipc/register-ipc.ts` plus `remote-icon-cache.ts`
//! (Phase 3C "icons + network-interfaces" slice).
//!
//! Three channels, all returning null/[] quietly on invalid input (the TS
//! handlers never throw across the wire for these):
//! - `app:get-process-icon`: Windows-only `.exe` shell icon, LRU-cached in
//!   memory; null on every other platform (the TS handler does the same).
//! - `app:get-cached-icon`: persistent stale-if-error cache for untrusted
//!   policy icon URLs — HTTPS-only, SSRF-validated hops (public-IP allow-list
//!   with the fake-ip DNS carve-out), ≤5 redirects, 12 s timeout, 512 KiB
//!   cap, mime allow-list, base64 data URL out; the URL never touches disk
//!   (only the hashed semantic key and the image bytes are stored).
//! - `app:list-network-interfaces`: interface names with at least one
//!   address, sanitized, byte-sorted (the TS `localeCompare` on ASCII
//!   interface names matches).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::subscription::is_public_address;

const MAX_ICON_BYTES: usize = 512 * 1024;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT_MS: u64 = 12_000;
const MAX_CACHE_FILES: usize = 256;
const MAX_CACHE_BYTES: u64 = 96 * 1024 * 1024;
const PROCESS_ICON_CACHE_LIMIT: usize = 512;
const ALLOWED_TYPES: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

/// Persistent, stale-if-error cache for untrusted policy icon URLs.
pub struct RemoteIconCache {
    root: PathBuf,
    direct: reqwest::Client,
    proxy: Option<reqwest::Client>,
    /// Download dedup: one `OnceCell` per in-flight semantic key, exactly the
    /// TS `inFlight` promise map.
    in_flight: Mutex<std::collections::HashMap<String, Arc<tokio::sync::OnceCell<()>>>>,
}

impl RemoteIconCache {
    pub fn new(root: PathBuf, proxy: Option<reqwest::Client>) -> Self {
        RemoteIconCache {
            root,
            direct: build_client(None),
            proxy: proxy.map(|client| client),
            in_flight: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn get(&self, cache_key: Option<&str>, url: Option<&str>, refresh: bool) -> Value {
        let Some(cache_key) = cache_key else {
            return Value::Null;
        };
        if cache_key.is_empty() || cache_key.len() > 512 {
            return Value::Null;
        }
        let cached = self.read(cache_key);
        if !refresh {
            return cached.map(Value::String).unwrap_or(Value::Null);
        }
        let Some(url) = url else {
            return cached.map(Value::String).unwrap_or(Value::Null);
        };
        if url.len() > 2048 {
            return cached.map(Value::String).unwrap_or(Value::Null);
        }
        // Deduplicate concurrent refreshes for the same key: later callers
        // await the same OnceCell (the TS inFlight promise map).
        let cell = {
            let mut guard = self.in_flight.lock().await;
            guard
                .entry(cache_key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
                .clone()
        };
        let _ = cell
            .get_or_init(|| async {
                if let Ok(data_url) = self.download(url).await {
                    let _ = self.write(cache_key, &data_url).await;
                }
            })
            .await;
        // Release the dedup slot (the TS finally-cleanup).
        self.in_flight.lock().await.remove(cache_key);
        self.read(cache_key)
            .map(Value::String)
            .unwrap_or_else(|| cached.map(Value::String).unwrap_or(Value::Null))
    }

    fn path_for(&self, cache_key: &str) -> PathBuf {
        let digest = Sha256::digest(cache_key.as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.root.join(format!("{hex}.json"))
    }

    fn read(&self, cache_key: &str) -> Option<String> {
        let raw = std::fs::read_to_string(self.path_for(cache_key)).ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        let data_url = parsed["dataUrl"].as_str()?;
        (data_url.starts_with("data:image/")).then(|| data_url.to_string())
    }

    async fn write(&self, cache_key: &str, data_url: &str) -> std::io::Result<()> {
        let target = self.path_for(cache_key);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temporary = target.with_extension("tmp");
        // The URL can carry a subscription-owned token. Persist only the
        // image bytes under the hashed semantic key, never the raw URL.
        let body = serde_json::json!({ "dataUrl": data_url }).to_string();
        tokio::fs::write(&temporary, body.as_bytes()).await?;
        tokio::fs::rename(&temporary, &target).await?;
        let root = self.root.clone();
        let _ = tokio::task::spawn_blocking(move || prune_cache(&root)).await;
        Ok(())
    }

    /// HTTPS only, no credentials, and the literal host or every resolved
    /// address must be globally routable (fake-ip answers allowed — TLS still
    /// authenticates the hostname; note the icon policy has NO scheme carve-
    /// out here because the scheme check is unconditional).
    fn validate(&self, url: &str) -> Result<url::Url, String> {
        let parsed =
            url::Url::parse(url).map_err(|_| "unsafe icon URL".to_string())?;
        if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("unsafe icon URL".to_string());
        }
        let bare_host = parsed
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let addresses = if crate::subscription::is_public_address(&bare_host) || is_ip_like(&bare_host) {
            vec![bare_host]
        } else {
            resolve_host_system(&bare_host)
        };
        let fake_ip_only = !addresses.is_empty()
            && addresses
                .iter()
                .all(|address| regex::Regex::new(r"^198\.(?:18|19)\.").expect("fake-ip regex compiles").is_match(address));
        if addresses.is_empty() || (addresses.iter().any(|address| !is_public_address(address)) && !fake_ip_only) {
            return Err("icon host is not public".to_string());
        }
        Ok(parsed)
    }

    async fn fetch_with(&self, transport: &reqwest::Client, initial_url: &str) -> Result<String, String> {
        let sweep = self.fetch_sweep(transport, initial_url);
        match tokio::time::timeout(Duration::from_millis(FETCH_TIMEOUT_MS), sweep).await {
            Ok(result) => result,
            Err(_) => Err("icon fetch timed out".to_string()),
        }
    }

    async fn fetch_sweep(&self, transport: &reqwest::Client, initial_url: &str) -> Result<String, String> {
        let mut current_url = initial_url.to_string();
        for redirects in 0..=MAX_REDIRECTS {
            let parsed = self.validate(&current_url)?;
            let response = transport
                .get(parsed)
                .send()
                .await
                .map_err(|error| format!("icon fetch failed: {error}"))?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let Some(location) = location.filter(|_| redirects != MAX_REDIRECTS) else {
                    return Err("invalid icon redirect".to_string());
                };
                let base = url::Url::parse(&current_url).map_err(|_| "unsafe icon URL".to_string())?;
                current_url = base.join(&location).map_err(|_| "invalid icon redirect".to_string())?.to_string();
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(format!("icon HTTP {status}"));
            }
            return self.read_response(response).await;
        }
        Err("too many icon redirects".to_string())
    }

    async fn read_response(&self, mut response: reqwest::Response) -> Result<String, String> {
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if !ALLOWED_TYPES.contains(&mime.as_str()) {
            return Err("unsupported icon type".to_string());
        }
        let mut chunks: Vec<u8> = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| format!("icon body failed: {error}"))?;
            let Some(chunk) = chunk else { break };
            if chunks.len() + chunk.len() > MAX_ICON_BYTES {
                return Err("icon too large".to_string());
            }
            chunks.extend_from_slice(&chunk);
        }
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&chunks)))
    }

    async fn download(&self, url: &str) -> Result<String, String> {
        let mut last_error = String::from("no icon transport");
        let transports: [&reqwest::Client; 2] = [&self.direct, match &self.proxy {
            Some(proxy) => proxy,
            // The proxy slot is filled by the 3D system-proxy slice; until
            // then the second transport IS the direct client (a harmless
            // repeat: the disk cache dedupes the bytes).
            None => &self.direct,
        }];
        for transport in transports {
            match self.fetch_with(transport, url).await {
                Ok(data_url) => return Ok(data_url),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }
}

fn build_client(proxy: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(url) = proxy {
        if let Ok(proxy) = reqwest::Proxy::all(url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().expect("icon HTTP client builds")
}

fn is_ip_like(host: &str) -> bool {
    host.contains(':') || host.split('.').count() == 4
}

fn resolve_host_system(hostname: &str) -> Vec<String> {
    let target = if hostname.contains(':') {
        format!("[{hostname}]:443")
    } else {
        format!("{hostname}:443")
    };
    match std::net::ToSocketAddrs::to_socket_addrs(&target) {
        Ok(addrs) => addrs.map(|addr| addr.ip().to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

/// LRU prune: oldest-mtime-first until both caps hold (256 files / 96 MiB).
fn prune_cache(root: &Path) {
    let Ok(names) = std::fs::read_dir(root) else { return };
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let hex = name.strip_suffix(".json").unwrap_or("");
        if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
            continue;
        }
        if let Ok(info) = entry.metadata() {
            entries.push((entry.path(), info.len(), info.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)));
        }
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut bytes: u64 = entries.iter().map(|(_, size, _)| size).sum();
    let mut count = entries.len();
    for (path, size, _) in entries {
        if count <= MAX_CACHE_FILES && bytes <= MAX_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            count -= 1;
            bytes -= size;
        }
    }
}

/// `app:get-process-icon` — the Windows shell icon for a local `.exe` path.
/// Non-Windows platforms return null (the TS handler does the same), and so
/// does every failure.
pub fn get_process_icon(raw_path: Option<&str>) -> Value {
    let Some(raw_path) = raw_path else { return Value::Null };
    if !cfg!(windows) {
        return Value::Null;
    }
    // Local drive paths only: never let renderer input make Explorer resolve
    // a UNC/SMB path (which could cause unintended network access).
    let valid = raw_path.len() <= 1024
        && regex::Regex::new(r"^[a-zA-Z]:\\").expect("drive regex compiles").is_match(raw_path)
        && regex::Regex::new(r"(?i)\.exe$").expect("exe regex compiles").is_match(raw_path);
    if !valid {
        return Value::Null;
    }
    // LRU memory cache in front of the shell call.
    if let Some(cached) = process_icon_cached(raw_path) {
        return Value::String(cached);
    }
    match extract_process_icon(raw_path) {
        Some(data_url) => {
            process_icon_store(raw_path, data_url.clone());
            Value::String(data_url)
        }
        None => Value::Null,
    }
}

/// LRU memory cache for process icons (paths that pass the drive/exe gate).
static PROCESS_ICON_CACHE: std::sync::Mutex<Option<std::collections::VecDeque<(String, String)>>> =
    std::sync::Mutex::new(None);

fn process_icon_cached(path: &str) -> Option<String> {
    let mut guard = PROCESS_ICON_CACHE.lock().expect("process icon cache mutex");
    let cache = guard.get_or_insert_with(std::collections::VecDeque::new);
    if let Some(index) = cache.iter().position(|(key, _)| key == path) {
        let entry = cache.remove(index).expect("entry exists");
        cache.push_back(entry.clone());
        return Some(entry.1);
    }
    None
}

fn process_icon_store(path: &str, value: String) {
    let mut guard = PROCESS_ICON_CACHE.lock().expect("process icon cache mutex");
    let cache = guard.get_or_insert_with(std::collections::VecDeque::new);
    if value.len() <= 512_000 {
        cache.push_back((path.to_string(), value));
        while cache.len() > PROCESS_ICON_CACHE_LIMIT {
            cache.pop_front();
        }
    }
}

#[cfg(windows)]
fn extract_process_icon(path: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
    use windows::Win32::Graphics::Gdi::{
        GetDIBits, GetDC, ReleaseDC, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        HDC,
    };

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            Default::default(),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if result == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let icon: HICON = info.hIcon;
        let outcome = icon_to_png(icon);
        let _ = DestroyIcon(icon);
        outcome
    }

    fn icon_to_png(icon: HICON) -> Option<String> {
        unsafe {
            let mut icon_info = ICONINFO::default();
            GetIconInfo(icon, &mut icon_info).ok()?;
            let mut width = 0i32;
            let mut height = 0i32;
            // Prefer the color bitmap dimensions.
            if !icon_info.hbmColor.is_invalid() {
                let mut bmp = BITMAPINFO::default();
                bmp.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                let dc: HDC = GetDC(None);
                GetDIBits(dc, icon_info.hbmColor, 0, 0, None, &mut bmp, DIB_RGB_COLORS);
                width = bmp.bmiHeader.biWidth;
                height = bmp.bmiHeader.biHeight;
                ReleaseDC(None, dc);
            }
            let _ = DeleteObject(icon_info.hbmColor);
            let _ = DeleteObject(icon_info.hbmMask);
            if width <= 0 || height == 0 {
                return None;
            }
            let positive_height = height.abs();
            // Pull 32bpp BGRA rows.
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = width;
            bmi.bmiHeader.biHeight = -positive_height; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            let mut pixels = vec![0u8; (width as usize) * (positive_height as usize) * 4];
            let dc: HDC = GetDC(None);
            let copied = GetDIBits(
                dc,
                icon_info.hbmColor,
                0,
                positive_height as u32,
                Some(pixels.as_mut_ptr().cast()),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(None, dc);
            if copied == 0 {
                return None;
            }
            // BGRA -> RGBA. When the color bitmap carries no alpha channel
            // (copied rows are fully opaque because icons are 32bpp with
            // alpha in modern Windows), leave the bytes as-is.
            for rgba in pixels.chunks_exact_mut(4) {
                rgba.swap(0, 2);
            }
            let mut png_buffer = std::io::Cursor::new(Vec::new());
            {
                let mut encoder = png::Encoder::new(&mut png_buffer, width as u32, positive_height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&pixels).ok()?;
            }
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png_buffer.into_inner())
            ))
        }
    }
}

#[cfg(not(windows))]
fn extract_process_icon(_path: &str) -> Option<String> {
    // The TS handler returns null on non-win32 platforms; parity.
    None
}

/// `app:list-network-interfaces` — interface names carrying at least one
/// address, sanitized, sorted.
pub fn list_network_interfaces() -> Value {
    let mut names: Vec<String> = if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .map(|interface| interface.name)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    let names: Vec<String> = names
        .into_iter()
        .filter(|name| !name.is_empty() && name.len() <= 255 && !name.chars().any(|c| c.is_control()))
        .collect();
    serde_json::to_value(names).unwrap_or(Value::Array(Vec::new()))
}

/// Shared desktop state handed to the dispatch (managed in app setup).
pub struct DesktopServices {
    pub icon_cache: Arc<RemoteIconCache>,
}

impl DesktopServices {
    pub fn new(icon_cache_root: PathBuf) -> Self {
        DesktopServices {
            icon_cache: Arc::new(RemoteIconCache::new(icon_cache_root, None)),
        }
    }

    pub fn get_process_icon(&self, raw_path: Option<&str>) -> Value {
        get_process_icon(raw_path)
    }

    pub fn list_network_interfaces(&self) -> Value {
        list_network_interfaces()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_interfaces_are_sanitized_and_sorted() {
        let names = list_network_interfaces();
        let names: Vec<String> = names
            .as_array()
            .expect("interface list is an array")
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        assert!(!names.is_empty(), "a live system always has at least lo");
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "byte-sorted");
        for name in &names {
            assert!(!name.is_empty());
            assert!(name.len() <= 255);
            assert!(!name.chars().any(char::is_control));
        }
    }

    #[tokio::test]
    async fn icon_cache_round_trips_through_the_hashed_file() {
        let temp = tempfile::TempDir::new().unwrap();
        let cache = RemoteIconCache::new(temp.path().to_path_buf(), None);
        // Seed a PNG on the wire.
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
        ];
        let (_base, _server) = crate::subscription::test_support::start_http_stub(
            200,
            vec![("content-type", "image/png".to_string())],
            // The stub writes a String; encode the bytes as latin-1-safe chars.
            png.iter().map(|byte| *byte as char).collect::<String>(),
        );
        // The stub only speaks http; the cache validate() requires https, so
        // exercise the FILE layer directly (the wire layer is covered by the
        // subscription sweep tests).
        let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
        cache.write("key-1", &data_url).await.unwrap();
        assert_eq!(cache.read("key-1").as_deref(), Some(data_url.as_str()));
        // get() without refresh returns the cached value.
        let value = cache.get(Some("key-1"), None, false).await;
        assert_eq!(value, Value::String(data_url.clone()));
        // Unknown keys read as null.
        let value = cache.get(Some("missing"), Some("https://example.com/i.png"), false).await;
        assert_eq!(value, Value::Null);
        // Invalid keys return null without touching the disk.
        let value = cache.get(Some(""), Some("https://example.com/i.png"), true).await;
        assert_eq!(value, Value::Null);
        let value = cache.get(Some(&"a".repeat(513)), Some("https://example.com/i.png"), true).await;
        assert_eq!(value, Value::Null);
    }

    #[test]
    fn process_icon_rejects_non_local_paths_without_touching_the_shell() {
        // Non-Windows or invalid input: null either way (TS parity).
        assert_eq!(get_process_icon(None), Value::Null);
        assert_eq!(get_process_icon(Some("")), Value::Null);
        assert_eq!(get_process_icon(Some("relative\\path.exe")), Value::Null);
        assert_eq!(get_process_icon(Some(r"\\\\server\\share\\x.exe")), Value::Null);
        assert_eq!(get_process_icon(Some(r"C:\Program Files\app.dll")), Value::Null);
        assert_eq!(get_process_icon(Some(&format!("C:\\{}", "a".repeat(1100)))), Value::Null);
    }

    #[tokio::test]
    async fn prune_respects_the_file_cap() {
        let temp = tempfile::TempDir::new().unwrap();
        let cache = RemoteIconCache::new(temp.path().to_path_buf(), None);
        for index in 0..(MAX_CACHE_FILES + 10) {
            cache.write(&format!("key-{index}"), "data:image/png;base64,AAAA").await.unwrap();
        }
        let remaining = std::fs::read_dir(temp.path()).unwrap().flatten().count();
        assert!(
            remaining <= MAX_CACHE_FILES,
            "prune keeps the cache at or below the file cap (got {remaining})"
        );
    }
}
