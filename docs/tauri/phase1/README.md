# Phase 1 — Establish migration boundaries (Electron shell split)

Status: **Complete** (Electron-side scope; Tauri shell itself starts in Phase 2).

## What was done

The former monolithic `src/main/index.ts` (1911 lines: module-level bootstrap +
`app.whenReady` service graph + quit flow) is split into a thin entry plus
explicit shell modules. No domain service was redesigned; every moved block is
a verbatim extraction whose only edits are the extraction seams.

### Module map

| Module | Owns (all extracted from the former monolith) |
|---|---|
| `src/main/index.ts` | Thin entry: `bootstrapShell()` + `app.whenReady -> runWhenReady` + fatal-error surface. |
| `src/main/electron/boot-flags.ts` | `MURGE_CI_BOOT_FLAGS` parsing, `--hidden`, Actions-only `--no-kernel-autostart`, boot diagnostics dump, packaging/restore watchdogs, GPU-disable decision. Electron-free. |
| `src/main/electron/runtime-state.ts` | `ApplicationState`: the module-level mutable variables (`kernel`, `mihomo`, `systemProxy`, `mainWindow`, `trayController`, `modeTransition`, …) as one container, initialized to the exact pre-refactor values. Type-only imports. |
| `src/main/electron/bootstrap.ts` | Module-level shell bootstrap: single-instance lock, boot flags, diagnostics, watchdogs, GPU gating, userData pinning, log directory + `FileLogService`, settings services, storage warmup chain, lifecycle/window adapter wiring. Acts as the composition root's construction half. |
| `src/main/electron/when-ready.ts` | The `app.whenReady` orchestration — service graph and startup order, verbatim. Acts as the composition root's ordering half (the plan's `application/composition-root.ts` suggestion is realized as this bootstrap+when-ready pair; a single merged file would have re-created a monolith). |
| `src/main/electron/window-adapter.ts` | `WINDOW_GEOMETRY`, `createWindow`, `showMainWindowAt`/`showMainWindow`, identity registration (`murge://` + AppUserModelId), second-instance handling, deep-link queueing, `--ui-smoke` probe, `pendingRendererRoute` delivery. |
| `src/main/electron/deep-link.ts` | `extractDeepLink` + `createDeepLinkQueue` — Electron-free so the registration/delivery contract is unit-testable. |
| `src/main/electron/lifecycle-adapter.ts` | Quit flow: `restoreSystemProxyBeforeQuit` (3 bounded attempts), `restoreNetworkBeforeQuit` (inside the ONE mode-transition queue), `beginApplicationShutdown` (idempotent via shared promise), `before-quit`/`window-all-closed` registration, fatal-startup surface. |
| `src/main/electron/tray-adapter.ts` | Tray icon root resolution, `openTrayDirectory`, `TrayController` construction with the exact former dependency set, runtime-accent wiring (proxy/TUN phases + native theme). |
| `src/main/electron/update-adapter.ts` | `bindUpdateService` — the single seam between the update service and shutdown disposal. |
| `src/main/electron/ci-probes-adapter.ts` | Headless probes: `runPackagingSmoke`, `runSystemProxyRestore`, `runSystemProxyEnable` (unchanged gates/messages). |
| `src/renderer/src/platform/desktop-contract.ts` | Renderer-side shell detection (`detectShell`) + `DesktopApi`/`IPC`/type re-exports — the seam the Tauri renderer will program against. |
| `src/shared/ipc-types.ts` | Type-only aggregation re-export so the renderer contract can import shell types without importing the Electron-typed IPC registry. |

### Invariants preserved (checked, not assumed)

- Startup order is unchanged; see `tests/phase1-startup-order.test.ts` for the
  static lock (brand -> identity/deep links -> storage warmup -> pre-kernel
  services -> headless probes -> kernel graph -> proxy/TUN wiring -> recovery
  joins -> IPC -> window -> tray -> recovery loops -> auto-update check).
- Single mihomo process / single ownership chain unchanged; the privileged
  service remains the only production core host on Windows.
- Proxy restore still runs BEFORE kernel stop on every teardown path, including
  quit (`lifecycle-adapter`) and ordered-gateway stop.
- The webview never gains new privileges: `src/preload/` and the IPC channel
  surface are untouched (`git diff main --stat` shows no preload/shared/ipc.ts
  changes); `window.desktop` signatures unchanged.
- Brand comes only from `brand.config.json` (`parseBrandConfig` still gates
  startup).
- The kernel workspace stays `join(profileRoot, 'kernel')`
  (`…\io.murge.desktop\profiles\kernel`).

### Contract-test retargeting (assertion semantics unchanged)

`windows-ci-contract`, `activity-ui-contract`, `preload-build-path`,
`resources-unlock-ui-contract`, `system-proxy-uninstall-nsis`,
`update-notification-navigation`, `tun-contracts` (takeover assertion),
`g1-probe-isolation` (shell list extended to the new modules),
`phase9b-ownership` now read the owning module instead of `src/main/index.ts`.
The only literal-update exceptions: boot-flag env gates are expressed against
the module's `env` parameter (`env.MURGE_CI_BOOT_DIAG !== '1'`,
`env.GITHUB_ACTIONS === 'true' && hasArg('--no-kernel-autostart')`), and the
uninstaller GPU assertion now targets the split watchdog (boot-flags) + gate
(bootstrap) pair.

### New Phase 1 tests

- `tests/phase1-shell-boundary.test.ts` — boot-flag parsing semantics
  (forwarder, `--hidden`, Actions gate, opt-in diagnostics), GPU-disable flag
  set, deep-link extraction/queueing, window geometry literal.
- `tests/phase1-startup-order.test.ts` — startup-order anchors, thin-entry
  guarantee (no service wiring back in `index.ts`), G1/Wintun purity of the new
  shell modules.

## Verification (Linux ARM64, real execution)

- `npm run typecheck` — green (`vue-tsc` web + `tsc` node).
- `npx vitest run` — **1899 passed / 7 skipped** (1883 pre-existing + 16 new).
- `go test ./...` (native/tun-service, go1.26.5) — ok.
- `git rev-parse main` still `9da5522` (v0.9.8); no main-branch changes.

## Not in scope / next

- Tauri shell (`src-tauri`) starts in Phase 2; nothing Electron was deleted.
- The renderer still boots Electron-only (`desktop-contract.detectShell` is
  consumed from Phase 2 onward).
