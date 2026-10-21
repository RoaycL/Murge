//! Client for the privileged LocalSystem TUN service — Rust port of
//! `tun/service-identity.ts`, `tun/service-protocol.ts` (response side),
//! `tun/named-pipe-transport.ts` and `tun/service-client.ts`.
//!
//! The service owns the only mihomo process on Windows production builds. This
//! client can never choose a binary, command line, working directory or
//! environment: it sends a profile and a session id over the authenticated
//! named pipe, and the service decides everything else. The wire format is one
//! JSON object per line in each direction (`native/tun-service/protocol.go`).

use std::sync::Mutex;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{code, IpcError};

pub const TUN_SERVICE_PROTOCOL_VERSION: u64 = 7;
pub const TUN_SERVICE_MAX_PROFILE_BYTES: usize = 16 * 1024 * 1024;
pub const TUN_SERVICE_MAX_PROVIDER_CONTENT_BYTES: usize = 4 * 1024 * 1024;
/// Provider YAML can legitimately be several MiB; JSON escaping needs headroom.
#[cfg(any(windows, test))]
pub const MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// A rolling/specific selection may make the service fetch and verify the
/// official core before it replies.
pub const START_TIMEOUT_MS: u64 = 150_000;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct TunServiceIdentity {
    pub service_name: String,
    pub pipe_name: String,
    pub namespace_id: String,
}

/// Stable across product-name changes as long as the durable appId is kept.
pub fn tun_service_identity(app_id: &str) -> TunServiceIdentity {
    let digest = Sha256::digest(app_id.as_bytes());
    let suffix: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    TunServiceIdentity {
        service_name: format!("ProxyDesktopTun_{suffix}"),
        pipe_name: format!("proxy-desktop-tun-{suffix}"),
        namespace_id: format!("proxy-desktop-{suffix}"),
    }
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// Response validation (the zod schema + superRefine in service-protocol.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct TunServiceResponse {
    pub request_id: String,
    pub outcome: String,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub error_code: Option<String>,
    pub content: Option<String>,
    pub content_format: Option<String>,
    pub content_source: Option<String>,
    pub validation_message: Option<String>,
}

fn protocol_invalid(reason: impl Into<String>) -> IpcError {
    IpcError::code(
        code::TUN_HELPER_PROTOCOL_INVALID,
        format!("Invalid TUN service protocol message: {}", reason.into()),
    )
}

fn is_uint64_decimal(value: &str) -> bool {
    let well_formed = value == "0"
        || (value.len() <= 20
            && !value.starts_with('0')
            && !value.is_empty()
            && value.bytes().all(|byte| byte.is_ascii_digit()));
    well_formed && value.parse::<u64>().is_ok()
}

fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, IpcError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(protocol_invalid(format!("{key} must be a string"))),
    }
}

fn nullable_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, IpcError> {
    match object.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        _ => Err(protocol_invalid(format!("{key} must be a string or null"))),
    }
}

/// Validate one service reply against the request it answers.
pub fn parse_tun_service_response(
    input: &Value,
    expected_request_id: &str,
) -> Result<TunServiceResponse, IpcError> {
    const KEYS: [&str; 10] = [
        "protocolVersion",
        "requestId",
        "outcome",
        "sessionId",
        "pid",
        "errorCode",
        "content",
        "contentFormat",
        "contentSource",
        "validationMessage",
    ];
    let object = input
        .as_object()
        .ok_or_else(|| protocol_invalid("response must be an object"))?;
    if let Some(key) = object.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(protocol_invalid(format!("unexpected key {key}")));
    }
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(TUN_SERVICE_PROTOCOL_VERSION) {
        return Err(protocol_invalid("protocolVersion mismatch"));
    }
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| is_uint64_decimal(value))
        .ok_or_else(|| protocol_invalid("requestId must be a uint64 decimal"))?
        .to_string();
    let outcome = object
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "stopped"
                    | "starting"
                    | "running"
                    | "stopping"
                    | "installed"
                    | "content"
                    | "valid"
                    | "failed"
                    | "conflict"
            )
        })
        .ok_or_else(|| protocol_invalid("unknown outcome"))?
        .to_string();
    let session_id = nullable_string(object, "sessionId")?;
    if session_id
        .as_deref()
        .map(|value| !is_uuid(value))
        .unwrap_or(false)
    {
        return Err(protocol_invalid("sessionId must be a uuid"));
    }
    let pid = match object.get("pid") {
        Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
                .ok_or_else(|| protocol_invalid("pid must be a positive integer"))?
                as u32,
        ),
        None => return Err(protocol_invalid("pid is required")),
    };
    let error_code = nullable_string(object, "errorCode")?;
    if error_code
        .as_deref()
        .map(|value| {
            value.is_empty()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or(false)
    {
        return Err(protocol_invalid("errorCode must be an upper-case token"));
    }
    let content = optional_string(object, "content")?;
    if content
        .as_ref()
        .map(|text| text.chars().count() > TUN_SERVICE_MAX_PROVIDER_CONTENT_BYTES)
        .unwrap_or(false)
    {
        return Err(protocol_invalid("content exceeds the byte limit"));
    }
    let content_format = optional_string(object, "contentFormat")?;
    if content_format
        .as_deref()
        .map(|value| !matches!(value, "yaml" | "text"))
        .unwrap_or(false)
    {
        return Err(protocol_invalid("unknown contentFormat"));
    }
    let content_source = optional_string(object, "contentSource")?;
    if content_source
        .as_deref()
        .map(|value| !matches!(value, "cache" | "inline"))
        .unwrap_or(false)
    {
        return Err(protocol_invalid("unknown contentSource"));
    }
    let validation_message = optional_string(object, "validationMessage")?;
    if validation_message
        .as_ref()
        .map(|text| text.chars().count() > 4096)
        .unwrap_or(false)
    {
        return Err(protocol_invalid("validationMessage too long"));
    }

    let owns_child = matches!(outcome.as_str(), "starting" | "running" | "stopping");
    if owns_child && (session_id.is_none() || pid.is_none()) {
        return Err(protocol_invalid(format!(
            "{outcome} requires sessionId and pid"
        )));
    }
    if outcome == "stopped" && (session_id.is_some() || pid.is_some()) {
        return Err(protocol_invalid(
            "stopped must not retain process ownership",
        ));
    }
    let has_content = content.is_some() || content_format.is_some() || content_source.is_some();
    if outcome == "content"
        && (content.is_none() || content_format.is_none() || content_source.is_none())
    {
        return Err(protocol_invalid("content requires payload metadata"));
    }
    if outcome != "content" && has_content {
        return Err(protocol_invalid(
            "non-content response must not carry provider content",
        ));
    }
    if outcome != "failed" && validation_message.is_some() {
        return Err(protocol_invalid(
            "only failed responses may carry validationMessage",
        ));
    }
    if request_id != expected_request_id {
        return Err(protocol_invalid("response requestId mismatch"));
    }
    Ok(TunServiceResponse {
        request_id,
        outcome,
        session_id,
        pid,
        error_code,
        content,
        content_format,
        content_source,
        validation_message,
    })
}

/// Parse the single response frame: exactly one JSON line, optionally
/// followed by line terminators only.
#[cfg(any(windows, test))]
pub fn parse_response_frame(buffered: &[u8]) -> Result<Option<Value>, IpcError> {
    if buffered.len() > MAX_RESPONSE_BYTES {
        return Err(protocol_invalid(
            "TUN service response exceeded the byte limit",
        ));
    }
    let Some(newline) = buffered.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    if buffered[newline + 1..]
        .iter()
        .any(|byte| *byte != b'\r' && *byte != b'\n')
    {
        return Err(protocol_invalid("TUN service returned multiple frames"));
    }
    serde_json::from_slice::<Value>(&buffered[..newline])
        .map(Some)
        .map_err(|_| protocol_invalid("TUN service returned invalid JSON"))
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// One request/response exchange. Errors use UPSTREAM_UNREACHABLE when the
/// service cannot be reached (the callers retry exactly that code during the
/// SCM start window) and UPSTREAM_TIMEOUT for a deadline.
pub trait TunServiceTransport: Send + Sync {
    fn request(&self, message: Value, timeout_ms: u64) -> BoxFuture<'_, Result<Value, IpcError>>;
}

fn unreachable_error(message: &str) -> IpcError {
    IpcError::code(code::UPSTREAM_UNREACHABLE, message)
}

/// The production transport: `\\.\pipe\<pipeName>`, one frame each way.
pub struct NamedPipeTunServiceTransport {
    #[cfg_attr(not(windows), allow(dead_code))]
    path: String,
}

impl NamedPipeTunServiceTransport {
    pub fn new(pipe_name: &str) -> Result<Self, IpcError> {
        let safe = !pipe_name.is_empty()
            && pipe_name.len() <= 96
            && pipe_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if !safe {
            return Err(IpcError::invalid_argument("unsafe TUN service pipe name"));
        }
        Ok(NamedPipeTunServiceTransport {
            path: format!(r"\\.\pipe\{pipe_name}"),
        })
    }
}

impl TunServiceTransport for NamedPipeTunServiceTransport {
    fn request(&self, message: Value, timeout_ms: u64) -> BoxFuture<'_, Result<Value, IpcError>> {
        Box::pin(async move {
            let exchange = self.exchange(message);
            match tokio::time::timeout(Duration::from_millis(timeout_ms), exchange).await {
                Ok(result) => result,
                Err(_) => Err(IpcError::code(
                    code::UPSTREAM_TIMEOUT,
                    "TUN service request timed out",
                )),
            }
        })
    }
}

impl NamedPipeTunServiceTransport {
    #[cfg(windows)]
    async fn exchange(&self, message: Value) -> Result<Value, IpcError> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut pipe = ClientOptions::new()
            .open(&self.path)
            .map_err(|_| unreachable_error("TUN service is unavailable"))?;
        let mut frame = serde_json::to_vec(&message).expect("request serializes");
        frame.push(b'\n');
        pipe.write_all(&frame)
            .await
            .map_err(|_| unreachable_error("TUN service is unavailable"))?;
        let mut buffered: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = pipe
                .read(&mut chunk)
                .await
                .map_err(|_| unreachable_error("TUN service is unavailable"))?;
            if read == 0 {
                return Err(unreachable_error("TUN service closed without a response"));
            }
            buffered.extend_from_slice(&chunk[..read]);
            if let Some(value) = parse_response_frame(&buffered)? {
                return Ok(value);
            }
        }
    }

    #[cfg(not(windows))]
    async fn exchange(&self, _message: Value) -> Result<Value, IpcError> {
        Err(unreachable_error(
            "TUN service is only available on Windows",
        ))
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct TunOwnedSession {
    pub session_id: String,
    pub pid: u32,
}

struct ClientState {
    next_request_id: u64,
    owned: Option<TunOwnedSession>,
}

/// Typed ordinary-process to privileged-service client.
pub struct TunServiceClient {
    transport: Box<dyn TunServiceTransport>,
    state: Mutex<ClientState>,
}

fn fail(code_name: &str, message: impl Into<String>) -> IpcError {
    IpcError::code(code_name, message)
}

fn reason(response: &TunServiceResponse) -> String {
    response
        .validation_message
        .clone()
        .or_else(|| response.error_code.clone())
        .unwrap_or_else(|| format!("Service returned {}", response.outcome))
}

impl TunServiceClient {
    pub fn new(transport: Box<dyn TunServiceTransport>) -> Self {
        TunServiceClient {
            transport,
            state: Mutex::new(ClientState {
                next_request_id: 0,
                owned: None,
            }),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ClientState> {
        self.state
            .lock()
            .expect("tun service client mutex poisoned")
    }

    pub fn get_owned_session(&self) -> Option<TunOwnedSession> {
        self.guard().owned.clone()
    }

    /// Drop a session the caller has proven dead, so the next start() is not
    /// refused locally. The service still enforces its own ownership record.
    pub fn forget_owned_session(&self) {
        self.guard().owned = None;
    }

    fn take_request_id(&self) -> Result<String, IpcError> {
        let mut state = self.guard();
        if state.next_request_id == u64::MAX {
            return Err(fail(
                code::TUN_HELPER_PROTOCOL_INVALID,
                "requestId exhausted",
            ));
        }
        state.next_request_id += 1;
        Ok(state.next_request_id.to_string())
    }

    async fn exchange(
        &self,
        mut request: Map<String, Value>,
        timeout_ms: u64,
    ) -> Result<TunServiceResponse, IpcError> {
        let request_id = self.take_request_id()?;
        request.insert(
            "protocolVersion".into(),
            json!(TUN_SERVICE_PROTOCOL_VERSION),
        );
        request.insert("requestId".into(), json!(request_id));
        let raw = self
            .transport
            .request(Value::Object(request), timeout_ms)
            .await?;
        parse_tun_service_response(&raw, &request_id)
    }

    fn profile_request(
        operation: &str,
        profile: &str,
        version: Option<&str>,
    ) -> Result<Map<String, Value>, IpcError> {
        if profile.is_empty() || profile.len() > TUN_SERVICE_MAX_PROFILE_BYTES {
            return Err(fail(
                code::TUN_HELPER_PROTOCOL_INVALID,
                "profile exceeds byte limit",
            ));
        }
        let mut request = Map::new();
        request.insert("operation".into(), json!(operation));
        request.insert("profile".into(), json!(profile));
        request.insert("profileSha256".into(), json!(sha256_hex(profile)));
        if let Some(version) = version {
            request.insert("version".into(), json!(version));
        }
        Ok(request)
    }

    pub async fn start(
        &self,
        profile: &str,
        version: Option<&str>,
    ) -> Result<TunOwnedSession, IpcError> {
        if self.guard().owned.is_some() {
            return Err(fail(code::KERNEL_RUNNING, "A TUN session is already owned"));
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut request = Self::profile_request("start", profile, version)?;
        request.insert("sessionId".into(), json!(session_id));
        let response = self.exchange(request, START_TIMEOUT_MS).await?;
        if response.outcome == "conflict" {
            return Err(fail(code::TUN_SERVICE_CONFLICT, reason(&response)));
        }
        match (
            response.outcome.as_str(),
            response.session_id.as_deref(),
            response.pid,
        ) {
            ("running", Some(id), Some(pid)) if id == session_id => {
                let owned = TunOwnedSession { session_id, pid };
                self.guard().owned = Some(owned.clone());
                Ok(owned)
            }
            _ => Err(fail(code::KERNEL_SPAWN_FAILED, reason(&response))),
        }
    }

    /// Ask the service to fetch and verify one official mihomo release.
    pub async fn install_version(
        &self,
        version: &str,
        proxy_port: Option<u16>,
    ) -> Result<(), IpcError> {
        let mut request = Map::new();
        request.insert("operation".into(), json!("install"));
        request.insert("version".into(), json!(version));
        if let Some(port) = proxy_port {
            request.insert("proxyPort".into(), json!(port));
        }
        let response = self.exchange(request, START_TIMEOUT_MS).await?;
        if response.outcome != "installed" {
            return Err(fail(
                code::ARTIFACT_DOWNLOAD_FAILED,
                response
                    .error_code
                    .clone()
                    .unwrap_or_else(|| format!("Service returned {}", response.outcome)),
            ));
        }
        Ok(())
    }

    /// Validate with the same pinned binary the service will run.
    #[allow(dead_code)] // staged: the profile import semantic validator
    pub async fn validate_profile(
        &self,
        profile: &str,
        version: Option<&str>,
    ) -> Result<(), IpcError> {
        let request = Self::profile_request("validate", profile, version)?;
        let response = self.exchange(request, 45_000).await?;
        if response.outcome != "valid" {
            let message = response
                .validation_message
                .clone()
                .filter(|text| !text.is_empty())
                .or_else(|| response.error_code.clone())
                .unwrap_or_else(|| format!("Service returned {}", response.outcome));
            return Err(IpcError::invalid_argument(message));
        }
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), IpcError> {
        let Some(owned) = self.get_owned_session() else {
            return Ok(());
        };
        let mut request = Map::new();
        request.insert("operation".into(), json!("stop"));
        request.insert("sessionId".into(), json!(owned.session_id));
        let response = self.exchange(request, DEFAULT_TIMEOUT_MS).await?;
        if response.outcome == "conflict" {
            return Err(fail(code::TUN_SERVICE_CONFLICT, reason(&response)));
        }
        if response.outcome != "stopped" {
            return Err(fail(
                code::KERNEL_STOP_TIMEOUT,
                response
                    .error_code
                    .clone()
                    .unwrap_or_else(|| format!("Service returned {}", response.outcome)),
            ));
        }
        self.guard().owned = None;
        Ok(())
    }

    pub async fn reconcile(&self) -> Result<TunServiceResponse, IpcError> {
        let mut request = Map::new();
        request.insert("operation".into(), json!("reconcile"));
        let response = self.exchange(request, DEFAULT_TIMEOUT_MS).await?;
        if response.outcome == "conflict" {
            return Err(fail(
                code::TUN_SERVICE_CONFLICT,
                response
                    .error_code
                    .clone()
                    .unwrap_or_else(|| "TUN service ownership conflict".into()),
            ));
        }
        match (
            response.outcome.as_str(),
            &response.session_id,
            response.pid,
        ) {
            ("running", Some(session_id), Some(pid)) => {
                self.guard().owned = Some(TunOwnedSession {
                    session_id: session_id.clone(),
                    pid,
                });
            }
            ("stopped", _, _) => self.guard().owned = None,
            _ => {}
        }
        Ok(response)
    }

    /// Read one provider from the service-owned live mihomo home.
    pub async fn get_provider_content(&self, kind: &str, name: &str) -> Result<Value, IpcError> {
        if !matches!(kind, "proxy" | "rule")
            || name.is_empty()
            || name.chars().count() > 256
            || name.len() > 512
        {
            return Err(IpcError::invalid_argument("invalid provider reference"));
        }
        let mut request = Map::new();
        request.insert("operation".into(), json!("provider-content"));
        request.insert("providerKind".into(), json!(kind));
        request.insert("providerName".into(), json!(name));
        let response = self.exchange(request, 30_000).await?;
        match (
            response.outcome.as_str(),
            &response.content,
            &response.content_format,
            &response.content_source,
        ) {
            ("content", Some(content), Some(format), Some(source)) => Ok(json!({
                "kind": kind, "name": name, "content": content, "format": format, "source": source
            })),
            _ => {
                let message = match response.error_code.as_deref() {
                    Some("PROVIDER_NOT_FOUND") => "当前运行配置中没有这个外部资源".to_string(),
                    Some("PROVIDER_CACHE_MISSING") => "资源缓存尚未生成，请先更新资源".to_string(),
                    Some("PROVIDER_PATH_UNAVAILABLE") => "该资源没有可读取的缓存路径".to_string(),
                    Some("PROVIDER_CONTENT_TOO_LARGE") => {
                        "资源内容超过 4 MiB，暂时无法预览".to_string()
                    }
                    Some("PROVIDER_CONTENT_INVALID") => "资源缓存不是可显示的文本内容".to_string(),
                    Some("PROVIDER_CONTENT_READ_FAILED") => {
                        "读取资源缓存失败，请检查文件权限或重新更新资源".to_string()
                    }
                    Some("PROVIDER_MRS_CONVERT_FAILED") => "MRS 规则集转换失败".to_string(),
                    Some("PROVIDER_MRS_CONVERT_TIMEOUT") => "MRS 规则集转换超时".to_string(),
                    Some(other) => other.to_string(),
                    None => format!("Service returned {}", response.outcome),
                };
                Err(IpcError::internal(message))
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Arc;

    /// Scripted transport: each request pops one reply builder, which sees the
    /// request (so it can echo requestId / sessionId).
    pub(crate) type Reply = Box<dyn FnOnce(&Value) -> Result<Value, IpcError> + Send>;

    #[derive(Clone, Default)]
    pub(crate) struct ScriptedTransport {
        pub replies: Arc<Mutex<VecDeque<Reply>>>,
        pub requests: Arc<Mutex<Vec<Value>>>,
    }

    impl ScriptedTransport {
        pub(crate) fn push(
            &self,
            reply: impl FnOnce(&Value) -> Result<Value, IpcError> + Send + 'static,
        ) {
            self.replies.lock().unwrap().push_back(Box::new(reply));
        }
    }

    impl TunServiceTransport for ScriptedTransport {
        fn request(
            &self,
            message: Value,
            _timeout_ms: u64,
        ) -> BoxFuture<'_, Result<Value, IpcError>> {
            self.requests.lock().unwrap().push(message.clone());
            let reply = self.replies.lock().unwrap().pop_front();
            Box::pin(async move {
                match reply {
                    Some(reply) => reply(&message),
                    None => Err(unreachable_error("TUN service is unavailable")),
                }
            })
        }
    }

    pub(crate) fn reply(
        request: &Value,
        outcome: &str,
        session: Option<&str>,
        pid: Option<u32>,
    ) -> Value {
        json!({
            "protocolVersion": TUN_SERVICE_PROTOCOL_VERSION,
            "requestId": request["requestId"],
            "outcome": outcome,
            "sessionId": session,
            "pid": pid,
            "errorCode": null
        })
    }

    #[test]
    fn identity_matches_the_typescript_derivation() {
        // sha256("io.murge.desktop")[..16 hex], fixed by service-identity.ts.
        let identity = tun_service_identity("io.murge.desktop");
        let suffix = &sha256_hex("io.murge.desktop")[..16];
        assert_eq!(identity.pipe_name, format!("proxy-desktop-tun-{suffix}"));
        assert_eq!(identity.service_name, format!("ProxyDesktopTun_{suffix}"));
        assert_eq!(identity.namespace_id, format!("proxy-desktop-{suffix}"));
    }

    #[test]
    fn response_validation_mirrors_the_schema() {
        let base = |outcome: &str, session: Value, pid: Value| json!({"protocolVersion": 7, "requestId": "4", "outcome": outcome, "sessionId": session, "pid": pid, "errorCode": null});
        let session = "6f1c2f1e-8a5b-4c1d-9e2f-0a1b2c3d4e5f";
        assert!(
            parse_tun_service_response(&base("running", json!(session), json!(42)), "4").is_ok()
        );
        assert!(
            parse_tun_service_response(&base("running", Value::Null, json!(42)), "4").is_err(),
            "running needs a session"
        );
        assert!(
            parse_tun_service_response(&base("stopped", json!(session), Value::Null), "4").is_err(),
            "stopped keeps no ownership"
        );
        assert!(
            parse_tun_service_response(&base("stopped", Value::Null, Value::Null), "5").is_err(),
            "requestId must match"
        );
        let mut extra = base("stopped", Value::Null, Value::Null);
        extra["surprise"] = json!(1);
        assert!(
            parse_tun_service_response(&extra, "4").is_err(),
            "strict keys"
        );
        let mut message = base("valid", Value::Null, Value::Null);
        message["validationMessage"] = json!("x");
        assert!(
            parse_tun_service_response(&message, "4").is_err(),
            "only failed carries a message"
        );
        let mut content = base("content", Value::Null, Value::Null);
        content["content"] = json!("a: 1");
        assert!(
            parse_tun_service_response(&content, "4").is_err(),
            "content needs metadata"
        );
        content["contentFormat"] = json!("yaml");
        content["contentSource"] = json!("cache");
        assert!(parse_tun_service_response(&content, "4").is_ok());
        let mut bad_code = base("failed", Value::Null, Value::Null);
        bad_code["errorCode"] = json!("lower");
        assert!(parse_tun_service_response(&bad_code, "4").is_err());
        assert!(parse_tun_service_response(&json!({"protocolVersion": 6, "requestId": "4", "outcome": "stopped", "sessionId": null, "pid": null, "errorCode": null}), "4").is_err());
    }

    #[test]
    fn response_frames_are_single_lines() {
        assert_eq!(
            parse_response_frame(b"{\"a\":1}").unwrap(),
            None,
            "incomplete frame waits"
        );
        assert_eq!(
            parse_response_frame(b"{\"a\":1}\r\n").unwrap(),
            Some(json!({"a": 1}))
        );
        assert!(parse_response_frame(b"{\"a\":1}\n{}\n").is_err());
        assert!(parse_response_frame(b"nope\n").is_err());
    }

    #[test]
    fn pipe_names_are_restricted() {
        assert!(NamedPipeTunServiceTransport::new("proxy-desktop-tun-0123").is_ok());
        assert!(NamedPipeTunServiceTransport::new(r"..\evil").is_err());
        assert!(NamedPipeTunServiceTransport::new("").is_err());
    }

    #[tokio::test]
    async fn start_owns_the_session_and_stop_releases_it() {
        let transport = ScriptedTransport::default();
        transport.push(|request| {
            assert_eq!(request["operation"], "start");
            assert_eq!(request["profileSha256"], sha256_hex("mode: rule\n"));
            assert_eq!(request["version"], "smart");
            Ok(reply(
                request,
                "running",
                request["sessionId"].as_str(),
                Some(77),
            ))
        });
        transport.push(|request| {
            assert_eq!(request["operation"], "stop");
            Ok(reply(request, "stopped", None, None))
        });
        let client = TunServiceClient::new(Box::new(transport.clone()));
        let owned = client.start("mode: rule\n", Some("smart")).await.unwrap();
        assert_eq!(owned.pid, 77);
        assert_eq!(
            client
                .start("mode: rule\n", None)
                .await
                .unwrap_err()
                .parts()
                .0,
            code::KERNEL_RUNNING
        );
        client.stop().await.unwrap();
        assert_eq!(client.get_owned_session(), None);
        let ids: Vec<String> = transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r["requestId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["1", "2"], "a locally refused start sends nothing");
    }

    #[tokio::test]
    async fn start_rejects_a_foreign_session_and_conflicts() {
        let transport = ScriptedTransport::default();
        transport.push(|request| {
            Ok(reply(
                request,
                "running",
                Some("6f1c2f1e-8a5b-4c1d-9e2f-0a1b2c3d4e5f"),
                Some(9),
            ))
        });
        transport.push(|request| {
            let mut value = reply(request, "conflict", None, None);
            value["errorCode"] = json!("SESSION_CONFLICT");
            Ok(value)
        });
        let client = TunServiceClient::new(Box::new(transport));
        assert_eq!(
            client.start("a", None).await.unwrap_err().parts().0,
            code::KERNEL_SPAWN_FAILED
        );
        assert_eq!(
            client.start("a", None).await.unwrap_err().parts().0,
            code::TUN_SERVICE_CONFLICT
        );
        assert_eq!(client.get_owned_session(), None);
    }

    #[tokio::test]
    async fn reconcile_adopts_and_clears_ownership() {
        let transport = ScriptedTransport::default();
        let session = "6f1c2f1e-8a5b-4c1d-9e2f-0a1b2c3d4e5f";
        transport.push(move |request| Ok(reply(request, "running", Some(session), Some(5))));
        transport.push(|request| Ok(reply(request, "stopped", None, None)));
        let client = TunServiceClient::new(Box::new(transport));
        client.reconcile().await.unwrap();
        assert_eq!(client.get_owned_session().unwrap().pid, 5);
        client.reconcile().await.unwrap();
        assert_eq!(client.get_owned_session(), None);
    }

    #[tokio::test]
    async fn provider_content_maps_service_errors() {
        let transport = ScriptedTransport::default();
        transport.push(|request| {
            let mut value = reply(request, "failed", None, None);
            value["errorCode"] = json!("PROVIDER_CACHE_MISSING");
            Ok(value)
        });
        transport.push(|request| {
            let mut value = reply(request, "content", None, None);
            value["content"] = json!("payload: []");
            value["contentFormat"] = json!("yaml");
            value["contentSource"] = json!("cache");
            Ok(value)
        });
        let client = TunServiceClient::new(Box::new(transport));
        let error = client
            .get_provider_content("rule", "ads")
            .await
            .unwrap_err();
        assert!(error.0.contains("资源缓存尚未生成"), "{}", error.0);
        let content = client.get_provider_content("rule", "ads").await.unwrap();
        assert_eq!(content["format"], "yaml");
        assert!(client.get_provider_content("bogus", "ads").await.is_err());
    }
}
