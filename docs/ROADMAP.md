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
- [x] Owner chose GPL-3.0-only for the application before public binary release;
  the complete license is retained in the repository and installed artifact,
  with a fail-closed release check for the SPDX identifier and license text.

Exit criteria:

- Clean Windows VM can install, launch the UI shell and uninstall it.
- No real kernel starts automatically.
- Installer artifacts contain required notices.

## Phase 7 — Real mihomo integration on isolated Windows

Environment: disposable Windows VM with an independent recovery path.

Entry gate: Phases 1–6 complete and explicit owner authorization for this phase.

Status: complete. The real lifecycle remains opt-in: the installer carries the
architecture-matched official archive, while verification, extraction and spawn
begin exclusively in response to the renderer's `kernel:start` action. First
launch therefore does not depend on GitHub availability.

Step B (Win x64 real mihomo on the disposable Windows CI job) has now executed
multiple times — the two latest green runs (fault-injection step verified):
- <https://github.com/RoaycL/Murge/actions/runs/33058910851/job/98472683074> (HEAD `7bc55fe`)
- <https://github.com/RoaycL/Murge/actions/runs/33056173514/job/98463535723>

- [x] Resolve a pinned official mihomo release (v1.19.30) for win32/x64, win32/arm64 and linux/arm64. (Step A: `src/main/kernel/mihomo-artifact.ts`; the catalog holds only digest-verified platforms, others resolve to `UNSUPPORTED`. Platform triage: **Win x64** = runtime verified in the disposable Windows CI job; **Win arm64** = official asset + digest verification implemented, runtime verification explicitly deferred (packaging-only for now, never substituted with the linux/arm64 build); **Linux arm64** = server/dev-only support, not a Windows-arm64 delivery.)
- [x] Verify release checksum before execution. (Step A: streaming SHA-256 against the pinned digest AND the pinned byte size; a mismatch/truncation is rejected as `ARTIFACT_HASH_MISMATCH` with no file retained. Provenance is recorded in a structured `MihomoVerifiedMarker` holding version, archive SHA-256, binary SHA-256, platform, arch; the binary is re-hashed before every reuse and a tampered, truncated, forged or mismatched binary is quarantined and re-downloaded + re-extracted from a fresh verified archive.)
- [x] Generate a random controller secret and localhost-only controller address. (Step A: `randomSecret(32)` → 64-hex; the secret must match `/^[0-9a-f]{64}$/` and is redacted by `sanitizeMihomoConfig` so it never leaks to logs/evidence.)
- [x] Materialize a safe test configuration with `MATCH,DIRECT`. (Step A: `mihomo-config-store` validates with a real YAML parser against an exact top-level allowlist `{mixed-port, allow-lan, mode, log-level, ipv6, external-controller, secret, tun, dns, rules}`; `tun`/`dns` may only be `enable:false`, `rules` must be exactly `MATCH,DIRECT`, ports are restricted to 1024–65535, and duplicate keys, aliases, tags, composite keys and complex objects are rejected.)
- [x] Implement controller readiness using a listener check plus `/version`. (Step A: bounded supervisor + `MihomoClient.getVersion()`; the real test polls `/version` and asserts the controller and the mixed port each have at least one loopback listener, failing closed when tooling is unavailable.)
- [x] Integrate real REST and WebSocket transports. (Production uses a random authenticated loopback controller; push streams never bind or alter host networking.)
- [x] Verify graceful stop, crash handling and restart behavior. (component/CI-level via a gated real test that stops/restarts with a fresh PID AND a dedicated Windows fault-injection step that orphans a watchdog-restarted kernel and proves the shared `scripts/kernel-watchdog-cleanup.mjs` reaps it; production lifecycle wiring deferred.)
- [x] Verify configuration validation and activation using test profiles only. (The production lifecycle starts from the separately validated safe-direct config; applying arbitrary owner profiles to the live kernel remains outside this isolated phase.)
- [x] Record binary path, version, PID, listener and endpoint evidence. (The real integration test now writes the resolved binary path, mihomo version, PID, both listener host:port, the `/version` result and the network-diff PASS into the evidence artifact — never the controller secret. Verified against the `kernel-real-evidence` artifact of run `33058910851`.)
- [x] Add a host-level before/after network-integrity snapshot and a `finally` cleanup/watchdog in the Windows job. (The real test differs a host network snapshot before/after, and the `if: always()` finally step now calls the shared `scripts/kernel-watchdog-cleanup.mjs`.)
- [x] Fault-inject a watchdog restart and prove external cleanup. (The Windows job adds a dedicated crash-orphan step: it starts a real mihomo, triggers a watchdog restart, records the recovered PID, then SIGKILLs its own worker WITHOUT calling `supervisor.stop()`. Because a Windows child survives its parent only when detached, the test uses a test-only `DetachedKernelProcessAdapter` so the restarted kernel is genuinely orphaned; it then runs the EXACT same `scripts/kernel-watchdog-cleanup.mjs` and asserts that script reaped a live recorded PID (`stopping recorded PID X`), released both ports and removed the leftover workspace. This closes the acceptance gap where a green run's `finally` never exercised the find-and-kill branch because the test process had already exited.)
- [x] Harden the shared watchdog cleanup to fail closed. (`scripts/kernel-watchdog-cleanup.mjs` now infuses the real/fault-injection runs against a missing, corrupt or field-incomplete evidence file under `--require-evidence` (used by both the `if: always()` finally step and the fault-injection step) while STILL sweeping and proving-free any residual mihomo on the disposable runner; `tasklist`/`ps`/`netstat`/`ss` probe failures or blank/unparseable output THROW instead of reporting "no residual"/"released"; and a live recorded PID is killed only after the OS confirms its identity is still `mihomo`/`mihomo.exe` (never a recycled/unrelated PID). The real integration test's final enriched evidence write is now awaited (no swallowed error) and re-read with a full field-by-field assertion.)
- [x] Strictly validate evidence and never let a crafted path widen the `rm` scope. (`scripts/kernel-watchdog-cleanup.mjs` adds `validateEvidenceSchema`, checked in `--require-evidence` mode BEFORE any directory removal: `pid` must be a positive integer, both ports distinct integers in 1024–65535, `workspace`/`configDir` absolute non-root paths with a `mihomo-real-*`/`mihomo-cleanup-fault-*` basename and `configDir` contained within `workspace`, and `--allowed-workspace-roots` (passed by CI as the runner's temp dir i.e. `$env:TEMP`/`$env:TMP`) requires the workspace to resolve inside an allowed root — so `/`, a disk root, a parent/relative path or an escaped `configDir` is rejected and the directory is NEVER removed. On a path problem the script still enumerates and reaps residual mihomo by exact name but performs no deletion, and `--require-evidence` fails the run. Malicious/out-of-root-path tests prove the sentinel workspace survives.)
- [x] Match mihomo processes only by exact name. (The residual-process sweep in `scripts/kernel-watchdog-cleanup.mjs` now uses the strict `isMihomoName` (`mihomo`/`mihomo.exe`, case-insensitive) in both the Windows `tasklist` and Unix `ps` branches instead of a `/^mihomo/i` prefix, so an approximate name such as `mihomo-helper.exe`, `mihomo-ui.exe`, `mihomo.old` or `not-mihomo` is never enumerated or signalled. And when the recorded `binaryPath` basename mismatches the observed process name, the recorded PID is treated as stale/reused — it is NOT killed by recorded PID (the exact-name sweep may still clean a real residual), instead of the old warn-then-kill.)
- [x] Block symlink/junction/reparse-point escape from the `rm` scope. (Lexical `resolve`/`relative` cannot prove the ACTUAL filesystem target stays inside an allowed root, so `scripts/kernel-watchdog-cleanup.mjs` adds `validateEvidencePaths`: it `lstat`s `workspace`/`configDir` so a symbolic link / junction / reparse point is rejected rather than descended, and `realpath`s them plus every `--allowed-workspace-roots` entry to prove the resolved target stays inside an allowed root (defense-in-depth even when `lstat` does not flag the link). Each `mihomo-workspace-*` child is `lstat`ed before deletion and, when it is a link, only the link itself is `unlink`ed — never recursed into. A path that does not exist (ENOENT) is not a problem (nothing to delete so no escape), which is the normal case since the real-kernel test's own afterEach removes its workspace before the CI `finally` cleanup runs. On any real-path problem the script still sweeps residual mihomo by exact name but performs no directory removal, and `--require-evidence` fails. Real-filesystem tests create a junction target outside the allowed root and prove the external sentinel survives for a symlinked `workspace`, a symlinked `configDir` and a symlinked `mihomo-workspace-*` child, while a normal real workspace still cleans end to end. These run under vitest on the ubuntu `verify` job, and the `kernel-real-windows` job re-runs the same assertions via the standalone `node scripts/kernel-watchdog-symlink-escape.check.mjs` — Node's native ESM loader imports the shared `.mjs` on Windows, which vitest's Windows transform cannot do — so the junction/reparse-point behavior is exercised on the actual Windows FS.)
- [x] Wire the production kernel lifecycle to an explicit user-triggered action. (Overview calls `kernel:start`; packaged Windows resolves and spawns only from that IPC action, waits for authenticated `/version`, and stops the half-ready process on timeout.)

> Real mihomo execution evidence remains confined to disposable Windows CI/VM.
> The production composition is now complete, but this Mac still never launches
> the binary during development or verification.

Exit criteria:

- Real kernel lifecycle is proven on isolated Windows (Step B).
- The host's normal network path remains unchanged.
- No owner subscription or credential is used.

## Phase 8 — Windows system proxy

Environment: disposable Windows VM with snapshot and rollback.

Entry gate: Phase 7 complete and separate explicit owner authorization.

Status: **complete and verified** at commit `2409cff`, scope-limited to the per-user HKCU Internet
Settings key. On every other OS (and on any non-win32 production build) the
feature fails closed: the adapter reports `unsupported`, the main process exposes
a disabled state and the Overview switch is disabled. On win32 the main process is
the single source of truth (`SystemProxyService`), so nothing is optimistic — the
registry is only written after a kernel probe confirms the loopback mixed-port is
reachable, and the exact previous values are backed up BEFORE any write so an
orphaned enable is recoverable.

The real enable/restore path runs only on a disposable Windows GitHub Actions
runner, gated inside the test by `MURGE_RUN_REAL_SYSTEM_PROXY=1` + `win32` (the
test skips in the normal `npm test`). It writes the three HKCU values, proves via a
host `NetworkSnapshot` that ONLY the HKCU Internet Settings proxy field changed
(WinHTTP, default routes, DNS, adapters and firewall profiles stay byte-identical),
then restores the exact original values in a `finally` block — so a failing
assertion can never leave the host proxy changed. The final acceptance run is
[GitHub Actions 33244865437](https://github.com/RoaycL/Murge/actions/runs/33244865437):
all four jobs passed, including the packaged Windows installer lifecycle, real
mihomo lifecycle, real HKCU enable/restore and the external `if: always()` recovery
check. The installed-artifact smoke also starts the bundled kernel, reads the live
mixed-port and verifies its HTTP CONNECT and SOCKS5 surfaces over loopback before
enabling the proxy. No owner traffic or credential is used.

- [x] Define owned-state marker and exact previous-state backup. (`src/main/system-proxy/{policy,backup-store}.ts`: `buildWrittenState`/`isOwned`/`matchesPrevious` define ownership as all three keys exactly matching the written target; the backup is written atomically (temp+rename) BEFORE any registry change, keyed by schema version, so a crash right after `enable()` is recoverable from the committed backup.)
- [x] Implement enable, verify, restore and crash recovery. (`src/main/system-proxy/service.ts`: serialized enable/disable/restore, `init()` orphan recovery, `restoreBeforeKernelUnavailable()`; the ordered kernel gateway restores before stopping the kernel so proxy state is never left dangling when the kernel becomes unavailable.)
- [x] Handle PAC/manual proxy conflicts explicitly. (External modification of an owned value or a conflicting existing proxy surfaces `SYSTEM_PROXY_STATE_CONFLICT` with a structured `conflictDetail`; no mutation is performed on a conflict.)
- [x] Update Overview switch only after OS verification. (The UI reads the main-process `status` and never flips optimistically: the switch is driven by the verified `phase`, with a busy state while the main process acts.)
- [x] Add an emergency restore command independent of the GUI. (`SystemProxyOrderedKernelGateway.stop()` and the main-process `before-quit` both call `restoreBeforeKernelUnavailable()` in the main process, so proxy state is reverted even if the renderer is unresponsive. A dedicated standalone CLI is not in scope; the Phase 11 recovery matrix exercises the main-process path.)
- [x] Test install, enable, crash, relaunch, restore and uninstall sequences. (Unit/component coverage in `tests/system-proxy-*.test.ts`; the gated real test `tests/system-proxy-real.integration.test.ts` covers enable/verify/restore on the real HKCU key; install/launch/uninstall is covered by the existing Windows installer smoke-test job.)
- [x] Record before/after registry/settings evidence. (`tests/system-proxy-real.integration.test.ts` diffs the registry values plus a host `NetworkSnapshot` before/after. Effective request-route evidence via an actual proxy-aware request is out of scope for this phase.)

Exit criteria:

- Previous proxy state is restored exactly. (Proved by the real test: `after === before` on the registry values and the full host network snapshot.)
- Emergency restore works when the Electron UI is unavailable. (Main-process `before-quit` plus the ordered kernel gateway restore path; renderer-independent.)
- The live mixed-port is protocol-probed before takeover. (Satisfied by the
  packaged Windows acceptance path using loopback-only HTTP CONNECT and SOCKS5
  probes. End-to-end destination routing remains intentionally deferred to the
  later network recovery/release matrix and is not a Phase 8 completion blocker.)

## Phase 9 — Windows TUN and privileged helper

> **Phase 9B decision (2026-08-30):** the implementation direction is now
> `docs/phase9b-mihomo-owned-tun.md`. Mihomo is the sole owner of Wintun,
> routes and DNS; the privileged service only verifies, starts, stops and
> supervises the fixed packaged mihomo. The helper-created-adapter/G1-reuse
> design below is retained as a historical audit trail and is no longer an
> implementation gate or production path.
>
> Phase 9B non-network implementation now includes the exact TUN profile
> generator/validator, renderer-safe v2 intent, digest-bound privileged service
> protocol, single-owned-session client, readiness/rollback lifecycle adapter,
> and unit tests. The Electron bridge and native Windows service remain gated
> until that service is compiled and its ACL/installer lifecycle is reviewed.
> Runtime completion still requires the isolated Windows evidence matrix in the
> Phase 9B decision; tests on macOS/Linux cannot mark TUN runtime complete.
>
> **Implementation update:** the Go Windows Service, owner-SID Named Pipe,
> archive/core integrity checks, PID reconciliation, fail-closed installer
> lifecycle, Electron IPC/preload/store/UI wiring and x64/arm64 CI build are now
> implemented. GitHub-hosted packaging verifies only the idle service lifecycle;
> it deliberately does not enable TUN. The isolated Windows runtime evidence
> gate remains open.

Environment: disposable Windows VM with snapshot and out-of-band recovery.

Entry gate: Phase 8 complete, design review approved, separate owner authorization.

Status: in progress — design-review package revised to **rev.8** per the **round-3** through **round-8** review items. Round-3 items 1–4 retained: (1) Wintun ABI corrected verbatim from the official `wintun.h` (pinned **0.14.1**, per-arch DLL, `WINAPI`, recorded exports/header source) — `WintunCreateAdapter(Name, TunnelType, RequestedGUID) -> handle` with the app-supplied `RequestedGUID` as a stable identity, `WintunGetAdapterLUID(h,&luid)`, `WintunStartSession(h,capacity)` creates the session; (2) elevation rewritten to the official **COM Elevation Moniker**; (3) client PID fixed to `RPC_CALL_ATTRIBUTES_V2.ClientPID` + `ncalrpc`-only; (4) a **true write-ahead journal** (PREPARED→mutate→APPLIED, reconcile PREPARED-but-unknown by `WintunOpenAdapter(Name)` + identity; the earlier 'enumerate the product adapter' phrasing corrected in round-4). **Round-4 items corrected this revision:** (5) **removed the nonexistent `WintunDeleteAdapter` / `RebootRequired`→`delete-pending` / explicit-adapter-deletion semantics**; the official **0.14.1 `wintun.h` is the ONLY ABI source**, and the only removal operation is **`WintunCloseAdapter(creatorHandle)`** (which 'removes adapter' for a create-created adapter); `WintunDeleteDriver` is exported but production policy **forbids** calling it; there is **no `WintunFreeSendPacket`**; (6) the **helper lifecycle is unified to one per-enable resident model** (round-5): the helper is a **per-enable single-client resident server** whose process lifetime is **bound to the enabled TUN window** (it holds the creator handle and runs **resident-active**), served by the **same instance** for enable and disable — **not** a short-lived transaction server; the **G1 lifecycle probe** (a create+hold creator handle → b mihomo `WintunOpenAdapter`+`StartSession` → c helper closes creator handle/exits → d observe whether session+adapter persist) now records an **Observed A/B** that does **not** change this fixed baseline; (7) COM elevation **`Elevation\Enabled` = REG_DWORD `1`** (not string `'Enabled'`), **`ThreadingModel` removed**, **bitness/WOW64 registration location** via the **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY` flags** (amd64/arm64-only ⇒ **no 32-bit COM helper** registered); the **state machine + tests** were expanded with the **resident-active** state and the **app/mihomo/helper crash**, **same-PID disable** and **no-old-creator-handle** cases (round-5); (8) **export table = verbatim 0.14.1 `Wintun_*_FUNC` set** incl. `WintunOpenAdapter`, `WintunGetRunningDriverVersion`, `WintunSetLogger`, and exported-but-forbidden `WintunDeleteDriver`; **build-time dumpbin/GetProcAddress ABI check** added; (9) **G1 stays a hard pre-implementation gate**, now the **G1 lifecycle probe** run only through the separately authorized G1 workflow on a snapshot-able self-hosted Windows lab on a snapshot-able, out-of-band-recoverable Windows VM with separate owner authorization — **never on this dev machine**. **Round-6 security blockers applied (rev.6).** (a) COM ACL/SDDL is a **pure allow-list** with **explicit COM rights masks** — `LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)` (`0xB` = EXECUTE|EXECUTE_LOCAL|ACTIVATE_LOCAL), `AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)` (`0x3` = EXECUTE|EXECUTE_LOCAL); **no** `DENY Everyone`/`DENY built-in Users`, **no** `Everyone`/`Users`/`Authenticated Users`, and **no `DENY` at all** (a complete allow-list denies by absence); a **per-ACE table** (object SID / allow-deny / COM rights mask) and **`AccessCheck` + descriptor-build verification** (design doc §5.1, tests `T24`, `T32`–`T40`). (b) The **trusted recovery state** lives in `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\` (design doc §8.0): created by the **elevated helper**, owner = SYSTEM, **resolvable pure allow-list SDDL** `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)` (**no owner-SID file ACE** — the Medium surface has no raw read; the helper reaches it via `BA` since it runs elevated as an admin, and the Medium token has `BA` deny-only + no owner ACE), **`High` mandatory-integrity label** (`NO_WRITE_UP`, `HI` = `S-1-16-12288`) — the real same-user boundary, since the helper and the Medium UI share one SID and the DACL + missing owner ACE split them; the owner UI reads **sanitized** state **only** via helper COM (never raw baseline/journal); each file opened with `FILE_FLAG_OPEN_REPARSE_POINT` + reject-reparse-point + held-handle `FileIdInfo` re-verify + temp/`FlushFileBuffers`/`ReplaceFile` atomic rename; **never** follows a user-controllable path; upgrade/uninstall retain the dir until a safe recovery completes. (c) **Integrity is deterministic** (C12): the boundary is the **DACL + integrity label** (Medium cannot write the store), not a digest a same-user attacker could re-write; records still carry `schemaVersion` + SHA-256 to detect **corruption**; the former **"HMAC/digest or at least digest" claim is removed** (no false guarantee). (d) The **WAL defends against directory substitution** (design doc §8.0/§8.3): startup validates dir owner/DACL/reparse; before each `PREPARED`/`APPLIED`/`RECONCILED` append the open handle's file ID is re-verified (no string-path re-open); any anomaly ⇒ **zero network mutation** + `restore-failed` (tests `T25`–`T30`, install-doc round-6 tests). **Round-8 descriptor API/persistence and restricted-token corrections applied (rev.8) — re-review requested.** **Implementation gate still NOT met** (design-review sign-off + separate owner authorization still required, plus G1 (unproven; Observed A/B to be recorded by the probe) and the certificate-provider decision).

- [~] Write and approve helper/privilege threat model. (draft → `docs/helper-threat-model.md`; revised per the **round-3** + **round-4** review items: device model = driver installed/loaded inside `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`, no separate load step; C3 rewritten as the **COM elevation-moniker** bootstrap with `CoGetObject("Elevation:Administrator!new:{CLSID}")` + `Elevation\Enabled = REG_DWORD 1` (no `ThreadingModel`), `RunAs = "Interactive User"`, `ClientPID` + `RPC_QUERY_CLIENT_PID` + `ncalrpc`-only, and the **per-enable single-client resident server** (process lifetime bound to the enabled TUN window, holding the creator handle for the whole window; round-5); C4 updated to a **write-ahead** journal (CREATE_ADAPTER/PREPARED fsync'd before create, reconcile PREPARED-but-unknown by `WintunOpenAdapter(Name)` + identity); C5 updated to the real 0.14.1 lifecycle — adapter removed **only** by `WintunCloseAdapter(creatorHandle)`, no `WintunDeleteAdapter`/`RebootRequired`/`delete-pending`, `WintunDeleteDriver` never called; single OS-config owner D6 (Option A); G1 outlined as the unproven **G1 lifecycle probe** (Observed A/B; the resident baseline is fixed)); **round-6**: C12 rewritten to the **deterministic integrity contract** (store DACL + `High` mandatory label are the boundary — a same-user Medium attacker cannot write the store, only the High helper can; `schemaVersion`+SHA-256 detect corruption only; the former **“HMAC/digest or at least digest” claim removed**; tamper/corruption ⇒ fail closed), and C2/C3 harmonized to the **pure allow-list** DACL with **explicit COM rights masks** `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)` (launch) / `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)` (access), **no** `DENY Everyone`/`DENY Users`, no Everyone/Users/AuthUsers, and **no `DENY` at all** (deny-by-absence), `AccessCheck`-verified; approval pending)
- [~] Define install, upgrade, rollback and uninstall behavior. (draft → `docs/helper-install-upgrade-rollback.md`; revised per the **round-3** + **round-4** review items: adapter/driver created at first enable via the corrected `WintunCreateAdapter(...RequestedGUID)` ABI, no `load_driver` op; **write-ahead** enable order (PREPARED→APPLIED); **disable closes the creator handle via `WintunCloseAdapter`** (the only removal path) — no `DELETE_ADAPTER`/`WintunDeleteAdapter`/`RebootRequired`/`delete-pending`; mihomo adds no route/DNS; uninstall never removes a shipped/pre-existing driver **or a pre-existing adapter**; expanded test map (**G1 lifecycle probe**, second-Murge-instance race, WAL crash boundaries, creator-handle-close removal)); **round-6**: the **trusted state store** (`%ProgramData%\<id>\tun-state\<ownerSid>\`) is created/validated by the elevated helper at first enable and the store is **retained on upgrade/uninstall until a safe recovery completes**; the **descriptor-build** tests (`ConvertStringSecurityDescriptorToSecurityDescriptor` already returns `SE_SELF_RELATIVE`; COM-only `REG_BINARY` byte round-trip; state-dir apply/readback via filesystem security APIs; `AccessCheck` Launch and Access owner=allow / second-user=deny / SYSTEM=allow; COM mask equality `0xB`/`0x3` + `0x1`; state-dir `High` `NO_WRITE_UP` label; Medium-write-fails/High restricted helper with enabled non-deny-only `BA` succeeds) plus the COM `AccessCheck`, state-store owner/DACL/reparse, WAL handle file-ID re-verify, journal schema/digest anomaly, Medium-vs-High MIC-blocking and uninstall-retains-store tests are added; approval pending)
- [~] Design review package. (draft → `docs/helper-design.md`: shared TUN contract, §3.0 **pinned Wintun 0.14.1 ABI** = verbatim `Wintun_*_FUNC` set incl. `WintunOpenAdapter`/`WintunCloseAdapter`/`WintunDeleteDriver`(forbidden)/`WintunGetRunningDriverVersion`/`WintunSetLogger`, + **build-time dumpbin/GetProcAddress ABI check**; **no `WintunDeleteAdapter`/`WintunFreeSendPacket`**), §3.2 creation with `RequestedGUID` identity, §3.3 **creator-handle lifecycle + G1 lifecycle probe** (Observed A/B; the fixed baseline = helper holds the creator handle for the whole enable window) + new §3.4 **resident-active lifetime / emergency restore / helper-crash recovery**, §5.1 elevation-moniker registration (`Elevation\Enabled=REG_DWORD 1`, no `ThreadingModel`, WOW64 via the `KEY_WOW64_*KEY` flags (amd64/arm64-only ⇒ **no 32-bit COM helper**)), §5.5 **per-enable single-client resident server** (exhaustive 5-exit-condition list, no idle exit; round-5), **write-ahead journal** + reconcile-PREPARED-but-unknown by `WintunOpenAdapter(Name)` + identity (§8.3–§8.5), single OS-config owner `DesiredNetworkState`, fixed types, unified TUN state machine, config-gating design, renderer intent-only contract, module layout, expanded test/evidence matrix (**G1 lifecycle probe**, second-instance race, WAL boundaries, `CLOSE_CREATOR_HANDLE` removal); D4 resolved no-auto-start; D5 resolved never-remove-pre-existing/shared; G1 + certificate provider still open — **implementation gate NOT met**); **round-6**: §5.1 rewritten to a **pure allow-list** COM ACL/SDDL with **explicit COM rights masks** (`LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`, `AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`, **no** `DENY`) + **per-ACE table**, with **`AccessCheck` + descriptor-build** verification (tests `T24`, `T32`–`T40`); new §8.0 **Trusted state storage, integrity and WAL directory defense** — the `%ProgramData%\<id>\tun-state\<ownerSid>\` store (owner SYSTEM, pure allow-list DACL, **`High` mandatory label** = the real same-user boundary, sanitized helper-COM read only, `FILE_FLAG_OPEN_REPARSE_POINT` + reject-reparse-point + held-handle `FileIdInfo` re-verify + temp/`FlushFileBuffers`/`ReplaceFile` atomic rename, never follow a user path, upgrade/uninstall retain) and the **deterministic integrity contract** (DACL/integrity label primary; `schemaVersion`+SHA-256 for corruption only; **HMAC language removed**; fail-closed `restore-failed`); §8.3 WAL now **defends against directory substitution**; §13 expanded with round-6 tests **T24–T31** and the round-8-corrected tests **T32–T40** (`ConvertString…` return-form validation; COM-only `REG_BINARY` round-trip; filesystem-security state-dir readback; AccessCheck matrices including SYSTEM on Access; COM masks; `High` label; Medium denied/High restricted helper with enabled non-deny-only `BA` allowed). **Implementation gate still NOT met** (needs design-review sign-off + separate owner authorization; G1 (Observed A/B pending) and certificate provider still OPEN).)
- [x] Implement **non-network Phase 9 foundation contracts only**: shared `TunPhase`/`TunStatus`/`DesiredNetworkState` + runtime schemas; pure reviewed transition function; exact SDDL source-contract builder; bounded machine-code-only in-memory audit log; reserved typed IPC names + typed TUN protocol errors; unit/static tests proving these modules contain no process spawn, Wintun, COM elevation, network or OS-mutation calls. This does **not** satisfy or bypass the implementation gate; the reserved IPC names are deliberately not registered in Electron handlers/preload.
- [x] Implement the **non-transport helper envelope security layer**: fixed operation allowlist, exact envelope fields, 4 KiB canonical sorted-key JSON payload, length-prefixed HMAC-SHA256 with an 8-byte big-endian uint64 request ID, strict monotonic replay rejection, HKDF role separation and launch/session-key zeroization. Every operation has a strict payload schema: five read/recovery intents accept only `null`, adapter creation/close accept only canonical identity fields, and `apply_network_state` reuses the strict `DesiredNetworkState` schema; arbitrary paths, commands and unknown keys are rejected before replay state advances. It is an in-memory protocol primitive only: no COM transport, helper command implementation, renderer bridge or OS mutation is present.
- [x] Harden the pure `DesiredNetworkState` ownership invariants: reject control characters in adapter identity, exact duplicate routes, duplicate DNS/metric LUID targets, duplicate DNS servers and a single intent targeting more than one adapter LUID. This prevents ambiguous apply/rollback ownership before a privileged adapter exists; no OS API is involved.
- [x] Pin and audit the official **Wintun 0.14.1 SDK without creating an adapter**: official archive/header/amd64/arm64 DLL SHA-256 values are recorded; a Windows-hosted read-only job downloads and verifies the release, compiles `native/wintun-abi-audit/abi-audit.cpp` directly against the verified official `wintun.h`, checks native layouts/calling-convention types, and resolves every expected export without invoking any Wintun function. This supersedes the older scaffold wording that called the manifest unpopulated; it does not provide the G1 binding and does not satisfy the execution gate.
- [x] Resolve **D4/D5** and scaffold the **non-executable G1 gate**: no helper boot auto-start; never delete pre-existing/shared Wintun driver or adapters; manual workflow requires an exact acknowledgement, authorization/asset/snapshot/recovery identifiers, protected `phase9-tun-lab` approval and a `murge-tun-lab` self-hosted Windows runner. The checked-in gate supports `--validate-only`, emits `probeExecuted:false`, and refuses every execution mode; it performs no Wintun/network action.
- [x] Implement the **G1 probe execution body + test framework** (scaffold **complete, not executed**). The pure step a–j orchestrator (`src/main/tun/g1-probe.ts`) drives an **injected driver**; the **real driver** (`src/main/tun/g1-driver.ts`) fails closed to `unsupported` — the pinned Wintun manifest digest is intentionally **unpopulated** and there is **no bundled native binding**, so no Wintun DLL is ever loaded and no mihomo is ever spawned; a standalone gated `--execute-g1-probe` entry (`src/main/tun/g1-probe-runner.ts`) plus a **validation-only** workflow that refuses execution; and pure unit tests against a **fake driver** covering every hard gate denial, the a–j lifecycle, the **strict Name+GUID+LUID identity-match cleanup rule** and every a–j fault boundary (each triggering the finally-cleanup). **G1 remains UNEXECUTED and UNPROVEN**, and the **implementation gate is NOT met**: the probe has never been run on a real Windows lab, the pinned digest is unpopulated and there is no native integration. The real probe is **not wired into** the app shell, preload or IPC layer, and default `npm test`/`npm run build` never loads the DLL, spawns mihomo or touches routes/DNS/system proxy/firewall. **Implementation re-review round-1 (in progress):** the G1 execution skeleton was reworked per the round-1 reviewer's 6 P1 items + a set of bonus fixes — corrected observation order (Observed B is only valid once the creator handle is closed AND the mihomo session is still active); the exact creator-handle lifecycle (the handle is an opaque native pointer; `WintunCloseAdapter` is always passed the *exact* handle that `WintunCreateAdapter` returned, closed at most once, cleared immediately after a successful close); removal of the wrong **"TS types = verbatim ABI"** contract (the official `wintun.h` is pinned; `HANDLE`/`NET_LUID`/`GUID`/`WINAPI` are handled only at the C/C++/Rust native boundary; TS exposes a high-level opaque interface; native compile-time signature/export-symbol checks; `unsupported` retained until a real binding lands); the mihomo probe config (official `auto-route:false`/`auto-detect-interface:false`/`strict-route:false`/`device:<probe adapter>`/`dns.enable:false`/`allow-lan:false`, no invalid top-level `inbound`; config is generated → validated through the repo mihomo config validator + strict G1 validator + parse-back field assert before mihomo starts; `device` only names the NIC and does **not** prove reuse of the helper Wintun instance, so **G1 stays UNPROVEN**); the `finally` must independently stop mihomo (bounded graceful stop, then terminate the exact recorded PID / ChildProcess, wait + verify exit, then read the creator handle's live identity and only close the exact handle on a strict match); a **conflict pre-check before creation** (read-only enumerate same-name adapter, same RequestedGUID, probe-name prefix, leftover previous-round probe resources; on any hit exit with zero change and record the conflict); orchestrator-controlled per-step timeouts; evidence written only into a verified dedicated evidence dir with exclusive create, rejecting reparse/symlink, absolute-path escape and overwrite; exception evidence retains the already-verified DLL digest; accurate error-code mapping (`unsupported`/`timeout`/`identity-conflict`); fault injection for the read/diff/cleanup network steps; and the standalone runner exposes only exported functions with no real CLI bootstrap. **No real Wintun/mihomo TUN/route/DNS was run** in this rework — G1 remains UNEXECUTED/UNPROVEN and the **implementation gate is NOT met**.
  - Round-3 local hardening: side-effecting operations are never abandoned after an arbitrary cancellation grace period; late native handles/processes must settle and be reclaimed before the probe returns. Mihomo stop owns the complete graceful → force → liveness-verification budget, retains its exact process reference on an unconfirmed exit, and may be retried by `finally`. Evidence is restricted to a direct child of the dedicated directory, opened exclusively with mode `0600`, and written only after the already-open file's parent directory identity is reverified. This remains scaffold-only and does not change the UNEXECUTED/UNPROVEN gate.

**Implementation re-review round-2 (in progress):** per the round-2 reviewer's 5 P1 + 2 P2 items — the `runStep` timeout now cancels the underlying op and reclaims late resources (no residual adapter/mihomo, late-success tests added); the OWNED `WintunCreateAdapter` creator handle from *this* call is closed unconditionally (once) in `finally`, with the strict identity-match `cleanupAllowed` rule applied only to recovered/enumerated/partner resources, plus `readAdapterIdentity` throw/timeout no-residue tests; `stopMihomoProbe`'s result is honoured (true only on confirmed exit: SIGTERM→SIGKILL→bounded wait→verify, error≠stopped, timers/listeners cleared, orchestrator never marks stopped on false) with SIGTERM-ineffective/SIGKILL-ineffective/error-but-alive tests; illegal observation combos are recorded as `observed=null`/`g1-failed` over the full truth-combo table; `resolveSafeEvidencePath` no longer uses `baseReal!==base` string equality as the reparse criterion (it canonicalised the real base ONLY for containment — false-positiving on macOS temp dirs and Windows case/short-path/normalization differences), keeps exclusive create and re-verifies the parent real path immediately before the write (validate-vs-write TOCTOU); mihomo config gating treats `FakeConfigValidator` as the cheap structural pre-flight only — a real `mihomo -t` against the SAME binary + BYTE-IDENTICAL start file is required before any real execution (P2-7). **No real Wintun/mihomo TUN/route/DNS was run in any round — G1 stays UNEXECUTED/UNPROVEN and the implementation gate is NOT met.**
- [~] Implement explicit elevation flow. (The injected, serial `TunElevationFlow` now enforces integrity-before-prompt, explicit connect intent, one owned live session, UAC-denial state, renderer-independent teardown, liveness confirmation and retry when a helper remains alive. The production `GatedTunElevationActivator` performs no COM call; native `CoGetObject`/registration/handshake remain gated pending G1 and design approval.)
- [~] Verify driver/helper signature and binary integrity. (The read-only, injected `TunBinaryIntegrityVerifier` now validates the complete two-entry manifest before inspection, pins canonical path + SHA-256 for helper/Wintun, requires valid Authenticode + the configured publisher thumbprint for the helper, and keeps the production inspector fail-closed. A real `WinVerifyTrust` inspector, release helper digest and publisher thumbprint remain gated/owner-supplied; no DLL is loaded.)
- [~] Implement TUN configured/starting/active/failed states and recovery states (restoring / restore-failed / conflict / unsupported). (The serial, renderer-independent `TunCoordinator` and fake-driven state/recovery tests are complete. The privileged adapter remains fail-closed and unwired pending G1.)
- [~] Add emergency disable and cleanup path independent of the GUI. (`TunCoordinator.emergencyDisable()` is idempotent, serialized and retryable after `restore-failed`; the real helper/OS cleanup adapter and recovery CLI remain gated pending G1.)
- [ ] Test DNS, IPv4, IPv6, sleep/wake, network change and crash recovery.
- [ ] Record service, route, DNS and non-proxy-aware request evidence.

Exit criteria:

- Transparent capture is proven without losing VM connectivity.
- Disable/uninstall returns routes and DNS to the exact previous state.
- Recovery works after forced process termination.

## Phase 10 — Desktop product features

Environment: Mac for mock UI; Windows VM for OS behavior.

Entry gate: relevant preceding service phase complete.

- [~] System tray menu and state synchronization. (The main-process `TrayController` is implemented and wired: show/focus, verified kernel phase, serialized start/stop, quit, close-to-tray and idempotent teardown. It consumes the ordered kernel gateway, so tray stop preserves the Phase 8 proxy-before-kernel safety ordering and never toggles optimistically. The Electron adapter and packaged icon are included; controller behavior is unit-tested. Final native Windows tray rendering, Explorer restart behavior and installer lifecycle remain pending on the Windows VM.)
- [~] Start-on-login with explicit user opt-in. (A serial `StartupService`, strict boolean IPC, preload API and Settings → General switch are implemented. The default path only reads state and never writes; only an explicit user toggle invokes the OS adapter, followed by read-after-write confirmation with divergence/error shown without optimistic UI. Windows login launches with `--hidden`, creating only the tray/UI process — never the kernel, proxy or TUN. Non-Windows fails closed as unsupported. Unit coverage proves default-off/no-write, explicit enable, divergence and unsupported behavior; final installed Windows Task Manager/login lifecycle evidence remains pending.)
- [x] Connection detail and close actions. (Activity's live connection card opens a dedicated searchable master/detail view backed by the existing shared `/connections` transport. Close requests are deduplicated while in flight and are never treated optimistically: the store re-reads `/connections` and reports success only after the target ID is absent; controller divergence and typed failures remain visible and retryable. Store tests cover filtering/selection, confirmed close, divergence and concurrent duplicate intent.)
- [x] Process/device detail panes. (The former fixed examples now aggregate the live `/connections` snapshot. Process identity uses name + path; device identity truthfully uses the reported source IP and does not invent DHCP hostnames. Both pages provide stable traffic/name ordering, selection, upload/download totals, active connection counts, target/process detail and explicit empty/loading states; pure tests cover aggregation and ranking.)
- [x] Logs viewer, filtering, export and redaction. (A bounded 2,000-entry Pinia store consumes the existing shared `/logs` stream, exposes connection/error state and level/text filtering, and the renderer-only export path re-applies credential redaction at the file boundary. The page is reached through Settings → Logs so the fixed-height 934×672 sidebar geometry is unchanged. Unit tests cover bearer/basic credentials, URL user-info, sensitive query/assignment values, normalization and export-time defense-in-depth.)
- [x] DNS diagnostic and cache actions. (Strict hostname/query-type IPC validation drives the documented `/dns/query` endpoint; upstream responses are runtime-validated. DNS and Fake-IP flushes use their dedicated 204 endpoints, expose confirmed success/failure without optimistic state, and are covered by client/IPC/mock tests.)
- [x] Theme, reduced motion, keyboard navigation and high contrast. (Settings → Appearance provides system/light/dark selection, explicit high contrast and reduced-motion preferences with strict versioned local parsing. System theme changes remain live; explicit selections are stable. Global `:focus-visible` styling covers native controls, links and interactive cards, Space/Enter activate the Activity connection card, and both the explicit preference and OS `prefers-reduced-motion` disable nonessential motion. Contract tests cover malformed persisted values and theme resolution.)
- [x] About, diagnostics bundle and support links. (Brand-configured HTTPS repository/support links, packaged app/platform metadata and an explicit allowlist diagnostic serializer are implemented. The bundle intentionally excludes controller URLs, profiles, paths, logs, raw errors and network addresses; tests inject representative secrets and prove they are absent.)
- [x] Application update design with signing and rollback. (`docs/application-update-design.md`: signed per-machine NSIS, metadata SHA-512 + Authenticode publisher verification, explicit/manual lifecycle, network teardown gate, forward-version rollback releases and Windows evidence matrix. Runtime updater remains disabled pending owner channel/signing decisions.)
- [x] Kernel update design with pinned channels, checksums and rollback. (`docs/kernel-update-design.md`: no `/upgrade`; signed canonical manifest, allowlisted origin, SHA-256, service-side revalidation, immutable current/previous slots, loopback-only validation and fail-closed rollback. Runtime updater remains disabled pending owner channel/signing-key decisions.)

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

- [x] Choose the application open-source license: GPL-3.0-only.
- [ ] Decide whether Windows arm64 is required for the first release.
- [ ] Decide whether HTTPS decryption and rewrite pages remain visible, experimental or removed.
- [ ] Decide whether TUN is part of v1 or a later release.
- [ ] Choose application and kernel update channels.
- [ ] Provide final icon and brand assets.
