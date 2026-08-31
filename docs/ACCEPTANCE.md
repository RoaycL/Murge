# Phase 1–8 acceptance criteria

## Current milestone

- [x] Default development commands do not start a real kernel or mutate system networking.
- [x] macOS system proxy and TUN implementations are absent or explicitly blocked.
- [x] `npm ci` completes in CI.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] `npm run brand:check` passes.
- [x] Development window opens at no less than 934×672.
- [x] Default route is Activity.
- [ ] Activity and all secondary pages pass the final raw-pixel visual review; remaining deltas are tracked in `UI_DEBT.md`.
- [x] A 934×672 Activity screenshot has been compared directly with `ui-reference/murge-ui-preview.html` and deviations are documented.
- [x] Overview never reports unimplemented system proxy, TUN or LAN controls as active.
- [x] Navigation pages render and the Phase 4–5 pages use typed live/mock gateways.
- [x] Renderer has no Node access.
- [x] Packaged Windows kernel start is explicit, authenticated, loopback-only and safe-direct.
- [x] API and handoff documents identify source references and uncertainty.
- [x] Owner-selected GPL-3.0-only application license is present and `npm run license:check` passes.
- [x] The RC route/navigation allowlist hides TUN, capture, HTTPS decryption, rewrite and placeholder pages that lack a completed service contract.
- [x] Excluded placeholder page sources are absent, and supported RC controls have accessible names/state without changing the reference geometry.
- [x] Installed artifacts retain source-access instructions for Murge and the exact bundled mihomo version.

## Phase 8 — Windows system proxy

- [x] The feature is brand-neutral (PowerShell `Add-Type` uses a generic `SystemProxy` namespace; no product name in source under `src/`).
- [x] Non-win32 (and the dev path) fail closed: adapter reports `unsupported`, main exposes a disabled state and the Overview switch is disabled.
- [x] The main process is the single source of truth; the UI never flips optimistically.
- [x] Previous HKCU proxy state is backed up atomically before any write and restored exactly afterward.
- [x] External modification / conflicting proxy surfaces `SYSTEM_PROXY_STATE_CONFLICT` with a structured detail and performs no mutation.
- [x] Crash/orphan recovery: `init()` restores a stale owned enable from the committed backup; the ordered kernel gateway restores before the kernel stops; `before-quit` restores.
- [x] `npm run license:check`, `npm run typecheck`, `npm test`, `npm run build` and `npm run brand:check` all pass locally.
- [x] The gated real test `tests/system-proxy-real.integration.test.ts` (skipped unless `MURGE_RUN_REAL_SYSTEM_PROXY=1` + `win32`) writes the three HKCU values, proves a host `NetworkSnapshot` changed only in the HKCU Internet Settings proxy field, and restores the exact original values in a `finally` block.
- [x] A dedicated `system-proxy-real-windows` CI job is added to `.github/workflows/ci.yml` and gated by `MURGE_RUN_REAL_SYSTEM_PROXY=1`, to run only on `windows-latest`.

Out of scope for Phase 8 (tracked for a later phase): serving an actual proxy and producing effective request-route evidence; a standalone GUI-independent restore CLI (the current restore is main-process wired).

## Future runtime evidence

A command returning success is not enough. Runtime tasks must prove the relevant layer:

- Kernel: executable path, version, PID, controller listener and `/version`.
- System proxy: before/after OS settings (proven by the gated real test) and effective request route (deferred — the feature registers the proxy, it does not serve one).
- TUN: service/driver state, route table, DNS path and a captured non-proxy-aware request.
- Profile switch: validation, active path/config and retained unsupported fields.
- Update: signature/checksum, version change, restart and rollback behavior.
