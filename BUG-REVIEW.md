# Bug review — kernel / system-proxy / TUN lifecycle

Concrete, verifiable bugs only. This file is the review record; each item is marked
**FIXED**, **WONTFIX**, or **ALREADY-FIXED** with the commit/file where the change
landed.

## 1. Quit flow stopped the TUN child *before* restoring the owned system proxy — FIXED
- **File:** `src/main/index.ts` `restoreNetworkBeforeQuit`
- **Fix:** the quit task now calls `restoreSystemProxyBeforeQuit()` FIRST, then
  `tunCoordinator.emergencyDisable()`, matching the invariant every other
  teardown path enforces (`single-kernel-gateway.ts` `stop()`,
  `ordered-kernel-gateway.ts` `stop()`). The registry can no longer aim at the
  unified mixed port after the child that owns it has been stopped.
- **Severity:** medium

## 2. Fresh system-proxy enable never cleared a leftover bundle → self-conflict / dev-prod divergence — FIXED
- **File:** `src/main/system-proxy/backup-store.ts`
- **Fix:** `InMemorySystemProxyBackupStore.write` now REPLACES the stored value,
  exactly like the file-backed store (which overwrites via rename). The previous
  no-op-when-present behaviour silently dropped the new bundle (including a
  `setProxyBypass` superseded `ProxyOverride`) in dev, so a later `disable()`
  restored stale values while the service reported `enabled` with the new target.
- **Follow-up (closed):** `enable()` treated a SAME-TARGET stale bundle as a
  conflict whenever the registry matched neither `written` nor `previous`
  (`!sameTarget && (routeOwned || alreadyRestored)`), e.g. a crash after
  restore-verification but before `backup.delete()`, or our server flipped
  off / override edited inside our own envelope. `enable()` now classifies by
  ownership, not port identity: `serverStillOurs || alreadyRestored` →
  `restoreBackupStrict` + fresh enable; only a DIFFERENT proxy server (another
  tool's takeover) surfaces the conflict. Verified by
  `tests/system-proxy-stale-bundle.test.ts` (5 cases, incl. the fail-closed
  external-server case).

## 3. Production kernel readiness (`readinessPattern: null`) — WONTFIX (accepted)
- **File:** `src/main/index.ts` (spawn args), `src/main/kernel/supervisor.ts`
- **Assessment:** confirmed latent, but every *internal* start path that reacts
  to `phase === 'running'` is already probe-gated (`ControllerReadyKernelGateway`
  for renderer start; the crash-recovery re-enable in `index.ts` re-checks live
  `/version` + socket probes and retries until convergence). The asym dev/prod
  readiness contract is a known, documented limitation, not an exploitable bug.
  No change.

## 4. Kernel watchdog `release()` relied on stdin EOF — ALREADY-FIXED
- **File:** `src/main/kernel/crash-watchdog.ts`
- **Assessment:** the finding described the OLD `cmd /c more > NUL & taskkill`
  helper (commit `ee2e30f`). Current HEAD (`c1937c2`) rewrote it to a PowerShell
  `ReadByte` release-byte protocol: `release()` writes a single release byte and
  the helper only runs `taskkill` on a genuine `-1` (EOF from parent death). The
  stdin-destroy-before-taskkill race no longer exists. Tests
  (`tests/kernel-watchdog.test.ts`) assert the release-byte vs EOF distinction.
  No change.

## 5. Abnormal-exit monitor skips `restoring` / `restore-failed` TUN phases — WONTFIX (accepted)
- **File:** `src/main/index.ts` monitor, `src/main/kernel/mode-transition.ts`
- **Assessment:** confirmed the monitor and `recoverTunExit` both only reconcile
  `active`/`starting`. This is a bounded gap in the degraded-phase recovery
  guarantee, not a crash; the next user enable from `restore-failed` is allowed
  and surfaces any lingering conflict. Left as a documented limitation.

## Notes (verified non-bugs, to save re-review)
- `KernelSupervisor` lifecycle chain, `exitWork`, `waitForExit`/`exitWait` and
  readiness handling are consistent; no deadlock between `stop()` and
  `handleExit`.
- `ModeTransitionController.runExclusive` and both gateway queues are
  fail-isolated and cannot self-deadlock.
- `SystemProxyService` enable/disable/`restoreBeforeKernelUnavailable` all
  serialize on one queue; `handleNetworkUp` intentionally stays outside it.
- `NamedPipeTunServiceTransport` settles exactly once and enforces byte/frame
  limits.
- `TunCoordinator`'s state machine refuses invalid transitions; double-click
  cannot double-spawn the child.
