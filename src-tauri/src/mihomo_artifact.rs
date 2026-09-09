//! Pinned mihomo artifact pipeline — the Rust mirror of
//! `src/main/kernel/mihomo-artifact.ts`.
//!
//! Phase 7 resolves a fixed, official `MetaCubeX/mihomo` build and refuses to
//! run anything whose archive digest does not match the pinned SHA-256. The
//! embedded manifest is the single source of truth; a download that does not
//! match is rejected with ARTIFACT_HASH_MISMATCH before any binary is
//! extracted or executed. Only platforms whose digest was verified against the
//! official release are listed; unsupported platforms resolve to UNSUPPORTED
//! rather than to an unverified digest.
#![cfg_attr(not(test), allow(dead_code))] // resolved by the real-kernel wiring slice

use crate::error::{code, IpcError};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The pinned manifest, embedded at build time (single source of truth).
#[allow(dead_code)] // re-exported for diagnostics/tests
pub const MIHOMO_ASSETS_JSON: &str = include_str!("../../resources/mihomo-assets.json");

const MANIFEST: once_cell::sync::Lazy<Value> =
    once_cell::sync::Lazy::new(|| serde_json::from_str(MIHOMO_ASSETS_JSON).expect("mihomo-assets.json parses"));

/// The pinned bundled mihomo build (resources/mihomo-assets.json `version`).
pub fn mihomo_version() -> String {
    MANIFEST["version"].as_str().expect("manifest version").to_string()
}

pub fn mihomo_release_base() -> String {
    MANIFEST["releaseBase"].as_str().expect("manifest releaseBase").to_string()
}

/// Convenience: `MIHOMO_VERSION` without the leading `v`.
pub fn mihomo_version_no_v() -> String {
    mihomo_version().trim_start_matches('v').to_string()
}

/// One pinned asset spec (`mihomo-artifact.ts` MihomoAsset).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoAsset {
    /// Platform value the asset targets (`win32`/`linux`/`darwin`).
    pub platform: String,
    /// Arch value the asset targets (`x64`/`arm64`/...).
    pub arch: String,
    /// Official asset filename, e.g. `mihomo-windows-amd64-v1.19.30.zip`.
    pub filename: String,
    /// Full official download URL.
    pub url: String,
    /// Pinned SHA-256 digest of the archive bytes.
    pub sha256: String,
    /// Official archive size in bytes (verified against the release).
    pub size: u64,
    /// Archive sort. `gz` is a single raw gzipped binary; `zip` is a Windows zip.
    pub kind: String,
    /// Name of the executable held inside the archive before the target rename.
    pub inner_name: String,
    /// Release version (leading `v`). Absent implies the pinned version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

fn asset_catalog() -> Vec<MihomoAsset> {
    MANIFEST["assets"]
        .as_array()
        .expect("manifest assets")
        .iter()
        .map(|asset| MihomoAsset {
            platform: asset["platform"].as_str().unwrap_or_default().to_string(),
            arch: asset["arch"].as_str().unwrap_or_default().to_string(),
            filename: asset["filename"].as_str().unwrap_or_default().to_string(),
            url: format!("{}/{}", mihomo_release_base(), asset["filename"].as_str().unwrap_or_default()),
            sha256: asset["sha256"].as_str().unwrap_or_default().to_string(),
            size: asset["size"].as_u64().unwrap_or(0),
            kind: asset["kind"].as_str().unwrap_or_default().to_string(),
            inner_name: asset["innerName"].as_str().unwrap_or_default().to_string(),
            version: None,
        })
        .collect()
}

/// Resolve the pinned asset for a platform/arch pair, or null when unsupported.
pub fn mihomo_asset_for(platform: &str, arch: &str) -> Option<MihomoAsset> {
    asset_catalog().into_iter().find(|asset| asset.platform == platform && asset.arch == arch)
}

/// All supported asset specs (used for metadata tests).
pub fn mihomo_asset_catalog() -> Vec<MihomoAsset> {
    asset_catalog()
}

/// Safety slack above the pinned file size before we refuse to stream.
pub const DOWNLOAD_SIZE_SLACK_BYTES: u64 = 64 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Download transport (injectable for tests)
// ---------------------------------------------------------------------------

/// A single HTTP GET response: status, declared length and the (already
/// capped) body bytes. The real transport streams with reqwest and enforces
/// the byte ceiling + timeout itself; tests inject static bytes.
pub struct DownloadResponse {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Vec<u8>,
}

pub type DownloadTransport =
    Arc<dyn Fn(String, u64) -> futures_util::future::BoxFuture<'static, Result<DownloadResponse, String>> + Send + Sync>;

/// The production transport: reqwest GET with redirect follow, a hard byte
/// ceiling (the stream is aborted past it) and an overall timeout.
pub fn real_download_transport() -> DownloadTransport {
    Arc::new(move |url: String, max_bytes: u64| {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(DEFAULT_DOWNLOAD_TIMEOUT_SECS))
                .build()
                .map_err(|error| error.to_string())?;
            let response = client
                .get(&url)
                .timeout(Duration::from_secs(DEFAULT_DOWNLOAD_TIMEOUT_SECS))
                .send()
                .await
                .map_err(|error| format!("Mihomo download request failed for {url}: {error}"))?
                .error_for_status()
                .map_err(|error| format!("Mihomo download returned HTTP {} for {url}", error.status().map(|s| s.as_u16()).unwrap_or(0)))?;
            let content_length = response.content_length();
            if let Some(length) = content_length {
                if length > max_bytes {
                    return Err(format!(
                        "Mihomo archive {url} declares content-length {length}, above the {max_bytes}-byte limit"
                    ));
                }
            }
            // Stream the body while capping it so a lying server cannot balloon
            // memory past the ceiling.
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut body: Vec<u8> = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| error.to_string())?;
                if body.len() as u64 + chunk.len() as u64 > max_bytes {
                    return Err(format!("mihomo download exceeded the {max_bytes}-byte limit"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(DownloadResponse { status: 200, content_length, body })
        })
    })
}

/// Stream bytes into `destFile` while hashing and capping them (the TS
/// `writeAndHash`).
fn write_and_hash(body: &[u8], dest_file: &Path, max_bytes: u64) -> Result<(String, u64), String> {
    if body.len() as u64 > max_bytes {
        return Err(format!("mihomo download exceeded the {max_bytes}-byte limit"));
    }
    let mut hasher = Sha256::new();
    hasher.update(body);
    std::fs::write(dest_file, body).map_err(|error| error.to_string())?;
    Ok((format!("{:x}", hasher.finalize()), body.len() as u64))
}

/// Download the pinned asset, write it to disk while computing its SHA-256,
/// and reject it unless the digest and byte size exactly match the pinned
/// values. Returns the archive path. The archive is never extracted here —
/// extraction is a separate, explicit step so a bad digest can never produce
/// an executable.
pub async fn download_and_verify_mihomo(
    asset: &MihomoAsset,
    dest_dir: &Path,
    transport: &DownloadTransport,
) -> Result<PathBuf, IpcError> {
    std::fs::create_dir_all(dest_dir).map_err(|error| {
        IpcError::code(code::ARTIFACT_DOWNLOAD_FAILED, format!("Failed to create {}: {error}", dest_dir.display()))
    })?;
    let max_bytes = asset.size.saturating_add(DOWNLOAD_SIZE_SLACK_BYTES);
    let archive_path = dest_dir.join(&asset.filename);
    // The timeout budget (120s default) is enforced inside the real
    // transport; injected transports carry their own determinism.
    let response = (transport)(asset.url.clone(), max_bytes)
        .await
        .map_err(|message| IpcError::code(code::ARTIFACT_DOWNLOAD_FAILED, message))?;
    if response.status != 200 {
        return Err(IpcError::code(
            code::ARTIFACT_DOWNLOAD_FAILED,
            format!("Mihomo download returned HTTP {} for {}", response.status, asset.url),
        ));
    }
    if let Some(length) = response.content_length {
        if length > max_bytes {
            return Err(IpcError::code(
                code::ARTIFACT_DOWNLOAD_FAILED,
                format!("Mihomo archive {} declares content-length {length}, above the {max_bytes}-byte limit", asset.url),
            ));
        }
    }
    let result = write_and_hash(&response.body, &archive_path, max_bytes);
    let (digest, bytes) = match result {
        Ok(result) => result,
        Err(message) => {
            let _ = std::fs::remove_file(&archive_path);
            return Err(IpcError::code(
                code::ARTIFACT_DOWNLOAD_FAILED,
                format!("Failed to save mihomo archive {}: {message}", asset.filename),
            ));
        }
    };
    if digest != asset.sha256 {
        let _ = std::fs::remove_file(&archive_path);
        return Err(IpcError::code(
            code::ARTIFACT_HASH_MISMATCH,
            format!("SHA-256 mismatch for {}: expected {}, got {}", asset.filename, asset.sha256, digest),
        ));
    }
    if bytes != asset.size {
        let _ = std::fs::remove_file(&archive_path);
        return Err(IpcError::code(
            code::ARTIFACT_HASH_MISMATCH,
            format!(
                "SHA-256-matched but byte-size mismatch for {}: expected {}, got {bytes}",
                asset.filename, asset.size
            ),
        ));
    }
    Ok(archive_path)
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// Compute the SHA-256 of a file's bytes.
pub fn sha256_file(path: &Path) -> Result<String, IpcError> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to open {}: {error}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to read {}: {error}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Assert `path` is a real regular file (not a symlink/reparse point).
fn assert_regular_file(path: &Path, label: &str) -> Result<(), IpcError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Mihomo {label} is missing: {error}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(IpcError::code(
            code::ARTIFACT_EXTRACT_FAILED,
            format!("Mihomo {label} is a symlink; refusing to use it"),
        ));
    }
    if !metadata.is_file() {
        return Err(IpcError::code(
            code::ARTIFACT_EXTRACT_FAILED,
            format!("Mihomo {label} is not a regular file"),
        ));
    }
    Ok(())
}

/// Default extraction: gz via flate2; zip via the pinned-reader used by the
/// Sub-Store backend (never shells out, unlike the TS PowerShell fallback).
fn extract_archive_bytes(asset: &MihomoAsset, archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let bytes =
        std::fs::read(archive_path).map_err(|error| format!("Failed to read {}: {error}", archive_path.display()))?;
    if asset.kind == "gz" {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut plain: Vec<u8> = Vec::new();
        decoder.read_to_end(&mut plain).map_err(|error| format!("gunzip failed: {error}"))?;
        std::fs::write(dest_dir.join(&asset.inner_name), plain)
            .map_err(|error| format!("Failed to write extracted binary: {error}"))?;
        return Ok(());
    }
    crate::substore_zip::extract_zip_bytes(&bytes, dest_dir)
        .map(|_| ())
        .map_err(|error| format!("unzip failed: {}", error.0))
}

/// Extract the verified archive into `destDir` and return the absolute path of
/// the executable. Extraction refuses to believe a member path that escapes
/// the destination directory, refuses symlinks, makes the binary executable on
/// non-Windows, and renames it to a stable basename so callers never depend on
/// the archive's internal name.
pub fn extract_mihomo(asset: &MihomoAsset, dest_dir: &Path, archive_path: &Path, binary_name: Option<&str>) -> Result<PathBuf, IpcError> {
    std::fs::create_dir_all(dest_dir).map_err(|error| {
        IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to create {}: {error}", dest_dir.display()))
    })?;
    extract_archive_bytes(asset, archive_path, dest_dir).map_err(|message| {
        IpcError::code(
            code::ARTIFACT_EXTRACT_FAILED,
            format!("Failed to extract mihomo archive {}: {message}", asset.filename),
        )
    })?;

    // The selected asset, rather than the host running the resolver/tests,
    // determines its target basename and permission semantics. This also keeps
    // cross-platform artifact tests truthful on Windows runners.
    let is_win = asset.platform == "win32";
    let target_name = binary_name
        .map(str::to_string)
        .unwrap_or_else(|| if is_win { "mihomo.exe".to_string() } else { "mihomo".to_string() });
    let extracted_path = dest_dir.join(&asset.inner_name);
    let target_path = dest_dir.join(&target_name);

    // Guard against paths inside the archive that escaped the destination dir.
    let dest_root = dest_dir.canonicalize().unwrap_or_else(|_| dest_dir.to_path_buf());
    let resolved_extracted = extracted_path.canonicalize().unwrap_or_else(|_| extracted_path.clone());
    if !resolved_extracted.starts_with(&dest_root) {
        return Err(IpcError::code(
            code::ARTIFACT_EXTRACT_FAILED,
            "Mihomo archive member escaped the extraction directory",
        ));
    }
    assert_regular_file(&extracted_path, "extracted binary")?;

    if resolved_extracted != target_path.canonicalize().unwrap_or_else(|_| target_path.clone()) {
        std::fs::rename(&resolved_extracted, &target_path).map_err(|error| {
            IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to rename extracted binary: {error}"))
        })?;
    }
    assert_regular_file(&target_path, "binary")?;
    #[cfg(unix)]
    if !is_win {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o755)).map_err(|error| {
            IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to chmod the binary: {error}"))
        })?;
    }
    Ok(target_path)
}

// ---------------------------------------------------------------------------
// Provenance marker
// ---------------------------------------------------------------------------

/// Structured marker proving the on-disk binary is the pinned, verified one.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoVerifiedMarker {
    pub version: String,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(rename = "binarySha256")]
    pub binary_sha256: String,
    pub platform: String,
    pub arch: String,
    pub binary: String,
}

const MARKER_FILENAME: &str = ".mihomo-verified";
const MARKER_TMP_FILENAME: &str = ".mihomo-verified.tmp";

/// Write the marker atomically (tmp + rename) so a crash never leaves a half marker.
pub fn write_verified_marker(dir: &Path, marker: &MihomoVerifiedMarker) -> Result<(), IpcError> {
    let tmp = dir.join(MARKER_TMP_FILENAME);
    let final_path = dir.join(MARKER_FILENAME);
    std::fs::write(&tmp, serde_json::to_vec(marker).expect("marker serializes")).map_err(|error| {
        IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to write the marker: {error}"))
    })?;
    std::fs::rename(&tmp, &final_path)
        .map_err(|error| IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to commit the marker: {error}")))?;
    Ok(())
}

/// Read + shape-check the marker; returns null when absent/malformed.
pub fn read_verified_marker(dir: &Path) -> Option<MihomoVerifiedMarker> {
    let raw = std::fs::read_to_string(dir.join(MARKER_FILENAME)).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// The resolution result handed to the kernel supervisor.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMihomoBinary {
    /// Absolute path of the reproducible executable.
    pub path: PathBuf,
    /// Pinned mihomo version (without leading 'v').
    pub version: String,
    /// The asset spec that was verified and used.
    pub asset: MihomoAsset,
    /// Archive SHA-256 that was verified.
    pub sha256: String,
    /// Download URL that was used.
    pub url: String,
    /// Whether the binary was already present and verified (no re-download).
    pub reused: bool,
}

/// Resolve the pinned mihomo for the requested platform/arch into
/// `workspace_dir`, downloading + verifying + extracting only when the on-disk
/// binary can be proven to be the pinned, verified artifact. Provenance is
/// recorded in a structured marker (version, archive + binary SHA-256,
/// platform, arch) and the binary is re-hashed on every reuse; a tampered,
/// truncated, forged or cross-platform binary is quarantined and re-resolved
/// from a fresh verified archive.
pub async fn resolve_mihomo(
    platform: &str,
    arch: &str,
    workspace_dir: &Path,
    transport: &DownloadTransport,
) -> Result<ResolvedMihomoBinary, IpcError> {
    let Some(asset) = mihomo_asset_for(platform, arch) else {
        return Err(IpcError::code(
            crate::error::code::UNSUPPORTED,
            format!("No pinned mihomo artifact for {platform}/{arch} (version {})", mihomo_version()),
        ));
    };
    resolve_mihomo_asset(&asset, workspace_dir, transport).await
}

/// Resolve an explicit (possibly non-pinned) mihomo asset into
/// `workspace_dir`. The same down-to-the-byte verification applies.
pub async fn resolve_mihomo_asset(
    asset: &MihomoAsset,
    workspace_dir: &Path,
    transport: &DownloadTransport,
) -> Result<ResolvedMihomoBinary, IpcError> {
    let version_no_v = asset
        .version
        .as_deref()
        .map(|version| version.trim_start_matches('v').to_string())
        .unwrap_or_else(mihomo_version_no_v);
    std::fs::create_dir_all(workspace_dir).map_err(|error| {
        IpcError::code(code::ARTIFACT_EXTRACT_FAILED, format!("Failed to create {}: {error}", workspace_dir.display()))
    })?;
    let is_win = asset.platform == "win32";
    let target_name = if is_win { "mihomo.exe" } else { "mihomo" }.to_string();
    let marker_path = workspace_dir.join(MARKER_FILENAME);
    let binary_path = workspace_dir.join(&target_name);

    let mut reusable = false;
    if let Some(marker) = read_verified_marker(workspace_dir) {
        if marker.version == version_no_v
            && marker.archive_sha256 == asset.sha256
            && marker.platform == asset.platform
            && marker.arch == asset.arch
            && marker.binary == target_name
        {
            if assert_regular_file(&binary_path, "binary").is_ok()
                && sha256_file(&binary_path).is_ok_and(|digest| digest == marker.binary_sha256)
            {
                reusable = true;
            }
        }
    }

    if !reusable {
        // Quarantine any stale/binary payload before a fresh download so a
        // parallel caller never executes a half-verified artifact.
        let _ = std::fs::remove_file(&binary_path);
        let _ = std::fs::remove_file(&marker_path);
        let archive_path = download_and_verify_mihomo(asset, workspace_dir, transport).await?;
        let extracted = extract_mihomo(asset, workspace_dir, &archive_path, Some(&target_name))?;
        write_verified_marker(
            workspace_dir,
            &MihomoVerifiedMarker {
                version: version_no_v.clone(),
                archive_sha256: asset.sha256.clone(),
                binary_sha256: sha256_file(&extracted)?,
                platform: asset.platform.clone(),
                arch: asset.arch.clone(),
                binary: target_name.clone(),
            },
        )?;
        return Ok(ResolvedMihomoBinary {
            path: extracted,
            version: version_no_v,
            asset: asset.clone(),
            sha256: asset.sha256.clone(),
            url: asset.url.clone(),
            reused: false,
        });
    }

    Ok(ResolvedMihomoBinary {
        path: binary_path,
        version: version_no_v,
        asset: asset.clone(),
        sha256: asset.sha256.clone(),
        url: asset.url.clone(),
        reused: true,
    })
}

// ---------------------------------------------------------------------------
// Release-asset composition (specific versions)
// ---------------------------------------------------------------------------

/// Accept a GitHub release-asset `digest` (`sha256:<hex>`) or a bare `<hex>`.
fn extract_sha256(digest: &Value) -> Option<String> {
    let digest = digest.as_str()?;
    if let Some(hex) = digest.strip_prefix("sha256:") {
        if hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Some(hex.to_lowercase());
        }
        return None;
    }
    if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(digest.to_lowercase());
    }
    None
}

/// The filename "token" mihomo uses for a platform/arch, e.g. `windows-amd64`.
pub fn mihomo_asset_token(platform: &str, arch: &str) -> String {
    match platform {
        "win32" => match arch {
            "arm64" => "windows-arm64".to_string(),
            "x64" => "windows-amd64".to_string(),
            "x86" => "windows-386".to_string(),
            other => format!("windows-{other}"),
        },
        "linux" => match arch {
            "arm64" => "linux-arm64".to_string(),
            "x64" => "linux-amd64".to_string(),
            "x86" => "linux-386".to_string(),
            other => format!("linux-{other}"),
        },
        "darwin" => match arch {
            "arm64" => "darwin-arm64".to_string(),
            "x64" => "darwin-amd64".to_string(),
            other => format!("darwin-{other}"),
        },
        other => format!("{other}-{arch}"),
    }
}

/// mihomo ships Windows builds as `.zip` and everything else as a raw `.gz`.
pub fn mihomo_asset_kind_for(platform: &str) -> &'static str {
    if platform == "win32" { "zip" } else { "gz" }
}

/// The executable name held inside the archive for a platform/arch.
pub fn mihomo_asset_inner_name(platform: &str, arch: &str, kind: &str) -> String {
    let token = mihomo_asset_token(platform, arch);
    if kind == "zip" { format!("mihomo-{token}.exe") } else { format!("mihomo-{token}") }
}

/// Expected release asset filename for a version (leading `v`).
pub fn mihomo_asset_filename(platform: &str, arch: &str, version: &str) -> String {
    format!("mihomo-{}-{}.{}", mihomo_asset_token(platform, arch), version, mihomo_asset_kind_for(platform))
}

/// Build a [`MihomoAsset`] for `version` from a matching GitHub release
/// asset, or null when the asset does not correspond to this platform/arch or
/// carries no usable digest/size. The digest is taken from the upstream
/// release metadata, so a specific-version install is still verified to the
/// byte.
pub fn build_mihomo_asset_from_release(
    version: &str,
    platform: &str,
    arch: &str,
    release_asset: &Value,
) -> Option<MihomoAsset> {
    let kind = mihomo_asset_kind_for(platform);
    let expected_name = mihomo_asset_filename(platform, arch, version);
    if release_asset["name"].as_str() != Some(expected_name.as_str()) {
        return None;
    }
    let sha256 = extract_sha256(&release_asset["digest"])?;
    let size = release_asset["size"].as_u64().unwrap_or(0);
    if size == 0 {
        return None;
    }
    Some(MihomoAsset {
        platform: platform.to_string(),
        arch: arch.to_string(),
        filename: release_asset["name"].as_str().expect("checked name").to_string(),
        url: release_asset["browser_download_url"].as_str().unwrap_or_default().to_string(),
        sha256,
        size,
        kind: kind.to_string(),
        inner_name: mihomo_asset_inner_name(platform, arch, kind),
        version: Some(version.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Release-metadata client (kernel-manager-service.ts githubRequest)
// ---------------------------------------------------------------------------

/// Every other network path in the app is bounded; the release-metadata API
/// call must be too (a hung api.github.com connection would latch the
/// renderer busy flag for minutes).
pub const GITHUB_API_TIMEOUT_SECS: u64 = 30;
const MIHOMO_OWNER: &str = "MetaCubeX";
const MIHOMO_REPO: &str = "mihomo";

/// One published release asset (`kernel-manager-service.ts` GithubRelease).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoReleaseAsset {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub browser_download_url: String,
}

/// GET a GitHub API URL and decode the JSON body with the exact TS error
/// mapping (timeout vs failure vs status).
async fn github_get_json(url: &str) -> Result<Value, IpcError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(GITHUB_API_TIMEOUT_SECS))
        .build()
        .map_err(|error| IpcError::code(code::ARTIFACT_DOWNLOAD_FAILED, format!("GitHub 请求失败：{error}")))?;
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "mihomo-kernel-manager")
        .timeout(std::time::Duration::from_secs(GITHUB_API_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| {
            let message = error.to_string();
            if regex::Regex::new(r"(?i)timeout|abort").expect("timeout regex").is_match(&message) {
                IpcError::code(
                    code::ARTIFACT_DOWNLOAD_FAILED,
                    format!("GitHub 请求超时（{}ms）", GITHUB_API_TIMEOUT_SECS * 1000),
                )
            } else {
                IpcError::code(code::ARTIFACT_DOWNLOAD_FAILED, format!("GitHub 请求失败：{message}"))
            }
        })?;
    if !response.status().is_success() {
        return Err(IpcError::code(
            code::ARTIFACT_DOWNLOAD_FAILED,
            format!("GitHub 请求失败：{}", response.status().as_u16()),
        ));
    }
    response.json::<Value>().await.map_err(|error| {
        IpcError::code(code::ARTIFACT_DOWNLOAD_FAILED, format!("GitHub 请求失败：{error}"))
    })
}

/// The published version tags (`fetchGithubVersions`): per_page=50, tags
/// filtered to the strict release shape.
pub async fn fetch_github_versions() -> Result<Vec<String>, IpcError> {
    let url = format!("https://api.github.com/repos/{MIHOMO_OWNER}/{MIHOMO_REPO}/releases?per_page=50");
    let releases = github_get_json(&url).await?;
    let pattern = regex::Regex::new(r"^v\d+\.\d+\.\d+$").expect("version tag regex");
    let Some(releases) = releases.as_array() else {
        return Ok(Vec::new());
    };
    Ok(releases
        .iter()
        .filter_map(|release| release["tag_name"].as_str())
        .filter(|tag| pattern.is_match(tag))
        .map(str::to_string)
        .collect())
}

/// One release's asset metadata (`fetchGithubReleaseAssets`).
pub async fn fetch_github_release_assets(version: &str) -> Result<Vec<MihomoReleaseAsset>, IpcError> {
    let url = format!("https://api.github.com/repos/{MIHOMO_OWNER}/{MIHOMO_REPO}/releases/tags/{version}");
    let release = github_get_json(&url).await?;
    let Some(assets) = release["assets"].as_array() else {
        return Ok(Vec::new());
    };
    Ok(assets
        .iter()
        .map(|asset| MihomoReleaseAsset {
            name: asset["name"].as_str().unwrap_or_default().to_string(),
            digest: asset["digest"].as_str().map(str::to_string),
            size: asset["size"].as_u64(),
            browser_download_url: asset["browser_download_url"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fake_asset(bytes: &[u8], overrides: Value) -> MihomoAsset {
        let platform = overrides["platform"].as_str().unwrap_or("win32").to_string();
        let arch = overrides["arch"].as_str().unwrap_or("x64").to_string();
        let kind = overrides["kind"].as_str().unwrap_or("zip").to_string();
        let inner = overrides["innerName"].as_str().map(str::to_string).unwrap_or_else(|| {
            if kind == "zip" { "mihomo-windows-amd64.exe".to_string() } else { "mihomo-linux-arm64".to_string() }
        });
        let digest = {
            let mut hasher = Sha256::new();
            hasher.update(bytes);
            format!("{:x}", hasher.finalize())
        };
        MihomoAsset {
            platform,
            arch,
            filename: overrides["filename"].as_str().unwrap_or("mihomo-test.zip").to_string(),
            url: overrides["url"].as_str().unwrap_or("https://example.invalid/asset.zip").to_string(),
            sha256: digest,
            size: bytes.len() as u64,
            kind,
            inner_name: inner,
            version: overrides["version"].as_str().map(str::to_string),
        }
    }

    fn transport_from_bytes(bytes: &'static [u8]) -> DownloadTransport {
        Arc::new(move |_url: String, _max: u64| {
            let body = bytes.to_vec();
            Box::pin(async move {
                Ok(DownloadResponse { status: 200, content_length: Some(body.len() as u64), body })
            })
        })
    }

    pub(crate) fn transport_error(message: &'static str) -> DownloadTransport {
        Arc::new(move |_url: String, _max: u64| {
            let message = message.to_string();
            Box::pin(async move { Err(message) })
        })
    }

    fn gz_bytes(plain: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|entries| entries.filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn manifest_pins_the_official_version_and_release_base() {
        assert_eq!(mihomo_version(), "v1.19.30");
        assert_eq!(mihomo_release_base(), "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30");
        assert_eq!(mihomo_version_no_v(), "1.19.30");
    }

    #[test]
    fn catalog_exposes_the_verified_assets() {
        let win64 = mihomo_asset_for("win32", "x64").expect("win32/x64");
        assert_eq!(win64.filename, "mihomo-windows-amd64-v1.19.30.zip");
        assert_eq!(win64.sha256.len(), 64);
        assert_eq!(win64.size, 18499620);
        assert_eq!(win64.kind, "zip");
        assert_eq!(win64.inner_name, "mihomo-windows-amd64.exe");
        assert!(win64.url.starts_with(mihomo_release_base().as_str()));
        let winarm = mihomo_asset_for("win32", "arm64").expect("win32/arm64");
        assert_eq!(winarm.filename, "mihomo-windows-arm64-v1.19.30.zip");
        assert_eq!(winarm.inner_name, "mihomo-windows-arm64.exe");
        let linux = mihomo_asset_for("linux", "arm64").expect("linux/arm64");
        assert_eq!(linux.kind, "gz");
        assert_eq!(linux.inner_name, "mihomo-linux-arm64");
        // Unsupported platforms resolve to None (never an unverified digest).
        assert!(mihomo_asset_for("freebsd", "x64").is_none());
        assert!(mihomo_asset_for("darwin", "x64").is_none());
        // Catalog consistency: URL prefix + distinct digests + token mapping.
        let catalog = mihomo_asset_catalog();
        for asset in &catalog {
            assert!(asset.url.starts_with(mihomo_release_base().as_str()));
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.size > 0);
        }
        assert_eq!(mihomo_asset_token("win32", "x64"), "windows-amd64");
        assert_eq!(mihomo_asset_token("linux", "arm64"), "linux-arm64");
        assert_eq!(mihomo_asset_kind_for("win32"), "zip");
        assert_eq!(mihomo_asset_kind_for("linux"), "gz");
        assert_eq!(mihomo_asset_filename("win32", "x64", "v1.19.30"), "mihomo-windows-amd64-v1.19.30.zip");
        assert_eq!(mihomo_asset_inner_name("linux", "arm64", "gz"), "mihomo-linux-arm64");
    }

    #[tokio::test]
    async fn download_streams_bytes_when_the_digest_matches() {
        let temp = tempfile::TempDir::new().unwrap();
        let bytes: &'static [u8] = Box::leak(b"archive bytes".to_vec().into_boxed_slice());
        let asset = fake_asset(bytes, serde_json::json!({}));
        let archive = download_and_verify_mihomo(&asset, temp.path(), &transport_from_bytes(bytes)).await.unwrap();
        assert!(archive.exists());
        assert_eq!(std::fs::read(&archive).unwrap(), bytes);
    }

    #[tokio::test]
    async fn download_rejects_and_removes_on_digest_mismatch() {
        let temp = tempfile::TempDir::new().unwrap();
        let asset = fake_asset(b"pinned bytes", serde_json::json!({}));
        let wrong: &'static [u8] = Box::leak(b"bytes that do not match the pinned digest".to_vec().into_boxed_slice());
        let error = download_and_verify_mihomo(&asset, temp.path(), &transport_from_bytes(wrong)).await.unwrap_err();
        assert!(
            error.0.starts_with("PROTOCOL_ERROR:ARTIFACT_HASH_MISMATCH::SHA-256 mismatch for mihomo-test.zip"),
            "{}",
            error.0
        );
        assert!(!temp.path().join(&asset.filename).exists());
    }

    #[tokio::test]
    async fn download_rejects_truncated_streams() {
        let temp = tempfile::TempDir::new().unwrap();
        let asset = fake_asset(b"pinned bytes", serde_json::json!({}));
        // Same digest tail is impossible; fewer bytes simply fails the digest
        // (and even a padded match would fail the byte-size check).
        let short: &'static [u8] = Box::leak(b"pinned".to_vec().into_boxed_slice());
        let error = download_and_verify_mihomo(&asset, temp.path(), &transport_from_bytes(short)).await.unwrap_err();
        assert!(error.0.contains("ARTIFACT_HASH_MISMATCH"), "{}", error.0);
        // A digest-matching but shorter body fails the byte-size check.
        let bytes: &'static [u8] = Box::leak(b"pinned bytes".to_vec().into_boxed_slice());
        let mut asset2 = fake_asset(bytes, serde_json::json!({}));
        asset2.size = bytes.len() as u64 + 1;
        let error = download_and_verify_mihomo(&asset2, temp.path(), &transport_from_bytes(bytes)).await.unwrap_err();
        assert!(
            error.0.contains("SHA-256-matched but byte-size mismatch"),
            "{}",
            error.0
        );
        assert!(!temp.path().join(&asset2.filename).exists());
    }

    #[tokio::test]
    async fn download_rejects_oversized_content_length_and_transport_errors() {
        let temp = tempfile::TempDir::new().unwrap();
        let bytes: &'static [u8] = Box::leak(b"archive bytes".to_vec().into_boxed_slice());
        let asset = fake_asset(bytes, serde_json::json!({}));
        // Declared content-length above size + slack refuses before streaming.
        let transport: DownloadTransport = {
            Arc::new(move |_url: String, _max: u64| {
                Box::pin(async move {
                    Ok(DownloadResponse { status: 200, content_length: Some(u64::MAX), body: Vec::new() })
                })
            })
        };
        let error = download_and_verify_mihomo(&asset, temp.path(), &transport).await.unwrap_err();
        assert!(error.0.contains("declares content-length"), "{}", error.0);
        // Transport failure surfaces as ARTIFACT_DOWNLOAD_FAILED.
        let error = download_and_verify_mihomo(&asset, temp.path(), &transport_error("connection reset")).await.unwrap_err();
        assert_eq!(error.0, "PROTOCOL_ERROR:ARTIFACT_DOWNLOAD_FAILED::connection reset");
        // A body larger than size + slack is capped.
        let big: &'static [u8] = Box::leak(vec![0u8; (asset.size + DOWNLOAD_SIZE_SLACK_BYTES + 1) as usize].into_boxed_slice());
        let error = download_and_verify_mihomo(&asset, temp.path(), &transport_from_bytes(big)).await.unwrap_err();
        assert!(error.0.contains("exceeded") || error.0.contains("byte"), "{}", error.0);
        assert!(!temp.path().join(&asset.filename).exists());
    }

    #[tokio::test]
    async fn extraction_renames_and_sets_permissions() {
        let temp = tempfile::TempDir::new().unwrap();
        let dest = temp.path().join("dest");
        // gz → raw binary, renamed to the stable target name.
        let gz = gz_bytes(b"ELF");
        std::fs::write(temp.path().join("archive.gz"), &gz).unwrap();
        let asset = fake_asset(&gz, serde_json::json!({ "platform": "linux", "arch": "arm64", "kind": "gz", "innerName": "mihomo-linux-arm64", "filename": "archive.gz" }));
        let target = extract_mihomo(&asset, &dest, temp.path().join("archive.gz").as_path(), None).unwrap();
        assert_eq!(target, dest.join("mihomo"));
        assert_eq!(std::fs::read(&target).unwrap(), b"ELF");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "the binary must be executable");
        }
        // zip → inner exe renamed to mihomo.exe.
        let zip = crate::substore_zip::zip_stored_bytes(vec![("mihomo-windows-amd64.exe", b"PE".to_vec())]);
        std::fs::write(temp.path().join("archive.zip"), &zip).unwrap();
        let asset = fake_asset(&zip, serde_json::json!({ "platform": "win32", "arch": "x64", "kind": "zip", "innerName": "mihomo-windows-amd64.exe", "filename": "archive.zip" }));
        let target = extract_mihomo(&asset, &dest, temp.path().join("archive.zip").as_path(), None).unwrap();
        assert_eq!(target, dest.join("mihomo.exe"));
        assert_eq!(std::fs::read(&target).unwrap(), b"PE");
    }

    #[tokio::test]
    async fn extraction_marks_failures_and_guards_the_destination() {
        let temp = tempfile::TempDir::new().unwrap();
        let dest = temp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        // A corrupt gz fails as ARTIFACT_EXTRACT_FAILED with the wrapped copy.
        std::fs::write(temp.path().join("archive.gz"), b"not gzip at all").unwrap();
        let asset = fake_asset(b"x", serde_json::json!({ "platform": "linux", "arch": "arm64", "kind": "gz", "innerName": "mihomo-linux-arm64", "filename": "archive.gz" }));
        let error = extract_mihomo(&asset, &dest, temp.path().join("archive.gz").as_path(), None).unwrap_err();
        assert!(
            error.0.starts_with("PROTOCOL_ERROR:ARTIFACT_EXTRACT_FAILED::Failed to extract mihomo archive archive.gz"),
            "{}",
            error.0
        );
        // A missing member is a regular-file refusal.
        let zip = crate::substore_zip::zip_stored_bytes(vec![("other.bin", b"PE".to_vec())]);
        std::fs::write(temp.path().join("archive2.zip"), &zip).unwrap();
        let asset = fake_asset(&zip, serde_json::json!({ "platform": "win32", "arch": "x64", "kind": "zip", "innerName": "mihomo-windows-amd64.exe", "filename": "archive2.zip" }));
        let error = extract_mihomo(&asset, &dest, temp.path().join("archive2.zip").as_path(), None).unwrap_err();
        assert!(error.0.contains("is missing"), "{}", error.0);
    }

    #[test]
    fn marker_roundtrip_and_malformed_refusal() {
        let temp = tempfile::TempDir::new().unwrap();
        assert!(read_verified_marker(temp.path()).is_none());
        write_verified_marker(
            temp.path(),
            &MihomoVerifiedMarker {
                version: "1.19.30".to_string(),
                archive_sha256: "a".repeat(64),
                binary_sha256: "b".repeat(64),
                platform: "win32".to_string(),
                arch: "x64".to_string(),
                binary: "mihomo.exe".to_string(),
            },
        )
        .unwrap();
        let marker = read_verified_marker(temp.path()).unwrap();
        assert_eq!(marker.version, "1.19.30");
        assert_eq!(marker.binary, "mihomo.exe");
        // Malformed JSON → None (never a panic).
        std::fs::write(temp.path().join(MARKER_FILENAME), "{not json").unwrap();
        assert!(read_verified_marker(temp.path()).is_none());
    }

    #[tokio::test]
    async fn resolve_rejects_unsupported_platforms() {
        let temp = tempfile::TempDir::new().unwrap();
        let error = resolve_mihomo("freebsd", "x64", temp.path(), &transport_error("never")).await.unwrap_err();
        assert!(
            error.0.starts_with("PROTOCOL_ERROR:UNSUPPORTED::No pinned mihomo artifact for freebsd/x64"),
            "{}",
            error.0
        );
    }

    #[tokio::test]
    async fn resolve_downloads_verifies_and_writes_the_marker() {
        let temp = tempfile::TempDir::new().unwrap();
        let asset = mihomo_asset_for("win32", "x64").unwrap();
        assert!(asset.url.starts_with(mihomo_release_base().as_str()));
        // The pinned digest cannot be forged by a fake transport, so the
        // fresh-download path must REJECT (the real digest arrives from the
        // real release only). Provenance: the directory ends empty.
        let wrong: &'static [u8] = Box::leak(b"bytes that do not match the pinned digest".to_vec().into_boxed_slice());
        let error = resolve_mihomo("win32", "x64", temp.path(), &transport_from_bytes(wrong)).await.unwrap_err();
        assert!(error.0.contains("ARTIFACT_HASH_MISMATCH"), "{}", error.0);
        assert_eq!(dir_entries(temp.path()), Vec::<String>::new());
    }

    #[tokio::test]
    async fn resolve_reuses_and_reverifies_an_explicit_asset() {
        let temp = tempfile::TempDir::new().unwrap();
        let payload = b"existing verified payload";
        let binary = temp.path().join("mihomo.exe");
        std::fs::write(&binary, payload).unwrap();
        let binary_sha256 = sha256_file(&binary).unwrap();
        let asset = fake_asset(payload, serde_json::json!({}));
        write_verified_marker(
            temp.path(),
            &MihomoVerifiedMarker {
                version: mihomo_version_no_v(),
                archive_sha256: asset.sha256.clone(),
                binary_sha256,
                platform: asset.platform.clone(),
                arch: asset.arch.clone(),
                binary: "mihomo.exe".to_string(),
            },
        )
        .unwrap();
        let downloads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let transport: DownloadTransport = {
            let downloads = downloads.clone();
            Arc::new(move |_url: String, _max: u64| {
                downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async move { Err("must not download".to_string()) })
            })
        };
        let resolved = resolve_mihomo_asset(&asset, temp.path(), &transport).await.unwrap();
        assert_eq!(resolved.reused, true);
        assert_eq!(resolved.path, binary);
        assert_eq!(std::fs::read(&resolved.path).unwrap(), payload);
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn resolve_quarantines_tampered_and_forged_states() {
        let asset = fake_asset(b"pinned bytes", serde_json::json!({}));
        // 1. Tampered binary with a valid marker → quarantine + fresh download
        //    (which then fails verification) → empty dir.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("mihomo.exe"), b"original verified payload").unwrap();
        let binary_sha256 = sha256_file(temp.path().join("mihomo.exe").as_path()).unwrap();
        write_verified_marker(
            temp.path(),
            &MihomoVerifiedMarker {
                version: mihomo_version_no_v(),
                archive_sha256: asset.sha256.clone(),
                binary_sha256,
                platform: asset.platform.clone(),
                arch: asset.arch.clone(),
                binary: "mihomo.exe".to_string(),
            },
        )
        .unwrap();
        std::fs::write(temp.path().join("mihomo.exe"), b"tampered payload!!!").unwrap();
        let wrong: &'static [u8] = Box::leak(b"not the pinned bytes".to_vec().into_boxed_slice());
        let error = resolve_mihomo_asset(&asset, temp.path(), &transport_from_bytes(wrong)).await.unwrap_err();
        assert!(error.0.contains("ARTIFACT_HASH_MISMATCH"), "{}", error.0);
        assert_eq!(dir_entries(temp.path()), Vec::<String>::new());
        // 2. Forged marker (wrong recorded binary hash) → not reusable.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("mihomo.exe"), b"verified payload").unwrap();
        write_verified_marker(
            temp.path(),
            &MihomoVerifiedMarker {
                version: mihomo_version_no_v(),
                archive_sha256: asset.sha256.clone(),
                binary_sha256: "f".repeat(64),
                platform: asset.platform.clone(),
                arch: asset.arch.clone(),
                binary: "mihomo.exe".to_string(),
            },
        )
        .unwrap();
        let error = resolve_mihomo_asset(&asset, temp.path(), &transport_from_bytes(wrong)).await.unwrap_err();
        assert!(error.0.contains("ARTIFACT_HASH_MISMATCH"), "{}", error.0);
        assert_eq!(dir_entries(temp.path()), Vec::<String>::new());
        // 3. Marker platform mismatch → not reusable.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("mihomo.exe"), b"verified payload").unwrap();
        let binary_sha256 = sha256_file(temp.path().join("mihomo.exe").as_path()).unwrap();
        write_verified_marker(
            temp.path(),
            &MihomoVerifiedMarker {
                version: mihomo_version_no_v(),
                archive_sha256: asset.sha256.clone(),
                binary_sha256,
                platform: "linux".to_string(),
                arch: asset.arch.clone(),
                binary: "mihomo.exe".to_string(),
            },
        )
        .unwrap();
        let error = resolve_mihomo_asset(&asset, temp.path(), &transport_from_bytes(wrong)).await.unwrap_err();
        assert!(error.0.contains("ARTIFACT_HASH_MISMATCH"), "{}", error.0);
        assert_eq!(dir_entries(temp.path()), Vec::<String>::new());
    }

    #[test]
    fn release_assets_build_verified_specs() {
        let release = serde_json::json!({
            "name": "mihomo-windows-amd64-v1.19.29.zip",
            "digest": "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "size": 18400000,
            "browser_download_url": "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-windows-amd64-v1.19.29.zip"
        });
        let asset = build_mihomo_asset_from_release("v1.19.29", "win32", "x64", &release).expect("asset");
        assert_eq!(asset.filename, "mihomo-windows-amd64-v1.19.29.zip");
        assert_eq!(asset.version.as_deref(), Some("v1.19.29"));
        assert_eq!(asset.sha256, "a".repeat(64));
        assert_eq!(asset.inner_name, "mihomo-windows-amd64.exe");
        // Name mismatch / bare hex digest / missing size are refused.
        let mut mismatched = release.clone();
        mismatched["name"] = serde_json::json!("mihomo-windows-amd64-v1.19.28.zip");
        assert!(build_mihomo_asset_from_release("v1.19.29", "win32", "x64", &mismatched).is_none());
        let mut bare = release.clone();
        bare["digest"] = serde_json::json!("b".repeat(64));
        assert!(build_mihomo_asset_from_release("v1.19.29", "win32", "x64", &bare).is_some());
        let mut no_size = release.clone();
        no_size["size"] = serde_json::json!(0);
        assert!(build_mihomo_asset_from_release("v1.19.29", "win32", "x64", &no_size).is_none());
    }
}
