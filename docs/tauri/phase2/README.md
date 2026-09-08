# Phase 2 — Side-by-side Tauri shell

Status: **Complete** (shell skeleton + compatibility bridge; Phase 3 vertical
slices add the Rust service implementations).

> Note: Phase 2 was implemented together with the start of Phase 3A in the same
> working session; the progress table tracks both.

## What was done

`src-tauri/` now exists alongside the untouched Electron shell (nothing was
deleted; `npm run dev` still boots Electron).

### Structure

```
src-tauri/
├── Cargo.toml                 # crate `murge` (brand executableName), lib+bin
├── build.rs                   # tauri-build
├── tauri.conf.json            # brand-identical window (934x672 / 848x640 min, #eef3f8)
├── capabilities/main-window.json  # least-privilege: core:default only
├── icons/                     # generated from resources/icon.png (tauri icon)
└── src/
    ├── main.rs                # thin bin entry (windows_subsystem hidden in release)
    ├── lib.rs                 # builder: brand gate, single-instance, state, dispatch
    ├── brand.rs               # parses brand.config.json (include_str!, same doc as Electron)
    ├── app_info.rs            # AppInfo in Electron vocabulary (win32/x64/arm64)
    ├── paths.rs               # app-data namespace = brand appId; dev = memory-only
    ├── settings.rs            # 3A: byte-compatible app-settings store + 7 tests
    └── ipc.rs                 # single `desktop_ipc` dispatch command + 4 tests
```

### Compatibility bridge (the Phase 2 centerpiece)

- `scripts/generate-tauri-bridge.mjs` parses `src/preload/index.ts` (the
  method surface) + `src/shared/ipc.ts` (the wire channel names) and generates
  `src/renderer/src/platform/generated/desktop-api.ts` — a typed
  `createDesktopApi()` rendering **all 121 channels** (111 invoke + 10 events)
  over the single `desktop_ipc` command and Tauri events.
- Arguments travel as a positional payload array (names never reach the wire).
- Errors keep the Electron wire format (`PROTOCOL_ERROR:<CODE>::<message>`) and
  are decoded with the SAME `@shared/protocol-errors` helper, so error mapping
  is shell-independent.
- Events unwrap Tauri's `Event<T>` envelope to the bare payload the Electron
  listeners receive, and expose the same synchronous-unsubscribe contract.
- `src/renderer/src/main.ts` detects the shell and installs the bridge BEFORE
  Vue mounts — the same guarantee the Electron preload gives.
- Channels without a Rust handler yet fail **closed** with
  `PROTOCOL_ERROR:UNSUPPORTED::…` (honest errors during the migration, never
  silent no-ops).

### Configuration parity (checked against brand.config.json + Electron)

| Item | Value | Source |
|---|---|---|
| Identifier / appId | `io.murge.desktop` | brand.appId |
| Product name | `Murge` | brand.productName |
| Window canvas | 934x672 content-size, min 848x640 | `WINDOW_GEOMETRY` |
| Background | `#eef3f8` | Electron createWindow |
| Dev server | `http://localhost:5173` (strict) | `vite.renderer.config.ts` |
| Production dist | `../out/renderer` (shared with Electron build) | `tauri.conf.json` |
| Renderer CSP | null (renderer already sets none; no inline-script need added) | `tauri.conf.json` |

### npm surface

`dev:renderer`, `build:renderer`, `tauri`, `tauri:dev`, `tauri:build`,
`tauri:bridge` — the Electron scripts are unchanged.

### Capabilities

`capabilities/main-window.json` grants only `core:default` to the `main`
window. No filesystem, shell, opener or broad plugin permissions reach the
webview; everything privileged stays in Rust (and the privileged Go service
remains the only core owner — Phase 3D).

## Verification (Linux ARM64, real execution)

- Rust: `cargo test` — **17 passed / 0 failed** (brand, app-info, paths,
  settings store, dispatch table).
- Rust: `cargo build` — the shell binary links (with the real renderer dist
  embedded via `generate_context!`).
- TypeScript: `npm run typecheck` — green (generated bridge included).
- `npx vitest run` — **1905 passed / 7 skipped** (1883 + 16 Phase 1 + 6
  Phase 2 bridge-parity tests).
- Renderer: `npm run build:renderer` — emits into the shared `out/renderer`.
- Phase 2 exit gates from the plan: `tauri dev`/GUI rendering on an
  interactive desktop requires a display — **deferred to Windows CI** (the
  same gate class as the Phase 0 runtime baseline); everything assertable
  headlessly passes here.

## Out of scope / next

- Phase 3A continues: profiles/source-metadata, overrides/DNS/sniffer/core/
  geodata/TUN persistence, usage history, file logging, dialog/clipboard/
  open-directory/safe-storage equivalents.
- Phase 3B-3D: controller streams, downloads, privileged core.
