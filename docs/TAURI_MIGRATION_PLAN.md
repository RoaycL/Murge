# Murge Electron to Tauri Migration Plan

## Objective

Migrate the Windows desktop shell from Electron 44 to Tauri 2 without changing Murge's user-visible behavior, network semantics, persistent data, or security boundaries.

The target architecture is:

- Vue 3, Pinia, Vue Router, existing views and visual design remain the frontend.
- Tauri's Rust process replaces the Electron main process and preload.
- The existing LocalSystem Go TUN service remains the only privileged mihomo owner.
- Rust communicates with the Go service over the existing authenticated named-pipe protocol.
- The final product does not ship a Node sidecar.
- Electron remains buildable until the Tauri package passes the complete parity gate.

This branch starts from `v0.9.6` (`c0b0b5e`). Do not merge it into `main` until the definition of done at the end of this document is satisfied.

## Non-negotiable invariants

1. Murge continues to run exactly one mihomo process for system-proxy and TUN modes.
2. Switching system proxy and TUN remains an in-place hot transition; it must not create a second core or leave a dead proxy port.
3. The Go service keeps its LocalSystem identity, directory ACL and reparse-point protections, client executable digest pin, rolling-core trust catalog, job-object ownership, and fail-closed protocol validation.
4. The webview never receives unrestricted filesystem, shell, registry, process, or named-pipe access.
5. Every frontend argument is validated again by Rust. TypeScript types are not a security boundary.
6. Existing app data, profiles, DNS/sniffer/core/TUN settings, usage history, icon cache, log files, selected policies, Sub-Store data, and proxy backup remain readable after upgrade.
7. An upgrade, uninstall, crash, logoff, or failed migration must not leave Windows pointing at a dead system-proxy port.
8. Stable and specific mihomo versions remain immutable; preview and Smart remain digest-keyed rolling channels with current/previous fallback.
9. Product identity continues to come from `brand.config.json`; do not duplicate Murge names or identifiers in Rust.
10. Do not remove Electron code, Electron CI, or the Electron release path before installed Tauri parity is proven.

## Migration strategy

Use a strangler migration, not a rewrite in one commit. Keep the renderer-facing `window.desktop` contract stable and provide two implementations:

- Electron: the existing preload implementation.
- Tauri: a compatibility bridge backed by `invoke` and Tauri events.

Views and stores should not know which shell is running. New shell-specific code belongs behind adapters.

Each phase must leave the repository buildable and tested. Prefer small commits that complete one vertical slice. Record completed work and unresolved differences in the progress table below.

## Phase 0: Freeze the baseline

Deliverables:

- Record installer size, installed size, idle memory, cold start to visible window, cold start to tray, and time to a ready mixed port on x64 and arm64.
- Export an inventory mapping every `window.desktop` method/event and every IPC channel to its owning service and tests.
- Record the current app-data, executable, logs, working, kernel, Sub-Store, and service directories.
- Add a parity checklist for all tray commands, settings pages, headless commands, deep links, updater states, and shutdown paths.
- Preserve a passing baseline for TypeScript tests, Go tests, Windows packaging, real mihomo, system-proxy restore, TUN service install/uninstall, and interactive GUI smoke.

Exit gate:

- The inventory contains every current IPC method and event.
- Baseline measurements and CI run links are committed.
- No product behavior has changed.

## Phase 1: Establish migration boundaries

Split `src/main/index.ts` only as far as needed to expose shell boundaries. Do not redesign every domain service.

Suggested modules:

- `src/main/electron/bootstrap.ts`
- `src/main/electron/window-adapter.ts`
- `src/main/electron/lifecycle-adapter.ts`
- `src/main/electron/tray-adapter.ts`
- `src/main/electron/update-adapter.ts`
- `src/main/application/composition-root.ts`
- `src/renderer/src/platform/desktop-contract.ts`

Deliverables:

- One composition root owns service construction and startup order.
- Electron-specific APIs are isolated behind explicit adapters.
- Existing `window.desktop` signatures remain unchanged.
- Characterization tests lock down startup ordering, mode transitions, quit restoration, event delivery, and error mapping.

Exit gate:

- Electron passes all existing gates with no acceptance change.
- `src/main/index.ts` is a thin Electron entry point rather than the application implementation.

## Phase 2: Add a side-by-side Tauri shell

Create `src-tauri` and a second development/build entry without deleting Electron.

Deliverables:

- Tauri 2 Rust workspace and configuration.
- Windows x64 and arm64 build targets.
- Tauri window loads the existing Vite/Vue renderer.
- A startup bridge installs `window.desktop` before Vue mounts.
- Brand, window size, theme, single-instance behavior, deep link, show/hide/close-to-tray, and application paths match Electron.
- Capability files grant only the commands required by the main window. Do not expose broad shell or filesystem plugin permissions to the renderer.

Exit gate:

- Both `npm run dev` and the Tauri development command work.
- Basic navigation renders identically in light and dark themes.
- Tauri can return app information through the compatibility bridge.

## Phase 3: Port backend services in vertical slices

Port in the following order. Each slice includes Rust commands, Tauri event delivery, bridge wiring, unit tests, and a Windows smoke test.

### 3A. Safe local state

- Brand and app information
- App settings and atomic JSON persistence
- Profiles and source metadata
- Overrides, DNS, sniffer, core, geodata, and TUN setting persistence
- Usage history and file logging
- Dialog, clipboard, opening directories, and safe storage equivalents

Keep pure parsing and UI formatting in TypeScript where useful. Filesystem ownership, credentials, processes, registry access, and network authority belong in Rust.

### 3B. mihomo controller and streams

- HTTP controller requests
- WebSocket traffic, memory, connections, providers, rules, and logs
- Main-process log ring buffer and persistent logs
- Reconnect/backoff and snapshot/event sequence semantics
- Policy selection, delay tests, provider refresh, connection close, and diagnostics

Do not tie stream collection to whether a Vue page is mounted.

### 3C. Downloads and external resources

- Subscription fetch and redirect policy
- Proxy-first/direct fallback behavior
- Remote icon cache and process icon extraction
- Geodata and provider content access
- Sub-Store lifecycle, verified downloads, and proxy environment
- Bounded concurrency, timeouts, response-size limits, and stale-cache behavior

### 3D. Privileged core and network modes

- Rust named-pipe client for the existing Go protocol
- Client identity and service-config changes required by the new Tauri executable name/path/digest
- Kernel status, validation, install, start, stop, inspect, and rolling-channel operations
- System proxy backup/enable/guard/restore
- TUN enable/disable and in-place system-proxy-to-TUN transitions
- Network-change recovery and startup intent reconciliation

The renderer must never call the Go service directly.

Exit gate for Phase 3:

- Every existing `window.desktop` command and event has a Tauri implementation or an explicitly approved removal.
- Contract tests run against Electron and Tauri adapters.
- System proxy and TUN real-Windows gates pass with one service-owned core.

## Phase 4: Native desktop integration

Deliverables:

- Dynamic tray icon state: idle/system-proxy/TUN and theme-aware variants.
- Full native tray menu, policy icons, policy switching, process list, configuration switching, directory shortcuts, restart, and quit.
- Scheduled-task startup behavior equivalent to the current LogonTrigger, delay, priority, least-privilege, migration, and Run-key fallback behavior.
- Notifications, native theme changes, power/session events, second-instance routing, and headless restore commands.
- File/process icon cache with bounded eviction and stale-request generation guards.

Exit gate:

- Tray acceptance checklist passes on an interactive Windows desktop.
- Login startup, silent startup, close-to-tray, restart, logoff, and shutdown are observed rather than inferred from unit tests.

## Phase 5: Updater, installer, and upgrade path

Tauri updater signatures are mandatory for update integrity and are separate from Windows Authenticode signing. Define secure CI secret ownership and key rotation before enabling updates.

Deliverables:

- Tauri NSIS per-machine x64 and arm64 packages with no combined installer.
- Equivalent extra resources: Go service, per-architecture mihomo archive, geodata, defaults, licenses, notices, tray assets, and resolved manifests.
- NSIS pre-uninstall hook restores only Murge-owned proxy state and uninstalls the Go service.
- First Tauri installer upgrades an existing Electron installation without duplicate uninstall entries, orphaned scheduled tasks, lost app data, or two installed executables.
- A final Electron release provides an explicit migration path to the first Tauri release; do not assume Electron `latest.yml` and Tauri updater metadata are interchangeable.
- Tauri update check/download/install/restart supports the configured local proxy, bounded timeouts, release notes, rollback-safe failure behavior, and architecture matching.

Exit gate:

- Installed Electron-to-Tauri upgrade passes on clean and configured Windows accounts.
- Exact registry snapshots prove system-proxy restoration across upgrade and uninstall.
- Installed files, service state, scheduled task, app data, and uninstall entries match the expected postconditions.

## Phase 6: CI and acceptance parity

Add Tauri jobs alongside, not instead of, Electron jobs:

- Rust format, clippy, tests, dependency audit, and release build
- Vue typecheck and unit tests
- Go TUN service tests and x64/arm64 builds
- Tauri x64/arm64 NSIS packaging and artifact inspection
- Real mihomo startup and controller readiness
- Real system-proxy enable/guard/restore
- Real TUN install/start/hot-switch/stop/uninstall
- Rolling preview/Smart A-to-B update and offline-current/previous fallback
- Upgrade from the latest Electron installer
- Interactive Windows GUI and tray smoke

Retain Electron CI until Tauri passes the full matrix repeatedly and the user approves the cutover.

## Phase 7: Cutover and cleanup

Only after every exit gate passes:

- Make Tauri the default development, build, package, and release path.
- Archive the final Electron compatibility release and migration notes.
- Remove Electron, electron-vite, electron-builder, electron-updater, preload, and Electron-only adapters.
- Remove Electron CI after at least one successful production Tauri upgrade cycle.
- Update architecture, release, signing, security, and contributor documentation.

## Required test scenarios

At minimum, preserve or add automated coverage for:

1. App starts with no profile, with an active profile, and with remembered system-proxy or TUN intent.
2. System proxy enables only after the mixed port is reachable.
3. System proxy to TUN and TUN to system proxy do not interrupt traffic longer than the existing baseline.
4. DNS and sniffer hot reload do not restart an unrelated core.
5. Crash, forced kill, updater exit, logoff, shutdown, and uninstall restore owned proxy state.
6. Logs and traffic history collect while their pages are closed.
7. Tray menu policy selection and icons remain current while the window is hidden.
8. Stable/specific core trust remains immutable; preview/Smart roll by digest and retain one verified fallback.
9. Corrupt settings, profiles, trust catalogs, provider caches, and update metadata fail safely without deleting the last recoverable copy.
10. Existing Electron app data opens unchanged under Tauri.
11. The installed Go service accepts only the installed Tauri executable and is removed on uninstall.
12. x64 and arm64 packages contain only their matching native assets.

## Definition of done

The migration is complete only when:

- Tauri implements the complete approved desktop contract.
- All hosted and interactive Windows gates pass on x64; compile/package and available runtime gates pass on arm64.
- Electron-to-Tauri installed upgrade is proven with user data and proxy state preserved.
- Installer, installed footprint, idle memory, and startup measurements are documented against the Phase 0 baseline.
- No Node runtime or Node sidecar ships in the Tauri installer.
- No duplicate mihomo owner, proxy writer, updater, startup registrar, or logging collector exists.
- Security review confirms least-privilege Tauri capabilities and preserves the Go service threat model.
- The user explicitly approves the release-path cutover.

## Progress tracking

Update this table in every migration pull request.

| Phase | Status | Evidence | Blockers |
|---|---|---|---|
| 0. Baseline | In progress | `docs/tauri/phase0/`：`IPC_INVENTORY.md`（121/121 `window.desktop` 方法+事件与通道、实现、测试映射；111 invoke 全注册、10 事件全有发送方的脚本核对）；`DIRECTORIES.md`（app-data/logs/kernel/Sub-Store/service 等目录基线）；`PARITY_CHECKLIST.md`（托盘 17 项、设置页 22 项、headless 10 项、深链 5 项、更新器 10 项、关停 12 项）；`BASELINE.md`（TS 1883 通过/7 跳过、Go `go test ./...` 通过，Linux ARM64 真实执行） | Windows 运行时基线（安装包/内存/冷启动/真实 mihomo/系统代理/TUN/交互 smoke 的数值与 CI 链接）需 Windows CI 或真机，见 `BASELINE.md` §1 占位表 |
| 1. Boundaries | Not started | — | — |
| 2. Tauri shell | Not started | — | — |
| 3A. Local state | Not started | — | — |
| 3B. Controller/streams | Not started | — | — |
| 3C. Downloads/resources | Not started | — | — |
| 3D. Privileged/network | Not started | — | — |
| 4. Desktop integration | Not started | — | — |
| 5. Updater/installer | Not started | — | — |
| 6. CI/parity | Not started | — | — |
| 7. Cutover | Not started | — | — |

## Instructions for implementation agents

- Read this document and `docs/ARCHITECTURE.md` before changing code.
- Work on one phase or vertical slice at a time; do not start later phases to hide an earlier failing gate.
- Do not silently change current behavior. If parity is impossible, document the exact difference and request a product decision.
- Preserve unrelated user files and never add the untracked icon concept PNGs unless explicitly requested.
- Use the existing gateways, schemas, fixtures, and tests as behavioral specifications, but verify security-sensitive behavior from the implementation rather than static string assertions alone.
- Never expose generic shell execution, arbitrary filesystem paths, registry access, or the privileged named pipe directly to the webview.
- Do not claim Windows runtime success from cross-compilation alone.
- Do not delete Electron code until Phase 7.
- Every handoff must state changed files, tests actually executed, tests skipped, current phase status, and the next concrete task.
