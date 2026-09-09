//! Kernel process lifecycle — the Rust mirror of `src/main/kernel/types.ts`,
//! staged API surfaces below are consumed by the real-kernel wiring slice.
//! `mihomo-config.ts`, `config-store.ts`, `mihomo-config-store.ts`,
//! `node-adapter.ts`, `resolvers.ts` and `supervisor.ts`.
//!
//! The supervisor owns the kernel process lifecycle over injected seams: a
//! `KernelBinaryResolver` (which binary to run), a `KernelConfigStore` (the
//! materialized runtime config) and a `KernelProcessAdapter` (OS process
//! spawning). Start/stop serialize through a single tokio queue so concurrent
//! calls queue instead of racing: a second start is idempotent, and a stop
//! submitted while a start is in flight runs only after the start settles.
//! The default production composition keeps the disabled resolver (the same
//! UNSUPPORTED copy the Electron build uses outside packaged Windows) until
//! the artifact pipeline is wired into app setup.

#![cfg_attr(not(test), allow(dead_code))]
use crate::error::{code, IpcError};
use crate::events::EventHub;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The disabled-resolver copy (resolvers.ts DisabledKernelResolver).
pub const DISABLED_RESOLVER_MESSAGE: &str =
    "Kernel execution is disabled in this build; no real kernel is started.";

// ---------------------------------------------------------------------------
// Shared contract (main/kernel/types.ts)
// ---------------------------------------------------------------------------

/// A resolved kernel executable.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelBinary {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub version: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// A materialized runtime config (the supervisor's contract with its store).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelConfig {
    pub config_path: PathBuf,
    pub root_dir: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Resolves the binary to run. It never touches the OS process layer.
pub trait KernelBinaryResolver: Send + Sync {
    fn resolve(&self) -> BoxFuture<'_, Result<KernelBinary, IpcError>>;
}

/// Materializes the runtime config and cleans its workspace afterwards.
pub trait KernelConfigStore: Send + Sync {
    fn materialize<'a>(&'a self, binary: &'a KernelBinary, secret: &'a str) -> BoxFuture<'a, Result<KernelConfig, IpcError>>;
    fn cleanup<'a>(&'a self, config: &'a KernelConfig) -> BoxFuture<'a, Result<(), IpcError>>;
}

// ---------------------------------------------------------------------------
// Secrets (mihomo-config.ts randomSecret)
// ---------------------------------------------------------------------------

/// The strict controller-secret contract: 64 lowercase hex characters.
pub fn is_valid_secret(secret: &str) -> bool {
    secret.len() == 64 && secret.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The shared auth secret is generated exactly once at the composition root
/// from the OS CSPRNG (`randomSecret(32)` → 64 hex characters).
pub fn random_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Strict config generation (mihomo-config.ts generateMihomoConfig)
// ---------------------------------------------------------------------------

/// Unprivileged port range: high ports only, never a privileged (<1024) port.
const MIN_PORT: i64 = 1024;
const MAX_PORT: i64 = 65535;

fn assert_port(port: i64, label: &str) -> Result<(), IpcError> {
    if !(MIN_PORT..=MAX_PORT).contains(&port) {
        return Err(IpcError::invalid_argument(format!(
            "Invalid {label}: must be an unprivileged integer port between {MIN_PORT} and {MAX_PORT}, got {port}"
        )));
    }
    Ok(())
}

/// Generate the strict loopback-only direct config, byte-shaped like the TS
/// output. No profile: proxies, groups and rules come from the profile branch
/// of the config store, never from this strict generator.
pub fn generate_mihomo_config(options: &Value) -> Result<String, IpcError> {
    let mixed_port = options["mixedPort"].as_i64().unwrap_or(0);
    let controller_port = options["controllerPort"].as_i64().unwrap_or(0);
    let http_port = options["httpPort"].as_i64().unwrap_or(0);
    let socks_port = options["socksPort"].as_i64().unwrap_or(0);
    let allow_lan = options["allowLan"].as_bool().unwrap_or(false);
    let controller_host = options["controllerHost"].as_str().unwrap_or("127.0.0.1");
    let controller_panel = options["controllerPanel"].as_bool().unwrap_or(false);
    let log_level = options["logLevel"].as_str().unwrap_or("info");
    let secret = options["secret"].as_str().unwrap_or_default();
    assert_port(mixed_port, "mixed-port")?;
    assert_port(controller_port, "external-controller port")?;
    if mixed_port == controller_port {
        return Err(IpcError::invalid_argument("mixed-port and external-controller port must differ"));
    }
    for (index, port) in [http_port, socks_port].into_iter().enumerate() {
        if port != 0 {
            assert_port(port, if index == 0 { "HTTP port" } else { "SOCKS port" })?;
        }
    }
    let mut active_ports = vec![mixed_port, controller_port];
    if http_port != 0 {
        active_ports.push(http_port);
    }
    if socks_port != 0 {
        active_ports.push(socks_port);
    }
    let unique: std::collections::HashSet<i64> = active_ports.iter().copied().collect();
    if unique.len() != active_ports.len() {
        return Err(IpcError::invalid_argument("listener ports must differ"));
    }
    if !is_valid_secret(secret) {
        return Err(IpcError::invalid_argument("secret must be a 64-character lowercase hex string"));
    }
    // Phase 7 pins DIRECT; other modes are rejected before any directory is
    // created (the TS generateMihomoConfig order).
    let mode = options["mode"].as_str().unwrap_or("direct");
    if mode != "direct" {
        return Err(IpcError::invalid_argument(format!("Unsupported mihomo mode: {mode}; Phase 7 requires 'direct'")));
    }
    if !matches!(log_level, "silent" | "error" | "warn" | "info" | "debug") {
        return Err(IpcError::invalid_argument(format!("Unsupported log level: {log_level}")));
    }
    Ok(
        [
            (http_port != 0).then(|| format!("port: {http_port}")),
            (socks_port != 0).then(|| format!("socks-port: {socks_port}")),
            Some(format!("mixed-port: {mixed_port}")),
            Some(format!("allow-lan: {allow_lan}")),
            Some(format!("bind-address: {}", if allow_lan { "'*'" } else { "127.0.0.1" })),
            Some("mode: direct".to_string()),
            Some(format!("log-level: {log_level}")),
            Some("ipv6: false".to_string()),
            Some(format!("external-controller: {controller_host}:{controller_port}")),
            Some(format!("secret: {secret}")),
            controller_panel.then(|| {
                "external-ui: ui\nexternal-ui-name: metacubexd\nexternal-ui-url: https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip".to_string()
            }),
            Some("tun:\n  enable: false".to_string()),
            Some("dns:\n  enable: false".to_string()),
            Some("rules:\n  - MATCH,DIRECT".to_string()),
            Some(String::new()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<String>>()
        .join("\n"),
    )
}

// ---------------------------------------------------------------------------
// Config stores (config-store.ts + mihomo-config-store.ts)
// ---------------------------------------------------------------------------

/// Materializes a runtime config into an isolated temporary workspace and
/// cleans it up afterwards (`config-store.ts` TempKernelConfigStore).
pub struct TempKernelConfigStore;

impl KernelConfigStore for TempKernelConfigStore {
    fn materialize<'a>(&'a self, _binary: &'a KernelBinary, secret: &'a str) -> BoxFuture<'a, Result<KernelConfig, IpcError>> {
        let secret = secret.to_string();
        Box::pin(async move {
            let root_dir =
                std::env::temp_dir().join(format!("kernel-workspace-{}", crate::system_proxy::new_uuid()));
            std::fs::create_dir_all(&root_dir).map_err(|error| {
                IpcError::code(code::KERNEL_SPAWN_FAILED, format!("Failed to create the kernel workspace: {error}"))
            })?;
            let config_path = root_dir.join("config.yaml");
            // Harmless placeholder: no listener, no proxy, no TUN/DNS.
            std::fs::write(&config_path, format!("# Fixture kernel config (no listener configured)\nkernelSecret: {secret}\n"))
                .map_err(|error| {
                    IpcError::code(code::KERNEL_SPAWN_FAILED, format!("Failed to write the kernel config: {error}"))
                })?;
            let mut env = BTreeMap::new();
            env.insert("MURGE_KERNEL_SECRET".to_string(), secret.to_string());
            env.insert("MURGE_KERNEL_CONFIG".to_string(), config_path.to_string_lossy().to_string());
            Ok(KernelConfig { config_path, root_dir, args: Vec::new(), env })
        })
    }

    fn cleanup<'a>(&'a self, config: &'a KernelConfig) -> BoxFuture<'a, Result<(), IpcError>> {
        let config = config.clone();
        Box::pin(async move {
            // Never delete outside the workspace this store created.
            let root = config.root_dir.canonicalize().unwrap_or_else(|_| config.root_dir.clone());
            let child = config.config_path.canonicalize().unwrap_or_else(|_| config.config_path.clone());
            if child != root && !child.starts_with(&root) {
                return Ok(());
            }
            let _ = std::fs::remove_dir_all(&root);
            Ok(())
        })
    }
}

/// The production store (`mihomo-config-store.ts`): writes the strict runtime
/// config into an exclusive per-run child of `workspaceDir` and keeps the
/// persistent kernel home (`-d`) that holds geodata + provider caches across
/// restarts. Validations run FIRST (secret → generated/config document →
/// YAML schema) so an invalid secret or profile never leaves a stale
/// `mihomo-workspace-*` child behind; the written document is gated by
/// `kernel_config_validation` (strict allowlist for the direct branch, the
/// `配置文件构建失败：…` profile gate for the profile branch). Cleanup deletes
/// ONLY the exact per-run child this store created — never the stable
/// kernel home whose geodata must survive restarts.
pub struct StrictMihomoConfigStore {
    pub mixed_port: i64,
    pub http_port: i64,
    pub socks_port: i64,
    pub controller_port: i64,
    pub controller_host: String,
    pub allow_lan: bool,
    pub controller_panel: bool,
    pub workspace_dir: PathBuf,
    pub kernel_home_dir: Option<PathBuf>,
    /// Installer-shipped geodata seeded into the persistent home on every
    /// materialize (fail-open, mtime-refresh semantics).
    pub seed_resources_dir: Option<PathBuf>,
    /// The exact directory this store created; unknown until materialize runs.
    owned_dir: Mutex<Option<PathBuf>>,
    /// When set, the composed ACTIVE profile document becomes the runtime
    /// config instead of the strict direct-only bootstrap.
    pub resolve_active_document: Option<Arc<dyn Fn() -> Option<String> + Send + Sync>>,
}

struct BuiltConfig {
    text: String,
    from_profile: bool,
}

impl KernelConfigStore for StrictMihomoConfigStore {
    fn materialize<'a>(&'a self, _binary: &'a KernelBinary, secret: &'a str) -> BoxFuture<'a, Result<KernelConfig, IpcError>> {
        let secret = secret.to_string();
        Box::pin(async move {
            // (1) Run EVERY filesystem-independent validation FIRST. The
            // secret, the generated config and the YAML schema are all
            // validated before any directory is created, so an invalid secret
            // or config never leaves a stale `mihomo-workspace-*` child
            // behind (a failed materialize returns no KernelConfig, so the
            // supervisor could never clean it up).
            if !is_valid_secret(&secret) {
                return Err(IpcError::invalid_argument(
                    "Mihomo controller secret must be a 64-character lowercase hex string",
                ));
            }
            let built = self.build_config_text(&secret)?;
            if built.from_profile {
                let profile_errors =
                    crate::kernel_config_validation::profile_kernel_config_errors(&built.text);
                if !profile_errors.is_empty() {
                    return Err(IpcError::invalid_argument(format!(
                        "配置文件构建失败：{}",
                        profile_errors.join("；")
                    )));
                }
            } else {
                crate::kernel_config_validation::validate_mihomo_config_yaml(&built.text)?;
            }

            // (2) Only now create the exclusive per-run child plus the
            // persistent home. `workspace_dir` (if given) is a parent; the
            // caller's own files under it must survive a later cleanup.
            let parent = if !self.workspace_dir.as_os_str().is_empty() {
                std::fs::create_dir_all(&self.workspace_dir).map_err(|error| {
                    IpcError::code(
                        code::KERNEL_SPAWN_FAILED,
                        format!("Failed to create the workspace parent: {error}"),
                    )
                })?;
                self.workspace_dir.clone()
            } else {
                std::env::temp_dir()
            };
            let root_dir = parent.join(format!("mihomo-workspace-{}", crate::system_proxy::new_uuid()));
            std::fs::create_dir_all(&root_dir).map_err(|error| {
                IpcError::code(
                    code::KERNEL_SPAWN_FAILED,
                    format!("Failed to create the kernel workspace: {error}"),
                )
            })?;
            *self.owned_dir.lock().expect("owned dir poisoned") = Some(root_dir.clone());
            let config_path = root_dir.join("config.yaml");
            // The kernel home is a stable sibling: it holds the geodata
            // databases and provider caches that must survive restarts, so it
            // is NEVER cleaned up. Without a configured home the per-run dir
            // keeps the historical behavior (fixture/dev runs).
            let home_dir = self
                .kernel_home_dir
                .clone()
                .unwrap_or_else(|| root_dir.clone());
            if let Err(error) = std::fs::create_dir_all(&home_dir) {
                self.remove_owned_dir();
                return Err(IpcError::code(
                    code::KERNEL_SPAWN_FAILED,
                    format!("Failed to create the kernel home: {error}"),
                ));
            }
            let mut seeded: Vec<String> = Vec::new();
            if let Some(seed_dir) = &self.seed_resources_dir {
                // Fail-open by contract: a missing/corrupt seed never blocks a
                // start that could otherwise succeed.
                seeded = crate::kernel_config_validation::seed_geodata_files(&home_dir, seed_dir);
            }

            // (3) Anything that can fail AFTER the child exists (the config
            // write) must remove exactly that child before rethrowing the
            // original error. The caller-provided parent — and any
            // pre-existing file inside it — is never touched.
            if let Err(error) = std::fs::write(&config_path, &built.text) {
                self.remove_owned_dir();
                return Err(IpcError::code(
                    code::KERNEL_SPAWN_FAILED,
                    format!("Failed to write the kernel config: {error}"),
                ));
            }
            let mut env = BTreeMap::new();
            env.insert("MIHOMO_PLATFORM".to_string(), std::env::consts::OS.to_string());
            env.insert("MIHOMO_ARCH".to_string(), std::env::consts::ARCH.to_string());
            env.insert("MIHOMO_GEODATA_SEEDED".to_string(), seeded.join(","));
            let args = vec![
                "-f".to_string(),
                config_path.to_string_lossy().to_string(),
                "-d".to_string(),
                home_dir.to_string_lossy().to_string(),
            ];
            Ok(KernelConfig { config_path, root_dir, args, env })
        })
    }

    /// Build the config document to write. When an active-profile resolver is
    /// configured and returns a document, the profile's proxies/groups/rules
    /// are used with only the app-critical listener/auth keys forced
    /// (from_profile=true). Otherwise the strict loopback-only direct config
    /// is generated (from_profile=false).
    fn cleanup<'a>(&'a self, config: &'a KernelConfig) -> BoxFuture<'a, Result<(), IpcError>> {
        let config = config.clone();
        Box::pin(async move {
            // Only ever delete the exact per-run child this store created —
            // NEVER the stable kernel home, whose geodata databases and
            // provider caches must survive restarts (deleting it would
            // reintroduce the first-run online download and its pre-proxy DNS
            // failure mode on every start).
            let owned = self.owned_dir.lock().expect("owned dir poisoned").clone();
            let Some(owned) = owned else { return Ok(()) };
            if config.root_dir != owned {
                return Ok(());
            }
            let child = config.config_path.canonicalize().unwrap_or_else(|_| config.config_path.clone());
            let owned_canonical = owned.canonicalize().unwrap_or_else(|_| owned.clone());
            if child != owned_canonical && !child.starts_with(&owned_canonical) {
                return Ok(());
            }
            let _ = std::fs::remove_dir_all(&owned);
            *self.owned_dir.lock().expect("owned dir poisoned") = None;
            Ok(())
        })
    }
}
impl StrictMihomoConfigStore {
    fn build_config_text(&self, secret: &str) -> Result<BuiltConfig, IpcError> {
        if let Some(resolve) = &self.resolve_active_document {
            if let Some(document) = resolve() {
                if !document.trim().is_empty() {
                    let text = crate::inspection::build_profile_kernel_config(
                        &document,
                        &json!({
                            "mixedPort": self.mixed_port,
                            "httpPort": self.http_port,
                            "socksPort": self.socks_port,
                            "controllerPort": self.controller_port,
                            "controllerHost": self.controller_host,
                            "allowLan": self.allow_lan,
                            "controllerPanel": self.controller_panel,
                            "secret": secret
                        }),
                    )?;
                    return Ok(BuiltConfig { text, from_profile: true });
                }
            }
        }
        Ok(BuiltConfig {
            text: generate_mihomo_config(&json!({
                "mixedPort": self.mixed_port,
                "httpPort": self.http_port,
                "socksPort": self.socks_port,
                "controllerPort": self.controller_port,
                "controllerHost": self.controller_host,
                "allowLan": self.allow_lan,
                "controllerPanel": self.controller_panel,
                "secret": secret
            }))?,
            from_profile: false,
        })
    }

    /// Delete the exact per-run child this store created and clear the
    /// ownership marker. Used only when materialize() fails AFTER creating
    /// the child but BEFORE returning a KernelConfig. Best-effort; never
    /// touches the caller-provided parent.
    fn remove_owned_dir(&self) {
        let dir = self.owned_dir.lock().expect("owned dir poisoned").take();
        if let Some(dir) = dir {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

}

// ---------------------------------------------------------------------------
// Process adapter (node-adapter.ts)
// ---------------------------------------------------------------------------

/// Process events forwarded to the supervisor (the TS handle's
/// stdout/stderr/exit/error listener set, collapsed into one sink).
pub trait KernelProcessSink: Send + Sync {
    fn stdout(&self, text: &str);
    fn stderr(&self, text: &str);
    /// A real exit: `code` when exited normally, `signal` when terminated.
    fn exit(&self, code: Option<i32>, signal: Option<String>);
    /// A spawn/operational failure (the TS `error` event).
    fn error(&self, message: &str);
}

/// Boundary over OS process spawning so tests can substitute fakes.
pub trait KernelProcessAdapter: Send + Sync {
    /// Spawn the binary; events flow into `sink`. Returns the PID, or None
    /// when the OS did not report one (the supervisor then fails the start).
    fn spawn(&self, binary: &KernelBinary, sink: Arc<dyn KernelProcessSink>) -> Result<Option<u32>, String>;
    /// Whether a previously recorded PID still refers to a live process.
    fn is_process_alive(&self, pid: u32) -> bool;
    /// The graceful termination signal (SIGTERM). True when delivered.
    fn terminate(&self, pid: u32) -> bool;
    /// The forceful termination signal (SIGKILL). True when delivered.
    fn kill(&self, pid: u32) -> bool;
}

#[cfg(unix)]
fn unix_signal(pid: u32, signal: i32) -> bool {
    // SAFETY: kill(2) with a numeric pid + signal; ESRCH simply reports false.
    unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
}

#[cfg(unix)]
fn unix_alive(pid: u32) -> bool {
    // kill(pid, 0) performs the permission/liveness probe without signaling.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// The real Unix adapter (tokio process). Windows production swaps in the
/// Job-Object equivalent with the same trait shape — on Windows Node also
/// maps SIGTERM to TerminateProcess, so both signals force-terminate there.
pub struct NodeKernelProcessAdapter;

impl KernelProcessAdapter for NodeKernelProcessAdapter {
    fn spawn(&self, binary: &KernelBinary, sink: Arc<dyn KernelProcessSink>) -> Result<Option<u32>, String> {
        use tokio::io::AsyncReadExt;
        // The cwd comes from the MURGE_KERNEL_CONFIG sibling contract: the
        // temp store writes config.yaml inside its workspace root.
        let config_root = binary
            .env
            .get("MURGE_KERNEL_CONFIG")
            .and_then(|config| Path::new(config).parent().map(Path::to_path_buf))
            .filter(|root| root.exists());
        let mut command = tokio::process::Command::new(&binary.command);
        command
            .args(&binary.args)
            .env_clear()
            .envs(&binary.env)
            .current_dir(config_root.unwrap_or_else(|| PathBuf::from(".")))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (key, value) in &binary.env {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to spawn {}: {error}", binary.command.display()))?;
        let pid = child.id();
        if let Some(mut stdout) = child.stdout.take() {
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 8192];
                loop {
                    match stdout.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => sink.stdout(&String::from_utf8_lossy(&buffer[..read])),
                    }
                }
            });
        }
        if let Some(mut stderr) = child.stderr.take() {
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 8192];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => sink.stderr(&String::from_utf8_lossy(&buffer[..read])),
                    }
                }
            });
        }
        // The child is intentionally NOT kill-on-drop: the supervisor owns
        // the termination ladder and must see the exit event first.
        let child = Arc::new(tokio::sync::Mutex::new(child));
        tokio::spawn(async move {
            let status = child.lock().await.wait().await;
            match status {
                Ok(status) => {
                    let code = status.code();
                    #[cfg(unix)]
                    let signal = std::os::unix::process::ExitStatusExt::signal(&status)
                        .map(|signal| signal.to_string());
                    #[cfg(not(unix))]
                    let signal: Option<String> = None;
                    sink.exit(code, signal);
                }
                Err(error) => sink.error(&error.to_string()),
            }
        });
        Ok(pid)
    }

    fn is_process_alive(&self, pid: u32) -> bool {
        #[cfg(unix)]
        return unix_alive(pid);
        #[cfg(not(unix))]
        return false;
    }

    fn terminate(&self, pid: u32) -> bool {
        #[cfg(unix)]
        return unix_signal(pid, libc::SIGTERM);
        #[cfg(not(unix))]
        {
            let _ = pid;
            false
        }
    }

    fn kill(&self, pid: u32) -> bool {
        #[cfg(unix)]
        return unix_signal(pid, libc::SIGKILL);
        #[cfg(not(unix))]
        {
            let _ = pid;
            false
        }
    }
}

/// The config workspace is the child's cwd when it still exists (the TS
/// spawn passes `cwd: config.rootDir`); a removed dir falls back to inherit.
fn env_current_dir(root_dir: &Path) -> Option<PathBuf> {
    root_dir.exists().then(|| root_dir.to_path_buf())
}

// ---------------------------------------------------------------------------
// Binary resolvers (resolvers.ts)
// ---------------------------------------------------------------------------

/// Safety net for builds where kernel execution is not permitted. It never
/// resolves a real binary and always fails loudly with UNSUPPORTED.
pub struct DisabledKernelBinaryResolver;

impl KernelBinaryResolver for DisabledKernelBinaryResolver {
    fn resolve(&self) -> BoxFuture<'_, Result<KernelBinary, IpcError>> {
        Box::pin(async move { Err(IpcError::unsupported(DISABLED_RESOLVER_MESSAGE)) })
    }
}

/// Resolves the pinned official mihomo binary for the real-kernel milestone
/// (`resolvers.ts` MihomoKernelResolver). It refuses to run unless explicitly
/// enabled via `allow_real`, so the default build still fails closed.
pub struct MihomoKernelBinaryResolver {
    pub allow_real: bool,
    pub workspace_dir: PathBuf,
    pub transport: crate::mihomo_artifact::DownloadTransport,
    /// The kernel-manager enabled gate (`kernelEnabled`).
    pub kernel_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl KernelBinaryResolver for MihomoKernelBinaryResolver {
    fn resolve(&self) -> BoxFuture<'_, Result<KernelBinary, IpcError>> {
        Box::pin(async move {
            if !self.allow_real {
                return Err(IpcError::unsupported(
                    "Real kernel execution is disabled; refusing to resolve a mihomo binary.",
                ));
            }
            if !(self.kernel_enabled)() {
                return Err(IpcError::unsupported(
                    "内核已停用：请在「通用」的「内核管理」中启用「启用 Smart 内核」。",
                ));
            }
            let platform = std::env::consts::OS
                .replace("macos", "darwin")
                .replace("windows", "win32");
            let arch = match std::env::consts::ARCH {
                "x86_64" => "x64",
                "aarch64" => "arm64",
                "x86" => "x86",
                other => other,
            };
            let resolved =
                crate::mihomo_artifact::resolve_mihomo(&platform, arch, &self.workspace_dir, &self.transport).await?;
            let mut env = BTreeMap::new();
            env.insert("MIHOMO_PLATFORM".to_string(), platform);
            env.insert("MIHOMO_ARCH".to_string(), arch.to_string());
            Ok(KernelBinary {
                command: resolved.path,
                args: Vec::new(),
                version: Some(resolved.version),
                env,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Supervisor (supervisor.ts)
// ---------------------------------------------------------------------------

/// Supervision options (the TS KernelSupervisorOptions).
#[derive(Clone)]
pub struct SupervisorOptions {
    /// Max time to wait for readiness after a spawn. Default 5000ms.
    pub start_timeout_ms: u64,
    /// Max time to wait for a graceful stop. Default 5000ms.
    pub stop_timeout_ms: u64,
    /// Extra time to wait after SIGKILL before declaring failure. Default 3000ms.
    pub force_kill_timeout_ms: u64,
    /// Max unexpected-exit restarts before giving up. Default 10.
    pub max_restarts: u32,
    /// Base crash backoff; doubled per attempt. Default 250ms.
    pub backoff_ms: u64,
    /// Upper bound on a single backoff delay. Default 5000ms.
    pub max_backoff_ms: u64,
    /// Continuous runtime that refills the crash-restart budget. Default 60s.
    pub restart_budget_reset_ms: u64,
    /// Readiness marker tested against accumulated stdout. None = spawn
    /// success means ready (the production composition relies on the
    /// controller-ready gateway instead).
    pub readiness_pattern: Option<String>,
    /// Rolling log byte cap. Default 256KiB.
    pub max_log_bytes: usize,
    /// Rolling log entry cap. Default 4000.
    pub max_log_entries: usize,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        SupervisorOptions {
            start_timeout_ms: 5000,
            stop_timeout_ms: 5000,
            force_kill_timeout_ms: 3000,
            max_restarts: 10,
            backoff_ms: 250,
            max_backoff_ms: 5000,
            restart_budget_reset_ms: 60_000,
            readiness_pattern: None,
            max_log_bytes: 256 * 1024,
            max_log_entries: 4000,
        }
    }
}

/// Everything the supervisor needs to run a kernel process.
pub struct KernelDependencies {
    pub resolver: Arc<dyn KernelBinaryResolver>,
    pub config_store: Arc<dyn KernelConfigStore>,
    pub adapter: Arc<dyn KernelProcessAdapter>,
    /// Controller secret forwarded to the config store on each start.
    pub secret: String,
    /// The crash-watchdog attach (`crash-watchdog.ts`): force-kills the kernel
    /// when the APP dies while the kernel lives. The Windows Job-Object attach
    /// lands with the Windows production slice; None = no watchdog.
    pub attach_watchdog: Option<Arc<dyn Fn(u32) -> Arc<dyn KernelWatchdog> + Send + Sync>>,
}

/// The crash-watchdog seam (`crash-watchdog.ts`): when the APP dies while the
/// kernel lives, the attached watch force-kills the kernel; the supervisor
/// releases it on natural exit/stop. The real Job-Object attach lands with the
/// Windows production slice.
pub trait KernelWatchdog: Send + Sync {
    fn release(&self);
}

struct SpawnedProcess {
    pid: u32,
    watchdog: Option<Arc<dyn KernelWatchdog>>,
}

struct SupervisorState {
    status: Value,
    handle: Option<SpawnedProcess>,
    config: Option<KernelConfig>,
    is_stopping: bool,
    restart_count: u32,
    readiness: Option<tokio::sync::oneshot::Sender<Result<(), IpcError>>>,
    exit_wait: Option<tokio::sync::oneshot::Sender<bool>>,
    /// The latest post-exit cleanup task (`exitWork`); start/stop await it so
    /// they never finish while a secret-bearing workspace is still on disk.
    exit_work: Option<tokio::task::JoinHandle<()>>,
    stdout_buf: String,
    log: Vec<(String, String)>, // (stream, text)
}

/// The supervisor state machine. Operations serialize through one lifecycle
/// lock (the TS `withLifecycle` chain), and post-exit cleanup runs on its own
/// awaited task (`exitWork`) so stop()/start() never finish while the
/// secret-bearing workspace is still on disk.
pub struct KernelSupervisor {
    /// Set once by `create()`; lets spawned sinks/timers reach the supervisor
    /// without a reference cycle (Weak).
    self_ref: Mutex<Option<std::sync::Weak<KernelSupervisor>>>,
    deps: KernelDependencies,
    options: SupervisorOptions,
    state: Mutex<SupervisorState>,
    lifecycle: tokio::sync::Mutex<()>,
    restart_epoch: AtomicU64,
    healthy_epoch: AtomicU64,
    /// `status` event listeners — every `setStatus` fans out here.
    pub status_listeners: EventHub,
}

impl KernelSupervisor {
    /// Create the Arc-shared supervisor. The sink bridge needs a weak back
    /// reference, so construction hands out the Arc explicitly.
    pub fn create(deps: KernelDependencies, options: SupervisorOptions) -> Arc<KernelSupervisor> {
        let supervisor = KernelSupervisor {
            self_ref: Mutex::new(None),
            deps,
            options,
            state: Mutex::new(SupervisorState {
                status: json!({
                    "phase": "stopped",
                    "pid": null,
                    "version": null,
                    "controllerUrl": null,
                    "startedAt": null,
                    "lastError": null
                }),
                handle: None,
                config: None,
                is_stopping: false,
                restart_count: 0,
                readiness: None,
                exit_wait: None,
                exit_work: None,
                stdout_buf: String::new(),
                log: Vec::new(),
            }),
            lifecycle: tokio::sync::Mutex::new(()),
            restart_epoch: AtomicU64::new(0),
            healthy_epoch: AtomicU64::new(0),
            status_listeners: EventHub::new(),
        };
        let arc = Arc::new(supervisor);
        *arc.self_ref.lock().expect("self ref poisoned") = Some(Arc::downgrade(&arc));
        arc
    }

    pub fn get_status(&self) -> Value {
        self.state.lock().expect("kernel status mutex poisoned").status.clone()
    }

    fn set_status(&self, patch: Value) {
        let snapshot = {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            if let (Some(target), Some(patch)) = (state.status.as_object_mut(), patch.as_object()) {
                for (key, value) in patch {
                    target.insert(key.clone(), value.clone());
                }
            }
            state.status.clone()
        };
        self.status_listeners.emit(&snapshot);
    }

    fn append_log(&self, stream: &str, text: &str) {
        let mut state = self.state.lock().expect("kernel status mutex poisoned");
        state.log.push((stream.to_string(), text.to_string()));
        // Rotate the oldest out under BOTH caps (the TS BoundedLogBuffer).
        let mut size: usize = state.log.iter().map(|(_, text)| text.len()).sum();
        while state.log.len() > self.options.max_log_entries || size > self.options.max_log_bytes {
            let Some((_, oldest)) = state.log.first() else { break };
            let dropped = oldest.len();
            size = size.saturating_sub(dropped);
            state.log.remove(0);
        }
    }

    /// The materialized runtime config while a process exists (null once its
    /// exit work has cleaned the workspace).
    pub fn get_active_config(&self) -> Option<KernelConfig> {
        self.state.lock().expect("kernel status mutex poisoned").config.clone()
    }

    /// Diagnostics snapshot (the TS getRecentLogs; no IPC channel exposes it).
    pub fn recent_logs(&self) -> Vec<(String, String)> {
        self.state.lock().expect("kernel status mutex poisoned").log.clone()
    }

    async fn await_exit_work(&self) {
        let task = { self.state.lock().expect("kernel status mutex poisoned").exit_work.take() };
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// Start the kernel.
    pub async fn start(&self) -> Result<Value, IpcError> {
        let _serial = self.lifecycle.lock().await;
        {
            let state = self.state.lock().expect("kernel status mutex poisoned");
            if matches!(state.status["phase"].as_str(), Some("running") | Some("starting") | Some("stopping")) {
                return Ok(state.status.clone());
            }
            // A still-alive process (e.g. one that survived SIGKILL) must be
            // stopped before a second kernel is spawned, or the old leaks.
            if state.handle.is_some() {
                return Err(IpcError::code(
                    code::KERNEL_RUNNING,
                    "A kernel process is still running; stop it before starting again.",
                ));
            }
        }
        // A previous process's exit work may still be removing its temp config.
        self.await_exit_work().await;
        self.restart_epoch.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.restart_count = 0;
        }
        self.do_start().await?;
        Ok(self.get_status())
    }

    async fn do_start(&self) -> Result<(), IpcError> {
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.stdout_buf.clear();
        }
        self.set_status(json!({ "phase": "starting", "lastError": null }));

        // Resolver step: a failure lands as phase `failed` + the message as
        // `lastError` and propagates (the TS raiseFailed).
        let binary = match self.deps.resolver.resolve().await {
            Ok(binary) => binary,
            Err(error) => return Err(self.raise_failed(error)),
        };

        self.handle_stale_pid();

        let config = match self.deps.config_store.materialize(&binary, &self.deps.secret).await {
            Ok(config) => config,
            Err(error) => return Err(self.raise_failed(error)),
        };
        self.state.lock().expect("kernel status mutex poisoned").config = Some(config.clone());

        // Spawn with the merged args/env; events flow into the sink. The
        // bridge holds a Weak reference so the sink can never outlive (nor
        // leak-pin) the supervisor.
        let weak = self.self_weak();
        let supervisor: Arc<dyn KernelProcessSink> = Arc::new(SinkBridge { supervisor: weak });
        let merged = KernelBinary {
            command: binary.command.clone(),
            args: binary.args.iter().chain(config.args.iter()).cloned().collect(),
            version: binary.version.clone(),
            env: {
                let mut env = binary.env.clone();
                for (key, value) in &config.env {
                    env.insert(key.clone(), value.clone());
                }
                env
            },
        };
        let pid = match self.deps.adapter.spawn(&merged, supervisor) {
            Ok(pid) => pid,
            Err(message) => {
                self.cleanup_config().await;
                return Err(self.raise_failed(IpcError::code(code::KERNEL_SPAWN_FAILED, message)));
            }
        };
        let Some(pid) = pid else {
            self.cleanup_handle().await;
            self.cleanup_config().await;
            return Err(self.raise_failed(IpcError::code(
                code::KERNEL_SPAWN_FAILED,
                "Kernel process did not report a PID.",
            )));
        };
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle = Some(SpawnedProcess { pid, watchdog: None });
        }
        self.append_log(
            "stdout",
            &format!("[supervisor] spawned pid={pid} cmd={} {}\n", binary.command.display(), binary.args.join(" ")),
        );
        self.set_status(json!({ "pid": pid, "version": binary.version, "startedAt": null, "lastError": null }));
        // The watchdog attaches as soon as the kernel EXISTS: the spawn→ready
        // window has a live process a killed app must not orphan.
        if let Some(attach) = self.watchdog_factory() {
            let watchdog = attach(pid);
            if let Ok(mut state) = self.state.try_lock() {
                if let Some(handle) = state.handle.as_mut() {
                    handle.watchdog = Some(watchdog);
                }
            }
        }

        if let Err(underlying) = self.await_ready().await {
            // The half-started process may still be alive. Abort it with the
            // same bounded termination used by stop(): never drop the handle
            // or delete its config until the process has actually exited.
            let exited = self.terminate_and_wait().await;
            if exited {
                // The ORIGINAL error propagates (resolver failure keeps
                // UNSUPPORTED, the timeout keeps KERNEL_START_TIMEOUT, an
                // exit during start keeps KERNEL_CRASHED).
                return Err(self.raise_failed(underlying));
            }
            let pid = self.get_status()["pid"].clone();
            let message = underlying.extract_message();
            self.set_status(json!({
                "phase": "failed",
                "pid": pid,
                "lastError": format!("Kernel did not exit after SIGKILL (start failed: {message})")
            }));
            return Err(IpcError::code(
                code::KERNEL_STOP_TIMEOUT,
                format!("Kernel did not exit after SIGKILL while aborting an unstarted kernel ({message})."),
            ));
        }

        self.set_status(json!({ "phase": "running", "startedAt": crate::system_proxy::now_iso() }));
        // Arm the sustained-run reset: once the kernel has been up this long,
        // the crash budget refills — a later exit is a fresh, independent
        // failure and must not inherit the exhausted budget.
        self.clear_healthy_timer();
        if self.options.max_restarts > 0 && self.options.restart_budget_reset_ms > 0 {
            let this = self.self_weak();
            let this = match this.upgrade() {
                Some(this) => this,
                None => return Ok(()),
            };
            let epoch = this.healthy_epoch.load(Ordering::SeqCst);
            let budget = self.options.restart_budget_reset_ms;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(budget)).await;
                if this.healthy_epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                let mut state = this.state.lock().expect("kernel status mutex poisoned");
                if state.status["phase"] == "running" && state.restart_count > 0 {
                    state.restart_count = 0;
                    state.log.push(("stdout".to_string(), "[supervisor] sustained run; crash-restart budget reset\n".to_string()));
                }
            });
        }
        Ok(())
    }

    fn watchdog_factory(&self) -> Option<Arc<dyn Fn(u32) -> Arc<dyn KernelWatchdog> + Send + Sync>> {
        self.deps.attach_watchdog.clone()
    }

    fn handle_stale_pid(&self) {
        let recorded = self.get_status()["pid"].as_u64();
        let Some(recorded) = recorded else { return };
        let recorded = recorded as u32;
        if self.deps.adapter.is_process_alive(recorded) {
            self.append_log("stdout", &format!("[supervisor] recorded pid={recorded} is still alive; proceeding with a fresh spawn.\n"));
        } else {
            self.set_status(json!({ "pid": null }));
            self.append_log("stdout", &format!("[supervisor] cleared stale pid={recorded}.\n"));
        }
    }

    async fn await_ready(&self) -> Result<(), IpcError> {
        if self.options.readiness_pattern.is_none() {
            return Ok(()); // spawn success means ready
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.readiness = Some(sender);
        }
        let timeout = tokio::time::timeout(Duration::from_millis(self.options.start_timeout_ms), receiver).await;
        // Detach any leftover sender so a late stdout cannot send into it.
        self.state.lock().expect("kernel status mutex poisoned").readiness = None;
        match timeout {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) | Err(_) => Err(IpcError::code(
                code::KERNEL_START_TIMEOUT,
                "Kernel did not report ready within the start timeout.",
            )),
        }
    }

    /// The stop ladder: SIGTERM then SIGKILL, waiting for a real exit after
    /// each signal. Returns true only once the process has actually exited
    /// (and its config cleanup has finished).
    async fn terminate_and_wait(&self) -> bool {
        let pid = {
            let state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle.as_ref().map(|handle| handle.pid)
        };
        let Some(pid) = pid else { return true };
        self.deps.adapter.terminate(pid);
        if self.wait_for_exit(pid, self.options.stop_timeout_ms).await {
            return true;
        }
        self.deps.adapter.kill(pid);
        self.wait_for_exit(pid, self.options.force_kill_timeout_ms).await
    }

    async fn wait_for_exit(&self, pid: u32, timeout_ms: u64) -> bool {
        // Never hold the std lock across an await (the future must stay Send).
        let already_gone = {
            let state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle.as_ref().map(|handle| handle.pid) != Some(pid)
        };
        if already_gone {
            // Already exited; the exit event is gone. Wait for its cleanup.
            self.await_exit_work().await;
            return true;
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.exit_wait = Some(sender);
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), receiver).await {
            Ok(Ok(exited)) => exited,
            _ => {
                self.state.lock().expect("kernel status mutex poisoned").exit_wait = None;
                false
            }
        }
    }

    /// Stop the kernel. Safe for the app quit path.
    pub async fn stop(&self) -> Result<Value, IpcError> {
        let _serial = self.lifecycle.lock().await;
        self.restart_epoch.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.restart_count = 0;
        }
        if self.get_status()["phase"] == "stopped" {
            return Ok(self.get_status());
        }
        let has_handle = self.state.lock().expect("kernel status mutex poisoned").handle.is_some();
        if !has_handle {
            // Either never started, or the process already exited. Its exit
            // work may still be removing the temp config; stop()/before-quit
            // must not finish before the workspace is gone.
            self.await_exit_work().await;
            self.set_status(json!({ "phase": "stopped", "pid": null }));
            return Ok(self.get_status());
        }
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.is_stopping = true;
            if let Some(handle) = state.handle.as_mut() {
                handle.watchdog = None; // exiting on OUR request
            }
            self.healthy_epoch.fetch_add(1, Ordering::SeqCst);
        }
        self.set_status(json!({ "phase": "stopping" }));
        if self.terminate_and_wait().await {
            return Ok(self.get_status());
        }
        // The process survived even SIGKILL, so it is almost certainly still
        // running. Never report it as stopped or drop its pid/handle: doing so
        // would let a later start() spawn a second kernel that shadows the
        // first. The temp config is kept because the live process may still
        // read it, and a subsequent stop() can retry termination.
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.is_stopping = false;
        }
        self.set_status(json!({
            "phase": "failed",
            "lastError": "Kernel survived SIGKILL and may still be running."
        }));
        Err(IpcError::code(code::KERNEL_STOP_TIMEOUT, "Kernel did not exit after SIGKILL."))
    }

    fn raise_failed(&self, error: IpcError) -> IpcError {
        let message = error.extract_message();
        self.set_status(json!({ "phase": "failed", "lastError": message }));
        error
    }

    async fn cleanup_config(&self) {
        let config = self.state.lock().expect("kernel status mutex poisoned").config.take();
        if let Some(config) = config {
            let _ = self.deps.config_store.cleanup(&config).await;
        }
    }

    async fn cleanup_handle(&self) {
        let pid = {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle.take().map(|handle| handle.pid)
        };
        if let Some(pid) = pid {
            let _ = self.deps.adapter.kill(pid); // best effort
            self.set_status(json!({ "pid": null }));
        }
    }

    fn clear_healthy_timer(&self) {
        self.healthy_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// The process exited. Post-exit work (config cleanup + status/restart)
    /// runs on ONE awaited task: cleanup finishes before the exit wait is
    /// resolved and before a crash-restart schedules, so a fresh directory
    /// never materializes over an uncleaned one.
    pub fn handle_exit(self: &Arc<Self>, code: Option<i32>, signal: Option<String>) {
        let was_running = self.get_status()["phase"] == "running";
        // The config may hold the controller secret: reject readiness first.
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle = None;
            self.healthy_epoch.fetch_add(1, Ordering::SeqCst);
        }
        let supervisor = self.clone();
        let task = tokio::spawn(async move {
            supervisor.cleanup_config().await;
            // Resolve any pending exit wait BEFORE the status transitions so
            // stop() observes the cleaned workspace.
            let waiter = supervisor.state.lock().expect("kernel status mutex poisoned").exit_wait.take();
            if let Some(sender) = waiter {
                let _ = sender.send(true);
            }
            let is_stopping = {
                let mut state = supervisor.state.lock().expect("kernel status mutex poisoned");
                let stopping = state.is_stopping;
                state.is_stopping = false;
                stopping
            };
            if is_stopping {
                supervisor.set_status(json!({ "phase": "stopped", "pid": null }));
                return;
            }
            let desc = format!("Kernel {}", describe_exit(code, signal));
            supervisor.set_status(json!({ "phase": "failed", "pid": null, "lastError": desc.clone() }));
            if was_running {
                supervisor.schedule_restart(&desc);
            }
        });
        self.state.lock().expect("kernel status mutex poisoned").exit_work = Some(task);
    }

    /// An operational error on a live child (the TS `error` event). Never
    /// drops the handle for a PID that is still alive: keeping it tracked
    /// prevents a second kernel from starting and lets stop() retry.
    pub fn handle_error(self: &Arc<Self>, message: &str) {
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            if let Some(sender) = state.readiness.take() {
                let _ = sender.send(Err(IpcError::code(code::KERNEL_SPAWN_FAILED, message.to_string())));
            }
        }
        let pid = self.state.lock().expect("kernel status mutex poisoned").handle.as_ref().map(|handle| handle.pid);
        if let Some(pid) = pid {
            if self.deps.adapter.is_process_alive(pid) {
                self.set_status(json!({ "phase": "failed", "pid": pid, "lastError": format!("Kernel process error: {message}") }));
                return;
            }
        }
        // A failed spawn has no later exit event to clean up: drop the handle
        // NOW so start()/stop() observe the terminal state immediately.
        {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.handle = None;
        }
        let supervisor = self.clone();
        let message = message.to_string();
        let task = tokio::spawn(async move {
            supervisor.cleanup_config().await;
            let waiter = supervisor.state.lock().expect("kernel status mutex poisoned").exit_wait.take();
            if let Some(sender) = waiter {
                let _ = sender.send(true);
            }
            supervisor.set_status(json!({ "phase": "failed", "pid": null, "lastError": format!("Kernel spawn failed: {message}") }));
        });
        self.state.lock().expect("kernel status mutex poisoned").exit_work = Some(task);
    }

    fn schedule_restart(self: &Arc<Self>, reason: &str) {
        if self.state.lock().expect("kernel status mutex poisoned").restart_count >= self.options.max_restarts {
            return;
        }
        let count = {
            let mut state = self.state.lock().expect("kernel status mutex poisoned");
            state.restart_count += 1;
            state.restart_count
        };
        let delay = std::cmp::min(
            self.options.backoff_ms.saturating_mul(1u64 << (count - 1).min(16)),
            self.options.max_backoff_ms,
        );
        self.append_log("stdout", &format!("[supervisor] crash detected; restart {count}/{} in {delay}ms ({reason})\n", self.options.max_restarts));
        let supervisor = self.clone();
        let epoch = self.restart_epoch.load(Ordering::SeqCst);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if supervisor.restart_epoch.load(Ordering::SeqCst) != epoch {
                return; // stop()/start() invalidated the pending restart
            }
            let _serial = supervisor.lifecycle.lock().await;
            if supervisor.state.lock().expect("kernel status mutex poisoned").handle.is_some()
                || supervisor.get_status()["phase"] != "failed"
            {
                return;
            }
            let _ = supervisor.do_start().await;
        });
    }

    fn self_weak(&self) -> std::sync::Weak<KernelSupervisor> {
        self.self_ref.lock().expect("self ref poisoned").clone().expect("supervisor self reference set at creation")
    }
}

// ---------------------------------------------------------------------------
// Controller-ready gateway (controller-ready-gateway.ts)
// ---------------------------------------------------------------------------

/// Abstraction over the authenticated loopback probe so the gateway is
/// testable; the production probe is `MihomoClient::get_version`.
pub trait VersionProbe: Send + Sync {
    fn probe(&self) -> BoxFuture<'_, Result<(), IpcError>>;
}

/// The production probe: GET /version with the controller secret.
pub struct MihomoVersionProbe {
    pub client: crate::mihomo::MihomoClient,
}

impl VersionProbe for MihomoVersionProbe {
    fn probe(&self) -> BoxFuture<'_, Result<(), IpcError>> {
        Box::pin(async move { self.client.get_version().await.map(|_| ()) })
    }
}

/// Makes the user-facing start action wait for the loopback controller's
/// authenticated /version response. Process spawn alone is not readiness.
pub struct ControllerReadyKernelGateway {
    kernel: Arc<KernelSupervisor>,
    probe: Arc<dyn VersionProbe>,
    timeout_ms: u64,
    retry_ms: u64,
}

impl ControllerReadyKernelGateway {
    pub fn new(kernel: Arc<KernelSupervisor>, probe: Arc<dyn VersionProbe>, timeout_ms: u64, retry_ms: u64) -> Self {
        ControllerReadyKernelGateway { kernel, probe, timeout_ms, retry_ms }
    }

    pub fn get_status(&self) -> Value {
        self.kernel.get_status()
    }

    pub async fn start(&self) -> Result<Value, IpcError> {
        let status = self.kernel.start().await?;
        if status["phase"] != "running" {
            return Ok(status);
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(self.timeout_ms);
        while std::time::Instant::now() < deadline {
            if self.probe.probe().await.is_ok() {
                return Ok(self.kernel.get_status());
            }
            tokio::time::sleep(Duration::from_millis(self.retry_ms)).await;
        }
        // The typed readiness failure remains the primary error. The
        // supervisor retains any process that survives termination, so this
        // cannot permit a duplicate start or erase its live config.
        let _ = self.kernel.stop().await;
        Err(IpcError::code(
            code::KERNEL_START_TIMEOUT,
            "mihomo process started but its authenticated loopback controller did not become ready.",
        ))
    }

    pub async fn stop(&self) -> Result<Value, IpcError> {
        self.kernel.stop().await
    }
}

/// Bridges adapter process events into the supervisor state machine. Holds a
/// Weak reference: a leaked sink can never pin the supervisor alive.
struct SinkBridge {
    supervisor: std::sync::Weak<KernelSupervisor>,
}

impl KernelProcessSink for SinkBridge {
    fn stdout(&self, text: &str) {
        let Some(supervisor) = self.supervisor.upgrade() else { return };
        supervisor.append_log("stdout", text);
        // Readiness marker test against the accumulated stdout. The buffer is
        // only fed while a readiness waiter exists (the TS contract), so the
        // rolling log never accumulates a second copy of steady-state output.
        let pattern = supervisor.options.readiness_pattern.clone();
        if let Some(pattern) = pattern {
            let pending = { supervisor.state.lock().expect("kernel status mutex poisoned").readiness.is_some() };
            if pending {
                let matched = {
                    let mut state = supervisor.state.lock().expect("kernel status mutex poisoned");
                    state.stdout_buf.push_str(text);
                    state.stdout_buf.contains(&pattern)
                };
                if matched {
                    let sender = supervisor.state.lock().expect("kernel status mutex poisoned").readiness.take();
                    if let Some(sender) = sender {
                        let _ = sender.send(Ok(()));
                    }
                }
            }
        }
    }

    fn stderr(&self, text: &str) {
        if let Some(supervisor) = self.supervisor.upgrade() {
            supervisor.append_log("stderr", text);
        }
    }

    fn exit(&self, code: Option<i32>, signal: Option<String>) {
        let Some(supervisor) = self.supervisor.upgrade() else { return };
        supervisor.handle_exit(code, signal);
    }

    fn error(&self, message: &str) {
        let Some(supervisor) = self.supervisor.upgrade() else { return };
        supervisor.handle_error(message);
    }
}

/// The TS describeExit copy.
fn describe_exit(code: Option<i32>, signal: Option<String>) -> String {
    if let Some(signal) = signal {
        return format!("terminated by {signal}");
    }
    format!("exited with code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
}

// ---------------------------------------------------------------------------
// Tests — the ported tests/kernel-supervisor.test.ts harness
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct StubResolver {
        resolve_calls: std::sync::atomic::AtomicU32,
        error: Mutex<Option<IpcError>>,
        binary: KernelBinary,
    }

    impl StubResolver {
        fn new() -> Self {
            StubResolver {
                resolve_calls: std::sync::atomic::AtomicU32::new(0),
                error: Mutex::new(None),
                binary: KernelBinary {
                    command: PathBuf::from("/fake/kernel"),
                    args: vec!["--fixture".to_string()],
                    version: Some("9.0.0".to_string()),
                    env: BTreeMap::new(),
                },
            }
        }
    }

    impl KernelBinaryResolver for StubResolver {
        fn resolve<'a>(&'a self) -> BoxFuture<'a, Result<KernelBinary, IpcError>> {
            Box::pin(async move {
                self.resolve_calls.fetch_add(1, Ordering::SeqCst);
                if let Some(error) = self.error.lock().expect("resolver poisoned").take() {
                    return Err(error);
                }
                Ok(self.binary.clone())
            })
        }
    }

    /// A store whose cleanup() can be held open so tests can observe ordering.
    struct StubStore {
        materialize_calls: std::sync::atomic::AtomicU32,
        cleanup_calls: Mutex<Vec<KernelConfig>>,
        last_secret: Mutex<Option<String>>,
        hold_cleanup: AtomicBool,
        cleanup_started: std::sync::atomic::AtomicU32,
        cleanup_resolvers: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
        materialize_error: Mutex<Option<String>>,
    }

    impl StubStore {
        fn new() -> Self {
            StubStore {
                materialize_calls: std::sync::atomic::AtomicU32::new(0),
                cleanup_calls: Mutex::new(Vec::new()),
                last_secret: Mutex::new(None),
                hold_cleanup: AtomicBool::new(false),
                cleanup_started: std::sync::atomic::AtomicU32::new(0),
                cleanup_resolvers: Mutex::new(Vec::new()),
                materialize_error: Mutex::new(None),
            }
        }

        fn cleanup_count(&self) -> usize {
            self.cleanup_calls.lock().expect("cleanup poisoned").len()
        }

        fn resolve_cleanup(&self) {
            if let Some(sender) = self.cleanup_resolvers.lock().expect("resolvers poisoned").pop() {
                let _ = sender.send(());
            }
        }
    }

    impl KernelConfigStore for StubStore {
        fn materialize<'a>(&'a self, _binary: &'a KernelBinary, secret: &'a str) -> BoxFuture<'a, Result<KernelConfig, IpcError>> {
            let secret = secret.to_string();
            Box::pin(async move {
                self.materialize_calls.fetch_add(1, Ordering::SeqCst);
                *self.last_secret.lock().expect("secret poisoned") = Some(secret.clone());
                if let Some(message) = self.materialize_error.lock().expect("err poisoned").take() {
                    return Err(IpcError::code(code::KERNEL_SPAWN_FAILED, message));
                }
                Ok(KernelConfig {
                    config_path: PathBuf::from("/tmp/kernel/config.yaml"),
                    root_dir: PathBuf::from("/tmp/kernel"),
                    args: Vec::new(),
                    env: BTreeMap::from([("KERNEL_SECRET".to_string(), secret)]),
                })
            })
        }

        fn cleanup<'a>(&'a self, config: &'a KernelConfig) -> BoxFuture<'a, Result<(), IpcError>> {
            let config = config.clone();
            Box::pin(async move {
                self.cleanup_calls.lock().expect("cleanup poisoned").push(config);
                self.cleanup_started.fetch_add(1, Ordering::SeqCst);
                if !self.hold_cleanup.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let (sender, receiver) = tokio::sync::oneshot::channel();
                self.cleanup_resolvers.lock().expect("resolvers poisoned").push(sender);
                let _ = receiver.await;
                Ok(())
            })
        }
    }

    struct FakeAdapter {
        spawn_calls: Mutex<Vec<KernelBinary>>,
        alive_pids: Mutex<std::collections::HashSet<u32>>,
        handles: Mutex<Vec<Arc<FakeHandleState>>>,
        next_pid: std::sync::atomic::AtomicU32,
        /// None = auto-increment; Some(None) = spawn that produced no PID.
        spawn_pid: Mutex<Option<Option<u32>>>,
        last_sink: Mutex<Option<Arc<dyn KernelProcessSink>>>,
    }

    struct FakeHandleState {
        pid: Option<u32>,
        signals: Mutex<Vec<String>>,
        on_sigterm_exits: AtomicBool,
        on_sigkill_exits: AtomicBool,
        exited: AtomicBool,
    }

    impl FakeAdapter {
        fn new() -> Self {
            FakeAdapter {
                spawn_calls: Mutex::new(Vec::new()),
                alive_pids: Mutex::new(std::collections::HashSet::new()),
                handles: Mutex::new(Vec::new()),
                next_pid: std::sync::atomic::AtomicU32::new(1),
                spawn_pid: Mutex::new(None),
                last_sink: Mutex::new(None),
            }
        }

        fn spawn_count(&self) -> usize {
            self.spawn_calls.lock().expect("spawn poisoned").len()
        }

        fn last_handle(&self) -> Option<Arc<FakeHandleState>> {
            self.handles.lock().expect("handles poisoned").last().cloned()
        }

        fn emit_stdout(&self, text: &str) {
            if let Some(sink) = self.last_sink.lock().expect("sink poisoned").as_ref() {
                sink.stdout(text);
            }
        }

        fn emit_exit(&self, code: Option<i32>, signal: Option<String>) {
            if let Some(sink) = self.last_sink.lock().expect("sink poisoned").as_ref() {
                sink.exit(code, signal);
            }
        }

        fn emit_error(&self, message: &str) {
            if let Some(sink) = self.last_sink.lock().expect("sink poisoned").as_ref() {
                sink.error(message);
            }
        }
    }

    impl KernelProcessAdapter for FakeAdapter {
        fn spawn(&self, binary: &KernelBinary, sink: Arc<dyn KernelProcessSink>) -> Result<Option<u32>, String> {
            self.spawn_calls.lock().expect("spawn poisoned").push(binary.clone());
            *self.last_sink.lock().expect("sink poisoned") = Some(sink);
            let pid = self
                .spawn_pid
                .lock()
                .expect("spawn pid poisoned")
                .unwrap_or_else(|| Some(self.next_pid.fetch_add(1, Ordering::SeqCst)));
            let state = Arc::new(FakeHandleState {
                pid,
                signals: Mutex::new(Vec::new()),
                on_sigterm_exits: AtomicBool::new(true),
                on_sigkill_exits: AtomicBool::new(true),
                exited: AtomicBool::new(false),
            });
            self.handles.lock().expect("handles poisoned").push(state.clone());
            if let Some(pid) = pid {
                self.alive_pids.lock().expect("alive poisoned").insert(pid);
            }
            Ok(pid)
        }

        fn is_process_alive(&self, pid: u32) -> bool {
            self.alive_pids.lock().expect("alive poisoned").contains(&pid)
        }

        fn terminate(&self, pid: u32) -> bool {
            let handle = self
                .handles
                .lock()
                .expect("handles poisoned")
                .iter()
                .find(|handle| handle.pid == Some(pid))
                .cloned();
            let Some(handle) = handle else { return false };
            handle.signals.lock().expect("signals poisoned").push("SIGTERM".to_string());
            if handle.on_sigterm_exits.load(Ordering::SeqCst) {
                self.emit_exit(Some(0), None);
            }
            true
        }

        fn kill(&self, pid: u32) -> bool {
            let handle = self
                .handles
                .lock()
                .expect("handles poisoned")
                .iter()
                .find(|handle| handle.pid == Some(pid))
                .cloned();
            let Some(handle) = handle else { return false };
            handle.signals.lock().expect("signals poisoned").push("SIGKILL".to_string());
            if handle.on_sigkill_exits.load(Ordering::SeqCst) {
                self.emit_exit(None, Some("SIGKILL".to_string()));
            }
            true
        }
    }

    pub(crate) struct Harness {
        pub(crate) supervisor: Arc<KernelSupervisor>,
        pub(crate) adapter: Arc<FakeAdapter>,
        pub(crate) resolver: Arc<StubResolver>,
        pub(crate) store: Arc<StubStore>,
    }

    pub(crate) fn create_harness() -> Harness {
        create_harness_with(SupervisorOptions {
            readiness_pattern: Some("fixture-ready".to_string()),
            start_timeout_ms: 2000,
            stop_timeout_ms: 2000,
            force_kill_timeout_ms: 2000,
            max_restarts: 3,
            backoff_ms: 250,
            max_backoff_ms: 10000,
            ..SupervisorOptions::default()
        })
    }

    pub(crate) fn create_harness_with(options: SupervisorOptions) -> Harness {
        let resolver = Arc::new(StubResolver::new());
        let store = Arc::new(StubStore::new());
        let adapter = Arc::new(FakeAdapter::new());
        let supervisor = KernelSupervisor::create(
            KernelDependencies {
                resolver: resolver.clone(),
                config_store: store.clone(),
                adapter: adapter.clone(),
                secret: "s3cret".to_string(),
                attach_watchdog: None,
            },
            options,
        );
        Harness { supervisor, adapter, resolver, store }
    }

    async fn wait_for(condition: impl Fn() -> bool) {
        for _ in 0..3000 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("waitFor timed out");
    }

    fn readiness_pending(supervisor: &KernelSupervisor) -> bool {
        supervisor.state.lock().expect("state poisoned").readiness.is_some()
    }

    /// Start on a task and drive to readiness by emitting the fixture marker
    /// (the TS startToRunning).
    pub(crate) async fn start_to_running(h: &Harness) -> Value {
        let supervisor = h.supervisor.clone();
        let task = tokio::spawn(async move { supervisor.start().await });
        wait_for(|| readiness_pending(&h.supervisor)).await;
        h.adapter.emit_stdout("fixture-ready pid=1\n");
        let status = task.await.expect("start task").expect("start ok");
        assert_eq!(status["phase"], "running");
        status
    }

    fn error_code(error: &IpcError) -> String {
        error.0.splitn(2, "::").next().unwrap_or("").trim_start_matches("PROTOCOL_ERROR:").to_string()
    }

    fn signals(handle: &Arc<FakeHandleState>) -> Vec<String> {
        handle.signals.lock().expect("signals poisoned").clone()
    }

    #[tokio::test]
    async fn starts_running_and_surfaces_pid_version() {
        let h = create_harness();
        let status = start_to_running(&h).await;
        let pid = h.adapter.last_handle().unwrap().pid.unwrap();
        assert_eq!(status["pid"], pid);
        assert_eq!(status["version"], "9.0.0");
        assert_eq!(h.resolver.resolve_calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.store.materialize_calls.load(Ordering::SeqCst), 1);
        // The fixture-ready line is captured into the rolling log.
        assert!(h.supervisor.recent_logs().iter().any(|(_, text)| text.contains("fixture-ready")));
    }

    #[tokio::test]
    async fn double_start_is_idempotent_without_a_second_spawn() {
        let h = create_harness();
        start_to_running(&h).await;
        let again = h.supervisor.start().await.unwrap();
        assert_eq!(again["phase"], "running");
        assert_eq!(h.adapter.spawn_count(), 1);
        assert_eq!(h.supervisor.get_status()["phase"], "running");
    }

    #[tokio::test]
    async fn stop_submitted_during_start_serializes() {
        let h = create_harness();
        let supervisor = h.supervisor.clone();
        let start_task = tokio::spawn(async move { supervisor.start().await });
        wait_for(|| readiness_pending(&h.supervisor)).await;
        let handle = h.adapter.last_handle().unwrap();
        let supervisor = h.supervisor.clone();
        let stop_task = tokio::spawn(async move { supervisor.stop().await });
        // The stop must not touch the process while the start is still pending.
        assert!(signals(&handle).is_empty());
        h.adapter.emit_stdout("fixture-ready pid=1\n");
        assert_eq!(start_task.await.unwrap().unwrap()["phase"], "running");
        assert_eq!(stop_task.await.unwrap().unwrap()["phase"], "stopped");
        assert_eq!(h.adapter.spawn_count(), 1);
        assert!(signals(&handle).contains(&"SIGTERM".to_string()));
        assert_eq!(h.supervisor.get_status()["phase"], "stopped");
    }

    #[tokio::test]
    async fn shuts_down_gracefully_on_sigterm() {
        let h = create_harness();
        start_to_running(&h).await;
        let status = h.supervisor.stop().await.unwrap();
        assert_eq!(status["phase"], "stopped");
        assert_eq!(signals(&h.adapter.last_handle().unwrap()), vec!["SIGTERM".to_string()]);
        assert_eq!(h.supervisor.get_status()["phase"], "stopped");
    }

    #[tokio::test]
    async fn forces_sigkill_when_sigterm_is_ignored() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: Some("fixture-ready".to_string()),
            stop_timeout_ms: 15,
            force_kill_timeout_ms: 15,
            ..SupervisorOptions::default()
        });
        start_to_running(&h).await;
        h.adapter.last_handle().unwrap().on_sigterm_exits.store(false, Ordering::SeqCst);
        let status = h.supervisor.stop().await.unwrap();
        assert_eq!(status["phase"], "stopped");
        assert_eq!(signals(&h.adapter.last_handle().unwrap()), vec!["SIGTERM".to_string(), "SIGKILL".to_string()]);
    }

    #[tokio::test]
    async fn survivor_is_tracked_when_even_sigkill_is_ignored_and_retries_later() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: Some("fixture-ready".to_string()),
            stop_timeout_ms: 15,
            force_kill_timeout_ms: 15,
            ..SupervisorOptions::default()
        });
        start_to_running(&h).await;
        let handle = h.adapter.last_handle().unwrap();
        let pid = handle.pid.unwrap();
        handle.on_sigterm_exits.store(false, Ordering::SeqCst);
        handle.on_sigkill_exits.store(false, Ordering::SeqCst);
        let error = h.supervisor.stop().await.unwrap_err();
        assert!(error.0.contains("Kernel did not exit after SIGKILL"));

        // The un-terminable process is NOT reported as stopped: pid + handle survive.
        let status = h.supervisor.get_status();
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["pid"], pid);
        assert!(h.adapter.is_process_alive(pid));
        // The temp config is kept while the process is still alive.
        assert_eq!(h.store.cleanup_count(), 0);

        // Starting again is refused while a process is still running.
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_RUNNING");
        assert_eq!(h.adapter.spawn_count(), 1);

        // A later stop() retry terminates the still-running process.
        handle.on_sigterm_exits.store(true, Ordering::SeqCst);
        let status = h.supervisor.stop().await.unwrap();
        assert_eq!(status["phase"], "stopped");
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn fails_a_start_with_no_pid_and_cleans_up_the_config() {
        let h = create_harness();
        *h.adapter.spawn_pid.lock().expect("pid poisoned") = Some(None);
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_SPAWN_FAILED");
        assert_eq!(h.supervisor.get_status()["phase"], "failed");
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn cleans_the_config_after_an_asynchronous_spawn_error() {
        let h = create_harness();
        let supervisor = h.supervisor.clone();
        let start_task = tokio::spawn(async move { supervisor.start().await });
        wait_for(|| readiness_pending(&h.supervisor)).await;
        let handle = h.adapter.last_handle().unwrap();
        let pid = handle.pid.unwrap();
        h.adapter.alive_pids.lock().expect("alive poisoned").remove(&pid);
        h.adapter.emit_error("async ENOENT");

        let error = start_task.await.unwrap().unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_SPAWN_FAILED");
        wait_for(|| h.store.cleanup_count() == 1).await;
        assert!(h.supervisor.get_active_config().is_none());
        let status = h.supervisor.get_status();
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["pid"], Value::Null);

        assert_eq!(h.supervisor.stop().await.unwrap()["phase"], "stopped");
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn does_not_finish_stop_until_the_temp_config_cleanup_resolves() {
        let h = create_harness();
        start_to_running(&h).await;
        h.store.hold_cleanup.store(true, Ordering::SeqCst);

        let supervisor = h.supervisor.clone();
        let stop_task = tokio::spawn(async move { supervisor.stop().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(h.store.cleanup_started.load(Ordering::SeqCst), 1);
        assert!(!stop_task.is_finished());

        h.store.resolve_cleanup();
        let status = stop_task.await.unwrap().unwrap();
        assert_eq!(status["phase"], "stopped");
    }

    #[tokio::test]
    async fn cleans_the_crashed_config_before_a_restart_materializes_a_new_one() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: None,
            max_restarts: 1,
            backoff_ms: 10,
            max_backoff_ms: 40,
            ..SupervisorOptions::default()
        });
        h.supervisor.start().await.unwrap();
        assert_eq!(h.store.materialize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.store.cleanup_count(), 0);

        h.adapter.emit_exit(Some(1), None);
        wait_for(|| h.store.cleanup_count() == 1).await;
        wait_for(|| h.adapter.spawn_count() == 2).await;

        assert_eq!(h.store.materialize_calls.load(Ordering::SeqCst), 2);
        // The old secret-bearing config was cleaned before the new one was made.
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn holds_a_crash_restart_until_the_crashed_config_cleanup_resolves() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: None,
            max_restarts: 1,
            backoff_ms: 10,
            max_backoff_ms: 40,
            ..SupervisorOptions::default()
        });
        h.supervisor.start().await.unwrap();
        h.store.hold_cleanup.store(true, Ordering::SeqCst);

        h.adapter.emit_exit(Some(1), None);
        wait_for(|| h.store.cleanup_started.load(Ordering::SeqCst) == 1).await;
        // Cleanup is held: the restart must not materialize a new config or spawn.
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(h.store.materialize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.adapter.spawn_count(), 1);

        h.store.resolve_cleanup();
        wait_for(|| h.adapter.spawn_count() == 2).await;
        assert_eq!(h.store.materialize_calls.load(Ordering::SeqCst), 2);
        // The old config was fully cleaned before the new one was materialized.
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn start_timeout_survivor_stays_tracked_until_stop_retries() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: Some("fixture-ready".to_string()),
            start_timeout_ms: 50,
            stop_timeout_ms: 15,
            force_kill_timeout_ms: 15,
            ..SupervisorOptions::default()
        });
        let supervisor = h.supervisor.clone();
        let start_task = tokio::spawn(async move { supervisor.start().await });
        wait_for(|| h.adapter.last_handle().is_some()).await;
        let handle = h.adapter.last_handle().unwrap();
        let pid = handle.pid.unwrap();
        handle.on_sigterm_exits.store(false, Ordering::SeqCst);
        handle.on_sigkill_exits.store(false, Ordering::SeqCst);

        let error = start_task.await.unwrap().unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_STOP_TIMEOUT");
        let status = h.supervisor.get_status();
        // The un-terminable half-started process is still tracked, not dropped.
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["pid"], pid);
        assert!(h.adapter.is_process_alive(pid));
        assert_eq!(h.store.cleanup_count(), 0);

        // start() is refused while the survivor is still tracked.
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_RUNNING");
        assert_eq!(h.adapter.spawn_count(), 1);

        // A later stop() retry terminates the survivor and releases the config.
        handle.on_sigterm_exits.store(true, Ordering::SeqCst);
        let status = h.supervisor.stop().await.unwrap();
        assert_eq!(status["phase"], "stopped");
        assert_eq!(h.store.cleanup_count(), 1);
        assert!(h.supervisor.state.lock().expect("state poisoned").handle.is_none());
    }

    #[tokio::test]
    async fn cleans_the_config_even_when_the_restart_cap_is_reached() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: None,
            max_restarts: 0,
            backoff_ms: 10,
            max_backoff_ms: 40,
            ..SupervisorOptions::default()
        });
        h.supervisor.start().await.unwrap();
        h.adapter.emit_exit(Some(1), None);
        wait_for(|| h.supervisor.get_status()["phase"] == "failed").await;
        wait_for(|| h.store.cleanup_count() == 1).await;
    }

    #[tokio::test]
    async fn allows_stop_after_a_failed_start_without_leaking_the_config() {
        let h = create_harness();
        *h.adapter.spawn_pid.lock().expect("pid poisoned") = Some(None);
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_SPAWN_FAILED");
        assert_eq!(h.store.cleanup_count(), 1);
        let stopped = h.supervisor.stop().await.unwrap();
        assert_eq!(stopped["phase"], "stopped");
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn clears_a_stale_recorded_pid_before_spawning() {
        let h = create_harness();
        // A live, unrelated pid and a recorded pid that is no longer alive.
        h.adapter.alive_pids.lock().expect("alive poisoned").insert(50);
        h.supervisor.state.lock().expect("state poisoned").status["pid"] = json!(99999);
        let status = start_to_running(&h).await;
        assert_ne!(status["pid"], 99999);
        assert_eq!(status["pid"], h.adapter.last_handle().unwrap().pid.unwrap());
    }

    #[tokio::test]
    async fn detects_a_crash_and_restarts_up_to_the_backoff_cap() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: None,
            max_restarts: 2,
            backoff_ms: 10,
            max_backoff_ms: 40,
            ..SupervisorOptions::default()
        });
        h.supervisor.start().await.unwrap();
        assert_eq!(h.adapter.spawn_count(), 1);

        h.adapter.emit_exit(Some(1), None);
        wait_for(|| h.adapter.spawn_count() == 2).await;
        h.adapter.emit_exit(Some(1), None);
        wait_for(|| h.adapter.spawn_count() == 3).await;
        h.adapter.emit_exit(Some(1), None);

        // No further restart is scheduled once the cap is reached.
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h.adapter.spawn_count(), 3);
        assert_eq!(h.supervisor.get_status()["phase"], "failed");
    }

    #[tokio::test]
    async fn does_not_restart_a_start_that_never_became_ready() {
        let h = create_harness_with(SupervisorOptions {
            readiness_pattern: Some("fixture-ready".to_string()),
            start_timeout_ms: 20,
            ..SupervisorOptions::default()
        });
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_START_TIMEOUT");
        assert_eq!(h.supervisor.get_status()["phase"], "failed");
        assert_eq!(h.adapter.spawn_count(), 1);
    }

    #[tokio::test]
    async fn resolver_failure_lands_as_failed_with_the_unsupported_copy() {
        let h = create_harness();
        *h.resolver.error.lock().expect("err poisoned") =
            Some(IpcError::unsupported(crate::kernel_process::DISABLED_RESOLVER_MESSAGE));
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(
            error.0,
            format!("PROTOCOL_ERROR:UNSUPPORTED::{}", crate::kernel_process::DISABLED_RESOLVER_MESSAGE)
        );
        let status = h.supervisor.get_status();
        assert_eq!(status["phase"], "failed");
        assert_eq!(status["lastError"], crate::kernel_process::DISABLED_RESOLVER_MESSAGE);
        assert_eq!(h.adapter.spawn_count(), 0);
    }

    #[tokio::test]
    async fn config_store_failure_raises_failed() {
        let h = create_harness();
        *h.store.materialize_error.lock().expect("err poisoned") = Some("disk exploded".to_string());
        let error = h.supervisor.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_SPAWN_FAILED");
        assert_eq!(h.supervisor.get_status()["lastError"], "disk exploded");
        assert_eq!(h.adapter.spawn_count(), 0);
    }

    #[test]
    fn rolling_log_respects_both_caps() {
        let h = create_harness_with(SupervisorOptions {
            max_log_bytes: 8,
            max_log_entries: 1000,
            ..SupervisorOptions::default()
        });
        h.supervisor.append_log("stdout", "aaa");
        h.supervisor.append_log("stdout", "bbbb");
        h.supervisor.append_log("stderr", "cccc"); // rotates "aaa" out
        let texts: Vec<String> =
            h.supervisor.recent_logs().into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, vec!["bbbb".to_string(), "cccc".to_string()]);

        let h = create_harness_with(SupervisorOptions {
            max_log_bytes: 1000,
            max_log_entries: 2,
            ..SupervisorOptions::default()
        });
        h.supervisor.append_log("stdout", "a");
        h.supervisor.append_log("stdout", "b");
        h.supervisor.append_log("stdout", "c");
        let texts: Vec<String> =
            h.supervisor.recent_logs().into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, vec!["b".to_string(), "c".to_string()]);
    }

    // -- config generation + stores -----------------------------------------

    #[test]
    fn strict_config_generation_is_byte_shaped_like_the_ts_output() {
        let secret = "a".repeat(64);
        let text =
            generate_mihomo_config(&json!({ "mixedPort": 7890, "controllerPort": 9090, "secret": secret })).unwrap();
        assert!(text.contains("mixed-port: 7890"));
        assert!(text.contains("allow-lan: false"));
        assert!(text.contains("bind-address: 127.0.0.1"));
        assert!(text.contains("mode: direct"));
        assert!(text.contains("external-controller: 127.0.0.1:9090"));
        assert!(text.contains(&format!("secret: {secret}")));
        assert!(text.contains("tun:\n  enable: false"));
        assert!(text.contains("dns:\n  enable: false"));
        assert!(text.contains("rules:\n  - MATCH,DIRECT"));
        assert!(text.ends_with('\n'));
        // Panel + lan + explicit ports.
        let text = generate_mihomo_config(&json!({
            "mixedPort": 7897, "controllerPort": 9097, "httpPort": 7898, "socksPort": 7899,
            "allowLan": true, "controllerPanel": true, "secret": secret
        }))
        .unwrap();
        assert!(text.contains("port: 7898"));
        assert!(text.contains("socks-port: 7899"));
        assert!(text.contains("bind-address: '*'"));
        assert!(text.contains("external-ui-name: metacubexd"));
    }

    #[test]
    fn strict_config_rejects_invalid_inputs() {
        let secret = "a".repeat(64);
        // Privileged + out-of-range + missing ports are all rejected (TS copies).
        assert!(generate_mihomo_config(&json!({ "mixedPort": 0, "controllerPort": 9090, "secret": secret })).is_err());
        assert!(generate_mihomo_config(&json!({ "mixedPort": 80, "controllerPort": 9090, "secret": secret })).is_err());
        assert!(generate_mihomo_config(&json!({ "mixedPort": 65536, "controllerPort": 9090, "secret": secret })).is_err());
        // mixed-port/controller collision.
        assert!(generate_mihomo_config(&json!({ "mixedPort": 9090, "controllerPort": 9090, "secret": secret })).is_err());
        // HTTP-port collision with the mixed port.
        assert!(generate_mihomo_config(&json!({ "mixedPort": 7890, "controllerPort": 9090, "httpPort": 7890, "secret": secret })).is_err());
        assert!(generate_mihomo_config(&json!({ "mixedPort": 7890, "controllerPort": 9090, "secret": "nothex" })).is_err());
        assert!(generate_mihomo_config(&json!({ "mixedPort": 7890, "controllerPort": 9090, "logLevel": "verbose", "secret": secret })).is_err());
        let error = generate_mihomo_config(&json!({ "mixedPort": 80, "controllerPort": 9090, "secret": secret }))
            .unwrap_err()
            .0;
        assert!(error.contains("Invalid mixed-port: must be an unprivileged integer port between 1024 and 65535, got 80"), "{error}");
        // Non-direct mode is rejected with the Phase-7 copy.
        let error = generate_mihomo_config(&json!({ "mixedPort": 7890, "controllerPort": 9090, "mode": "global", "secret": secret }))
            .unwrap_err()
            .0;
        assert!(error.contains("Unsupported mihomo mode: global; Phase 7 requires 'direct'"), "{error}");
    }

    #[test]
    fn secret_helpers_match_the_ts_contract() {
        assert!(is_valid_secret(&"a".repeat(64)));
        assert!(!is_valid_secret(&"a".repeat(63)));
        assert!(!is_valid_secret(&"A".repeat(64)));
        assert!(!is_valid_secret(&"g".repeat(64)));
        let secret = random_secret();
        assert!(is_valid_secret(&secret), "generated secrets must satisfy the contract");
        assert_ne!(random_secret(), random_secret());
    }

    #[tokio::test]
    async fn temp_store_materializes_an_isolated_workspace_and_cleans_it() {
        let store = TempKernelConfigStore;
        let binary = KernelBinary {
            command: PathBuf::from("/fake/kernel"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let config = store.materialize(&binary, "s3cret").await.unwrap();
        assert!(config.config_path.starts_with(&config.root_dir));
        assert!(config.config_path.exists());
        let text = std::fs::read_to_string(&config.config_path).unwrap();
        assert!(text.contains("no listener configured"));
        assert_eq!(config.env["MURGE_KERNEL_SECRET"], "s3cret");
        store.cleanup(&config).await.unwrap();
        assert!(!config.root_dir.exists());
    }

    #[tokio::test]
    async fn strict_store_writes_the_runtime_config_and_keeps_the_home() {
        let base = tempfile::TempDir::new().unwrap();
        let home = base.path().join("kernel-home");
        let store = StrictMihomoConfigStore {
            mixed_port: 7897,
            http_port: 0,
            socks_port: 0,
            controller_port: 9097,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            workspace_dir: base.path().to_path_buf(),
            kernel_home_dir: Some(home.clone()),
            seed_resources_dir: None,
            owned_dir: Mutex::new(None),
            resolve_active_document: None,
        };
        let binary = KernelBinary {
            command: PathBuf::from("/fake/mihomo"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let config = store.materialize(&binary, &random_secret()).await.unwrap();
        assert!(config.root_dir.to_string_lossy().contains("mihomo-workspace-"));
        let text = std::fs::read_to_string(&config.config_path).unwrap();
        assert!(text.contains("mixed-port: 7897"));
        assert!(text.contains("external-controller: 127.0.0.1:9097"));
        assert_eq!(config.args, vec![
            "-f".to_string(),
            config.config_path.to_string_lossy().to_string(),
            "-d".to_string(),
            home.to_string_lossy().to_string()
        ]);
        assert!(config.env.contains_key("MIHOMO_PLATFORM"));
        store.cleanup(&config).await.unwrap();
        assert!(!config.root_dir.exists());
        // The persistent home is NEVER cleaned up.
        assert!(home.exists());
    }

    #[tokio::test]
    async fn strict_store_output_passes_the_strict_schema_gate() {
        let base = tempfile::TempDir::new().unwrap();
        let store = StrictMihomoConfigStore {
            mixed_port: 7897,
            http_port: 0,
            socks_port: 0,
            controller_port: 9097,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            workspace_dir: base.path().to_path_buf(),
            kernel_home_dir: None,
            seed_resources_dir: None,
            owned_dir: Mutex::new(None),
            resolve_active_document: None,
        };
        let binary = KernelBinary {
            command: PathBuf::from("/fake/mihomo"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let config = store.materialize(&binary, &random_secret()).await.unwrap();
        let text = std::fs::read_to_string(&config.config_path).unwrap();
        assert!(crate::kernel_config_validation::mihomo_config_errors(&text).is_empty(), "{text}");
        store.cleanup(&config).await.unwrap();
    }

    #[tokio::test]
    async fn secret_failures_leave_no_workspace_child_behind() {
        // Validations run BEFORE any directory is created.
        let base = tempfile::TempDir::new().unwrap();
        let store = StrictMihomoConfigStore {
            mixed_port: 24000,
            http_port: 0,
            socks_port: 0,
            controller_port: 24001,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            workspace_dir: base.path().to_path_buf(),
            kernel_home_dir: None,
            seed_resources_dir: None,
            owned_dir: Mutex::new(None),
            resolve_active_document: None,
        };
        let binary = KernelBinary {
            command: PathBuf::from("/bin/mihomo"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let error = store.materialize(&binary, "").await.unwrap_err();
        assert!(
            error.0.contains("Mihomo controller secret must be a 64-character lowercase hex string"),
            "{}",
            error.0
        );
        let error = store.materialize(&binary, "short").await.unwrap_err();
        assert!(error.0.starts_with("PROTOCOL_ERROR:INVALID_ARGUMENT::"), "{}", error.0);
        let children: Vec<_> = std::fs::read_dir(base.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("mihomo-workspace-"))
            .collect();
        assert!(children.is_empty(), "leaked workspace children: {children:?}");
    }

    #[tokio::test]
    async fn profile_branch_gates_the_document_and_forces_the_app_keys() {
        let base = tempfile::TempDir::new().unwrap();
        let store = StrictMihomoConfigStore {
            mixed_port: 28000,
            http_port: 0,
            socks_port: 0,
            controller_port: 28001,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            workspace_dir: base.path().to_path_buf(),
            kernel_home_dir: None,
            seed_resources_dir: None,
            owned_dir: Mutex::new(None),
            resolve_active_document: Some(Arc::new(|| {
                Some("proxies:\n  - name: a\n    type: ss\n    server: s\n    port: 1\ntun:\n  enable: true\n".to_string())
            })),
        };
        let binary = KernelBinary {
            command: PathBuf::from("/bin/mihomo"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let secret = random_secret();
        let config = store.materialize(&binary, &secret).await.unwrap();
        let text = std::fs::read_to_string(&config.config_path).unwrap();
        // The profile content is carried; the safety-critical keys are forced.
        assert!(text.contains("name: a"), "{text}");
        assert!(text.contains("mixed-port: 28000"), "{text}");
        assert!(text.contains("28001"), "{text}");
        assert!(text.contains(&format!("secret: {secret}")), "{text}");
        // The system-mutating tun block is neutralized on the main kernel.
        assert!(!text.contains("enable: true"), "{text}");
        store.cleanup(&config).await.unwrap();

        // A degenerate document is rejected BEFORE any directory exists.
        let store = StrictMihomoConfigStore {
            resolve_active_document: Some(Arc::new(|| Some("mode: rule\n".to_string()))),
            ..store
        };
        let error = store.materialize(&binary, &secret).await.unwrap_err();
        assert!(
            error.0.starts_with("PROTOCOL_ERROR:INVALID_ARGUMENT::配置文件构建失败："),
            "{}",
            error.0
        );
        let children: Vec<_> = std::fs::read_dir(base.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("mihomo-workspace-"))
            .collect();
        assert!(children.is_empty(), "leaked workspace children: {children:?}");
    }

    #[tokio::test]
    async fn strict_store_rejects_an_invalid_secret_with_the_ts_copy() {
        let base = tempfile::TempDir::new().unwrap();
        let store = StrictMihomoConfigStore {
            mixed_port: 7897,
            http_port: 0,
            socks_port: 0,
            controller_port: 9097,
            controller_host: "127.0.0.1".to_string(),
            allow_lan: false,
            controller_panel: false,
            workspace_dir: base.path().to_path_buf(),
            kernel_home_dir: None,
            seed_resources_dir: None,
            owned_dir: Mutex::new(None),
            resolve_active_document: None,
        };
        let binary = KernelBinary {
            command: PathBuf::from("/fake/mihomo"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let error = store.materialize(&binary, "nothex").await.unwrap_err();
        assert_eq!(
            error.0,
            "PROTOCOL_ERROR:INVALID_ARGUMENT::Mihomo controller secret must be a 64-character lowercase hex string"
        );
    }

    // -- the real Unix process adapter --------------------------------------

    #[cfg(unix)]
    #[tokio::test]
    async fn real_adapter_spawns_reports_exit_and_terminates() {
        use std::sync::atomic::AtomicUsize;
        struct CollectSink {
            exits: Arc<std::sync::Mutex<Vec<(Option<i32>, Option<String>)>>>,
            lines: Arc<AtomicUsize>,
        }
        impl KernelProcessSink for CollectSink {
            fn stdout(&self, _text: &str) {
                self.lines.fetch_add(1, Ordering::SeqCst);
            }
            fn stderr(&self, _text: &str) {}
            fn exit(&self, code: Option<i32>, signal: Option<String>) {
                self.exits.lock().expect("exits poisoned").push((code, signal));
            }
            fn error(&self, _message: &str) {}
        }
        let exits = Arc::new(std::sync::Mutex::new(Vec::new()));
        let lines = Arc::new(AtomicUsize::new(0));
        let adapter = NodeKernelProcessAdapter;
        let binary = KernelBinary {
            command: PathBuf::from("/bin/sh"),
            args: vec!["-c".to_string(), "echo hello; sleep 60".to_string()],
            version: None,
            env: BTreeMap::new(),
        };
        let pid = adapter
            .spawn(&binary, Arc::new(CollectSink { exits: exits.clone(), lines: lines.clone() }))
            .unwrap()
            .unwrap();
        assert!(pid > 0);
        assert!(adapter.is_process_alive(pid));
        assert!(adapter.terminate(pid));
        for _ in 0..3000 {
            if !exits.lock().expect("exits poisoned").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let exits = exits.lock().expect("exits poisoned");
        assert_eq!(exits.len(), 1);
        // Terminated by SIGTERM (signal 15) — not a clean code-0 exit.
        assert!(exits[0].1.is_some(), "expected a signal exit, got {:?}", exits[0]);
    }

    // -- controller-ready gateway -------------------------------------------

    struct ScriptedProbe {
        failures: std::sync::atomic::AtomicU32,
    }

    impl VersionProbe for ScriptedProbe {
        fn probe(&self) -> BoxFuture<'_, Result<(), IpcError>> {
            Box::pin(async move {
                if self.failures.fetch_sub(1, Ordering::SeqCst) > 1 {
                    return Err(IpcError::code(code::UPSTREAM_HTTP_ERROR, "not ready"));
                }
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn gateway_resolves_start_only_after_the_controller_answers() {
        let h = create_harness();
        let status = start_to_running(&h).await;
        let _ = status;
        let probe = Arc::new(ScriptedProbe { failures: std::sync::atomic::AtomicU32::new(2) });
        let gateway = ControllerReadyKernelGateway::new(h.supervisor.clone(), probe, 100, 1);
        let status = gateway.start().await.unwrap();
        assert_eq!(status["phase"], "running");
    }

    #[tokio::test]
    async fn gateway_stops_a_half_ready_process_with_a_typed_timeout() {
        let h = create_harness();
        start_to_running(&h).await;
        // Always-failing probe (u32::MAX failures).
        let probe = Arc::new(ScriptedProbe { failures: std::sync::atomic::AtomicU32::new(u32::MAX) });
        let gateway = ControllerReadyKernelGateway::new(h.supervisor.clone(), probe, 20, 1);
        let error = gateway.start().await.unwrap_err();
        assert_eq!(error_code(&error), "KERNEL_START_TIMEOUT");
        assert!(error.0.contains("did not become ready"));
        // The half-ready process was stopped through the supervisor.
        assert_eq!(h.supervisor.get_status()["phase"], "stopped");
        assert_eq!(h.store.cleanup_count(), 1);
    }

    #[tokio::test]
    async fn gateway_passes_through_a_non_running_start() {
        let h = create_harness();
        // A failing resolver → start fails before any probe would matter.
        *h.resolver.error.lock().expect("err poisoned") =
            Some(IpcError::unsupported(crate::kernel_process::DISABLED_RESOLVER_MESSAGE));
        let probe = Arc::new(ScriptedProbe { failures: std::sync::atomic::AtomicU32::new(1) });
        let gateway = ControllerReadyKernelGateway::new(h.supervisor.clone(), probe, 100, 1);
        assert!(gateway.start().await.is_err());
        // No probe side effects leaked into a running kernel.
        assert_eq!(h.adapter.spawn_count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_adapter_surfaces_spawn_failures() {
        let adapter = NodeKernelProcessAdapter;
        struct NullSink;
        impl KernelProcessSink for NullSink {
            fn stdout(&self, _: &str) {}
            fn stderr(&self, _: &str) {}
            fn exit(&self, _: Option<i32>, _: Option<String>) {}
            fn error(&self, _: &str) {}
        }
        let binary = KernelBinary {
            command: PathBuf::from("/nonexistent/murge-kernel-binary"),
            args: Vec::new(),
            version: None,
            env: BTreeMap::new(),
        };
        let error = adapter.spawn(&binary, Arc::new(NullSink)).unwrap_err();
        assert!(error.contains("Failed to spawn"), "{error}");
    }
}
