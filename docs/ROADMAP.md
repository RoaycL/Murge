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

Status: complete.

- [x] Define `KernelBinaryResolver`, `KernelConfigStore` and `KernelProcessAdapter` interfaces.
- [x] Implement lifecycle state transitions and concurrency locking.
- [x] Add a harmless fixture process that opens no network listener.
- [x] Implement start, graceful stop, timeout and forced-stop behavior against the fixture.
- [x] Implement stdout/stderr capture and bounded log rotation.
- [x] Implement crash detection and capped restart backoff.
- [x] Emit typed status events to preload and renderer.
- [x] Add tests for double-start, stop-during-start, crash, failed spawn and stale PID.
- [x] Keep real binary resolution disabled in development builds.

Exit criteria:

- PID and lifecycle transitions are proven using the fixture process.
- No default command opens a proxy/controller listener.
- No real mihomo binary is downloaded or executed.

## Phase 3 — Mock mihomo transport and Activity integration

Environment: current Mac, safe. In-process mock server only.

Entry gate: Phases 1–2 complete.

Status: complete, with two scoped carve-outs recorded in `docs/UI_DEBT.md`
(UI-DEBT-004). The P0 streams are fully integrated; the Activity latency card and
hourly-traffic bars remain static placeholders because their data sources (a
routing/DNS latency probe and durable sampled traffic history) are not part of
Phase 3's stream scope.

- [x] Implement REST timeout, cancellation and typed HTTP errors.
- [x] Implement one shared WebSocket transport per stream.
- [x] Implement reconnect backoff, jitter and listener cleanup.
- [x] Provide mock `/version`, `/configs`, `/traffic`, `/connections` and `/logs` endpoints.
- [x] Add `kernelStore`, `runtimeStore`, `trafficStore` and `connectionsStore`.
- [x] Replace Activity fixture values with mock IPC data. *(Speed cards, active
      connections, process/domain ranking and the 总计 breakdown are live. The
      latency card, hourly bars and the DHCP figure stay hardcoded — UI-DEBT-004.)*
- [x] Add bounded traffic history and connection aggregation.
- [x] Add loading, disconnected, empty and malformed-data states without changing geometry.
      *(Traffic and connections surface loading/disconnected/error; the two
      placeholder cards above have no live state to reflect yet — UI-DEBT-004.)*
- [x] Compare a 934×672 screenshot with the normative HTML reference.

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

- [x] Mock selection is confirmed by a subsequent mock read.
  - Verified by `tests/policies-selection.integration.test.ts`: a real
    `MihomoClient` against the mock controller, so a rapid B→C selection is
    read back from the controller (`group.now`) and confirmed against the store.
  - Also covered at the store level by `tests/policies-store.test.ts`
    (confirm-controller, serialize-rapid, supersede and recoverable-mismatch).
- [x] Timeout, unavailable node and provider-refresh failures are visible and recoverable.
  - Verified by `tests/policies-store.test.ts` (recoverable `panelError` on a
    controller mismatch) and `tests/providers-store.test.ts` (a failed reload
    surfaces a per-row error while preserving the last good data; a recorded
    `delay === 0` is rendered as unavailable, never 0ms).
- [ ] Geometry matches the normative reference.
  - Pending; tracked as UI pixel-diff debt in `docs/UI_DEBT.md` until the final
    unified alignment pass.

## Phase 5 — Profiles and subscriptions

Environment: current Mac, safe. Filesystem fixtures and mock validation only.

Entry gate: Phase 1 complete; can run in parallel with Phase 4 after contracts stabilize.

- [x] Define profile metadata, active profile and subscription models.
- [x] Implement import into an isolated test-data directory.
- [x] Preserve unsupported YAML keys and comments where feasible.
- [x] Implement atomic writes using temporary file plus rename.
- [x] Implement subscription fetch abstraction with credential redaction.
- [x] Implement validation adapter using a fake validator on this Mac.
- [x] Implement activation transaction and rollback.
- [x] Build configuration and provider settings pages from the approved visual language.
- [x] Add tests for failed fetch, invalid YAML, duplicate name and failed activation.

Exit criteria:

- Failed validation leaves the active profile unchanged.
- Logs never contain subscription credentials.
- Unknown configuration fields survive supported edits.

## Phase 6 — Windows packaging foundation

Environment: disposable Windows VM or CI runner. No network mutation required.

Entry gate: Phases 1–2 complete.

- [x] Verify x64 build and NSIS installer. (The `package-win` Windows CI job installs the NSIS installer, launches a `--packaging-smoke` production probe, asserts exit 0 and no real kernel/controller listener, then uninstalls and confirms user profiles survive. Observed green on a real Windows runner — CI run [33047258615](https://github.com/RoaycL/Murge/actions/runs/33047258615), Windows job `98434183222` — producing `Murge-Setup-0.1.0-x64.exe` and `Murge-Setup-0.1.0-arm64.exe`; arm64 is packaging-only with runtime verification explicitly deferred to the Windows VM. This run also shipped the transactional, marker-based legacy-data migration.)
- [x] Verify arm64 build or explicitly defer it. (Packaging strategy A: exactly two per-arch installers, x64 + arm64, never a combined multi-arch artifact. arm64 runtime verification is deferred to the Windows VM.)
- [x] Add final application icons and Windows metadata.
- [x] Verify brand-configured product name, executable and protocol scheme. (Wired via `brand.*` and covered by a builder-config test; runtime deep-link registration is Phase 7.)
- [x] Define stable application-data and migration namespaces. (The namespace is derived from `appId`, never the cosmetic product name, and legacy data is imported through a transactional staging + `migration-state.json` marker flow: a full copy Staged into a sibling directory, committed with an explicit no-overwrite conflict policy, and recoverable on the next launch after a partial failure.)
- [x] Migrate legacy data without a filename whitelist. (Whether a namespace still needs importing is decided by the migration marker and version, not by judging which files the target already holds, so Chromium runtime files — `Preferences`, `Local State`, `Local Storage` — never suppress the import; the marker is written atomically and existing newer profiles are never overwritten.)
- [x] Add uninstall behavior that preserves user profiles by default.
- [x] Document code-signing inputs without committing secrets.
- [x] Generate third-party notices and mihomo GPL compliance materials. (Placeholders removed; the every-bundled-dependency license text is retained under `licenses/` and bundled into the artifact alongside `THIRD_PARTY_NOTICES.md`, asserted by the `package-win` artifact check and the `third-party-notices` unit test.)
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
