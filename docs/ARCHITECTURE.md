# Architecture

## Goals

- Windows-first desktop UX with a renderer that can be developed on macOS.
- A replaceable product brand with no business logic coupled to the current name.
- A least-privilege renderer. Secrets, child processes and OS settings stay outside Vue.
- A testable boundary around the mihomo controller API.
- Explicit separation between configuration persistence and live runtime state.

## Process model

```text
Vue renderer
  │ typed window.desktop API
  ▼
preload allowlist
  │ validated Electron IPC
  ▼
Electron main
  ├── KernelSupervisor ── child mihomo process
  ├── MihomoClient ───── REST / WebSocket controller
  ├── ProfileService ─── YAML profiles and subscriptions
  ├── SystemProxy ────── Windows Internet Settings
  ├── TunService ─────── privileged helper boundary
  └── UpdateService ──── application and kernel channels
```

The renderer must never receive the controller secret, filesystem paths outside user-facing profile references, process handles or privileged helper credentials.

## Required folders

- `src/main`: trusted Electron code and operating-system integrations.
- `src/preload`: the only renderer bridge; expose individual operations, never raw `ipcRenderer`.
- `src/renderer`: Vue pages, components, stores and visual tokens.
- `src/shared`: serializable types and channel names shared between processes.
- `resources/bin`: ignored location for platform-specific kernel binaries.
- `resources/defaults`: templates copied to application data on first run.
- `docs`: implementation contracts and acceptance criteria.

## Services to implement

### KernelSupervisor

Responsibilities:

1. Resolve the packaged or development binary for `win32-x64` and `win32-arm64`.
2. Verify the binary checksum against release metadata controlled by the project.
3. Create an application-data directory and materialize an active configuration.
4. Generate a cryptographically random controller secret on first launch.
5. Spawn mihomo without a shell and capture stdout/stderr.
6. Wait for both controller listen readiness and `GET /version` success.
7. Stop gracefully, then use a bounded forced termination fallback.
8. Emit status transitions and prevent concurrent start/stop races.
9. Apply crash-loop backoff and write focused rolling logs.

### MihomoClient

- Own REST and WebSocket connections.
- Always send `Authorization: Bearer <secret>`.
- Percent-encode every dynamic path segment.
- Use request timeouts and a typed error hierarchy.
- Reconnect streams with capped exponential backoff and jitter.
- Stop reconnecting when the kernel is intentionally stopped.

### ProfileService

- Preserve the original YAML document for unsupported settings.
- Maintain a normalized view model only for fields surfaced in the GUI.
- Write atomically: temporary file, validation, rename.
- Run mihomo configuration validation before activation.
- Never silently discard unknown keys or comments during a simple profile switch.

### SystemProxyService

- Windows-only implementation behind an interface.
- Store the exact previous proxy state before enabling.
- Restore only values owned by this application.
- Recover stale owned state after a crash.
- Do not mutate system proxy settings from the renderer.

### TunService

- Treat TUN as a privileged, separately testable feature.
- Document and verify the driver/helper installation path.
- Require explicit user action for elevation.
- Report configured, starting, active and failed states separately.

## State model

- `kernelStore`: lifecycle, PID, controller health, version and last error.
- `runtimeStore`: mode, active profile, proxy/TUN status, network and external IP.
- `trafficStore`: bounded time-series buffers; renderer keeps at most the visible history window.
- `connectionsStore`: latest snapshot indexed by connection ID.
- `profilesStore`: metadata only; secrets stay in main process storage.

Do not use one global store for all controller data.

## Security rules

- Keep `sandbox`, `contextIsolation` enabled and `nodeIntegration` disabled.
- Validate every IPC argument in main; TypeScript types are not runtime validation.
- Bind `external-controller` to `127.0.0.1`, never `0.0.0.0` by default.
- Generate a controller secret even for localhost.
- Do not log subscription URLs containing credentials or controller secrets.
- Do not open arbitrary URLs received from the renderer without a scheme allowlist.
- Do not invoke PowerShell through concatenated command strings.
