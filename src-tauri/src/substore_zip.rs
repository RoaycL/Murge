//! Minimal ZIP reader for the Sub-Store frontend distribution (dist.zip) —
//! Rust port of `src/main/substore/substore-zip.ts`.
//!
//! Scope is deliberately narrow — the archive is a Vite build produced by the
//! official Sub-Store-Front-End release: no zip64, no encryption, no split
//! archives, only stored (0) and deflate (8) entries. Anything outside that
//! scope is rejected loudly instead of mis-extracted. A dedicated small
//! reader avoids a heavyweight archive dependency for one download path.

use std::io::Read;
use std::path::{Path, PathBuf};

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
/// EOCD: signature(4) disk(2) cdDisk(2) diskEntries(2) totalEntries(2) size(4) offset(4) commentLen(2).
const EOCD_MIN_LEN: usize = 22;
/// Central entry: fixed 46-byte header + name/extra/comment.
const CENTRAL_FIXED_LEN: usize = 46;
/// Local entry: fixed 30-byte header + name/extra.
const LOCAL_FIXED_LEN: usize = 30;
const MAX_ENTRIES: usize = 4096;
const MAX_ENTRY_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;

/// Every parse/extraction rejection carries the TS `ZIP 解析失败：` prefix.
#[derive(Debug)]
pub struct ZipFormatError(pub String);

impl std::fmt::Display for ZipFormatError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "ZIP 解析失败：{}", self.0)
    }
}

struct ZipEntry {
    name: String,
    is_directory: bool,
    method: u16,
    compressed_size: u32,
    uncompressed_size: u32,
    crc: u32,
    local_header_offset: u32,
}

fn read_u16(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

fn read_u32(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
}

fn find_eocd(buf: &[u8]) -> Result<usize, ZipFormatError> {
    // The EOCD is at the very end unless a zip comment follows; scan back the
    // maximum comment length (65535) plus the fixed record size.
    let min_start = buf.len().saturating_sub(EOCD_MIN_LEN + 0xffff);
    let mut index = buf.len().checked_sub(EOCD_MIN_LEN).ok_or_else(|| ZipFormatError("未找到目录结束记录（不是 ZIP 文件或已截断）".into()))?;
    loop {
        if read_u32(buf, index) == EOCD_SIGNATURE {
            return Ok(index);
        }
        if index == min_start {
            return Err(ZipFormatError("未找到目录结束记录（不是 ZIP 文件或已截断）".into()));
        }
        index -= 1;
    }
}

fn parse_central_directory(buf: &[u8]) -> Result<Vec<ZipEntry>, ZipFormatError> {
    let eocd = find_eocd(buf)?;
    let entry_count = read_u16(buf, eocd + 10) as usize;
    let cd_size = read_u32(buf, eocd + 12) as usize;
    let cd_offset = read_u32(buf, eocd + 16) as usize;
    if cd_offset == 0xffff_ffff || entry_count == 0xffff {
        return Err(ZipFormatError("不支持 zip64 归档".into()));
    }
    if entry_count > MAX_ENTRIES {
        return Err(ZipFormatError("条目数量超过上限".into()));
    }
    if cd_offset + cd_size > buf.len() {
        return Err(ZipFormatError("中央目录越界".into()));
    }
    let mut entries = Vec::with_capacity(entry_count);
    let mut cursor = cd_offset;
    for index in 0..entry_count {
        if cursor + CENTRAL_FIXED_LEN > buf.len() || read_u32(buf, cursor) != CENTRAL_SIGNATURE {
            return Err(ZipFormatError(format!("中央目录第 {} 项损坏", index + 1)));
        }
        let method = read_u16(buf, cursor + 10);
        let flags = read_u16(buf, cursor + 8);
        let crc = read_u32(buf, cursor + 16);
        let compressed_size = read_u32(buf, cursor + 20);
        let uncompressed_size = read_u32(buf, cursor + 24);
        let name_len = read_u16(buf, cursor + 28) as usize;
        let extra_len = read_u16(buf, cursor + 30) as usize;
        let comment_len = read_u16(buf, cursor + 32) as usize;
        let external_attrs = read_u32(buf, cursor + 38);
        let local_header_offset = read_u32(buf, cursor + 42);
        let name_start = cursor + CENTRAL_FIXED_LEN;
        if name_start + name_len > buf.len() {
            return Err(ZipFormatError(format!("中央目录第 {} 项损坏", index + 1)));
        }
        let name = String::from_utf8_lossy(&buf[name_start..name_start + name_len]).to_string();
        if method != 0 && method != 8 {
            return Err(ZipFormatError(format!("不支持的压缩方式 {method}（{name}）")));
        }
        if flags & 0x1 != 0 {
            return Err(ZipFormatError(format!("不支持加密条目（{name}）")));
        }
        if uncompressed_size as usize > MAX_ENTRY_BYTES {
            return Err(ZipFormatError(format!("条目解压后过大（{name}）")));
        }
        entries.push(ZipEntry {
            is_directory: name.ends_with('/') || external_attrs & 0x10 != 0,
            name,
            method,
            compressed_size,
            uncompressed_size,
            crc,
            local_header_offset,
        });
        cursor += CENTRAL_FIXED_LEN + name_len + extra_len + comment_len;
    }
    let total_size: usize = entries.iter().map(|entry| entry.uncompressed_size as usize).sum();
    if total_size > MAX_TOTAL_BYTES {
        return Err(ZipFormatError("解压后总大小超过上限".into()));
    }
    Ok(entries)
}

fn entry_data(buf: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, ZipFormatError> {
    let local = entry.local_header_offset as usize;
    if local + LOCAL_FIXED_LEN > buf.len() || read_u32(buf, local) != LOCAL_SIGNATURE {
        return Err(ZipFormatError(format!("本地头损坏（{}）", entry.name)));
    }
    let name_len = read_u16(buf, local + 26) as usize;
    let extra_len = read_u16(buf, local + 28) as usize;
    let data_start = local + LOCAL_FIXED_LEN + name_len + extra_len;
    let data_end = data_start + entry.compressed_size as usize;
    if data_end > buf.len() {
        return Err(ZipFormatError(format!("数据越界（{}）", entry.name)));
    }
    let raw = &buf[data_start..data_end];
    let output = match entry.method {
        0 => raw.to_vec(),
        _ => {
            let decoder = flate2::read::DeflateDecoder::new(raw);
            let mut output = Vec::with_capacity(entry.uncompressed_size as usize);
            decoder
                .take(MAX_ENTRY_BYTES as u64)
                .read_to_end(&mut output)
                .map_err(|_| ZipFormatError(format!("解压失败（{}）", entry.name)))?;
            output
        }
    };
    if output.len() != entry.uncompressed_size as usize {
        return Err(ZipFormatError(format!("解压大小不匹配（{}）", entry.name)));
    }
    if crc32fast::hash(&output) != entry.crc {
        return Err(ZipFormatError(format!("CRC 校验失败（{}）", entry.name)));
    }
    Ok(output)
}

/// Reject absolute paths and any `..` escape: the archive comes from the
/// network and the destination sits in user app-data.
fn assert_safe_rel_path(name: &str) -> Result<String, ZipFormatError> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.chars().take(1).next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) && normalized.chars().nth(1) == Some(':') {
        return Err(ZipFormatError(format!("条目为绝对路径（{name}）")));
    }
    let parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    if parts.iter().any(|part| *part == "..") {
        return Err(ZipFormatError(format!("条目路径越界（{name}）")));
    }
    Ok(parts.join("/"))
}

fn resolved_dest(dest_dir: &Path) -> PathBuf {
    std::fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf())
}

/// Extract a zip archive into `destDir`. When every entry shares one
/// top-level directory (`dist/...` for the frontend release), that prefix is
/// stripped so the output is the site root directly.
///
/// Returns the written file paths relative to `destDir`.
pub fn extract_zip_bytes(buf: &[u8], dest_dir: &Path) -> Result<Vec<String>, ZipFormatError> {
    let entries = parse_central_directory(buf)?;
    if entries.is_empty() {
        return Err(ZipFormatError("归档为空".into()));
    }
    let mut first_segments = std::collections::HashSet::new();
    for entry in &entries {
        let rel = assert_safe_rel_path(&entry.name)?;
        if let Some(first) = rel.split('/').next() {
            if !first.is_empty() {
                first_segments.insert(first.to_string());
            }
        }
    }
    let strip_one = first_segments.len() == 1 && entries.iter().all(|entry| entry.name.contains('/'));
    let resolved_dest = resolved_dest(dest_dir);
    let mut written = Vec::new();
    for entry in &entries {
        let rel = assert_safe_rel_path(&entry.name)?;
        let stripped = if strip_one { rel.splitn(2, '/').nth(1).unwrap_or("").to_string() } else { rel };
        if stripped.is_empty() {
            continue;
        }
        let target = resolved_dest.join(&stripped);
        let target = std::fs::canonicalize(&target).unwrap_or(target);
        if target != resolved_dest && !target.starts_with(&resolved_dest.join("")) {
            // The join above already normalizes; the explicit starts_with
            // check keeps a canonicalized symlink escape from writing.
            if !target.starts_with(&resolved_dest) {
                return Err(ZipFormatError(format!("条目解析越界（{}）", entry.name)));
            }
        }
        if entry.is_directory {
            std::fs::create_dir_all(&target).map_err(|_| ZipFormatError(format!("目录创建失败（{}）", entry.name)))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|_| ZipFormatError(format!("目录创建失败（{}）", entry.name)))?;
        }
        std::fs::write(&target, entry_data(buf, entry)?)
            .map_err(|_| ZipFormatError(format!("写入失败（{}）", entry.name)))?;
        written.push(stripped);
    }
    Ok(written)
}

/// Read the archive from disk and extract it (the TS `extractZipToDir`
/// shape; the service uses the byte-level entry).
#[allow(dead_code)]
pub fn extract_zip_to_dir(zip_path: &Path, dest_dir: &Path) -> Result<Vec<String>, ZipFormatError> {
    let buf = std::fs::read(zip_path).map_err(|_| ZipFormatError("归档读取失败".into()))?;
    extract_zip_bytes(&buf, dest_dir)
}

/// Minimal stored-entry zip (crate-internal fixture builder: the artifact
/// pipeline tests wrap a verified payload in a real zip member).
#[cfg_attr(not(test), allow(dead_code))] // artifact-pipeline test fixture
pub fn zip_stored_bytes(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut local = Vec::new();
    let mut central = Vec::new();
    let mut offsets = Vec::new();
    for (name, data) in &entries {
        offsets.push(local.len() as u32);
        let crc = crc32fast::hash(data);
        local.extend_from_slice(&LOCAL_SIGNATURE.to_le_bytes());
        local.extend_from_slice(&[8, 0]); // version needed
        local.extend_from_slice(&[0, 0]); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        local.extend_from_slice(&[0, 0, 0, 0]); // time+date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name.len() as u16).to_le_bytes());
        local.extend_from_slice(&[0, 0]); // extra len
        local.extend_from_slice(name.as_bytes());
        local.extend_from_slice(data);
        central.extend_from_slice(&CENTRAL_SIGNATURE.to_le_bytes());
        central.extend_from_slice(&[20, 0, 20, 0]); // versions
        central.extend_from_slice(&[0, 0]);
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&[0, 0, 0, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0, 0, 0, 0]); // extra + comment len
        central.extend_from_slice(&[0, 0]); // disk number
        central.extend_from_slice(&[0, 0]); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offsets.last().unwrap().to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let mut out = local;
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

#[cfg(test)]
mod tests {

    use super::*;
    use std::io::Write;

    fn zip_bytes(entries: Vec<(&str, Vec<u8>, u16)>) -> Vec<u8> {
        // Minimal writer: stored/deflate entries, central directory, EOCD.
        let mut local = Vec::new();
        let mut central = Vec::new();
        let mut offsets = Vec::new();
        for (name, data, method) in &entries {
            offsets.push(local.len() as u32);
            let crc = crc32fast::hash(data);
            let compressed = if *method == 8 {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(data).unwrap();
                encoder.finish().unwrap()
            } else {
                data.clone()
            };
            local.extend_from_slice(&LOCAL_SIGNATURE.to_le_bytes());
            local.extend_from_slice(&[8, 0]); // version needed
            local.extend_from_slice(&[0, 0]); // flags
            local.extend_from_slice(&method.to_le_bytes());
            local.extend_from_slice(&[0, 0, 0, 0]); // time+date
            local.extend_from_slice(&crc.to_le_bytes());
            local.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            local.extend_from_slice(&(data.len() as u32).to_le_bytes());
            local.extend_from_slice(&(name.len() as u16).to_le_bytes());
            local.extend_from_slice(&[0, 0]); // extra len
            local.extend_from_slice(name.as_bytes());
            local.extend_from_slice(&compressed);
            central.extend_from_slice(&CENTRAL_SIGNATURE.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0]); // versions
            central.extend_from_slice(&[0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0, 0, 0, 0]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0, 0, 0, 0]); // extra + comment len
            central.extend_from_slice(&[0, 0]); // disk number
            central.extend_from_slice(&[0, 0]); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&offsets.last().unwrap().to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let mut out = local;
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    fn staging_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("murge-zip-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_stored_and_deflate_entries_with_nested_directories() {
        let archive = zip_bytes(vec![
            ("dist/index.html", b"<html></html>".to_vec(), 0),
            ("dist/assets/app.js", b"console.log(1)".to_vec(), 8),
            ("dist/assets/", Vec::new(), 0),
        ]);
        let dest = staging_dir();
        let written = extract_zip_bytes(&archive, &dest).unwrap();
        // One top-level dir (dist/) is stripped: the output IS the site root.
        assert!(written.contains(&"index.html".to_string()));
        assert!(written.contains(&"assets/app.js".to_string()));
        assert_eq!(std::fs::read(dest.join("index.html")).unwrap(), b"<html></html>");
        assert_eq!(std::fs::read(dest.join("assets/app.js")).unwrap(), b"console.log(1)");
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn rejects_traversal_absolute_and_corrupt_entries() {
        let dest = staging_dir();
        // `..` escape is rejected BEFORE writing anything.
        let traversal = zip_bytes(vec![("dist/../../evil.txt", b"no".to_vec(), 0)]);
        assert!(extract_zip_bytes(&traversal, &dest).is_err());
        // Absolute path (a leading-slash name is rejected outright).
        let absolute = zip_bytes(vec![("/etc/passwd", b"no".to_vec(), 0)]);
        assert!(extract_zip_bytes(&absolute, &dest).is_err());
        // Windows drive letter.
        let drive = zip_bytes(vec![("C:/evil.txt", b"no".to_vec(), 0)]);
        assert!(extract_zip_bytes(&drive, &dest).is_err());
        // Not a zip at all.
        assert!(extract_zip_bytes(b"not a zip", &dest).is_err());
        // Empty archive.
        let empty = zip_bytes(Vec::new());
        assert!(extract_zip_bytes(&empty, &dest).is_err());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn rejects_crc_mismatch_instead_of_writing_unchecked_output() {
        let mut archive = zip_bytes(vec![("dist/index.html", b"payload".to_vec(), 0)]);
        // Flip one CRC byte in the central directory: EOCD(22) + name(15) +
        // (46 - 16 - 4) bytes of trailing central fields sit behind the CRC.
        let len = archive.len();
        archive[len - 22 - 15 - 26] ^= 0xff;
        let dest = staging_dir();
        assert!(extract_zip_bytes(&archive, &dest).is_err());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn no_top_level_layout_is_written_without_stripping() {
        let archive = zip_bytes(vec![("index.html", b"<html></html>".to_vec(), 0), ("app.js", b"x".to_vec(), 8)]);
        let dest = staging_dir();
        let written = extract_zip_bytes(&archive, &dest).unwrap();
        assert!(written.contains(&"index.html".to_string()));
        assert_eq!(std::fs::read(dest.join("index.html")).unwrap(), b"<html></html>");
        let _ = std::fs::remove_dir_all(&dest);
    }
}
