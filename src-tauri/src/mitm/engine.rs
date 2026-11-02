//! The in-process MITM engine (docs/MITM_REWRITE.md §3).
//!
//! mihomo routes decrypt-candidate connections to this listener as an HTTP
//! proxy (`Murge-MITM`), so every connection starts with an authenticated
//! `CONNECT host:port`. The engine then either
//! - terminates TLS with a leaf signed by the local CA and serves HTTP/1.1
//!   through the rewrite pipeline (hosts on the decrypt list),
//! - serves plain HTTP through the same pipeline, or
//! - passes the bytes through untouched.
//!
//! Every upstream leg goes back into mihomo's mixed port from the dedicated
//! loopback source address (127.0.0.2), which the injected rules exclude —
//! so the original policy decides the real exit and nothing loops.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
};
use tokio::net::{TcpListener, TcpSocket, TcpStream};

use super::ca::CaAuthority;
use super::rules::{apply_body_rules, apply_header_rules, CompiledRules, Phase, UrlAction};

/// The loopback source every upstream leg binds to; the injected mihomo rules
/// skip it (`NOT SRC-IP-CIDR,127.0.0.2/32`).
pub const UPSTREAM_SOURCE_IP: Ipv4Addr = Ipv4Addr::new(127, 0, 0, 2);
pub const PROXY_USER: &str = "murge";

const HEAD_LIMIT: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(2);
const BODY_LIMIT: usize = 8 * 1024 * 1024;
const LOG_LIMIT: usize = 200;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(full(message.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

// ---------------------------------------------------------------------------
// Recent requests (the 解密 page list)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    pub time: u64,
    pub method: String,
    pub url: String,
    pub host: String,
    pub status: Option<u16>,
    /// What the pipeline did: `302`, `reject-img`, `map-local`, `header`,
    /// `header-rewrite`, `body-rewrite`, …
    pub actions: Vec<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct RequestLog {
    entries: Mutex<VecDeque<LogEntry>>,
    seq: AtomicU64,
}

impl RequestLog {
    pub fn push(&self, mut entry: LogEntry) {
        entry.id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        entry.time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut entries = self.entries.lock().expect("request log");
        if entries.len() >= LOG_LIMIT {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    /// Newest first.
    pub fn list(&self) -> Vec<LogEntry> {
        self.entries
            .lock()
            .expect("request log")
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.entries.lock().expect("request log").clear();
    }
}

// ---------------------------------------------------------------------------
// Shared engine state
// ---------------------------------------------------------------------------

pub type UpstreamResolver = Arc<dyn Fn() -> Option<SocketAddr> + Send + Sync>;

pub struct EngineShared {
    pub password: String,
    pub enabled: AtomicBool,
    pub skip_verify: AtomicBool,
    pub rules: RwLock<Arc<CompiledRules>>,
    pub ca: RwLock<Option<Arc<CaAuthority>>>,
    /// mihomo's mixed port (read per connection: the port can change).
    pub upstream: UpstreamResolver,
    pub source_ip: IpAddr,
    pub log: RequestLog,
    verified_client: Arc<rustls::ClientConfig>,
    unverified_client: Arc<rustls::ClientConfig>,
}

impl EngineShared {
    pub fn new(upstream: UpstreamResolver) -> Self {
        let mut password = [0u8; 18];
        rand::Rng::fill(&mut rand::thread_rng(), &mut password);
        EngineShared {
            password: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(password),
            enabled: AtomicBool::new(false),
            skip_verify: AtomicBool::new(false),
            rules: RwLock::new(Arc::new(CompiledRules::default())),
            ca: RwLock::new(None),
            upstream,
            source_ip: IpAddr::V4(UPSTREAM_SOURCE_IP),
            log: RequestLog::default(),
            verified_client: Arc::new(client_config(false)),
            unverified_client: Arc::new(client_config(true)),
        }
    }

    pub fn rules(&self) -> Arc<CompiledRules> {
        self.rules.read().expect("rules").clone()
    }

    pub fn ca(&self) -> Option<Arc<CaAuthority>> {
        self.ca.read().expect("ca").clone()
    }

    fn client_tls(&self) -> Arc<rustls::ClientConfig> {
        if self.skip_verify.load(Ordering::Relaxed) {
            self.unverified_client.clone()
        } else {
            self.verified_client.clone()
        }
    }
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn client_config(skip_verify: bool) -> rustls::ClientConfig {
    let builder = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions");
    let mut config = if skip_verify {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider())))
            .with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// `skip-server-cert-verify`: accept any upstream certificate (signatures
/// over the handshake are still checked, so the session is still keyed to
/// whatever certificate the server presented).
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Serves the per-host leaf for the client's SNI (or the CONNECT host).
#[derive(Debug)]
struct LeafResolver {
    ca: Arc<CaAuthority>,
    fallback_host: String,
}

impl rustls::server::ResolvesServerCert for LeafResolver {
    fn resolve(
        &self,
        hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        let host = hello.server_name().unwrap_or(&self.fallback_host);
        self.ca.leaf_for(host).ok()
    }
}

// ---------------------------------------------------------------------------
// A stream with already-read bytes in front
// ---------------------------------------------------------------------------

pub struct Prefixed<S> {
    prefix: Vec<u8>,
    position: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Prefixed {
            prefix,
            position: 0,
            inner,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.position < self.prefix.len() {
            let remaining = &self.prefix[self.position..];
            let count = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..count]);
            self.position += count;
            if self.position == self.prefix.len() {
                self.prefix = Vec::new();
                self.position = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Read an HTTP head (request or status line + headers). Returns the lines
/// (without CRLF) and any bytes buffered past the blank line.
async fn read_head<S: AsyncRead + Unpin>(stream: S) -> std::io::Result<(Vec<String>, Vec<u8>, S)> {
    let mut reader = BufReader::new(stream);
    let mut lines = Vec::new();
    let mut total = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "head truncated",
            ));
        }
        total += read;
        if total > HEAD_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "head too large",
            ));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
        if trimmed.is_empty() {
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(trimmed);
    }
    let leftover = reader.buffer().to_vec();
    Ok((lines, leftover, reader.into_inner()))
}

fn header_value<'a>(lines: &'a [String], name: &str) -> Option<&'a str> {
    lines.iter().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// `host:port` / `[v6]:port` → (host without brackets, port).
pub fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Some((host.to_string(), port.parse().ok()?)),
        _ => Some((authority.to_string(), default_port)),
    }
}

fn format_authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

/// Bind the loopback listener synchronously (so the port is known before the
/// first kernel config is composed).
pub fn bind() -> std::io::Result<(std::net::TcpListener, u16)> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Accept loop; runs until the runtime ends.
pub async fn serve(shared: Arc<EngineShared>, listener: std::net::TcpListener) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let shared = shared.clone();
        tokio::spawn(async move {
            let _ = stream.set_nodelay(true);
            let _ = handle_client(shared, stream).await;
        });
    }
}

async fn handle_client(shared: Arc<EngineShared>, stream: TcpStream) -> std::io::Result<()> {
    let (lines, leftover, mut stream) =
        match tokio::time::timeout(HEAD_TIMEOUT, read_head(stream)).await {
            Ok(result) => result?,
            Err(_) => return Ok(()),
        };
    let request_line: Vec<&str> = lines[0].split_whitespace().collect();
    if request_line.len() < 3 || !request_line[0].eq_ignore_ascii_case("CONNECT") {
        stream
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("{PROXY_USER}:{}", shared.password))
    );
    if header_value(&lines, "proxy-authorization") != Some(expected.as_str()) {
        stream
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"murge\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }
    let Some((host, port)) = split_authority(request_line[1], 443) else {
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    };
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;

    // Sniff the first client bytes (TLS ClientHello starts with 0x16).
    let mut first = leftover;
    if first.is_empty() {
        let mut buf = vec![0u8; 4096];
        match tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.read(&mut buf)).await {
            Ok(Ok(0)) => return Ok(()),
            Ok(Ok(read)) => first.extend_from_slice(&buf[..read]),
            Ok(Err(error)) => return Err(error),
            // Server-speaks-first protocol: nothing to inspect.
            Err(_) => {}
        }
    }
    let is_tls = first.first() == Some(&0x16);
    // A ClientHello can span reads (post-quantum key shares make it large):
    // complete the first record so the SNI is visible.
    if is_tls {
        let wanted = tls_record_len(&first).unwrap_or(0).min(HEAD_LIMIT);
        let mut buf = vec![0u8; 4096];
        while first.len() < wanted {
            match tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.read(&mut buf)).await {
                Ok(Ok(read)) if read > 0 => first.extend_from_slice(&buf[..read]),
                _ => break,
            }
        }
    }
    let client = Prefixed::new(first.clone(), stream);
    let enabled = shared.enabled.load(Ordering::Relaxed);
    let rules = shared.rules();
    let looks_http = first.first().is_some_and(|b| b.is_ascii_uppercase());
    // mihomo forwards an IP when the domain was resolved locally (hosts,
    // some TUN paths); the SNI / Host header still names the site.
    let named_host = if host.parse::<IpAddr>().is_ok() {
        if is_tls {
            parse_sni(&first).unwrap_or_else(|| host.clone())
        } else {
            plain_host(&first).unwrap_or_else(|| host.clone())
        }
    } else {
        host.clone()
    };

    if enabled && is_tls && rules.hosts.should_decrypt(&named_host, port) {
        if let Some(ca) = shared.ca() {
            return serve_tls(shared, client, ca, named_host, port).await;
        }
    }
    if enabled
        && !is_tls
        && looks_http
        && rules.has_rewrites()
        && rules.hosts.covers_host(&named_host)
    {
        let ctx = Arc::new(ConnCtx::new(shared, "http", host, port));
        return serve_http(ctx, client).await;
    }
    passthrough(&shared, client, &host, port).await
}

/// Total length (header + body) of the TLS record starting at `bytes`.
fn tls_record_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 5 || bytes[0] != 0x16 {
        return None;
    }
    Some(5 + u16::from_be_bytes([bytes[3], bytes[4]]) as usize)
}

/// The SNI host name of a ClientHello in the first TLS record.
pub fn parse_sni(bytes: &[u8]) -> Option<String> {
    let record = bytes.get(5..tls_record_len(bytes)?.min(bytes.len()))?;
    // Handshake header: type(1)=ClientHello, length(3).
    if *record.first()? != 0x01 {
        return None;
    }
    let mut at = 4 + 2 + 32; // header, legacy_version, random
    let session_len = *record.get(at)? as usize;
    at += 1 + session_len;
    let suites_len = u16::from_be_bytes([*record.get(at)?, *record.get(at + 1)?]) as usize;
    at += 2 + suites_len;
    let compression_len = *record.get(at)? as usize;
    at += 1 + compression_len;
    let extensions_len = u16::from_be_bytes([*record.get(at)?, *record.get(at + 1)?]) as usize;
    at += 2;
    let end = (at + extensions_len).min(record.len());
    while at + 4 <= end {
        let kind = u16::from_be_bytes([record[at], record[at + 1]]);
        let len = u16::from_be_bytes([record[at + 2], record[at + 3]]) as usize;
        let data = record.get(at + 4..at + 4 + len)?;
        if kind == 0 {
            // server_name_list: length(2), then entries type(1) len(2) name.
            let mut cursor = 2;
            while cursor + 3 <= data.len() {
                let name_type = data[cursor];
                let name_len = u16::from_be_bytes([data[cursor + 1], data[cursor + 2]]) as usize;
                let name = data.get(cursor + 3..cursor + 3 + name_len)?;
                if name_type == 0 {
                    return std::str::from_utf8(name)
                        .ok()
                        .map(|n| n.to_ascii_lowercase());
                }
                cursor += 3 + name_len;
            }
            return None;
        }
        at += 4 + len;
    }
    None
}

/// The Host header of a plain HTTP request head, without the port.
fn plain_host(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let head = text.split("\r\n\r\n").next()?;
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("host") {
            return None;
        }
        split_authority(value.trim(), 80).map(|(host, _)| host)
    })
}

async fn passthrough<S>(
    shared: &EngineShared,
    mut client: S,
    host: &str,
    port: u16,
) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut upstream = dial_upstream(shared, host, port).await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

/// CONNECT through mihomo's mixed port from the loop-exempt source address.
async fn dial_upstream(
    shared: &EngineShared,
    host: &str,
    port: u16,
) -> std::io::Result<Prefixed<TcpStream>> {
    let target = (shared.upstream)()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotConnected, "内核未运行"))?;
    let socket = match shared.source_ip {
        IpAddr::V4(_) => TcpSocket::new_v4()?,
        IpAddr::V6(_) => TcpSocket::new_v6()?,
    };
    socket.bind(SocketAddr::new(shared.source_ip, 0))?;
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, socket.connect(target))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "连接内核超时"))??;
    let _ = stream.set_nodelay(true);
    let authority = format_authority(host, port);
    let mut stream = stream;
    stream
        .write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .await?;
    let (lines, leftover, stream) = tokio::time::timeout(CONNECT_TIMEOUT, read_head(stream))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "上游 CONNECT 超时"))??;
    let status = lines[0].split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(std::io::Error::other(format!("上游拒绝连接：{}", lines[0])));
    }
    Ok(Prefixed::new(leftover, stream))
}

async fn serve_tls<S>(
    shared: Arc<EngineShared>,
    client: S,
    ca: Arc<CaAuthority>,
    host: String,
    port: u16,
) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut config = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(std::io::Error::other)?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(LeafResolver {
            ca,
            fallback_host: host.clone(),
        }));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let started = Instant::now();
    let tls = match acceptor.accept(client).await {
        Ok(tls) => tls,
        Err(error) => {
            shared.log.push(LogEntry {
                id: 0,
                time: 0,
                method: "TLS".into(),
                url: format!("https://{}", format_authority(&host, port)),
                host: host.clone(),
                status: None,
                actions: Vec::new(),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(format!(
                    "客户端拒绝了解密证书（证书未信任或应用启用了证书锁定）：{error}"
                )),
            });
            return Ok(());
        }
    };
    let sni = tls.get_ref().1.server_name().map(str::to_string);
    let ctx = Arc::new(ConnCtx::new(shared, "https", sni.unwrap_or(host), port));
    serve_http(ctx, tls).await
}

// ---------------------------------------------------------------------------
// HTTP pipeline
// ---------------------------------------------------------------------------

struct ConnCtx {
    shared: Arc<EngineShared>,
    scheme: &'static str,
    host: String,
    port: u16,
    /// One kept-alive upstream per client connection (keyed by target).
    upstream: tokio::sync::Mutex<Option<(String, hyper::client::conn::http1::SendRequest<Body>)>>,
}

impl ConnCtx {
    fn new(shared: Arc<EngineShared>, scheme: &'static str, host: String, port: u16) -> Self {
        ConnCtx {
            shared,
            scheme,
            host,
            port,
            upstream: tokio::sync::Mutex::new(None),
        }
    }
}

async fn serve_http<S>(ctx: Arc<ConnCtx>, io: S) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |req| {
        let ctx = ctx.clone();
        async move { Ok::<_, Infallible>(handle_request(ctx, req).await) }
    });
    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .serve_connection(TokioIo::new(io), service)
        .with_upgrades()
        .await
        .map_err(std::io::Error::other)
}

struct Target {
    scheme: String,
    host: String,
    port: u16,
}

fn default_port(scheme: &str) -> u16 {
    if scheme == "https" {
        443
    } else {
        80
    }
}

fn authority_for(host: &str, port: u16, scheme: &str) -> String {
    if port == default_port(scheme) {
        if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        }
    } else {
        format_authority(host, port)
    }
}

fn parse_url(url: &str) -> Option<(Target, String)> {
    let parsed = url::Url::parse(url).ok()?;
    let scheme = parsed.scheme().to_string();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = parsed
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = parsed.port().unwrap_or_else(|| default_port(&scheme));
    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    Some((Target { scheme, host, port }, path))
}

fn is_textual(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else {
        return true;
    };
    let lowered = content_type.to_ascii_lowercase();
    lowered.starts_with("text/")
        || lowered.contains("json")
        || lowered.contains("javascript")
        || lowered.contains("xml")
        || lowered.contains("x-www-form-urlencoded")
}

fn decode_body(bytes: &[u8], encoding: Option<&str>) -> Option<Vec<u8>> {
    use std::io::Read;
    match encoding.map(|e| e.trim().to_ascii_lowercase()) {
        None => Some(bytes.to_vec()),
        Some(e) if e.is_empty() || e == "identity" => Some(bytes.to_vec()),
        Some(e) if e == "gzip" || e == "x-gzip" => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(bytes)
                .take(BODY_LIMIT as u64 * 4)
                .read_to_end(&mut out)
                .ok()?;
            Some(out)
        }
        Some(e) if e == "deflate" => {
            let mut out = Vec::new();
            if flate2::read::ZlibDecoder::new(bytes)
                .take(BODY_LIMIT as u64 * 4)
                .read_to_end(&mut out)
                .is_ok()
            {
                return Some(out);
            }
            out.clear();
            flate2::read::DeflateDecoder::new(bytes)
                .take(BODY_LIMIT as u64 * 4)
                .read_to_end(&mut out)
                .ok()?;
            Some(out)
        }
        _ => None,
    }
}

async fn collect_limited<B>(body: B) -> Result<Bytes, String>
where
    B: hyper::body::Body<Data = Bytes> + Send,
    B::Error: Into<BoxError>,
{
    Limited::new(body, BODY_LIMIT)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|error| format!("读取正文失败：{error}"))
}

/// Rewrite a text body in place; returns the new body + whether it changed.
fn rewrite_text(
    bytes: Bytes,
    encoding: Option<&str>,
    rules: &[&super::rules::BodyRewrite],
) -> (Bytes, bool) {
    let Some(decoded) = decode_body(&bytes, encoding) else {
        return (bytes, false);
    };
    let Ok(text) = String::from_utf8(decoded) else {
        return (bytes, false);
    };
    match apply_body_rules(&text, rules) {
        Some(next) => (Bytes::from(next), true),
        None => (bytes, false),
    }
}

fn set_body_headers(headers: &mut hyper::HeaderMap, length: usize, drop_encoding: bool) {
    if drop_encoding {
        headers.remove(hyper::header::CONTENT_ENCODING);
    }
    headers.remove(hyper::header::TRANSFER_ENCODING);
    headers.insert(
        hyper::header::CONTENT_LENGTH,
        hyper::header::HeaderValue::from(length),
    );
}

async fn handle_request(ctx: Arc<ConnCtx>, mut req: Request<Incoming>) -> Response<Body> {
    let started = Instant::now();
    let shared = ctx.shared.clone();
    let rules = shared.rules();
    let host_header = req
        .headers()
        .get(hyper::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let (mut target_host, mut target_port) = host_header
        .as_deref()
        .and_then(|value| split_authority(value, default_port(ctx.scheme)))
        .unwrap_or((ctx.host.clone(), ctx.port));
    if target_host.is_empty() {
        target_host = ctx.host.clone();
        target_port = ctx.port;
    }
    let mut scheme = ctx.scheme.to_string();
    let mut path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let mut url = format!(
        "{scheme}://{}{path}",
        authority_for(&target_host, target_port, &scheme)
    );
    let mut entry = LogEntry {
        id: 0,
        time: 0,
        method: req.method().to_string(),
        url: url.clone(),
        host: target_host.clone(),
        status: None,
        actions: Vec::new(),
        duration_ms: 0,
        error: None,
    };
    let finish = |mut entry: LogEntry, response: Response<Body>| {
        entry.status = Some(response.status().as_u16());
        entry.duration_ms = started.elapsed().as_millis() as u64;
        shared.log.push(entry);
        response
    };

    // --- URL rewrite ---
    if let Some((rule, rewritten)) = rules.find_url_rewrite(&url) {
        match &rule.action {
            UrlAction::Redirect(code) => {
                entry.actions.push(code.to_string());
                let mut response = Response::new(full(Bytes::new()));
                *response.status_mut() = StatusCode::from_u16(*code).unwrap_or(StatusCode::FOUND);
                if let Ok(location) = hyper::header::HeaderValue::from_str(&rewritten) {
                    response
                        .headers_mut()
                        .insert(hyper::header::LOCATION, location);
                }
                return finish(entry, response);
            }
            UrlAction::Reject(kind) => {
                entry.actions.push(kind.label().into());
                let (status, content_type, body) = kind.response();
                let mut response = Response::new(full(Bytes::from_static(body)));
                *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
                response.headers_mut().insert(
                    hyper::header::CONTENT_TYPE,
                    hyper::header::HeaderValue::from_static(content_type),
                );
                return finish(entry, response);
            }
            UrlAction::Header => {
                if let Some((next, next_path)) = parse_url(&rewritten) {
                    entry.actions.push("header".into());
                    scheme = next.scheme;
                    target_host = next.host;
                    target_port = next.port;
                    path = next_path;
                    url = rewritten;
                    if let Ok(value) = hyper::header::HeaderValue::from_str(&authority_for(
                        &target_host,
                        target_port,
                        &scheme,
                    )) {
                        req.headers_mut().insert(hyper::header::HOST, value);
                    }
                }
            }
        }
    }

    // --- Map Local ---
    if let Some(local) = rules.find_map_local(&url) {
        entry.actions.push("map-local".into());
        let mut response = Response::new(full(Bytes::from(local.body.clone())));
        *response.status_mut() = StatusCode::from_u16(local.status).unwrap_or(StatusCode::OK);
        for (name, value) in &local.headers {
            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(name.as_bytes()),
                hyper::header::HeaderValue::from_str(value),
            ) {
                response.headers_mut().insert(name, value);
            }
        }
        if let Ok(value) = hyper::header::HeaderValue::from_str(&local.content_type) {
            response
                .headers_mut()
                .insert(hyper::header::CONTENT_TYPE, value);
        }
        return finish(entry, response);
    }

    // --- Request headers / body ---
    if apply_header_rules(req.headers_mut(), rules.header_rules(Phase::Request, &url)) {
        entry.actions.push("header-rewrite".into());
    }
    let response_body_rules = rules.body_rules(Phase::Response, &url);
    if !response_body_rules.is_empty() {
        req.headers_mut().insert(
            hyper::header::ACCEPT_ENCODING,
            hyper::header::HeaderValue::from_static("identity"),
        );
    }
    let client_upgrade = req
        .headers()
        .contains_key(hyper::header::UPGRADE)
        .then(|| hyper::upgrade::on(&mut req));
    let (mut parts, incoming) = req.into_parts();
    for name in ["proxy-connection", "proxy-authorization"] {
        parts.headers.remove(name);
    }
    let request_body_rules = rules.body_rules(Phase::Request, &url);
    let body: Body = if !request_body_rules.is_empty()
        && is_textual(
            parts
                .headers
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
        ) {
        let bytes = match collect_limited(incoming).await {
            Ok(bytes) => bytes,
            Err(message) => {
                entry.error = Some(message.clone());
                return finish(
                    entry,
                    error_response(StatusCode::PAYLOAD_TOO_LARGE, &message),
                );
            }
        };
        let encoding = parts
            .headers
            .get(hyper::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let (next, changed) = rewrite_text(bytes, encoding.as_deref(), &request_body_rules);
        if changed {
            entry.actions.push("body-rewrite".into());
            set_body_headers(&mut parts.headers, next.len(), true);
        }
        full(next)
    } else {
        incoming.map_err(|e| Box::new(e) as BoxError).boxed()
    };
    parts.uri = match path.parse() {
        Ok(uri) => uri,
        Err(_) => {
            entry.error = Some("URL 无效".into());
            return finish(entry, error_response(StatusCode::BAD_REQUEST, "URL 无效"));
        }
    };
    if !parts.headers.contains_key(hyper::header::HOST) {
        if let Ok(value) =
            hyper::header::HeaderValue::from_str(&authority_for(&target_host, target_port, &scheme))
        {
            parts.headers.insert(hyper::header::HOST, value);
        }
    }
    let upstream_req = Request::from_parts(parts, body);
    entry.url = url.clone();
    entry.host = target_host.clone();

    // --- Upstream ---
    let target = Target {
        scheme,
        host: target_host,
        port: target_port,
    };
    let mut response = match send_upstream(&ctx, &target, upstream_req).await {
        Ok(response) => response,
        Err(message) => {
            entry.error = Some(message.clone());
            return finish(entry, error_response(StatusCode::BAD_GATEWAY, &message));
        }
    };

    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let server_upgrade = hyper::upgrade::on(&mut response);
        if let Some(client_upgrade) = client_upgrade {
            tokio::spawn(async move {
                if let (Ok(client), Ok(server)) = (client_upgrade.await, server_upgrade.await) {
                    let mut client = TokioIo::new(client);
                    let mut server = TokioIo::new(server);
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                }
            });
        }
        entry.actions.push("websocket".into());
        let (parts, _) = response.into_parts();
        return finish(entry, Response::from_parts(parts, full(Bytes::new())));
    }

    // --- Response headers / body ---
    let (mut parts, incoming) = response.into_parts();
    if apply_header_rules(
        &mut parts.headers,
        rules.header_rules(Phase::Response, &url),
    ) {
        entry.actions.push("header-rewrite".into());
    }
    let content_type = parts
        .headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let declared_length = parts
        .headers
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    let body: Body = if !response_body_rules.is_empty()
        && is_textual(content_type)
        && declared_length.is_none_or(|length| length <= BODY_LIMIT)
    {
        match collect_limited(incoming).await {
            Ok(bytes) => {
                let encoding = parts
                    .headers
                    .get(hyper::header::CONTENT_ENCODING)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                let (next, changed) =
                    rewrite_text(bytes, encoding.as_deref(), &response_body_rules);
                if changed {
                    entry.actions.push("body-rewrite".into());
                    set_body_headers(&mut parts.headers, next.len(), true);
                }
                full(next)
            }
            Err(message) => {
                entry.error = Some(message.clone());
                return finish(entry, error_response(StatusCode::BAD_GATEWAY, &message));
            }
        }
    } else {
        incoming.map_err(|e| Box::new(e) as BoxError).boxed()
    };
    finish(entry, Response::from_parts(parts, body))
}

async fn send_upstream(
    ctx: &ConnCtx,
    target: &Target,
    req: Request<Body>,
) -> Result<Response<Incoming>, String> {
    let key = format!(
        "{}://{}",
        target.scheme,
        format_authority(&target.host, target.port)
    );
    let mut slot = ctx.upstream.lock().await;
    let reusable = match slot.take() {
        Some((existing_key, mut sender)) if existing_key == key => {
            sender.ready().await.ok().map(|_| sender)
        }
        _ => None,
    };
    let mut sender = match reusable {
        Some(sender) => sender,
        None => open_upstream(&ctx.shared, target).await?,
    };
    let result = sender.send_request(req).await;
    *slot = Some((key, sender));
    result.map_err(|error| format!("上游请求失败：{error}"))
}

async fn open_upstream(
    shared: &EngineShared,
    target: &Target,
) -> Result<hyper::client::conn::http1::SendRequest<Body>, String> {
    let stream = dial_upstream(shared, &target.host, target.port)
        .await
        .map_err(|error| format!("连接上游失败：{error}"))?;
    if target.scheme == "https" {
        let connector = tokio_rustls::TlsConnector::from(shared.client_tls());
        let name = rustls::pki_types::ServerName::try_from(target.host.clone())
            .map_err(|_| format!("主机名无效：{}", target.host))?;
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, stream))
            .await
            .map_err(|_| "源站 TLS 握手超时".to_string())?
            .map_err(|error| format!("源站 TLS 握手失败：{error}"))?;
        handshake(tls).await
    } else {
        handshake(stream).await
    }
}

async fn handshake<S>(io: S) -> Result<hyper::client::conn::http1::SendRequest<Body>, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sender, connection) = hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .handshake(TokioIo::new(io))
        .await
        .map_err(|error| format!("上游握手失败：{error}"))?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    Ok(sender)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mitm::rules::{CompiledRules, ModuleSource};

    /// The origin: TLS with a leaf from its own CA; echoes on `/ws` after 101.
    pub(super) async fn origin(origin_ca: Arc<CaAuthority>) -> SocketAddr {
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(LeafResolver {
                ca: origin_ca,
                fallback_host: "origin.test".into(),
            }));
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let service =
                        hyper::service::service_fn(|mut req: Request<Incoming>| async move {
                            if req.uri().path() == "/ws" {
                                let upgrade = hyper::upgrade::on(&mut req);
                                tokio::spawn(async move {
                                    if let Ok(upgraded) = upgrade.await {
                                        let mut io = TokioIo::new(upgraded);
                                        let mut buf = [0u8; 5];
                                        if io.read_exact(&mut buf).await.is_ok() {
                                            let _ = io.write_all(&buf).await;
                                        }
                                    }
                                });
                                let response = Response::builder()
                                    .status(101)
                                    .header("connection", "upgrade")
                                    .header("upgrade", "websocket")
                                    .body(full(Bytes::new()))
                                    .unwrap();
                                return Ok::<_, Infallible>(response);
                            }
                            let seen = req
                                .headers()
                                .get("x-added")
                                .map(|v| v.to_str().unwrap().to_string())
                                .unwrap_or_default();
                            let response = Response::builder()
                                .header("content-type", "application/json")
                                .header("x-seen", seen)
                                .body(full(r#"{"vip":false}"#))
                                .unwrap();
                            Ok::<_, Infallible>(response)
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
        addr
    }

    /// The mihomo stand-in: answers CONNECT and records the source address.
    async fn fake_mihomo(origin: SocketAddr, sources: Arc<Mutex<Vec<IpAddr>>>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                sources.lock().unwrap().push(peer.ip());
                tokio::spawn(async move {
                    let (_, _, mut stream) = read_head(stream).await.unwrap();
                    let mut upstream = TcpStream::connect(origin).await.unwrap();
                    stream
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                });
            }
        });
        addr
    }

    async fn connect_through(engine: u16, password: &str, host: &str) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", engine)).await.unwrap();
        let auth =
            base64::engine::general_purpose::STANDARD.encode(format!("{PROXY_USER}:{password}"));
        stream
            .write_all(format!("CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let (lines, leftover, stream) = read_head(stream).await.unwrap();
        assert!(lines[0].contains(" 200 "), "{lines:?}");
        assert!(leftover.is_empty());
        stream
    }

    pub(super) async fn tls_client(
        stream: TcpStream,
        root: &CaAuthority,
        host: &str,
    ) -> Result<hyper::client::conn::http1::SendRequest<Body>, String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(root.ca_der().clone()).unwrap();
        let mut config = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).unwrap();
        let tls = connector
            .connect(name, stream)
            .await
            .map_err(|e| e.to_string())?;
        handshake(tls).await
    }

    pub(super) fn get(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("host", host)
            .body(full(Bytes::new()))
            .unwrap()
    }

    #[tokio::test]
    async fn decrypts_rewrites_passes_through_and_avoids_loops() {
        let (mitm_ca, _) = CaAuthority::generate("Murge Test MITM").unwrap();
        let mitm_ca = Arc::new(mitm_ca);
        let (origin_ca, _) = CaAuthority::generate("Origin Test CA").unwrap();
        let origin_ca = Arc::new(origin_ca);
        let origin_addr = origin(origin_ca.clone()).await;
        let sources = Arc::new(Mutex::new(Vec::new()));
        let upstream = fake_mihomo(origin_addr, sources.clone()).await;

        let shared = Arc::new(EngineShared::new(Arc::new(move || Some(upstream))));
        shared.enabled.store(true, Ordering::Relaxed);
        shared.skip_verify.store(true, Ordering::Relaxed);
        *shared.ca.write().unwrap() = Some(mitm_ca.clone());
        let module = r#"
[URL Rewrite]
^https://origin\.test/old/(.*) https://origin.test/new/$1 302
^https://origin\.test/ad - reject-dict
[Header Rewrite]
http-request ^https://origin\.test/ header-add X-Added yes
http-response ^https://origin\.test/ header-add X-Murge 1
[Body Rewrite]
http-response ^https://origin\.test/api "\"vip\":false" "\"vip\":true"
"#;
        *shared.rules.write().unwrap() = Arc::new(CompiledRules::build(
            &["origin.test".into()],
            &[ModuleSource { content: module }],
            true,
        ));
        let (listener, port) = bind().unwrap();
        tokio::spawn(serve(shared.clone(), listener));

        // Decrypted: the client trusts only the MITM CA.
        let stream = connect_through(port, &shared.password, "origin.test").await;
        let mut sender = tls_client(stream, &mitm_ca, "origin.test")
            .await
            .expect("mitm leaf trusted");
        let response = sender
            .send_request(get("/api/me", "origin.test"))
            .await
            .unwrap();
        assert_eq!(response.headers()["x-murge"], "1");
        assert_eq!(response.headers()["x-seen"], "yes");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"vip":true}"#);

        // Same client connection: redirect + reject without touching upstream.
        sender.ready().await.unwrap();
        let response = sender
            .send_request(get("/old/a?b=1", "origin.test"))
            .await
            .unwrap();
        assert_eq!(response.status(), 302);
        assert_eq!(
            response.headers()["location"],
            "https://origin.test/new/a?b=1"
        );
        sender.ready().await.unwrap();
        let response = sender
            .send_request(get("/ad", "origin.test"))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"{}");

        // WebSocket-style upgrade is spliced through.
        let stream = connect_through(port, &shared.password, "origin.test").await;
        let mut sender = tls_client(stream, &mitm_ca, "origin.test").await.unwrap();
        let request = Request::builder()
            .uri("/ws")
            .header("host", "origin.test")
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .body(full(Bytes::new()))
            .unwrap();
        let mut response = sender.send_request(request).await.unwrap();
        assert_eq!(response.status(), 101);
        let upgraded = hyper::upgrade::on(&mut response).await.unwrap();
        let mut io = TokioIo::new(upgraded);
        io.write_all(b"hello").await.unwrap();
        let mut echo = [0u8; 5];
        io.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"hello");

        // Not on the list: passthrough, the client sees the ORIGIN certificate.
        let stream = connect_through(port, &shared.password, "other.test").await;
        assert!(tls_client(stream, &mitm_ca, "origin.test").await.is_err());
        let stream = connect_through(port, &shared.password, "other.test").await;
        let mut sender = tls_client(stream, &origin_ca, "origin.test")
            .await
            .expect("origin cert");
        let response = sender
            .send_request(get("/api/me", "origin.test"))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"vip":false}"#);

        // Every upstream leg came from the loop-exempt source address.
        let sources = sources.lock().unwrap().clone();
        assert!(!sources.is_empty());
        assert!(
            sources
                .iter()
                .all(|ip| *ip == IpAddr::V4(UPSTREAM_SOURCE_IP)),
            "{sources:?}"
        );

        let log = shared.log.list();
        assert!(log
            .iter()
            .any(|e| e.actions.contains(&"body-rewrite".to_string())));
        assert!(log.iter().any(|e| e.actions.contains(&"302".to_string())));
    }

    #[tokio::test]
    async fn rejects_unauthenticated_and_non_connect_clients() {
        let shared = Arc::new(EngineShared::new(Arc::new(|| None)));
        let (listener, port) = bind().unwrap();
        tokio::spawn(serve(shared.clone(), listener));
        for request in [
            "CONNECT a.com:443 HTTP/1.1\r\nHost: a.com:443\r\n\r\n".to_string(),
            "CONNECT a.com:443 HTTP/1.1\r\nProxy-Authorization: Basic bXVyZ2U6d3Jvbmc=\r\n\r\n"
                .to_string(),
            "GET http://a.com/ HTTP/1.1\r\nHost: a.com\r\n\r\n".to_string(),
        ] {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let (lines, _, _) = read_head(stream).await.unwrap();
            assert!(
                lines[0].contains(" 407 ") || lines[0].contains(" 405 "),
                "{lines:?}"
            );
        }
    }

    #[test]
    fn sni_and_host_sniffing() {
        let mut config = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let name = rustls::pki_types::ServerName::try_from("Sni.Example.com").unwrap();
        let mut conn = rustls::ClientConnection::new(Arc::new(config), name).unwrap();
        let mut hello = Vec::new();
        conn.write_tls(&mut hello).unwrap();
        assert_eq!(tls_record_len(&hello), Some(hello.len()));
        assert_eq!(parse_sni(&hello).as_deref(), Some("sni.example.com"));
        assert_eq!(parse_sni(&hello[..20]), None);
        assert_eq!(
            plain_host(b"GET / HTTP/1.1\r\nHost: a.com:8080\r\n\r\n").as_deref(),
            Some("a.com")
        );
    }

    #[test]
    fn authority_parsing() {
        assert_eq!(
            split_authority("a.com:8443", 443),
            Some(("a.com".into(), 8443))
        );
        assert_eq!(split_authority("a.com", 443), Some(("a.com".into(), 443)));
        assert_eq!(split_authority("[::1]:80", 443), Some(("::1".into(), 80)));
        assert_eq!(format_authority("::1", 80), "[::1]:80");
        assert_eq!(authority_for("a.com", 443, "https"), "a.com");
        assert_eq!(authority_for("a.com", 8443, "https"), "a.com:8443");
    }

    #[test]
    fn decodes_gzip_bodies() {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"hello").unwrap();
        let gz = encoder.finish().unwrap();
        assert_eq!(decode_body(&gz, Some("gzip")).unwrap(), b"hello");
        assert!(decode_body(b"x", Some("br")).is_none());
        assert!(is_textual(Some("application/json; charset=utf-8")));
        assert!(!is_textual(Some("image/png")));
    }
}

/// Manual end-to-end check against a real mihomo binary:
/// `MURGE_E2E_MIHOMO=/path/to/mihomo cargo test --lib mitm::engine::e2e`.
/// Skipped (passes trivially) when the variable is unset, so CI's
/// `--include-ignored` run is unaffected.
#[cfg(test)]
mod e2e {
    use super::tests::{get, origin, tls_client};
    use super::*;
    use crate::mitm::rules::{CompiledRules, ModuleSource};

    #[tokio::test]
    async fn e2e_with_real_mihomo() {
        let Ok(binary) = std::env::var("MURGE_E2E_MIHOMO") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let (mitm_ca, _) = CaAuthority::generate("Murge E2E").unwrap();
        let mitm_ca = Arc::new(mitm_ca);
        let (origin_ca, _) = CaAuthority::generate("Origin E2E").unwrap();
        let origin_addr = origin(Arc::new(origin_ca)).await;
        let mixed = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };
        let upstream = SocketAddr::from(([127, 0, 0, 1], mixed));
        let shared = Arc::new(EngineShared::new(Arc::new(move || Some(upstream))));
        shared.enabled.store(true, Ordering::Relaxed);
        shared.skip_verify.store(true, Ordering::Relaxed);
        *shared.ca.write().unwrap() = Some(mitm_ca.clone());
        let module = "[Body Rewrite]\nhttp-response ^https://origin\\.test \"\\\"vip\\\":false\" \"\\\"vip\\\":true\"\n";
        *shared.rules.write().unwrap() = Arc::new(CompiledRules::build(
            &["origin.test:*".into()],
            &[ModuleSource { content: module }],
            true,
        ));
        let (listener, port) = bind().unwrap();
        tokio::spawn(serve(shared.clone(), listener));

        let base = format!(
            "mixed-port: {mixed}\nmode: rule\nlog-level: debug\nhosts:\n  origin.test: 127.0.0.1\n  other.test: 127.0.0.1\nproxies: []\nrules:\n  - MATCH,DIRECT\n"
        );
        let filters = shared.rules().hosts.mihomo_filters();
        let config =
            crate::mitm::inject_into_document(&base, &filters, port, &shared.password).unwrap();
        std::fs::write(dir.path().join("config.yaml"), &config).unwrap();
        let mut child = std::process::Command::new(binary)
            .arg("-d")
            .arg(dir.path())
            .arg("-f")
            .arg(dir.path().join("config.yaml"))
            .stdout(std::fs::File::create(dir.path().join("mihomo.log")).unwrap())
            .spawn()
            .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        let authority = format!("origin.test:{}", origin_addr.port());
        let attempt = async {
            let mut stream = TcpStream::connect(upstream).await.unwrap();
            stream
                .write_all(
                    format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
            let (lines, _, stream) = read_head(stream).await.unwrap();
            assert!(lines[0].contains(" 200 "), "{lines:?}");
            let mut sender = match tls_client(stream, &mitm_ca, "origin.test").await {
                Ok(sender) => sender,
                Err(error) => return Err(error),
            };
            let response = sender.send_request(get("/api", &authority)).await.unwrap();
            Ok::<_, String>(response.into_body().collect().await.unwrap().to_bytes())
        };
        let body = tokio::time::timeout(Duration::from_secs(15), attempt).await;
        let _ = child.kill();
        let _ = child.wait();
        let log = std::fs::read_to_string(dir.path().join("mihomo.log")).unwrap_or_default();
        let body = body
            .unwrap_or_else(|_| Err("timed out".into()))
            .unwrap_or_else(|error| panic!("{error}\n{config}\n{log}"));
        assert_eq!(&body[..], br#"{"vip":true}"#, "{config}\n{log}");
        assert!(log.contains("Murge-MITM"), "{log}");
        eprintln!("{config}\n{log}");
    }
}
