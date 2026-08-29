# Phase 9 — TUN privileged helper: install / upgrade / rollback / uninstall

> Status: **draft for design review.** This is a behavior definition, not code.
> It authorizes no network mutation and is the deliverable for the second Phase 9
> roadmap line ("Define install, upgrade, rollback and uninstall behavior"). It
> builds on `docs/helper-threat-model.md` (controls **C1**…**C13**) and mirrors the
> already-shipped system-proxy install/uninstall pattern in
> `resources/nsis/uninstall-restore.nsh` and `electron-builder.config.mjs`.

---

## 0. Reference model

- App files install under `Program Files\<product>` (per-arch installer, NSIS
  `oneClick:false`, NSIS include hook `uninstall-restore.nsh`).
- User data (profiles, owned backups, logs, kernel artifacts) lives in the
  brand-independent **application-data** namespace and survives uninstall
  (`deleteAppDataOnUninstall:false`).
- The kernel binary is bundled **per-arch**, checksum-pinned, verified at package
  time and re-verified at runtime before extraction
  (`resources/bin/<arch>`, `mihomo-artifact.ts`).
- The helper, its driver, and the TUN restore tool follow the same rules, applied
  where the helper must live at **High IL** (§1 of the threat model).

---

## 1. Components owned by the helper feature

| Component | Location | Trust | Lifecycle |
|---|---|---|---|
| Helper executable | app install dir (Program Files) | High IL | Installed/updated with the app; replaced only after integrity check |
| wintun (or chosen) driver | driver store / system32 driver store | Kernel | Installed once, tracked as "installed by us", removed only if ours and not in use |
| Optional helper service | Windows service (SERVICE_WIN32_OWN_PROCESS) | High IL / service SID | Registered/updated with the app; removed on uninstall after safe teardown |
| Baseline snapshot + mutation journal | app-data (helper-owned) | Medium/High | Written/read by helper; survives uninstall to enable rollback |
| TUN restore tool (`--restore-tun`) | app install dir | High IL | Used by the uninstall hook and the emergency path |
| Ownership/version manifest markers | app-data | Medium | Records which helper+driver version installed what, for upgrade/rollback |

---

## 2. Install (fresh)

1. **Placement and ACLs.** Install the helper, driver payload and restore tool under
   `Program Files` (or the approved equivalent). The directory DACL blocks Medium-IL
   writes (C2). Never stage an elevated binary in `%TEMP%` or an attacker-writable
   per-user path.
2. **Integrity before first use.** On first activation (not at install) verify the
   helper SHA-256 against a pinned release manifest and its Authenticode publisher
   (C1). The driver is a known-signed artifact.
3. **Driver install is deferred and explicit.** The signed driver is installed only
   when the user first **enables** TUN (explicit action), not at app install, unless
   the owner decides otherwise. If a driver with the same name already exists, do
   not overwrite it; record that it pre-existing.
4. **Service registration** (if the helper is a service): create with a restrictive
   DACL and the least set of privileges (C5); start it **disabled/manual**, not
   auto-start, unless the emergency path needs it (C9 — owner decision).
5. **No network mutation at install.** Install must not touch routes, DNS, interfaces
   or firewall. It only stages files and (if required) pre-registers a disabled
   service/driver.
6. **First-run gating.** The renderer shows TUN as **configured** (or
   **unsupported** on non-Windows) — never **active** — until the user explicitly
   enables and the helper reports success.

---

## 3. Upgrade

An upgrade must never leave the machine in a half-updated TUN state.

1. **Preserve user data.** Profiles, snapshots, journal and logs survive the
   upgrade (they live in app-data). The helper binary/driver version changes, not
   the user's data namespace.
2. **Reconcile in-flight TUN before replacement.** If TUN is active at upgrade time,
   the new build must first run the **teardown/restore** path (reading the baseline
   snapshot recorded by the old version) before it replaces the helper files. The
   snapshot/journal format is **versioned**, so a new helper can read and restore a
   snapshot written by an older helper (forward-compatible restore, C4/C9).
3. **Replace only after verification.** The new helper is placed only after the SHA-256
   + Authenticode check passes (C1); a failed check aborts the upgrade's helper swap
   and leaves the previous version intact and usable.
4. **Service/driver update.** If the service is present, stop it, replace the binary,
   restart. Do not briefly keep two versions of the service live.
5. **No mutation during the swap itself.** The upgrade replaces files/registers the
   service; it performs route/DNS changes only through the same activation path as
   normal use.
6. **Rollback-safe.** A failed upgrade leaves the previous helper+driver and the
   freshly-written snapshot such that **rollback** (§4) can still cleanly restore the
   prior state.

---

## 4. Rollback (to the previous release)

1. **Teardown current state.** Before installing an older helper/driver, run the
   restore/teardown path so the current TUN is removed and routes/DNS match the
   pre-enable baseline (C8/C9). If the current helper cannot restore (crash,
   corruption), the **emergency path** (§6) must still be able to, and rollback
   must abort rather than stack two inconsistent states.
2. **Version-compatible snapshots.** Revert helper+driver to the prior version while
   keeping the baseline snapshot. Because snapshot restore is forward-compatible,
   the older helper can restore the same baseline.
3. **Conflict ⇒ no rollback.** If current route/DNS no longer match what the helper
   wrote (external edit), produce `TUN_STATE_CONFLICT` and perform no mutation (C8);
   surface the structured conflict and require the emergency/owner path.
4. **Binary integrity on install.** The downgraded helper is verified (C1) before it
   is trusted to run.

---

## 5. Uninstall

Mirrors `resources/nsis/uninstall-restore.nsh`, extended for TUN.

1. **Pre-uninstall restore hook.** A
   `customUnInstall`/equivalent step runs **before** the uninstaller deletes the
   installed files and launches the headless `--restore-tun` path, which:
   - reads the baseline snapshot and terminates the TUN device,
   - restores routes/DNS/interface metrics **only if** current state still matches
     what the helper wrote (C8),
   - exits 0 on restored / already-disabled / safe-conflict (external edit left
     intact) so the uninstaller continues,
   - on **non-zero** (corrupt/unreadable snapshot) **aborts the uninstall** so the
     app and its restore tool remain on disk and the user can retry or use the
     emergency path — guaranteeing the OS is never left with a dangling TUN/route.
2. **Remove service/driver only after safe teardown.** Delete the helper service and
   the driver **only** if (a) the pre-uninstall restore completed and (b) the driver
   was installed by this app and is not in use by another consumer. A pre-existing
   or shared vendor driver is left in place.
3. **Preserve user data.** `deleteAppDataOnUninstall:false` keeps profiles and the
   baseline snapshot/journal so an aborted or partial uninstall is recoverable. If
   the owner later wants a "remove all data" option, it is a separate, explicit
   choice and must still run the TUN restore first.
4. **Fail-closed abort.** The uninstall hook treats a non-zero restore exit as a
   reason to stop (same behavior as the proxy hook), so a broken TUN never survives
   as an OS-level dangling route/DNS after the app is gone.

---

## 6. Emergency disable / escape hatch (independent of the GUI)

- A bundled, documented **`--recover`** mode (and/or a service command) that the
  owner can run from a console to restore the baseline snapshot **without** the
  renderer or the mihomo process (C9). It must not depend on the network it is
  about to fix.
- The helper records a mutation **journal** on disk so recovery can reconcile even
  after a crash during activation (C10).
- Recovery is idempotent and safe to re-run; it never re-applies a mutation that is
  already reverted.

---

## 7. Decision/authorization flags for design review

These are the decisions the install/upgrade/rollback behavior depends on (carried
from threat-model §10; the owner must confirm before implementation):

| # | Decision | Impact on this spec |
|---|---|---|
| D1 | Device model: signed wintun vs userspace-only | Driver install/rollback path differs |
| D2 | Helper shape: standalone elevated process vs Windows service (and account/service SID) | Service register/upgrade/remove steps differ |
| D3 | Driver install timing: at app install vs deferred to first enable | §2.3 / §2.4 |
| D4 | Whether the helper is allowed to start on boot for the emergency path | Auto-start vs manual service (C9) |
| D5 | Whether a wintun driver that pre-exists the app is ever removed | §5.2 |

---

## 8. Test / evidence mapping (disposable Windows only)

| Behavior | Test | Evidence |
|---|---|---|
| Install stages files, no network mutation | snapshot before/after install, assert unchanged | `NetworkSnapshot` diff |
| First enable requires explicit action | assert no TUN active on launch | status phase = configured |
| Upgrade preserves data + reconciles | enable TUN, upgrade, assert prior state restored/consistent | journal + snapshot digest |
| Rollback restores prior release | enable, rollback, assert baseline | route/DNS diff vs baseline |
| Uninstall restores + removes our driver | uninstall, assert routes/DNS == baseline, driver removed if ours | before/after snapshot |
| Uninstall abort on corrupt snapshot | corrupt snapshot, uninstall, assert abort + binary retained | exit code, `Abort` path |
| Emergency `--recover` independent of GUI | kill app, run `--recover`, assert restored | restored state |
| Crash mid-activation reconciliation | force-kill helper at each phase, assert `init()` reconciles | journal replay |

All of the above run only in the gated `windows-latest` job (skipped unless
`MURGE_RUN_REAL_TUN=1` **and** `win32`) and never in default `npm test`.
