# Phased development TODO

This roadmap is the execution order for human and AI contributors. Complete one phase at a time. Do not begin a phase whose entry gate is not satisfied.

Deferred visual issues are tracked in `docs/UI_DEBT.md` and are NOT fixed in feature phases (resolved only in the unified visual-acceptance pass).

Safety rules in `DEVELOPMENT_SAFETY.md` apply to every phase. On the current Mac, do not start real mihomo or change system proxy, TUN, DNS, routes, firewall or network interfaces.

## Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` complete and verified
- `[!]` blocked or requires owner decision

## Phase 0 — Framework baseline

Environment: current Mac, safe.

Status: complete.

- [x] Scaffold Electron + Vue 3 + TypeScript.
- [x] Separate main, preload, renderer and shared contracts.
- [x] Add configurable branding and rename checks.
- [x] Add the normative 934×672 UI reference.
- [x] Create Activity and Overview visual shells.
- [x] Create Processes, Devices, Policies, Rules, Capture, Decrypt, Rewrite and Settings visual shells.
- [x] Document mihomo controller endpoints.
- [x] Add development-machine network safety rules.
- [x] Verify type check, production build and development startup.

Exit evidence:

- Commit `67dc816` or later is present.
- `npm run brand:check`, `npm run typecheck`, `npm run build` and `npm test` pass.

## Phase 1 — Contract hardening and test infrastructure

Environment: current Mac, safe. Mocks only.

Entry gate: Phase 0 complete.

- [x] Add a runtime schema-validation library.
- [x] Validate `brand.config.json` at startup and build time.
- [x] Validate every renderer-to-main IPC argument.
- [x] Validate and normalize mihomo REST/WebSocket payloads.
- [x] Add typed error codes shared across process boundaries.
- [x] Add unit-test fixtures for valid, missing and forward-compatible API fields.
- [x] Add a fake service container for main-process tests.
- [x] Add CI for install, brand check, type check, unit tests and production build.
- [x] Add pull-request template requiring scope, evidence and UI screenshots.

Exit criteria:

- Invalid IPC input cannot reach a service method.
- Unknown upstream response fields do not break parsing.
- Required missing fields produce a typed protocol error.
- CI passes on a clean checkout.

Suggested AI task:

> Complete only Phase 1 from `docs/ROADMAP.md`. Follow `DEVELOPMENT_SAFETY.md`. Use mocks and unit tests; do not start real mihomo or modify networking. Submit one focused commit with test evidence.

## Phase 2 — Kernel lifecycle using a harmless fixture process

Environment: current Mac, safe only with a non-network fixture process.

Entry gate: Phase 1 complete.

- [ ] Define `KernelBinaryResolver`, `KernelConfigStore` and `KernelProcessAdapter` interfaces.
- [ ] Implement lifecycle state transitions and concurrency locking.
- [ ] Add a harmless fixture process that opens no network listener.
- [ ] Implement start, graceful stop, timeout and forced-stop behavior against the fixture.
- [ ] Implement stdout/stderr capture and bounded log rotation.
- [ ] Implement crash detection and capped restart backoff.
- [ ] Emit typed status events to preload and renderer.
- [ ] Add tests for double-start, stop-during-start, crash, failed spawn and stale PID.
- [ ] Keep real binary resolution disabled in development builds.

Exit criteria:

- PID and lifecycle transitions are proven using the fixture process.
- No default command opens a proxy/controller listener.
- No real mihomo binary is downloaded or executed.

## Phase 3 — Mock mihomo transport and Activity integration

Environment: current Mac, safe. In-process mock server only.

Entry gate: Phases 1–2 complete.

- [ ] Implement REST timeout, cancellation and typed HTTP errors.
- [ ] Implement one shared WebSocket transport per stream.
- [ ] Implement reconnect backoff, jitter and listener cleanup.
- [ ] Provide mock `/version`, `/configs`, `/traffic`, `/connections` and `/logs` endpoints.
- [ ] Add `kernelStore`, `runtimeStore`, `trafficStore` and `connectionsStore`.
- [ ] Replace Activity fixture values with mock IPC data.
- [ ] Add bounded traffic history and connection aggregation.
- [ ] Add loading, disconnected, empty and malformed-data states without changing geometry.
- [ ] Compare a 934×672 screenshot with the normative HTML reference.

Exit criteria:

- Activity updates once per second from the mock server.
- Reconnect does not duplicate events or leak listeners.
- Screenshot differences are documented and owner-approved.

## Phase 4 — Policies, rules and provider UI with mocks

Environment: current Mac, safe. Mocks only.

Entry gate: Phase 3 complete.

- [x] Implement policy-group and proxy-node stores.
- [x] Implement selection flow with optimistic state and rollback.
- [x] Implement individual and group delay-test states.
- [x] Implement proxy-provider list, refresh and health-check UI.
- [x] Implement rule table, search, sort and counters.
- [x] Implement rule-provider list and refresh UI.
- [x] Percent-encode all dynamic API path segments.
- [x] Add empty, unsupported and partial-capability states.
- [x] Add 934×672 reference screenshots for Policies and Rules.

Exit criteria:

- Mock selection is confirmed by a subsequent mock read.
- Timeout, unavailable node and provider-refresh failures are visible and recoverable.
- Geometry matches the normative reference.

## Phase 5 — Profiles and subscriptions

Environment: current Mac, safe. Filesystem fixtures and mock validation only.

Entry gate: Phase 1 complete; can run in parallel with Phase 4 after contracts stabilize.

- [ ] Define profile metadata, active profile and subscription models.
- [ ] Implement import into an isolated test-data directory.
- [ ] Preserve unsupported YAML keys and comments where feasible.
- [ ] Implement atomic writes using temporary file plus rename.
- [ ] Implement subscription fetch abstraction with credential redaction.
- [ ] Implement validation adapter using a fake validator on this Mac.
- [ ] Implement activation transaction and rollback.
- [ ] Build configuration and provider settings pages from the approved visual language.
- [ ] Add tests for failed fetch, invalid YAML, duplicate name and failed activation.

Exit criteria:

- Failed validation leaves the active profile unchanged.
- Logs never contain subscription credentials.
- Unknown configuration fields survive supported edits.

## Phase 6 — Windows packaging foundation

Environment: disposable Windows VM or CI runner. No network mutation required.

Entry gate: Phases 1–2 complete.

- [ ] Verify x64 build and NSIS installer.
- [ ] Verify arm64 build or explicitly defer it.
- [ ] Add final application icons and Windows metadata.
- [ ] Verify brand-configured product name, executable and protocol scheme.
- [ ] Define stable application-data and migration namespaces.
- [ ] Add uninstall behavior that preserves user profiles by default.
- [ ] Document code-signing inputs without committing secrets.
- [ ] Generate third-party notices and mihomo GPL compliance materials.
- [!] Owner chooses application license before public binary release.

Exit criteria:

- Clean Windows VM can install, launch the UI shell and uninstall it.
- No real kernel starts automatically.
- Installer artifacts contain required notices.

## Phase 7 — Real mihomo integration on isolated Windows

Environment: disposable Windows VM with an independent recovery path.

Entry gate: Phases 1–6 complete and explicit owner authorization for this phase.

- [ ] Resolve a pinned official mihomo release for x64/arm64.
- [ ] Verify release checksum before execution.
- [ ] Generate a random controller secret and localhost-only controller address.
- [ ] Materialize a safe test configuration with `MATCH,DIRECT`.
- [ ] Implement controller readiness using listener check plus `/version`.
- [ ] Integrate real REST and WebSocket transports.
- [ ] Verify graceful stop, crash handling and restart behavior.
- [ ] Verify configuration validation and activation using test profiles only.
- [ ] Record binary path, version, PID, listener and endpoint evidence.

Exit criteria:

- Real kernel lifecycle is proven on isolated Windows.
- The host's normal network path remains unchanged.
- No owner subscription or credential is used.

## Phase 8 — Windows system proxy

Environment: disposable Windows VM with snapshot and rollback.

Entry gate: Phase 7 complete and separate explicit owner authorization.

- [ ] Define owned-state marker and exact previous-state backup.
- [ ] Implement enable, verify, restore and crash recovery.
- [ ] Handle PAC/manual proxy conflicts explicitly.
- [ ] Update Overview switch only after OS verification.
- [ ] Add an emergency restore command independent of the GUI.
- [ ] Test install, enable, crash, relaunch, restore and uninstall sequences.
- [ ] Record before/after registry/settings and effective request-route evidence.

Exit criteria:

- Previous proxy state is restored exactly.
- Emergency restore works when the Electron UI is unavailable.
- A proxy-aware test request proves effective routing.

## Phase 9 — Windows TUN and privileged helper

Environment: disposable Windows VM with snapshot and out-of-band recovery.

Entry gate: Phase 8 complete, design review approved, separate owner authorization.

- [ ] Write and approve helper/privilege threat model.
- [ ] Define install, upgrade, rollback and uninstall behavior.
- [ ] Implement explicit elevation flow.
- [ ] Verify driver/helper signature and binary integrity.
- [ ] Implement TUN configured, starting, active and failed states.
- [ ] Add emergency disable and cleanup path independent of the GUI.
- [ ] Test DNS, IPv4, IPv6, sleep/wake, network change and crash recovery.
- [ ] Record service, route, DNS and non-proxy-aware request evidence.

Exit criteria:

- Transparent capture is proven without losing VM connectivity.
- Disable/uninstall returns routes and DNS to the exact previous state.
- Recovery works after forced process termination.

## Phase 10 — Desktop product features

Environment: Mac for mock UI; Windows VM for OS behavior.

Entry gate: relevant preceding service phase complete.

- [ ] System tray menu and state synchronization.
- [ ] Start-on-login with explicit user opt-in.
- [ ] Connection detail and close actions.
- [ ] Process/device detail panes.
- [ ] Logs viewer, filtering, export and redaction.
- [ ] DNS diagnostic and cache actions.
- [ ] Theme, reduced motion, keyboard navigation and high contrast.
- [ ] About, diagnostics bundle and support links.
- [ ] Application update design with signing and rollback.
- [ ] Kernel update design with pinned channels, checksums and rollback.

Exit criteria:

- Every toggle reflects verified runtime state.
- Accessibility review passes.
- Diagnostics contain no secrets.

## Phase 11 — Release candidate

Environment: clean Windows VMs and designated physical test machine only.

Entry gate: owner selects release scope and license; all included phases complete.

- [ ] Freeze supported feature list and explicitly hide unsupported Surge-like pages.
- [ ] Run clean-install, upgrade and uninstall matrices.
- [ ] Run system proxy and optional TUN recovery matrices.
- [ ] Verify first-launch behavior with no profile and invalid profile.
- [ ] Complete third-party notices and source-offer obligations.
- [ ] Sign installer and binaries.
- [ ] Publish checksums and reproducible release notes.
- [ ] Prepare rollback release and emergency network-recovery instructions.
- [ ] Owner approves final 934×672 screenshots.

Exit criteria:

- No critical recovery, credential, signing or licensing issue remains.
- Release evidence is attached to the version tag.
- Publishing the release receives a final explicit owner confirmation.

## Parallelization rules

- One AI owns one phase or one explicitly bounded item at a time.
- Phases 4 and 5 may run in parallel only after Phase 1 contracts are stable.
- Phase 6 packaging may run alongside mock UI work but cannot publish artifacts.
- Phases 7–9 are sequential and never run on the current Mac.
- UI contributors may work ahead using fixtures, but cannot declare a feature complete before its service phase passes.

## Owner decision backlog

- [ ] Choose the application open-source license.
- [ ] Decide whether Windows arm64 is required for the first release.
- [ ] Decide whether HTTPS decryption and rewrite pages remain visible, experimental or removed.
- [ ] Decide whether TUN is part of v1 or a later release.
- [ ] Choose application and kernel update channels.
- [ ] Provide final icon and brand assets.
