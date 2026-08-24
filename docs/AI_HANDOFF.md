# AI implementation handoff

## Mandatory reading

Read `DEVELOPMENT_SAFETY.md` first, then open `ui-reference/murge-ui-preview.html` and read `UI_SPEC.md`, `ARCHITECTURE.md`, `MIHOMO_API.md`, `BRANDING.md` and `ACCEPTANCE.md` before editing code.

## Development-machine safety gate

The current Mac may be the owner's active remote connection. On this machine, do not start real mihomo or modify system proxy, TUN, DNS, routes, interfaces, firewall rules or any other network state. Do not use the owner's real subscriptions or credentials. Use fixtures, fake processes, mocks and unit tests only. Windows network code may be written but must not be executed here.

This restriction overrides task wording such as “run,” “verify,” “finish” or “test end to end.” Only a new, explicit owner authorization for an exact network test can change it.

## Non-negotiable rules

1. Do not rename IPC channels or shared public types without updating docs and tests.
2. Do not expose `ipcRenderer`, the controller secret, Node APIs or filesystem access to Vue.
3. Do not replace the fixed 934×672 reference geometry until a visual review approves a responsive alternative.
4. Do not hardcode the current product name outside branding sources and branding docs.
5. Do not claim system proxy or TUN is active until the main process verifies OS/runtime state.
6. Do not download or execute a kernel binary without checksum verification.
7. Do not rewrite an entire YAML profile merely to change one GUI-supported field.
8. Preserve unrelated user changes and keep each implementation task scoped.
9. Follow `DEVELOPMENT_SAFETY.md`; default development and test commands must remain non-mutating.
10. Treat `ui-reference/murge-ui-preview.html` as the normative visual source. Do not redesign, embellish or substitute your own layout without explicit owner approval.

## Recommended task sequence

### Task 1 — Runtime validation and schemas

- Add a runtime schema library.
- Validate brand config, all IPC inputs and external API responses.
- Add unit tests for invalid payloads.

Done when malformed renderer input cannot reach service methods.

### Task 2 — Kernel supervisor

- Implement the contract in `src/main/services/kernel-supervisor.ts`.
- Use a test fixture process before integrating a real binary.
- Add lifecycle race, failed-start, crash and graceful-stop tests.

Done when PID change, listener readiness and `/version` success are independently verified.

### Task 3 — WebSocket transport

- Add a reusable main-process socket transport.
- Implement `/traffic`, `/connections` and `/logs` subscriptions.
- Reference count renderer subscriptions and cap event rate.

Done when disconnect/reconnect does not duplicate samples or leak listeners.

### Task 4 — Activity page integration

- Replace fixture data with stores backed by typed IPC.
- Keep layout pixel-stable in loading, active and failed states.
- Implement bounded histories and aggregations described in `MIHOMO_API.md`.
- Compare the 934×672 implementation screenshot directly with the Activity state in `ui-reference/murge-ui-preview.html`; do not reinterpret its layout.

Done when screenshot geometry remains approved at 934×672 and live data updates once per second.

### Task 5 — Policies and providers

- Implement group/node lists, selection, latency testing and provider refresh.
- Encode path segments and handle duplicate display names safely.

Done when selection is confirmed by a subsequent API read.

### Task 6 — Profiles

- Implement import, subscription update, validation and atomic activation.
- Preserve unsupported YAML keys.

Done when a failed validation leaves the active profile and kernel unchanged.

### Task 7 — Windows system proxy

- Implement behind an interface with a fake for tests.
- Back up and restore exact prior owned state.
- Add crash recovery.

Done when registry/settings inspection proves enable and restore behavior.

### Task 8 — TUN helper

- Write a design proposal before code.
- Define elevation, installation, uninstall and upgrade behavior.
- Keep it independently auditable.

Done only after route/DNS checks prove traffic is actually captured.

## Pull request template for implementation agents

Include:

- Scope completed and intentionally excluded.
- Changed IPC/API contracts.
- Test commands and results.
- Runtime evidence for process/network changes.
- 934×672 screenshot for UI changes.
- New security, privilege or migration considerations.

## Stop conditions

Ask the owner before:

- choosing the application license;
- publishing a GitHub release;
- changing `appId` or storage namespace;
- installing a privileged service or driver;
- enabling automatic kernel downloads;
- copying any vendor-owned icon or asset.
