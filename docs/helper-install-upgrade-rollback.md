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
- The helper, the **per-arch official `wintun.dll`** (never a bare driver file — see
  `docs/helper-design.md` §3), and the TUN restore tool follow the same rules,
  applied where the helper must live at **High IL** (§1 of the threat model).

---

## 1. Components owned by the helper feature

| Component | Location | Trust | Lifecycle |
|---|---|---|---|
| Helper executable | app install dir (Program Files) | High IL | Installed/updated with the app; replaced only after integrity check |
| **Per-arch official `wintun.dll`** | app install dir `resources/bin/<arch>` (never a bare driver file) | Medium/High | Bundled per-arch, digest-pinned; the signed Wintun kernel driver is **installed/loaded on demand by the DLL inside `WintunCreateAdapter`** at first enable (there is **no separate driver-load step**), and we do **not** ship/delete a `wintun.sys` ourselves |
| Optional helper service (alternative, D2) | Windows service (SERVICE_WIN32_OWN_PROCESS) | High IL / service SID | Only if the owner revokes D2 (standalone helper); registered/updated with the app; removed on uninstall after safe teardown |
| BaselineSnapshot + WrittenState + mutation journal | app-data (helper-owned) | Medium/High | Written before first mutation; survives uninstall to enable rollback |
| TUN restore tool (`--recover`) | app install dir | High IL | Used by the uninstall hook and the emergency path |
| Ownership/version manifest markers | app-data | Medium | Records which helper+dll version installed/loaded what, for upgrade/rollback |

---

## 2. Install (fresh)

1. **Placement and ACLs.** Install the helper, the per-arch `wintun.dll` and the
   restore tool under `Program Files` (or the approved equivalent). The directory
   DACL blocks Medium-IL writes (C2). Never stage a privileged binary or the DLL in
   `%TEMP%` or an attacker-writable per-user path; never load the DLL from a search
   path a lower-trust process can influence (C2).
2. **Integrity before first use.** On first activation (not at install) verify the
   helper SHA-256 against a pinned release manifest and its Authenticode publisher,
   and the official `wintun.dll` per-arch SHA-256 (C1). The Wintun kernel driver is
   installed/loaded by the DLL inside `WintunCreateAdapter` and is required to be a
   signed driver Windows will load; we do not self-sign a driver or a driver cert.
3. **Wintun adapter/driver creation is deferred and explicit.** The signed Wintun driver
   is **installed/loaded on demand by the official `wintun.dll` inside
   `WintunCreateAdapter`**, which the (elevated) helper calls only when the user first
   **enables** TUN (an explicit action) — not at app install. `LoadLibraryEx(wintun.dll)`
   alone does **not** install or load the driver, so there is no separate "load the
   driver" step. We never ship/install a bare `wintun.sys`; a pre-existing/shared Wintun
   driver is never overwritten or removed.
4. **Enable order (single OS-config owner).** At enable, before any OS mutation, the
   helper writes and verifies the **BaselineSnapshot**; then it writes (and **fsyncs**)
   **`CREATE_ADAPTER/PREPARED`** so recovery knows a create is in flight; **then** it calls
   `WintunCreateAdapter(Name, TunnelType, RequestedGUID)` (driver on demand + adapter created),
   and **only then** writes **`CREATE_ADAPTER/APPLIED`** with the LUID (pinned — re-derived to
   assert exactly one Murge adapter); **then** it applies routes/DNS/interface (they are always
   written **after** the adapter exists).
   mihomo's runtime config has `auto-route:false`/`auto-detect-interface:false`/
   `dns-hijack:false`, so mihomo adds no route/DNS of its own (single modifier = the
   helper). Any failure recovers by reconciling each `PREPARED-but-unknown` record against the
   current OS state, in reverse journal order. **Disable is the mirror, using the only
   removal path:** teardown mihomo's session + close its open handle, restore routes/DNS per
   item, then verify ownership (`Name`/`RequestedGUID`/LUID) and write
   `CLOSE_CREATOR_HANDLE/PREPARED` → `WintunCloseAdapter(creatorHandle)` (removes the
   adapter) → `CLOSE_CREATOR_HANDLE/APPLIED`/`RECONCILED`. There is **no `WintunDeleteAdapter`**,
   **no `RebootRequired`/`delete-pending`**, and **no** automatic delete on last-session/handle
    close by itself — the adapter is removed by closing the creator handle. Disable is served
    by the **same per-enable resident helper** that created the adapter (design doc
    §3.3–§3.4/§5.5); the helper **holds the creator handle for the whole enabled window**, so
    the close order does not depend on the G1 probe (G1 only confirms mihomo reuses the
    adapter).
5. **Service registration** (only if the helper is a service, i.e. D2 is revoked):
   create with a restrictive DACL and the least set of privileges (C5); start it
   **disabled/manual**, not auto-start, unless the emergency path needs it (C9 —
   owner decision). Under the current D2 (standalone helper) this step is skipped.
6. **No network mutation at install.** Install must not touch routes, DNS, interfaces
   or firewall. It only stages files and (if required) pre-registers a disabled
   service.
7. **First-run gating.** The renderer shows TUN as **configured** (or
   **unsupported** on non-Windows) — never **active** — until the user explicitly
   enables and the helper reports success.

---

## 3. Upgrade

An upgrade must never leave the machine in a half-updated TUN state.

1. **Preserve user data.** Profiles, snapshots, journal and logs survive the
   upgrade (they live in app-data). The helper binary/driver version changes, not
   the user's data namespace.
2. **Reconcile in-flight TUN before replacement.** If TUN is active at upgrade time,
   the new build must first run the **teardown/recovery** path (reading the
   `BaselineSnapshot` + `WrittenState` + mutation journal recorded by the old
   version) before it replaces the helper files. The snapshot/journal format is
   **versioned**, so a new helper can read and restore a state written by an older
   helper (forward-compatible restore, C4/C9/C10).
3. **Replace only after verification.** The new helper and `wintun.dll` are placed
   only after the SHA-256 + Authenticode check passes (C1); a failed check aborts the
   upgrade's helper swap and leaves the previous version intact and usable.
4. **Service/**`wintun.dll`** update.** If the service is present (D2 revoked), stop
   it, replace the binary, restart; do not briefly keep two versions live. Otherwise
   just replace the per-arch `wintun.dll` next to the helper (the signed kernel driver
   is not shipped or replaced by us).
5. **No mutation during the swap itself.** The upgrade replaces files/registers the
   service; it performs route/DNS changes only through the same activation path as
   normal use.
6. **Rollback-safe.** A failed upgrade leaves the previous helper+`wintun.dll` and the
   freshly-written snapshot such that **rollback** (§4) can still cleanly restore the
   prior state.

---

## 4. Rollback (to the previous release)

1. **Teardown current state.** Before installing an older helper/`wintun.dll`, run the
   restore/teardown path so the current TUN is removed and routes/DNS match the
   pre-enable **baseline** (§8 of the design doc; C8/C9). If the current helper
   cannot restore (crash, corruption), the **emergency path** (§6) must still be able
   to, and rollback must abort rather than stack two inconsistent states.
2. **Version-compatible records.** Revert helper+`wintun.dll` to the prior version
   while keeping the `BaselineSnapshot`/`WrittenState`/journal. Because restore is
   forward-compatible and **per-item owned-only**, the older helper can restore the
   same baseline.
3. **Conflict ⇒ no overwrite, per item.** If a current route/DNS no longer matches
   what the helper wrote (external edit), record a **per-item conflict**
   (`conflictDetail`) and leave that item untouched while restoring unrelated owned
   items (C8) — never all-or-nothing. Surface the structured conflict and require
   the emergency/owner path for the conflicted items.
4. **Binary integrity on install.** The downgraded helper and `wintun.dll` are
   verified (C1) before they are trusted to run.

---

## 5. Uninstall

Mirrors `resources/nsis/uninstall-restore.nsh`, extended for TUN.

1. **Pre-uninstall restore hook.** A
   `customUnInstall`/equivalent step runs **before** the uninstaller deletes the
   installed files and launches the headless **`--recover`** (alias `--restore-tun`)
   path, which:
   - reads the `BaselineSnapshot`/`WrittenState`/journal and terminates the TUN
     session (mihomo owns the data-plane device; the hook stops that process/session),
   - restores routes/DNS/interface metrics **per item and only if** the current state
     still matches what the helper wrote (C8),
   - exits 0 on restored / already-disabled / safe-conflict (external edit left
     intact, other owned items restored) so the uninstaller continues,
   - on **non-zero** (corrupt/unreadable snapshot) **aborts the uninstall** so the
     app and its restore tool remain on disk and the user can retry or use the
     emergency path — guaranteeing the OS is never left with a dangling TUN/route.
2. **Remove only after safe teardown.** Under D2 (standalone) there is **no helper
   service** to delete; if D2 is later revoked to a service, delete it **only** after
   the pre-uninstall restore completed. We do **not** ship a driver file to delete;
   the signed Wintun kernel driver is loaded through `wintun.dll`, and a
   pre-existing/shared Wintun driver is left in place. The helper removes **only** the
   product-owned adapter (via `WintunCloseAdapter(creatorHandle)`, after its session is ended) and leaves
   any pre-existing adapter untouched (C9). There is **no `WintunDeleteAdapter`**.
3. **Preserve user data.** `deleteAppDataOnUninstall:false` keeps profiles and the
   `BaselineSnapshot`/`WrittenState`/journal so an aborted or partial uninstall is
   recoverable. If the owner later wants a "remove all data" option, it is a
   separate, explicit choice and must still run the TUN restore first.
4. **Fail-closed abort.** The uninstall hook treats a non-zero restore exit as a
   reason to stop (same behavior as the proxy hook), so a broken TUN never survives
   as an OS-level dangling route/DNS after the app is gone.

---

## 6. Emergency disable / escape hatch (independent of the GUI)

- A bundled, documented **`--recover`** mode (and/or a service command) that the
  owner can run from a console to restore the baseline snapshot **without** the
  renderer or the mihomo process (C9). It must not depend on the network it is
  about to fix.
- The helper records a **write-ahead** mutation **journal** on disk (each op is
  `PREPARED` → mutate → `APPLIED`; `CREATE_ADAPTER/PREPARED`/`CLOSE_CREATOR_HANDLE/PREPARED`
  fsync'd before the OS is touched) so recovery can reconcile even after a crash during
  activation, by enumerating the current OS state rather than assuming (C10).
- Recovery is idempotent and safe to re-run; it never re-applies a mutation that is
  already reverted.

---

## 7. Decision/authorization flags for design review

These are the decisions the install/upgrade/rollback behavior depends on (carried
from threat-model §10). **D1–D3 + D6 are resolved** and in force; **D4–D5, G1 and the
certificate provider** remain open until design-review sign-off:

| # | Decision | Status | Impact on this spec |
|---|---|---|---|
| D1 | Device model: signed wintun vs userspace-only | **Resolved: signed wintun (official per-arch `wintun.dll`)** | Load the signed Wintun driver through the official `wintun.dll`; never ship a bare driver file or self-sign a driver cert; the driver is installed/loaded **inside `WintunCreateAdapter` on first enable** |
| D2 | Helper shape: standalone elevated process vs Windows service | **Resolved: standalone elevated helper** | No service register/upgrade/remove steps; §3.4/§5.2 drop the service path (but are kept as a documented alternative) |
| D3 | Adapter/driver creation timing: at app install vs deferred to first enable | **Resolved: on first enable** | §2.3 stages `wintun.dll` at install; §2.4 calls the adapter creation (driver on demand) on first enable; **no separate driver-load step** |
| D6 | OS network-config owner | **Resolved: helper is the sole modifier (Option A)** | mihomo runtime config has `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`; the helper applies the typed `DesiredNetworkState`; routes/DNS are written only after the adapter exists |
| D4 | Whether the helper is allowed to start on boot for the emergency path | Open (recommended: no auto-start) | Auto-start vs manual `--recover` (C9) |
| D5 | Whether a wintun driver that pre-exists the app is ever removed | Open (recommended: never) | §5.2 |
| G1 | Whether mihomo can reuse the helper-created adapter | **Open (unproven hypothesis)** | Blocking gate: the **G1 lifecycle probe** (create + hold creator handle → mihomo `WintunOpenAdapter` + `WintunStartSession` → helper `WintunCloseAdapter(creatorHandle)`/exit → observe whether session + adapter persist; design doc §3.3) must pass on a snapshot-able, out-of-band-recoverable Windows VM in gated CI before any Phase 9 helper implementation. The outcomes are **Observed A/B**; **neither changes the fixed baseline** (helper is a per-enable resident server holding the creator handle for the whole enabled window, §3.4/§5.5). |

> Because D2 resolved to a **standalone helper (not a service)**, §5.2's
> "delete the helper service" step applies only if a later owner decision revokes
> D2; the driver-removal rule (ours-only, not-in-use, never-a-preexisting-shared
> driver) remains regardless.

---

## 8. Test / evidence mapping (disposable Windows only)

| Behavior | Test | Evidence |
|---|---|---|
| Install stages files, no network mutation | snapshot before/after install, assert unchanged | `NetworkSnapshot` diff |
| First enable requires explicit action | assert no TUN active on launch | status phase = configured |
| Adapter/driver created on first enable (no separate load) | at first enable the helper calls `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`; assert the driver appears only then, and no "load driver" op exists | driver/adapter presence before vs at enable; journal has no `load_driver` op |
| **G1 lifecycle probe (disposable, hard gate)** | (a) helper `WintunCreateAdapter` holds the creator handle; (b) mihomo `WintunOpenAdapter` + `WintunStartSession`; (c) helper `WintunCloseAdapter(creatorHandle)`/exit; (d) observe whether session + adapter persist. On a snapshot-able VM restored out-of-band afterwards | adapter + session presence at a/b/c/d; record **which observation** (A = adapter disappears on creator close, B = it survives while mihomo holds a handle) and assert the **fixed baseline** (neither changes the helper-holds-creator-handle model); machine restored |
| Adapter handoff + single adapter (G1) | after the helper creates the adapter, mihomo reuses the same **RequestedGUID/LUID** and there is exactly **one** Murge adapter | enumerate by Name/RequestedGUID/LUID before/after; assert count==1 and same LUID |
| Routes/DNS always written after adapter creation | assert a route/DNS journal op never precedes `createAdapter`; failure before adapter leaves zero routes/DNS | journal seq |
| mihomo emits no route/DNS change | with `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`, mihomo adds/removes no route/DNS outside the helper | route/DNS snapshot before+after mihomo start, diff == helper-written set only |
| Upgrade preserves data + reconciles | enable TUN, upgrade, assert prior state restored/consistent | journal + snapshot digest |
| Rollback restores prior release | enable, rollback, assert baseline | route/DNS diff vs baseline |
| Uninstall restores routes/DNS and removes the product adapter | uninstall, assert routes/DNS == baseline; helper removes **only** the product-owned adapter via `WintunCloseAdapter(creatorHandle)` after its session ends; never a shipped/`pre-existing` driver or adapter | before/after snapshot; adapter enumerate |
| Uninstall abort on corrupt snapshot | corrupt snapshot, uninstall, assert abort + binary retained | exit code, `Abort` path |
| Emergency `--recover` independent of GUI | kill app, run `--recover`, assert restored | restored state |
| Crash mid-activation reconciliation (WAL) | force-kill helper at **each durable-journal record** (pre-snapshot, `CREATE_ADAPTER/PREPARED`, mid-create, `APPLIED`, each route/DNS `PREPARED`→`APPLIED`, `CLOSE_CREATOR_HANDLE/*`), assert `init()`/`--recover` reconciles each PREPARED-but-unknown record by `WintunOpenAdapter(Name)` + identity verification against the current OS state | journal replay + route/DNS diff + adapter enumerate |
| **Resident helper stays across a long IPC gap** | after `enable`, a long no-IPC period leaves adapter + routes/DNS intact (no idle exit) | wait > idle timeout; enumerate adapter; route/DNS diff == applied |
| **Disable uses the same helper instance** | `disable` is served by the same helper PID that enabled; evidence records enable PID == disable PID; the creator handle is closed at disable | helper PID logged at enable + disable; assert equal; adapter removed after ownership check |
| **App crash while enabled ⇒ emergency restore** | force-kill the app; the helper (watches the app process handle) restores routes/DNS, closes the creator handle, persists outcome, exits | routes/DNS restored; adapter removed; `RECONCILED` (or `RESTORE_FAILED` + journal kept); helper exited |
| **mihomo crash while enabled ⇒ emergency restore** | force-kill mihomo; the helper (watches the mihomo process handle) runs the same bounded emergency restore | same restore sequence + outcome |
| **Helper crash ⇒ adapter auto-removed + new recovery** | force-kill the helper; Windows closes its creator handle so the adapter is removed; the next `init()`/`--recover` launches a new recovery helper that does **not** claim to call `WintunCloseAdapter`, verifies the adapter is gone, and restores residual routes/DNS | adapter gone; new recovery helper reconciles `RECONCILED`; no `WintunCloseAdapter` recorded |
| **New recovery helper has no old creator handle** | a recovery helper started after a crash has no handle from the dead helper and must not close a creator handle; it decides restoration from journal + current OS adapter state | recovery branches to "adapter gone / conflict" without a creator-handle close |
| **Helper crash leaves no orphaned adapter / no delete of foreign** | after helper crash, if an adapter is observed still present the new helper marks a `conflict`, keeps evidence, and does **not** delete it (D5) | adapter absent or `conflict` + evidence + no delete |

All of the above run only in the gated `windows-latest` job (skipped unless
`MURGE_RUN_REAL_TUN=1` **and** `win32`) and never in default `npm test`.
