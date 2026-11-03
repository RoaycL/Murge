//! 网关模式 — Windows IPv4 forwarding for the LAN and TUN adapters.
//!
//! A device whose gateway is set to this PC only reaches the TUN adapter when
//! Windows forwards IPv4 between the LAN adapter and the TUN adapter. That
//! takes an elevated change, so the installed LocalSystem TUN service makes it
//! (`forwarding` operation, `native/tun-service/forwarding.go`): it switches
//! forwarding on, re-applies it every time mihomo recreates the TUN adapter,
//! and switches back off what it switched on when the core stops or the user
//! turns 网关模式 off.
//!
//! Without a reachable service (a dev build, or a broken install) the switch
//! falls back to one elevated PowerShell run, which shows the UAC prompt.

use serde_json::{json, Value};

use crate::error::IpcError;
use crate::kernel::KernelServices;
use crate::settings::{AppSettingsPatch, SettingsStore};

const DEVICE_PATTERN: &str = "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$";

fn state(enabled: bool, mode: &str, service: Option<&Value>, error: Option<String>) -> Value {
    let service_error = service
        .and_then(|status| status["error"].as_str())
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    json!({
        "enabled": enabled,
        "mode": mode,
        "tunPresent": service.and_then(|status| status["tunPresent"].as_bool()),
        "firewall": service.and_then(|status| status["firewall"].as_bool()),
        "interfaces": service
            .and_then(|status| status["interfaces"].as_array().cloned())
            .unwrap_or_default(),
        "error": error.or(service_error),
    })
}

/// `lan-gateway:get-state`.
pub async fn get_state(settings: &SettingsStore, kernel: &KernelServices) -> Value {
    let enabled = settings.get().lan_gateway;
    match &kernel.privileged {
        Some(privileged) => match privileged.client().forwarding("status").await {
            Ok(status) => state(enabled, "service", Some(&status), None),
            Err(error) => state(enabled, "service", None, Some(error.extract_message())),
        },
        None if cfg!(windows) => state(enabled, "elevated", None, None),
        None => state(enabled, "unsupported", None, None),
    }
}

/// `lan-gateway:set-enabled(enabled, device)`. `device` is the TUN adapter
/// name the renderer shows; only the elevated fallback needs it, the service
/// uses the adapter of the profile it started.
pub async fn set_enabled(
    settings: &SettingsStore,
    kernel: &KernelServices,
    enabled: bool,
    device: Option<String>,
) -> Result<Value, IpcError> {
    let device = device.unwrap_or_default();
    if !device.is_empty()
        && !regex::Regex::new(DEVICE_PATTERN)
            .expect("device pattern")
            .is_match(&device)
    {
        return Err(IpcError::invalid_argument("invalid TUN device"));
    }
    let persist = |value: bool| settings.set(&AppSettingsPatch(json!({ "lanGateway": value })));
    persist(enabled);
    let action = if enabled { "enable" } else { "disable" };
    let service_error = match &kernel.privileged {
        Some(privileged) => match privileged.client().forwarding(action).await {
            Ok(status) => {
                crate::file_log::app_log(
                    crate::file_log::FileLogLevel::Info,
                    "lan-gateway",
                    &format!(
                        "网关模式已{}（特权服务）",
                        if enabled { "开启" } else { "关闭" }
                    ),
                );
                return Ok(state(enabled, "service", Some(&status), None));
            }
            Err(error) => {
                let message = error.extract_message();
                crate::diag!("[lan-gateway] 特权服务切换失败，改用提权：{message}");
                Some(message)
            }
        },
        None => None,
    };
    if !cfg!(windows) {
        persist(false);
        return Ok(state(
            false,
            "unsupported",
            None,
            Some(service_error.unwrap_or_else(|| "仅 Windows 支持网关模式".into())),
        ));
    }
    // The service is missing or refused: ask for elevation once.
    match run_elevated(&forwarding_script(&device, enabled)).await {
        Ok(()) => {
            crate::file_log::app_log(
                crate::file_log::FileLogLevel::Info,
                "lan-gateway",
                &format!(
                    "网关模式已{}（提权）",
                    if enabled { "开启" } else { "关闭" }
                ),
            );
            Ok(state(enabled, "elevated", None, None))
        }
        Err(message) => {
            crate::diag!("[lan-gateway] 网关模式切换失败：{message}");
            // Nothing changed on the host, so the switch must not claim it did.
            persist(!enabled);
            Ok(state(!enabled, "elevated", None, Some(message)))
        }
    }
}

/// Tell the service the persisted 网关模式 and allow-lan after a core start
/// (best-effort): a restarted service has forgotten both.
pub async fn sync_after_start(
    client: &crate::tun_service::TunServiceClient,
    enabled: bool,
    allow_lan: bool,
) {
    for action in [
        if enabled { "enable" } else { "disable" },
        if allow_lan {
            "lan-proxy-on"
        } else {
            "lan-proxy-off"
        },
    ] {
        if let Err(error) = client.forwarding(action).await {
            eprintln!(
                "[lan-gateway] {action} sync failed: {}",
                error.extract_message()
            );
        }
    }
}

/// allow-lan moved: the service adds or drops the local-subnet firewall rule
/// for the running core (best-effort, the proxy switch itself already applied).
pub async fn sync_allow_lan(kernel: &KernelServices, allow_lan: bool) {
    if let Some(privileged) = &kernel.privileged {
        let action = if allow_lan {
            "lan-proxy-on"
        } else {
            "lan-proxy-off"
        };
        if let Err(error) = privileged.client().forwarding(action).await {
            eprintln!("[lan-gateway] {action} failed: {}", error.extract_message());
        }
    }
}

/// The elevated script: the TUN adapter plus every adapter that holds the
/// IPv4 default route (the LAN side).
pub fn forwarding_script(device: &str, enabled: bool) -> String {
    let state = if enabled { "Enabled" } else { "Disabled" };
    let tun = crate::updates::ps_literal(device);
    [
        "$ErrorActionPreference = 'Stop'".to_string(),
        format!("$tun = {tun}"),
        "$aliases = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne $tun } | Select-Object -ExpandProperty InterfaceAlias -Unique)".to_string(),
        "if ($tun -and (Get-NetIPInterface -AddressFamily IPv4 -InterfaceAlias $tun -ErrorAction SilentlyContinue)) { $aliases += $tun }".to_string(),
        "if ($aliases.Count -eq 0) { exit 3 }".to_string(),
        format!("Set-NetIPInterface -InterfaceAlias $aliases -AddressFamily IPv4 -Forwarding {state}"),
        "exit 0".to_string(),
    ]
    .join("\n")
}

/// The unelevated launcher: `Start-Process -Verb RunAs` shows the UAC prompt
/// and waits for the elevated script's exit code.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn elevation_launcher(inner: &str) -> String {
    let encoded = crate::updates::encode_powershell(inner);
    [
        "try {".to_string(),
        format!("  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','{encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop"),
        "  exit $process.ExitCode".to_string(),
        "} catch {".to_string(),
        "  exit 1223".to_string(),
        "}".to_string(),
    ]
    .join("\n")
}

#[cfg(windows)]
async fn run_elevated(inner: &str) -> Result<(), String> {
    let launcher = crate::updates::encode_powershell(&elevation_launcher(inner));
    let status = tokio::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &launcher,
        ])
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|error| format!("无法启动 PowerShell：{error}"))?;
    match status.code() {
        Some(0) => Ok(()),
        Some(1223) => Err("已取消管理员授权，未更改 Windows 转发设置".into()),
        Some(3) => Err("未找到可转发的网卡，请先开启 TUN 模式".into()),
        code => Err(format!(
            "设置 Windows 转发失败（退出码 {}）",
            code.map(|value| value.to_string())
                .unwrap_or_else(|| "未知".into())
        )),
    }
}

#[cfg(not(windows))]
async fn run_elevated(_inner: &str) -> Result<(), String> {
    Err("仅 Windows 支持网关模式".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_targets_the_tun_adapter_and_the_default_route() {
        let script = forwarding_script("Murge TUN", true);
        assert!(script.contains("$tun = 'Murge TUN'"));
        assert!(script.contains("-DestinationPrefix '0.0.0.0/0'"));
        assert!(script.ends_with("Forwarding Enabled\nexit 0"));
        assert!(forwarding_script("Murge TUN", false).contains("-Forwarding Disabled"));
    }

    #[test]
    fn launcher_asks_for_elevation_and_maps_a_refusal() {
        let launcher = elevation_launcher("exit 0");
        assert!(launcher.contains("-Verb RunAs"));
        assert!(launcher.contains("-Wait -PassThru"));
        assert!(launcher.contains("exit 1223"));
    }

    #[test]
    fn state_surfaces_the_service_report() {
        let status = json!({
            "desired": true, "device": "Murge TUN", "tunPresent": true,
            "interfaces": [{ "name": "以太网", "role": "lan", "forwarding": true, "managed": true }],
            "error": ""
        });
        let value = state(true, "service", Some(&status), None);
        assert_eq!(value["tunPresent"], true);
        assert_eq!(value["interfaces"][0]["name"], "以太网");
        assert_eq!(value["error"], Value::Null);
        let failed = state(
            true,
            "service",
            Some(&json!({ "error": "以太网: denied" })),
            None,
        );
        assert_eq!(failed["error"], "以太网: denied");
    }
}
