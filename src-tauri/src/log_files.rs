//! Reading the daily log files back: the app-log tail shown on the 日志 page
//! (「应用」 source) and the zipped 日志包 for troubleshooting.
//!
//! Every line that leaves this module goes through
//! [`redact_log_text`](crate::redact::redact_log_text) again, so files
//! written by an older build (weaker rules) are masked with today's rules.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::redact::redact_log_text;

/// How much of each app log the 应用 view reads from the end.
const TAIL_BYTES: u64 = 768 * 1024;
/// Entries returned to the renderer (matches the kernel view's cap).
const MAX_ENTRIES: usize = 2000;
/// Days of log files the 日志包 includes (today counts as one).
const BUNDLE_DAYS: i64 = 3;
/// A bundled file larger than this keeps only its newest part.
const BUNDLE_FILE_CAP: u64 = 8 * 1024 * 1024;

fn log_file_pattern() -> regex::Regex {
    regex::Regex::new(r"^(app|core|substore)-(\d{4})-(\d{2})-(\d{2})\.log$")
        .expect("log file pattern compiles")
}

/// Regular log files in `dir` (no symlinks), newest date first.
fn list_log_files(dir: &Path, kind: Option<&str>) -> Vec<(String, String, PathBuf)> {
    let pattern = log_file_pattern();
    let mut files: Vec<(String, String, PathBuf)> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    let captures = pattern.captures(&name)?;
                    let file_kind = captures.get(1)?.as_str().to_string();
                    if kind.is_some_and(|k| k != file_kind) {
                        return None;
                    }
                    let path = entry.path();
                    let info = std::fs::symlink_metadata(&path).ok()?;
                    if info.file_type().is_symlink() || !info.is_file() {
                        return None;
                    }
                    let date = format!("{}-{}-{}", &captures[2], &captures[3], &captures[4]);
                    Some((date, name, path))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    files
}

/// The last `cap` bytes of `path`, starting at a line boundary.
fn read_tail(path: &Path, cap: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let offset = len.saturating_sub(cap);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.take(cap).read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if offset > 0 {
        // Drop the partial first line.
        match text.find('\n') {
            Some(index) => text.drain(..=index),
            None => return Some(String::new()),
        };
    }
    Some(text)
}

/// One parsed app-log entry.
#[derive(Debug, Clone, PartialEq)]
pub struct AppLogEntry {
    pub time: String,
    pub level: String,
    pub module: String,
    pub message: String,
}

/// Parse `[ISO] [LEVEL] [module] message` lines. A line without that header
/// (a multi-line message, the truncation marker) continues the previous
/// entry; leading orphans are dropped.
pub fn parse_app_log(text: &str) -> Vec<AppLogEntry> {
    let header =
        regex::Regex::new(r"^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] \[([A-Z]+)\] \[([^\]\n]+)\] ?(.*)$")
            .expect("app log header compiles");
    let mut entries: Vec<AppLogEntry> = Vec::new();
    for line in text.lines() {
        if let Some(captures) = header.captures(line) {
            entries.push(AppLogEntry {
                time: captures[1].to_string(),
                level: normalize_level(&captures[2]).to_string(),
                module: captures[3].to_string(),
                message: captures[4].to_string(),
            });
        } else if let Some(last) = entries.last_mut() {
            if !line.trim().is_empty() && !line.starts_with("[LOG] Earlier entries") {
                last.message.push('\n');
                last.message.push_str(line);
            }
        }
    }
    entries
}

fn normalize_level(raw: &str) -> &'static str {
    match raw {
        "DEBUG" => "debug",
        "WARN" | "WARNING" => "warning",
        "ERROR" | "FATAL" => "error",
        _ => "info",
    }
}

/// The 应用 log view: newest [`MAX_ENTRIES`] entries of the two most recent
/// app logs, oldest first, plus the distinct module names seen.
pub fn read_app_entries(dir: &Path) -> Value {
    let files = list_log_files(dir, Some("app"));
    let mut entries: Vec<AppLogEntry> = Vec::new();
    // Oldest of the two first so the merged list stays ascending.
    for (_, _, path) in files.iter().take(2).rev() {
        if let Some(text) = read_tail(path, TAIL_BYTES) {
            entries.extend(parse_app_log(&text));
        }
    }
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    let mut modules: Vec<String> = entries.iter().map(|e| e.module.clone()).collect();
    modules.sort();
    modules.dedup();
    json!({
        "entries": entries
            .into_iter()
            .map(|e| json!({
                "time": e.time,
                "level": e.level,
                "module": e.module,
                "message": redact_log_text(&e.message),
            }))
            .collect::<Vec<_>>(),
        "modules": modules,
    })
}

/// Files for the 日志包: every log of the newest [`BUNDLE_DAYS`] dates.
fn bundle_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let files = list_log_files(dir, None);
    let mut dates: Vec<&String> = files.iter().map(|f| &f.0).collect();
    dates.dedup();
    let keep: Vec<String> = dates
        .into_iter()
        .take(BUNDLE_DAYS as usize)
        .cloned()
        .collect();
    files
        .into_iter()
        .filter(|(date, _, _)| keep.contains(date))
        .map(|(_, name, path)| (name, path))
        .collect()
}

/// Build the 日志包 zip: re-redacted log files of the last few days plus the
/// fixed-field diagnostic report and a short readme.
pub fn build_bundle(
    dir: &Path,
    diagnostics: &Value,
    generated_at: &str,
) -> std::io::Result<Vec<u8>> {
    let mut writer = ZipWriter::default();
    let mut listed: Vec<String> = Vec::new();
    for (name, path) in bundle_files(dir) {
        let Some(text) = read_tail(&path, BUNDLE_FILE_CAP) else {
            continue;
        };
        let redacted: String = text
            .lines()
            .map(|line| redact_log_text(line) + "\n")
            .collect();
        writer.add(&format!("logs/{name}"), redacted.as_bytes())?;
        listed.push(name);
    }
    let report = serde_json::to_vec_pretty(diagnostics).unwrap_or_default();
    writer.add("diagnostics.json", &report)?;
    let readme = format!(
        "{brand} 日志包\n生成时间：{generated_at}\n版本：{version}\n\n\
         包含最近 {days} 天的应用日志（app）、内核日志（core）和 Sub-Store 日志，以及 diagnostics.json 运行诊断。\n\
         导出时已再次脱敏：订阅地址的凭据、Token / Secret / 密码、WireGuard 私钥与预共享密钥、Tailscale 认证密钥等均已替换为 [REDACTED]。\n\
         日志仍会包含访问的域名和 IP，请只发给你信任的人。\n\n文件：\n{files}\n",
        brand = crate::brand::load_brand()
            .map(|brand| brand.short_name)
            .unwrap_or_else(|_| "Murge".to_string()),
        version = env!("CARGO_PKG_VERSION"),
        days = BUNDLE_DAYS,
        files = if listed.is_empty() {
            "（暂无日志文件）".to_string()
        } else {
            listed.iter().map(|n| format!("- logs/{n}")).collect::<Vec<_>>().join("\n")
        },
    );
    writer.add("README.txt", readme.as_bytes())?;
    writer.finish()
}

/// A minimal deflate ZIP writer (no zip64): enough for a few log files.
#[derive(Default)]
struct ZipWriter {
    out: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl ZipWriter {
    fn add(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data)?;
        let compressed = encoder.finish()?;
        let crc = crc32fast::hash(data);
        let offset = self.out.len() as u32;
        let name_bytes = name.as_bytes();
        // Bit 11: file names are UTF-8.
        let flags: u16 = 0x0800;
        let (time, date) = dos_now();
        let mut local = Vec::with_capacity(30 + name_bytes.len());
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&flags.to_le_bytes());
        local.extend_from_slice(&8u16.to_le_bytes());
        local.extend_from_slice(&time.to_le_bytes());
        local.extend_from_slice(&date.to_le_bytes());
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name_bytes);
        self.out.extend_from_slice(&local);
        self.out.extend_from_slice(&compressed);

        let c = &mut self.central;
        c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        c.extend_from_slice(&20u16.to_le_bytes());
        c.extend_from_slice(&20u16.to_le_bytes());
        c.extend_from_slice(&flags.to_le_bytes());
        c.extend_from_slice(&8u16.to_le_bytes());
        c.extend_from_slice(&time.to_le_bytes());
        c.extend_from_slice(&date.to_le_bytes());
        c.extend_from_slice(&crc.to_le_bytes());
        c.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        c.extend_from_slice(&0u16.to_le_bytes()); // extra
        c.extend_from_slice(&0u16.to_le_bytes()); // comment
        c.extend_from_slice(&0u16.to_le_bytes()); // disk
        c.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        c.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        c.extend_from_slice(&offset.to_le_bytes());
        c.extend_from_slice(name_bytes);
        self.count += 1;
        Ok(())
    }

    fn finish(mut self) -> std::io::Result<Vec<u8>> {
        let central_offset = self.out.len() as u32;
        let central_size = self.central.len() as u32;
        self.out.extend_from_slice(&self.central);
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&central_size.to_le_bytes());
        self.out.extend_from_slice(&central_offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        Ok(self.out)
    }
}

/// Local wall clock in MS-DOS `(time, date)` form.
fn dos_now() -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let now = chrono::Local::now();
    let time =
        ((now.hour() as u16) << 11) | ((now.minute() as u16) << 5) | ((now.second() as u16) / 2);
    let year = (now.year().clamp(1980, 2107) - 1980) as u16;
    let date = (year << 9) | ((now.month() as u16) << 5) | now.day() as u16;
    (time, date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers_and_folds_continuation_lines() {
        let text = "orphan\n\
            [2026-11-03T10:00:00.000Z] [INFO] [startup] version=0.10.3\n\
            [2026-11-03T10:00:01.000Z] [WARN] [mitm] engine listener failed\n  caused by: busy\n\
            [2026-11-03T10:00:02.000Z] [ERROR] [script] 去广告：TypeError\n";
        let entries = parse_app_log(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].module, "startup");
        assert_eq!(entries[1].level, "warning");
        assert_eq!(
            entries[1].message,
            "engine listener failed\n  caused by: busy"
        );
        assert_eq!(entries[2].level, "error");
        assert_eq!(entries[2].message, "去广告：TypeError");
    }

    #[test]
    fn reads_newest_app_logs_and_redacts_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("app-2026-11-02.log"),
            "[2026-11-02T10:00:00.000Z] [INFO] [tun] old\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("app-2026-11-03.log"),
            "[2026-11-03T10:00:00.000Z] [WARN] [profiles] fetch failed private-key: abc=\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("core-2026-11-03.log"), "[x] [INFO] core\n").unwrap();
        let value = read_app_entries(dir.path());
        let entries = value["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["module"], "tun");
        assert_eq!(entries[1]["message"], "fetch failed private-key=[REDACTED]");
        assert_eq!(value["modules"], json!(["profiles", "tun"]));
    }

    #[test]
    fn bundle_is_a_readable_zip_of_recent_days() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-10-30", "2026-11-01", "2026-11-02", "2026-11-03"] {
            std::fs::write(
                dir.path().join(format!("app-{day}.log")),
                format!("[{day}T00:00:00.000Z] [INFO] [startup] token=abc\n"),
            )
            .unwrap();
        }
        std::fs::write(dir.path().join("core-2026-11-03.log"), "hello\n").unwrap();
        let bytes = build_bundle(dir.path(), &json!({"schemaVersion":1}), "now").unwrap();
        let read = |name: &str| crate::substore_zip::read_zip_entry(&bytes, name);
        assert!(read("logs/core-2026-11-03.log").is_ok());
        assert!(read("logs/app-2026-11-01.log").is_ok());
        assert!(read("logs/app-2026-10-30.log").is_err());
        assert!(read("diagnostics.json").is_ok());
        assert!(read("README.txt").is_ok());
        let app = read("logs/app-2026-11-03.log").unwrap();
        let app = String::from_utf8(app).unwrap();
        assert!(app.contains("token=[REDACTED]"), "{app}");
    }
}
