# Phase 1–7 acceptance criteria

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

## Future runtime evidence

A command returning success is not enough. Runtime tasks must prove the relevant layer:

- Kernel: executable path, version, PID, controller listener and `/version`.
- System proxy: before/after OS settings and effective request route.
- TUN: service/driver state, route table, DNS path and a captured non-proxy-aware request.
- Profile switch: validation, active path/config and retained unsupported fields.
- Update: signature/checksum, version change, restart and rollback behavior.
