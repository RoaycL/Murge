//! Fixed diagnostic fields only. Log text, secrets and destinations never cross IPC.
use crate::{
    enhancements::ModelStores, kernel::KernelServices, paths::AppPaths, settings::SettingsStore,
    system_proxy::SystemProxyService, tun::TunCoordinator,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::OnceLock,
};

static STARTED: OnceLock<String> = OnceLock::new();
pub fn initialize() {
    let _ = STARTED.set(now());
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn classify(line: &str) -> &'static str {
    if line.contains("controller secret mismatch") || line.contains("PROTOCOL_ERROR:UNAUTHORIZED") {
        "controller-auth"
    } else if line.contains("UPSTREAM_UNREACHABLE") || line.contains("controller unreachable") {
        "controller-unreachable"
    } else if [
        "KERNEL_START",
        "KERNEL_SPAWN",
        "[kernel]",
        "[startup-restore] kernel",
    ]
    .iter()
    .any(|s| line.contains(s))
    {
        "kernel-start"
    } else if regex::Regex::new(r"(?i)\[tun\]|TUN_|TUN mode")
        .unwrap()
        .is_match(line)
    {
        "tun"
    } else if line.contains("[system-proxy]") || line.contains("SYSTEM_PROXY") {
        "system-proxy"
    } else if regex::Regex::new(r"(?i)\[profiles\]|subscription|provider")
        .unwrap()
        .is_match(line)
    {
        "subscription"
    } else if regex::Regex::new(r"(?i)\[updates\]|Cannot download|ERR_CONNECTION_ABORTED")
        .unwrap()
        .is_match(line)
    {
        "update"
    } else {
        "other"
    }
}

fn recent_errors(root: &Path) -> Result<Value, ()> {
    let pattern = regex::Regex::new(r"^app-\d{4}-\d{2}-\d{2}\.log$").unwrap();
    let mut names: Vec<_> = std::fs::read_dir(root)
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| pattern.is_match(n))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.reverse();
    names.truncate(2);
    let warning = regex::Regex::new(r"\[(?:ERROR|WARN|WARNING)\]").unwrap();
    let timestamp = regex::Regex::new(r"^\[([^\]]+)\]").unwrap();
    let mut categories: Vec<(&str, (usize, Option<String>))> = Vec::new();
    for name in names {
        let path = root.join(name);
        let Ok(info) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if info.file_type().is_symlink() || !info.is_file() {
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let offset = info.len().saturating_sub(256 * 1024);
        file.seek(SeekFrom::Start(offset)).map_err(|_| ())?;
        let mut bytes = Vec::new();
        file.take(256 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if !warning.is_match(line) {
                continue;
            }
            // Classify before masking so keyword categories retain Electron's
            // priority. Only the aggregate and normalized timestamp survive.
            let category = classify(line);
            let redacted = crate::redact::redact_log_text(line);
            let at = timestamp
                .captures(&redacted)
                .and_then(|c| chrono::DateTime::parse_from_rfc3339(&c[1]).ok())
                .map(|d| {
                    d.to_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                });
            let index = categories
                .iter()
                .position(|(name, _)| *name == category)
                .unwrap_or_else(|| {
                    categories.push((category, (0, None)));
                    categories.len() - 1
                });
            let entry = &mut categories[index].1;
            entry.0 += 1;
            if at > entry.1 {
                entry.1 = at;
            }
        }
    }
    Ok(Value::Array(categories.into_iter().map(|(category,(count,last_at))|json!({"category":category,"count":count,"lastAt":last_at})).collect()))
}

fn unavailable_host(ports: &Value) -> Value {
    json!({"startupTask":{"state":"unavailable","lastRunAt":null,"lastResult":null},"coreService":"unavailable",
        "tunAdapterPresent":null,"systemProxyRegistry":{"enabled":null,"target":"unavailable","port":null},"ports":ports})
}

#[cfg(windows)]
async fn host(device: &str, ports: &Value, pid: &Value) -> Value {
    use tokio::io::AsyncReadExt;
    // All executable/script text is fixed. Untrusted device/brand strings are
    // environment values, never executable PowerShell interpolation.
    const SCRIPT: &str = r#"
$taskState='missing';$lastRun=$null;$lastResult=$null
try {$task=Get-ScheduledTask -TaskName $env:MURGE_DIAG_TASK -ErrorAction Stop;$taskState=if($task.Settings.Enabled){'enabled'}else{'disabled'};$info=Get-ScheduledTaskInfo -TaskName $env:MURGE_DIAG_TASK -ErrorAction Stop;if($info.LastRunTime.Year -gt 2000){$lastRun=$info.LastRunTime.ToUniversalTime().ToString('o')};$lastResult=[int]$info.LastTaskResult}catch{$taskState=if($_.FullyQualifiedErrorId -like '*NoMatching*'){'missing'}else{'unavailable'}}
$service='missing';try{$service=(Get-Service -Name $env:MURGE_DIAG_SERVICE -ErrorAction Stop).Status.ToString().ToLowerInvariant()}catch{$service=if($_.FullyQualifiedErrorId -like '*NoServiceFoundForGivenName*'){'missing'}else{'unavailable'}}
$adapter=$null;try{if($env:MURGE_DIAG_DEVICE){$null=Get-NetAdapter -Name $env:MURGE_DIAG_DEVICE -ErrorAction Stop;$adapter=$true}}catch{$adapter=if($_.FullyQualifiedErrorId -like '*NoMatching*' -or $_.FullyQualifiedErrorId -like '*NotFound*'){$false}else{$null}}
$registry=@{enabled=$null;target='unavailable';port=$null};try{$p=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop;$enabled=$p.ProxyEnable -eq 1;$target='none';$port=$null;if($enabled){$target='external';if($p.ProxyServer -match '^(?:http=|https=)?127\.0\.0\.1:(\d{1,5})$'){$port=[int]$Matches[1];if($port -gt 0 -and $port -le 65535){$target='loopback'}else{$port=$null}}};$registry=@{enabled=$enabled;target=$target;port=$port}}catch{}
$ports=@($env:MURGE_DIAG_PORTS|ConvertFrom-Json);$owners=$null;try{$owners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)}catch{}
$result=@();foreach($item in $ports){$pids=@();if($null -ne $owners){$pids=@($owners|Where-Object {$_.LocalPort -eq $item.port}|Select-Object -ExpandProperty OwningProcess -Unique)};$owned=$null;if($null -ne $owners -and $env:MURGE_DIAG_PID){$owned=$pids -contains [int]$env:MURGE_DIAG_PID};$result+=@{label=$item.label;port=$item.port;ownerPids=$pids;ownedByKernel=$owned}}
@{startupTask=@{state=$taskState;lastRunAt=$lastRun;lastResult=$lastResult};coreService=$service;tunAdapterPresent=$adapter;systemProxyRegistry=$registry;ports=$result}|ConvertTo-Json -Depth 6 -Compress
"#;
    let Ok(brand) = crate::brand::load_brand() else {
        return unavailable_host(ports);
    };
    let service = crate::tun_service::tun_service_identity(&brand.app_id).service_name;
    let operation = async {
        let mut child = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .env("MURGE_DIAG_TASK", brand.app_id)
            .env("MURGE_DIAG_SERVICE", service)
            .env("MURGE_DIAG_DEVICE", device)
            .env("MURGE_DIAG_PORTS", ports.to_string())
            .env(
                "MURGE_DIAG_PID",
                pid.as_u64().map(|p| p.to_string()).unwrap_or_default(),
            )
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()?
            .take(16385)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > 16384 || !child.wait().await.ok()?.success() {
            return None;
        }
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    tokio::time::timeout(std::time::Duration::from_secs(7), operation)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| unavailable_host(ports))
}

#[cfg(not(windows))]
async fn host(_: &str, ports: &Value, _: &Value) -> Value {
    unavailable_host(ports)
}

pub async fn collect(
    paths: &AppPaths,
    settings: &SettingsStore,
    models: &ModelStores,
    kernel: &KernelServices,
    proxy: &SystemProxyService,
    tun: &TunCoordinator,
) -> Value {
    let kernel = kernel.get_status_value();
    let proxy = proxy.get_status_value();
    let tun = tun.get_status_value();
    let settings = settings.get();
    let core = crate::enhancements::coerce_core_settings(&models.core.get());
    let config = crate::enhancements::coerce_tun_config(&models.tun_config.get());
    let ports = Value::Array(
        [
            ("mixed", "mixedPort"),
            ("http", "httpPort"),
            ("socks", "socksPort"),
            ("controller", "controllerPort"),
        ]
        .iter()
        .filter_map(|(label, key)| {
            let port = core[*key].as_u64()?;
            if !(1..=65535).contains(&port) {
                return None;
            }
            Some(json!({"label":label,"port":port,"ownerPids":[],"ownedByKernel":null}))
        })
        .collect(),
    );
    let host = host(
        config["device"].as_str().unwrap_or_default(),
        &ports,
        &kernel["pid"],
    )
    .await;
    let errors = paths
        .app_data_root
        .as_ref()
        .map(|root| recent_errors(&root.join("logs")))
        .unwrap_or(Ok(json!([])));
    let warnings = if errors.is_err() {
        vec!["app-log-summary-unavailable"]
    } else {
        vec![]
    };
    json!({"schemaVersion":1,"generatedAt":now(),"app":{"version":env!("CARGO_PKG_VERSION"),
        "platform":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},
        "arch":if cfg!(target_arch="x86_64"){"x64"}else if cfg!(target_arch="aarch64"){"arm64"}else{std::env::consts::ARCH}},
        "startup":{"processStartedAt":STARTED.get_or_init(now),"marks":[]},
        "runtime":{"kernel":{"phase":kernel["phase"],"pid":kernel["pid"]},
        "systemProxy":{"desired":settings.system_proxy_desired,"phase":proxy["phase"],"port":proxy["port"]},
        "tun":{"desired":settings.tun_desired,"phase":tun["phase"]}},"host":host,
        "recentErrors":errors.unwrap_or(json!([])),"collectionWarnings":warnings,
        "privacy":"No raw logs, configuration, subscription URLs, controller secrets, domains or destinations are included."})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn error_summary_preserves_categories_and_never_exposes_raw_log_data() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("app-2026-09-29.log"),"[2026-09-29T01:00:00.000Z] [ERROR] controller secret mismatch https://secret.example/?token=private\n[2026-09-29T01:01:00.000Z] [WARN] [tun] private.example 192.168.1.10").unwrap();
        let result = recent_errors(root.path()).unwrap();
        let text = result.to_string();
        assert_eq!(result[0]["category"], "controller-auth");
        assert_eq!(result[0]["lastAt"], "2026-09-29T01:00:00.000Z");
        assert!(!text.contains("private"));
        assert!(!text.contains("secret.example"));
        assert!(!text.contains("192.168"));
    }
    #[test]
    fn classification_priority_matches_electron() {
        assert_eq!(
            classify("PROTOCOL_ERROR:UNAUTHORIZED TUN_"),
            "controller-auth"
        );
        assert_eq!(
            classify("UPSTREAM_UNREACHABLE [kernel]"),
            "controller-unreachable"
        );
        assert_eq!(classify("[kernel] TUN_"), "kernel-start");
        assert_eq!(classify("provider failed"), "subscription");
        assert_eq!(classify("Cannot download"), "update");
    }

    #[tokio::test]
    async fn collect_returns_contract_fields_without_runtime_secrets() {
        use crate::system_proxy::*;
        use std::sync::Arc;
        let paths = AppPaths {
            app_data_root: None,
            profile_root: None,
        };
        let settings = SettingsStore::new(None);
        let models = ModelStores::new(None);
        let proxy = SystemProxyService::new(
            Arc::new(FakeSystemProxyAdapter::new()),
            static_probe(Target {
                host: "127.0.0.1".into(),
                port: 7890,
            }),
            Arc::new(InMemoryBackupStore::new()),
            Arc::new(InMemoryBypassStore::new()),
            "diagnostic-test".into(),
        );
        let tun = TunCoordinator::new(Arc::new(crate::tun::GatedTunMutationAdapter), false);
        let report = collect(
            &paths,
            &settings,
            &models,
            &KernelServices::new(),
            &proxy,
            &tun,
        )
        .await;
        assert_eq!(report["schemaVersion"], 1);
        assert!(report["startup"]["marks"].is_array());
        assert!(report["runtime"]["kernel"].get("controllerUrl").is_none());
        assert!(report["runtime"]["tun"].get("errorMessage").is_none());
        assert!(report["host"]["ports"].is_array());
        assert_eq!(
            report["app"]["arch"],
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            }
        );
    }
}
