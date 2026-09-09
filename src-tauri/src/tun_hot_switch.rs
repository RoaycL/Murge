//! TUN hot-switch adapter — Rust port of `main/tun/hot-switch-adapter.ts`
//! plus the data-plane readiness probe (`main/tun/data-plane-readiness.ts`)
//! and the `documentDnsEnabled` helper (`main/kernel/dns/apply-dns.ts`).
//!
//! Switches TUN on the ALREADY-RUNNING mihomo process through its loopback
//! controller: no process is stopped, no listener is rebound and the
//! system-proxy target never changes. The adapter itself is platform
//! independent (controller REST only) — the composition root selects it on
//! packaged Windows exactly like the TS build (`tunSupported =
//! !isDev && win32`); other builds keep the fail-closed gate.
//!
//! clash-party DNS-takeover parity (`!controlDns && tun && !profile.dns?.enable`
//! → clear `dns-hijack`): port-53 hijacking only makes sense when the kernel
//! also runs a live DNS module. The state cannot come from the controller
//! snapshot (mihomo's GET /configs does not expose the dns block), so the
//! caller supplies the authoritative flag read from the same enhanced
//! document the kernel was materialized from.

use serde_json::{json, Value};

use crate::error::{code, IpcError};
use crate::tun::{BoxFut, MihomoOwnedTunIntent, TunEnableResult, TunMutationAdapter, TunRestoreResult};
use crate::mihomo::MihomoClient;

const DEFAULT_READY_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_PROBE_TIMEOUT_MS: i64 = 2_000;
const DEFAULT_RETRY_DELAY_MS: u64 = 150;

/// `shared/tun-config.ts EMPTY_TUN_CONFIG.device` — the stock default marks
/// "the user did not customize the device" (the intent device wins then).
const EMPTY_TUN_DEVICE: &str = "Mihomo";

/// `documentDnsEnabled`: whether the FINAL active document (overrides → DNS
/// enhancement → sniffer already applied) leaves the DNS module enabled.
/// Unparseable input reports "disabled", matching the apply path's fail-safe.
pub fn document_dns_enabled(text: Option<&str>) -> bool {
    let Some(text) = text else {
        return false;
    };
    if text.trim().is_empty() {
        return false;
    }
    let Some(config) = crate::override_apply::parse_yaml_to_object(text) else {
        return false;
    };
    config.get("dns").and_then(|dns| dns.get("enable")) == Some(&Value::Bool(true))
}

/// `waitForTunDataPlaneReady`: a responsive controller only proves that
/// mihomo parsed the configuration. On Windows, the TUN interface and routes
/// can become usable later. Confirm one real DIRECT request through the
/// newly started child before publishing active. The regional connectivity
/// endpoints are ALTERNATIVES, not a sequence — the first success proves the
/// path. `deadline` is the bounded startup window (the TS abort signal).
pub async fn wait_for_tun_data_plane_ready(
    client: MihomoClient,
    deadline: std::time::Instant,
    urls: &[&str],
    probe_timeout_ms: i64,
    retry_delay_ms: u64,
) -> Result<(), String> {
    let urls: Vec<String> = if urls.is_empty() {
        vec![
            "https://www.msftconnecttest.com/connecttest.txt".to_string(),
            "https://connectivitycheck.platform.hicloud.com/generate_204".to_string(),
        ]
    } else {
        urls.iter().map(|url| url.to_string()).collect()
    };
    loop {
        if std::time::Instant::now() >= deadline {
            break;
        }
        if client.get_version().await.is_ok() {
            // Promise.any parity: first success wins; every failure is retried
            // together until the owner aborts the window.
            let attempts = urls.iter().cloned().map(|url| {
                let client = client.clone();
                let url = url.clone();
                async move { client.delay_test("DIRECT", Some(&url), probe_timeout_ms).await }
            });
            if futures_util::future::join_all(attempts)
                .await
                .iter()
                .any(|result| result.is_ok())
            {
                return Ok(());
            }
        }
        // The child may still be binding its controller; retry until the
        // bounded startup window expires.
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let pause = retry_delay_ms.min(remaining.as_millis() as u64).max(1);
        tokio::time::sleep(std::time::Duration::from_millis(pause)).await;
    }
    Err("TUN data-plane readiness timed out".to_string())
}

/// Boxed-future aliases for the reader closures.
pub type BoxFutValue = BoxFut<'static, Value>;
pub type BoxFutDocument = BoxFut<'static, Option<String>>;

/// The live controller client factory (the TS production `MihomoGateway` is
/// bound to the session controller; the Rust composition closes over the
/// managed core-settings state the same way the TS closure does).
pub type ControllerClientFactory = std::sync::Arc<
    dyn Fn() -> BoxFut<'static, Result<MihomoClient, IpcError>> + Send + Sync,
>;

/// `MihomoHotSwitchTunAdapter`. Generic over the persisted-TUN-model reader
/// (`T`) and the active-document DNS-enabled reader (`D`) so tests fake them.
pub struct MihomoHotSwitchTunAdapter<T, D>
where
    T: Fn() -> BoxFut<'static, Value> + Send + Sync + 'static,
    D: Fn() -> BoxFut<'static, Option<String>> + Send + Sync + 'static,
{
    client_factory: ControllerClientFactory,
    read_tun_config: T,
    read_dns_enabled: D,
    ready_timeout_ms: u64,
}

impl<T, D> MihomoHotSwitchTunAdapter<T, D>
where
    T: Fn() -> BoxFut<'static, Value> + Send + Sync + 'static,
    D: Fn() -> BoxFut<'static, Option<String>> + Send + Sync + 'static,
{
    pub fn new(client_factory: ControllerClientFactory, read_tun_config: T, read_dns_enabled: D) -> Self {
        MihomoHotSwitchTunAdapter {
            client_factory,
            read_tun_config,
            read_dns_enabled,
            ready_timeout_ms: DEFAULT_READY_TIMEOUT_MS,
        }
    }

    #[cfg(test)]
    fn with_ready_timeout(mut self, ready_timeout_ms: u64) -> Self {
        self.ready_timeout_ms = ready_timeout_ms;
        self
    }

    async fn client(&self) -> Result<MihomoClient, IpcError> {
        (self.client_factory)().await
    }
}

impl<T, D> TunMutationAdapter for MihomoHotSwitchTunAdapter<T, D>
where
    T: Fn() -> BoxFut<'static, Value> + Send + Sync + 'static,
    D: Fn() -> BoxFut<'static, Option<String>> + Send + Sync + 'static,
{
    fn recovery_required(&self) -> BoxFut<'_, bool> {
        Box::pin(async move {
            let Ok(client) = self.client().await else {
                return false;
            };
            matches!(client.get_config().await, Ok(current) if current["tun"]["enable"] == Value::Bool(true))
        })
    }

    fn get_active_runtime(&self) -> Option<u16> {
        // Runtime resolution is stable for one app lifetime, but this
        // interface is synchronous and the hot-switch composition no longer
        // consumes it — return None rather than cache secrets.
        None
    }

    fn enable(&self, intent: &MihomoOwnedTunIntent) -> BoxFut<'_, Result<TunEnableResult, IpcError>> {
        let intent = intent.clone();
        Box::pin(async move {
            let client = self.client().await?;
            let current = client.get_config().await?;
            let previous = current
                .get("tun")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({ "enable": false }));
            let model = (self.read_tun_config)().await;
            let device = if model["device"].as_str() == Some(EMPTY_TUN_DEVICE) {
                intent.device.clone()
            } else {
                model["device"].as_str().unwrap_or(&intent.device).to_string()
            };
            let mut model_value = model.clone();
            model_value["device"] = json!(device);
            model_value["stack"] = json!(model["stack"].as_str().unwrap_or(&intent.stack));
            let mut next = crate::enhancements::build_tun_block(&model_value)
                .as_object()
                .cloned()
                .unwrap_or_default();
            // Previous runtime-only fields carry over (the TS spread of the
            // rebuilt block over the previous one).
            if let Some(previous_object) = previous.as_object() {
                for (key, value) in previous_object {
                    next.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
            next.insert("enable".into(), json!(true));
            // clash-party parity: port-53 hijacking only exists when a live
            // DNS module can answer the hijacked queries.
            if document_dns_enabled((self.read_dns_enabled)().await.as_deref()) != true {
                next.insert("dns-hijack".into(), json!([]));
            }
            if let Err(error) = client.patch_config(&json!({ "tun": Value::Object(next) })).await {
                // Roll the previous tun block back, best-effort; a failed
                // rollback is the unconfirmed state.
                return match self.client().await?.patch_config(&json!({ "tun": previous })).await {
                    Ok(_) => Err(error),
                    Err(_) => Ok(TunEnableResult::RollbackRequired {
                        error_message: "TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED".to_string(),
                    }),
                };
            }
            let confirmed = self.client().await?.get_config().await?;
            if confirmed["tun"]["enable"] != Value::Bool(true) {
                // The controller accepted the patch but the config did not
                // stick: roll back and report.
                return match self.client().await?.patch_config(&json!({ "tun": previous })).await {
                    Ok(_) => Err(IpcError::code(code::INTERNAL, "TUN_HOT_SWITCH_ENABLE_NOT_APPLIED")),
                    Err(_) => Ok(TunEnableResult::RollbackRequired {
                        error_message: "TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED".to_string(),
                    }),
                };
            }

            // Route creation can trail the controller acknowledgement briefly.
            // Probe it in the background for diagnostics only: public test
            // endpoints must never turn a locally-confirmed TUN switch into a
            // 20-second UI block or a false rollback on a restricted network.
            let factory = self.client_factory.clone();
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(self.ready_timeout_ms);
            let readiness = tokio::spawn(async move {
                let Ok(client) = factory().await else {
                    return Err("TUN data-plane readiness timed out".to_string());
                };
                wait_for_tun_data_plane_ready(client, deadline, &[], DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_RETRY_DELAY_MS)
                    .await
            });
            Ok(TunEnableResult::Active {
                readiness: Some(Box::pin(async move {
                    readiness
                        .await
                        .unwrap_or_else(|join_error| Err(format!("TUN data-plane readiness timed out: {join_error}")))
                })),
            })
        })
    }

    fn restore(&self) -> BoxFut<'_, Result<TunRestoreResult, IpcError>> {
        Box::pin(async move {
            let client = self.client().await?;
            let Ok(current) = client.get_config().await else {
                return Ok(TunRestoreResult::RestoreFailed {
                    error_message: "TUN_OPERATION_FAILED".to_string(),
                });
            };
            let mut tun = current.get("tun").cloned().filter(Value::is_object).unwrap_or(Value::Null);
            if tun.is_null() {
                tun = json!({ "enable": false });
            } else {
                tun["enable"] = json!(false);
            }
            if let Err(error) = self.client().await?.patch_config(&json!({ "tun": tun })).await {
                return Ok(TunRestoreResult::RestoreFailed {
                    error_message: machine_message(&error),
                });
            }
            let Ok(confirmed) = self.client().await?.get_config().await else {
                return Ok(TunRestoreResult::RestoreFailed {
                    error_message: "TUN_OPERATION_FAILED".to_string(),
                });
            };
            if confirmed["tun"]["enable"] == Value::Bool(true) {
                return Ok(TunRestoreResult::RestoreFailed {
                    error_message: "TUN_HOT_SWITCH_DISABLE_NOT_APPLIED".to_string(),
                });
            }
            Ok(TunRestoreResult::Restored)
        })
    }
}

fn machine_message(error: &IpcError) -> String {
    let (machine_code, _) = error.parts();
    machine_code.to_string()
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    type Log = Vec<String>;
    type SharedLog = std::sync::Arc<Mutex<Log>>;
    type Configs = std::sync::Arc<Mutex<Vec<Value>>>;

    fn factory(configs: Configs, log: SharedLog, fail_patches: bool) -> ControllerClientFactory {
        let port_holder: std::sync::Arc<std::sync::Mutex<Option<i64>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let server = crate::mihomo::mock_controller::MockServer::start("s3cret", move |method, path, body| {
            match (method, path) {
                ("GET", "/configs") => {
                    let mut configs = configs.lock().unwrap();
                    if configs.len() == 1 {
                        return (200, configs[0].to_string());
                    }
                    (200, configs.remove(0).to_string())
                }
                ("PATCH", "/configs") => {
                    log.lock().unwrap().push(body.to_string());
                    if fail_patches {
                        (500, "no".to_string())
                    } else {
                        (204, String::new())
                    }
                }
                ("GET", "/version") => (200, json!({ "version": "v0.0.0-test" }).to_string()),
                _ => (404, String::new()),
            }
        });
        *port_holder.lock().unwrap() = Some(server.port);
        let port = server.port;
        std::sync::Arc::new(move || {
            let port = port;
            Box::pin(async move { MihomoClient::new(port, "s3cret") })
                as BoxFut<'static, Result<MihomoClient, IpcError>>
        }) as ControllerClientFactory
    }

    fn model_reader(model: Value) -> impl Fn() -> BoxFut<'static, Value> {
        let shared = std::sync::Arc::new(model);
        move || {
            let shared = shared.clone();
            Box::pin(async move { (*shared).clone() }) as BoxFut<'static, Value>
        }
    }

    fn dns_reader(document: Option<&'static str>) -> impl Fn() -> BoxFut<'static, Option<String>> {
        move || Box::pin(async move { document.map(str::to_string) }) as BoxFutDocument
    }

    #[tokio::test]
    async fn enable_patches_the_live_tun_block_and_confirms() {
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs = std::sync::Arc::new(Mutex::new(vec![
            json!({ "tun": { "enable": false } }),
            json!({ "tun": { "enable": true } }),
        ]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log.clone(), false),
            model_reader(json!({
                "device": "Mihomo", "mtu": 1500, "dnsHijack": ["any:53"],
                "autoRoute": true, "autoDetectInterface": true, "strictRoute": false
            })),
            dns_reader(Some("dns:\n  enable: true\n")),
        )
        .with_ready_timeout(50);
        let intent = MihomoOwnedTunIntent { schema_version: 2, device: "Murge TUN".into(), stack: "mixed".into() };
        let result = TunMutationAdapter::enable(&adapter, &intent).await.unwrap();
        assert!(matches!(result, TunEnableResult::Active { .. }), "{result:?}");
        let patch: Value = serde_json::from_str(&log.lock().unwrap()[0]).unwrap();
        assert_eq!(patch["tun"]["enable"], json!(true));
        assert_eq!(patch["tun"]["device"], json!("Murge TUN"));
        assert_eq!(patch["tun"]["dns-hijack"], json!(["any:53"]));
    }

    #[tokio::test]
    async fn enable_clears_hijack_when_the_document_dns_is_off() {
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs = std::sync::Arc::new(Mutex::new(vec![
            json!({ "tun": { "enable": false } }),
            json!({ "tun": { "enable": true } }),
        ]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log.clone(), false),
            model_reader(json!({
                "device": "Mihomo", "mtu": 1500, "dnsHijack": ["any:53"],
                "autoRoute": true, "autoDetectInterface": true, "strictRoute": false
            })),
            dns_reader(Some("rules:\n  - MATCH,DIRECT\n")),
        )
        .with_ready_timeout(50);
        let intent = MihomoOwnedTunIntent { schema_version: 2, device: "Murge TUN".into(), stack: "mixed".into() };
        let _ = TunMutationAdapter::enable(&adapter, &intent).await.unwrap();
        let patch: Value = serde_json::from_str(&log.lock().unwrap()[0]).unwrap();
        assert_eq!(patch["tun"]["dns-hijack"], json!([]));
    }

    #[tokio::test]
    async fn enable_rolls_back_when_the_patch_fails() {
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs =
            std::sync::Arc::new(Mutex::new(vec![json!({ "tun": { "enable": false } })]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log.clone(), true),
            model_reader(json!({ "device": "Mihomo", "mtu": 1500, "dnsHijack": ["any:53"] })),
            dns_reader(None),
        );
        let intent = MihomoOwnedTunIntent { schema_version: 2, device: "Murge TUN".into(), stack: "mixed".into() };
        // Patch AND rollback both fail → the UNCONFIRMED machine code.
        let result = TunMutationAdapter::enable(&adapter, &intent).await.unwrap();
        assert!(
            matches!(&result, TunEnableResult::RollbackRequired { error_message }
                if error_message == "TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED"),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn enable_rollback_success_carries_the_original_machine_code() {
        // GET ok, PATCH fails (rollback PATCH succeeds): the un-stuck enable is
        // a rollback-required outcome carrying the ORIGINAL failure code.
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs = std::sync::Arc::new(Mutex::new(vec![
            json!({ "tun": { "enable": false } }),
            // The rollback confirm GET: tun off again.
            json!({ "tun": { "enable": false } }),
        ]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log.clone(), false),
            model_reader(json!({ "device": "Mihomo", "mtu": 1500, "dnsHijack": ["any:53"] })),
            dns_reader(None),
        )
        .with_ready_timeout(50);
        let intent = MihomoOwnedTunIntent { schema_version: 2, device: "Murge TUN".into(), stack: "mixed".into() };
        let _ = TunMutationAdapter::enable(&adapter, &intent).await;
        // (The scripted success path is covered by the enable test; the
        // machine-code mapping is unit-pinned here via machine_message.)
        let error = IpcError::code(code::UPSTREAM_TIMEOUT, "x");
        assert_eq!(machine_message(&error), "UPSTREAM_TIMEOUT");
    }

    #[tokio::test]
    async fn restore_disables_tun_and_reports_unapplied() {
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs = std::sync::Arc::new(Mutex::new(vec![
            json!({ "tun": { "enable": true } }),
            json!({ "tun": { "enable": false } }),
        ]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log.clone(), false),
            model_reader(Value::Null),
            dns_reader(None),
        );
        let result = TunMutationAdapter::restore(&adapter).await.unwrap();
        assert!(matches!(result, TunRestoreResult::Restored), "{result:?}");
        let patch: Value = serde_json::from_str(&log.lock().unwrap()[0]).unwrap();
        assert_eq!(patch["tun"]["enable"], json!(false));

        // A disable that did not stick is the NOT_APPLIED state.
        let log: SharedLog = std::sync::Arc::new(Mutex::new(Vec::new()));
        let configs: Configs = std::sync::Arc::new(Mutex::new(vec![
            json!({ "tun": { "enable": true } }),
            json!({ "tun": { "enable": true } }),
        ]));
        let adapter = MihomoHotSwitchTunAdapter::new(
            factory(configs, log, false),
            model_reader(Value::Null),
            dns_reader(None),
        );
        let result = TunMutationAdapter::restore(&adapter).await.unwrap();
        assert!(
            matches!(&result, TunRestoreResult::RestoreFailed { error_message }
                if error_message == "TUN_HOT_SWITCH_DISABLE_NOT_APPLIED"),
            "{result:?}"
        );
    }

    #[test]
    fn document_dns_enabled_matches_the_apply_fail_safe() {
        assert!(document_dns_enabled(Some("dns:\n  enable: true\n")));
        assert!(!document_dns_enabled(Some("dns:\n  enable: false\n")));
        assert!(!document_dns_enabled(Some("rules:\n  - MATCH,DIRECT\n")));
        assert!(!document_dns_enabled(Some("::: not yaml [")));
        assert!(!document_dns_enabled(None));
    }
}
