# Phase 9 — Windows TUN privileged helper: design review package (rev. 7)

> Status: **draft for design review (rev. 7).** Design/contract level only. No code
> execution, no network mutation, no driver/route/DNS change performed on this
> machine. This revision resolves the seven must-fix items from the second review
> (round-5, §0.4): unified per-enable single-client resident helper, Observed A/B,
> WAL ordering, the three crash-recovery paths, WOW64 bitness flags, and
> `%ProgramData%` recovery-state storage; and the **two round-6 security blockers**
> (§5.1, §8.0, §8.3, §13): a **pure allow-list COM/DACL/SDDL contract** and a
> **trusted, High-integrity, directory-substitution-resistant recovery state store**
> with a **deterministic integrity contract** (the integrity term "HMAC/digest or at
> least digest" is removed — C12). **Round-7 corrects the actual Windows
> security-descriptor contract** (§5.1, §8.0, §13, install doc §2/§8): the COM ACLs
> use **explicit COM rights masks** (`0xB`/`0x3`, **no generic `GX`**), no extra
> `DENY`, and the state directory uses one **resolvable, complete SDDL**
> (`O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`), with
> **no owner-SID file ACE** (the Medium UI has no raw-read path). The implementation
> gate remains **NOT met** and
> requires design-review sign-off plus separate owner authorization before any
> Windows implementation. In particular **G1 (mihomo reuses the helper-created
> adapter) is an unproven hypothesis** and is a hard blocking gate, not an
> established contract.

Decisions supplied by the owner (in force):

- **D1 = Signed Wintun (official WireGuard distribution).** Ship the official
  per-arch `wintun.dll`; the signed Wintun kernel driver is loaded **on demand by
  the DLL during `WintunCreateAdapter`** — there is **no separate driver-load op**,
  and `LoadLibraryEx(wintun.dll)` alone does **not** install/load the driver.
- **D2 = Standalone elevated helper process** (not a Windows service).
- **D3 = Wintun adapter/driver created at first enable** (the `wintun.dll` is
  staged from the installer, but the driver is installed + the adapter created only
  at the user's first explicit enable, inside `WintunCreateAdapter`).

Companion docs: `docs/helper-threat-model.md`, `docs/helper-install-upgrade-rollback.md`.
Conventions referenced: `src/shared/system-proxy.ts`, `src/shared/ipc.ts`,
`src/shared/gateways.ts`, `src/main/system-proxy/service.ts` & `adapters/*`,
`src/main/kernel/mihomo-config.ts`, `src/main/kernel/mihomo-artifact.ts`.

---

## 0. Review resolutions

### 0.1 Round 2 review fixes (rev.3 — retained)

| # | Finding / resolution |
|---|---|
| 1 | Fictitious standalone `load_driver` op removed; driver installed/loaded **inside `WintunCreateAdapter`**; adapter identity by name; **G1** flagged as unproven (§1.3, §12). |
| 2 | Enable order fixed so routes/DNS follow adapter creation; recovery in reverse journal order (§10.1, §8.4). |
| 3 | Single OS-config owner **Option A**; mihomo `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`; typed `DesiredNetworkState` (§1.1, §9). |
| 4 | Elevation bootstrap rewritten as an executable **COM elevation-moniker** sequence; `runas` cannot inherit handles (§5). |
| 5 | Key lifecycle: zero only `launchSecret` post-handshake; retain `sessionKey` to channel close/task end; `RtlSecureZeroMemory` on all paths; length-prefixed canonical MAC (§4.2, §4.3). |
| 6 | Type fixes: `dnsSets` closing `>`; `NET_LUID` as canonical hex string; `requestId` monotonic uint64 decimal string (§8.1). |
| 7 | Expanded test/evidence matrix (§13). |

### 0.2 Round 3 review fixes (rev.4 — superseded)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Wintun ABI wrong: `WintunCreateAdapter(LUID*, Name, TunnelType, Session*)` is an incorrect signature | **Fixed verbatim from the official `wintun.h`** (§3.0, pinned **0.14.1**, recorded arch/exported-symbols/header-source): `WintunCreateAdapter(Name, TunnelType, RequestedGUID) -> WINTUN_ADAPTER_HANDLE`; `WintunGetAdapterLUID(Adapter, &Luid)`; `WintunStartSession(Adapter, Capacity)` creates the packet session; `WintunEndSession` ends a session; `WintunCloseAdapter` releases a handle (and, for a create-created adapter, removes it). The "**Wintun has no RequestedGUID parameter**" assertion is **withdrawn** — `RequestedGUID` is a real parameter (§3.0, §3.2). Pinned version + arch + exported symbols + header source recorded. |
| 2 | Elevation bootstrap used plain `CoCreateInstance` + `requireAdministrator` instead of the official COM elevation moniker | **Rewritten to the COM Elevation Moniker flow** (§5.1–§5.2): client uses `CoGetObject("Elevation:Administrator!new:{CLSID}", BIND_OPTS3, ...)`; full HKLM `CLSID`/`LocalizedString`/`Elevation`/`LocalServer32` (absolute path + `ServerExecutable`)/`AppID`/`LaunchPermission`/`AccessPermission` listed; `RunAs = "Interactive User"` (Activate-as-Activator); explicit `CoInitializeSecurity`/`CoSetProxyBlanket` authn/impersonation/packet-privacy params. **Round-4 correction below** (`Elevation\Enabled = REG_DWORD 1`, `ThreadingModel` removed, WOW64/bitness location noted). |
| 3 | RPC client PID wrong: used `RPC_CALL_ATTRIBUTES_V2.ClientProcessId` | **Fixed to `RPC_CALL_ATTRIBUTES_V2.ClientPID`** with `Flags = RPC_QUERY_CLIENT_PID`; assert the call arrived over local **`ncalrpc`**; the PID is used **only to open and validate the process object** (path/digest/publisher/session-key), never as identity by itself (§5.2, §5.4). |
| 4 | Journal not truly write-ahead (the adapter was created, then the journal intent written) | **True write-ahead journal** (§8.3–§8.4): `BaselineSnapshot` committed first; `CREATE_ADAPTER/PREPARED` (fsync'd **before** `WintunCreateAdapter`); `CREATE_ADAPTER/APPLIED` after; every route/DNS op is `PREPARED` → mutate → `APPLIED`; crash between any two records is reconciled by **enumerating the product adapter / current OS state** (PREPARED-but-unknown). |
| 5 | No explicit adapter deletion; claimed last-session/handle close auto-deletes | **Corrected to the real 0.14.1 lifecycle** (§3.3): there is **no `WintunDeleteAdapter`**; an adapter created by `WintunCreateAdapter` is removed **only** by `WintunCloseAdapter(creatorHandle)`; there is **no `RebootRequired` adapter-delete return and no `delete-pending`** state (the only reboot-visible artifact is the Wintun driver, which we never delete). Because the creator handle is the adapter's lifetime anchor, the helper must keep the creator handle for the whole enabled window — **proven, not assumed**, by the **G1 lifecycle probe** (§3.3; the fixed resident lifecycle is in round-5, §0.4/§3.3/§5.5). The automatic-deletion and the explicit-`WintunDeleteAdapter` claims are both **removed**. |
| 6 | Reusable elevated helper let a second process attach | **Per-activation, single-client elevated server** (§5.5): each enable uses `Elevation:Administrator!new` to create a fresh server that **binds to the first verified client** and **rejects all other clients** (including a second Murge process with identical path/signature/hash). **Round-4 correction**: the server's **process lifetime is bound to the enabled TUN window** (it holds the creator handle), not to one IPC command — it is freshly activated per enable and exits on disable/rollback (helper holds the creator handle for the whole enabled window; see round-5, §0.4/§3.3/§5.5). Second-instance race test added (§13). |
| 7 | G1 still un-proven | Keep as a **hard pre-implementation gate**. The probe is now the **G1 lifecycle probe** (§3.3, §12, §13): create + hold creator handle → mihomo opens by Name + starts a session → helper closes the creator handle/exits → verify session + adapter persist; two **observed outcomes** (A = adapter disappears on creator close, B = it survives while mihomo holds a handle — §0.4/§3.3). Each of the previous "short-lived-helper" claims is **removed**. It runs **only** in gated disposable `windows-latest` CI on a snapshot-able, out-of-band-recoverable VM with separate owner authorization — **never on this dev machine**. |

### 0.3 Round 4 review fixes (rev.6 — retained)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Mixed a nonexistent `WintunDeleteAdapter` (+ `RebootRequired`/`delete-pending`) into the pinned 0.14.1 ABI | **Deleted from the whole design.** The **official 0.14.1 `wintun.h` is the ONLY ABI source**. Removal is `WintunCloseAdapter(creatorHandle)`, which "removes adapter" only for a create-created adapter; there is no `WintunDeleteAdapter`, no `WintunFreeSendPacket`, no `RebootRequired` adapter-delete return, no `delete-pending` state (§3.0, §3.3). |
| 2 | `WintunDeleteDriver` semantics mis-stated | The symbol **is** exported (`BOOL WINAPI (VOID)`) but production policy **forbids calling it** — it removes the shared Wintun driver if no adapters are in use and would affect other Wintun consumers (D5). Noted in the export table (§3.0) and never called. |
| 3 | Short-lived-helper vs creator-handle-lifetime contradiction unresolved | **Resolved by the G1 lifecycle probe** (§3.3): because the creator handle is the adapter's lifetime anchor, the model is **proven, not assumed**. Probe exercises a–d; the two outcomes are recorded as **Observed A** (adapter removed when creator handle closes) and **Observed B** (adapter survives while mihomo holds its own open handle). **Round-5 supersedes the B1/B2 architecture framing** (§0.4/§3.3): the **safety baseline is fixed** — helper holds the creator handle for the whole enabled window — and the A/B observation only affects a potential future optimization, **never** the baseline. G1 stays a **hard gate** (it must prove mihomo reuses the same adapter). |
| 4 | COM elevation `Elevation` default was the string `"Enabled"`; unexplained `ThreadingModel`; no bitness/WOW64 note | **Fixed** (§5.1): `Elevation\Enabled` is a **REG_DWORD `1`** (not a string); `LocalServer32\ThreadingModel` **removed**; the **bitness/WOW64 registration location** is documented via the **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY` flags** (no literal `WOW6432Node` path); since the product ships **amd64/arm64 helpers only**, we explicitly **do not register a 32-bit COM helper** (§5.1). |
| 5 | WAL delete/recovery still referred to deletion of the adapter | **Rewritten** (§8.3–§8.4): `CREATE_ADAPTER/APPLIED` stores `{Name, RequestedGUID, LUID}`; recovery **re-opens by `WintunOpenAdapter(Name)`** and verifies `RequestedGUID` via `WintunGetAdapterLUID` + `ConvertInterfaceLuidToGuid`/SetupAPI; only close the creator handle / run product lifecycle cleanup on an **exact identity match**; if the creator handle is already closed by a crash, **observe whether the adapter auto-disappeared** before marking `RECONCILED`. No `WintunDeleteAdapter`. |
| 6 | Export table out of sync; no ABI-check artifact | Export table is the **verbatim 0.14.1 `Wintun_*_FUNC` set** (§3.0) including `WintunOpenAdapter`, `WintunGetRunningDriverVersion`, `WintunSetLogger`, and exported-but-forbidden `WintunDeleteDriver`; removed the non-existent `WintunFreeSendPacket`. **Build-time `dumpbin`/`GetProcAddress` ABI check** added (§3.0, §13). |
| 7 | G1 probe wording was "one-shot minimal" | **Renamed/expanded to the G1 lifecycle probe** (§3.3, §12, §13): create + hold creator handle → mihomo opens by Name + starts a session → helper closes the creator handle/exits → verify session + adapter persist; the probe **never runs on this machine** (needs a snapshot-able, out-of-band-recoverable Windows VM + gated CI + separate owner authorization). |

### 0.4 Round 5 review fixes (rev.6 — retained)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Helper lifecycle still "a fresh helper per enable/disable"; disable can't reach the old creator handle | **Unified to one resident model** (§3.3, §5.5): one **per-enable single-client helper**. `enable` activates it; it binds the single client, creates the adapter, and holds the **creator handle for the whole enabled window** (`resident-active`, §3.4); `disable` is served by that **same instance** over the **same COM proxy**. No "fresh helper per transaction" wording remains. |
| 2 | No definition of an app/mihomo abnormal exit | **Added** (§3.4): helper **duplicates and watches both** the bound-app and mihomo process handles; on either abnormal exit it runs a **bounded emergency restore** (routes/DNS first → close the creator handle → persist outcome → exit). On restore failure it **still closes the creator handle** and **keeps the journal** for the next recovery. Timeouts distinguish **active idle** from handshake/command timeouts; **no idle exit while resident-active**. |
| 3 | No definition of the helper's own crash | **Added** (§3.4): on helper death **Windows auto-closes the creator handle ⇒ adapter removed** (0.14.1). The next `init()`/`--recover` **launches a new recovery helper** that **does not** claim to call `WintunCloseAdapter`, **verifies the adapter is gone**, and restores residual routes/DNS; if the adapter still exists but the new helper **can't prove/own the creator handle**, it **marks a conflict**, **keeps evidence**, and **does not delete** it (D5). |
| 4 | Confusing B1/B2 architecture naming | **Removed** (§3.3, §12, §13). Replaced with **Observed A** (adapter disappears on creator close) / **Observed B** (mihomo handle keeps it alive). The **safety baseline is fixed** — helper holds the creator handle for the whole enabled window — and **does not depend on** the observation. G1 proves mihomo **reuses the same adapter**; the A/B observation only decides a future optimization, never the baseline. |
| 5 | COM server labelled a "short-lived transaction server" | **Re-labelled per-enable single-client resident server** (§5.5), with an **exhaustive** exit-condition list (normal disable; enable-failure recovery; bound client/kernel death after emergency restore; handshake-phase timeout; explicit global max recovery timeout). **No idle timeout while resident-active.** |
| 6 | WOW64 path written as `HKLM\Software\WOW6432Node\Software\Classes` | **Fixed** (§5.1): describe the view with the **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY`** flags; and since the product ships **amd64/arm64 helpers only**, we explicitly **do not register a 32-bit COM helper** (so no 32-bit/WOW64 view is ever created). |
| 7 | State machine and tests not expanded for the resident model | **Added** (§10.2 helper `resident-active` state; §13 tests): enable → long no-IPC ⇒ adapter still present; disable uses the **same helper PID** (enable PID == disable PID recorded in evidence); three **distinct** recovery paths (app crash / mihomo crash / helper crash); new recovery helper has **no old creator handle**; helper crash ⇒ adapter gone + routes/DNS restored. |

### 0.5 Round 6 review fixes — the two security blockers (rev.6 — retained)

| # | Finding (blocker) | Resolution (this document) |
|---|---|---|
| 1 | COM ACL/SDDL used `DENY Everyone` + `DENY built-in Users` + `ALLOW some-interactive-user-SID`, which locks the legitimate user out (the owner is a member of Everyone and Users) | **Pure allow-list DACL** (§5.1): `LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`; `AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)` (**explicit COM rights masks** `0xB` = EXECUTE|EXECUTE_LOCAL|ACTIVATE_LOCAL; `0x3` = EXECUTE|EXECUTE_LOCAL; **no generic `GX`**). **No** `DENY Everyone`/`DENY built-in Users`, **no** `Everyone`/`Users`/`Authenticated Users`. **No `DENY` at all** (a complete pure allow-list denies by absence; `ANONYMOUS LOGON`/`NETWORK` are denied that way too). SYSTEM (local start/activate/access); the install-time owner SID (Local Launch/Activate/Access); Administrators only for install/repair and **not** in `AccessPermission`. **Per-ACE table** (object SID / allow-deny / permission bits) + **AccessCheck** verification (test `T24`). |
| 2 | Trusted recovery state was "app-data (Medium/High)" — vague and user-writable | **Deterministic store** (§8.0): `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`. Created by the **elevated helper**; owner = SYSTEM; **resolvable pure allow-list SDDL** `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)` (owner SYSTEM; `SY`/`BA` `GA`; **no owner SID ACE** — helper reaches it via `BA` since it runs as an admin; Medium has `BA` deny-only + no ACE + High label); **`High` mandatory-integrity label** (`NW`/`NO_WRITE_UP`, `HI` = `S-1-16-12288`) — the Medium/High split requires MIC + the missing owner ACE (the helper and the Medium UI share one SID, so the ACL alone cannot separate them). The owner UI reads **sanitized** state **only** via helper COM (never raw baseline/journal). Every record written by the helper only; each file opened with `FILE_FLAG_OPEN_REPARSE_POINT` (+ `FILE_FLAG_BACKUP_SEMANTICS`), **rejects** symlink/junction/mount/reparse point, reuses a held handle + `FileIdInfo` re-verify (never re-opens by string path), writes temp → `FlushFileBuffers` → `ReplaceFile`/atomic rename, and **never follows a user-controllable path**. Upgrade/uninstall **retain** the dir, cleaned only after a safe recovery completes. |
| 3 | Integrity phrased as "HMAC/digest or at least digest" (optional) | **Deterministic integrity contract** (§8.0, C12): the primary security boundary is the **Medium-unwritable DACL + integrity label**, not a digest a same-user attacker can re-write; records still carry `schemaVersion` + SHA-256 to detect **corruption**; the **HMAC claim is removed** (no key location/generation/DPAPI/rotation/upgrade-read path exists); the channel envelope MAC (§4.3) is a separate per-message authenticator, not a disk-state claim. Any read failure, wrong ACL, wrong owner, discovered reparse point, or schema/digest anomaly ⇒ **zero network mutation** + `restore-failed`. |
| 4 | WAL not defended against directory substitution | **Directory-replacement defense** (§8.0, §8.3): on `init`/`--recover` validate the store dir owner/DACL/reparse; before each `PREPARED`/`APPLIED`/`RECONCILED` append re-verify the already-open handle still points to the same file/dir (file ID) — **never** re-open via string path; tests added for crash-then-truncation, tampering, junction/symlink, ACL-changed, and directory-swapped (`T25`–`T30`). |
| 5 | Threat-model C12 said "snapshot and journal are HMAC/digest-protected or at least digest" | **C12 rewritten** to the deterministic contract (above), and C2/C3 harmonized to the **pure allow-list** ACL (no `DENY Everyone`/`DENY Users`); a same-user Medium attacker **cannot write** the state directory (only the High helper can); tamper/corruption always **fail closed**. |

### 0.6 Round 7 review fixes — security-descriptor contract (rev.7 — this revision)

| # | Finding (round 7) | Resolution (this revision) |
|---|---|---|
| 1 | COM `LaunchPermission`/`AccessPermission` used a generic `GX` and relied on a hand-interpreted `GX → COM rights` mapping (and allowed an extra `DENY ANONYMOUS LOGON`/`NETWORK`) | **Explicit COM rights masks** (§5.1): `Launch` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)` (`0xB` = `EXECUTE 0x1 | EXECUTE_LOCAL 0x2 | ACTIVATE_LOCAL 0x8`); `Access` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)` (`0x3` = `EXECUTE | EXECUTE_LOCAL`). Each ACL uses **one uniform new-style mask**, every ACE **contains `0x1`**, and there are **no `DENY` ACEs** (a complete allow-list denies by absence). |
| 2 | State-directory ACL was described per-ACE with `GR → GW` + traverse arrows and a wrong-number-of-semicolons SACL | **One resolvable complete SDDL** (§8.0): `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`; **no owner-SID file ACE** (Medium has no raw read; UI is COM-sanitized only), no arrows, exact mask `GA` for `SY`/`BA`, `HI` = `S-1-16-12288`, `NW` = `NO_WRITE_UP`, `OICI` inheritance. |
| 3 | No tests proved the descriptor-build/verification chain | **Descriptor-build tests** (§13): `ConvertStringSecurityDescriptorToSecurityDescriptor` succeeds; `MakeSelfRelativeSD` succeeds; the `REG_BINARY` value round-trips byte-identical; `GetSecurityInfo` reads back the DACL/SACL; `AccessCheck` verifies Launch (owner=allow, second user=deny, SYSTEM=allow) and Access (owner=allow, second user=deny); every COM ACE mask is **strictly** `0xB`/`0x3` and **contains `0x1`**; directory **High** mandatory label present with `NO_WRITE_UP`; **Medium** owner write/delete/change-ACL **fails** while **High** helper **succeeds**. |
| 4 | Install doc component table split the state into "app-data (Medium/High)" vs the `%ProgramData%` store | **Unified** (install doc §1): `BaselineSnapshot`/`WrittenState`/`MutationJournal` + ownership/version manifest all live in `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`, helper-owned / SYSTEM owner / **High integrity** / **Medium-not-writable**; the stale "app-data (Medium/High)" description is deleted. |


---

## 1. Architectural layering and the single owner per plane

### 1.1 Ownership split (item 3 — one owner per plane)

Each plane has exactly one owner:

| Plane | Owner | Responsibility |
|---|---|---|
| **TUN data plane** (adapter packet session) | **mihomo** (supervised kernel, `tun.stack: system`) | Opens/reuses the adapter, reads/writes packets. It must **not** modify routes or DNS. |
| **OS network-config plane** (driver install/load + route/DNS/interface mutation + baseline + recovery) | **helper** (elevated broker) | Calls `WintunCreateAdapter` (which installs/loads the driver on demand), applies the typed `DesiredNetworkState`, records/restores the baseline. The only route/DNS/interface modifier. |
| **Decision plane** (which routes/DNS/interface to set) | **main process** | Derives a precise typed `DesiredNetworkState` from the validated mihomo config (§9); the helper executes it verbatim. |

**Option A (chosen).** The helper is the **sole** OS network-config owner. Therefore:

- mihomo's synthesized runtime config has `auto-route:false`, `auto-detect-interface:false`,
  and `dns-hijack:false` — mihomo never adds/removes a route or hijacks DNS.
- The main process generates `DesiredNetworkState` (a pure, typed function — §9) and the
  helper applies exactly that; the helper does **not** read mihomo's config itself and is
  never handed raw command text.
- Because Option A is exclusive, mihomo **cannot** be given `auto-route`/`dns-hijack`.
  Choosing Option B (mihomo owns routes/DNS) is explicitly rejected: it would require the
  helper to give up per-item ownership/recovery of routes/DNS and adopt a different
  observable/restore contract, and it would make mihomo (Medium IL) responsible for
  OS mutations that need elevation.

The helper therefore **never holds a Wintun packet session and never touches a packet
buffer**. There is exactly one TUN data-plane owner (mihomo) and one OS-network-config
owner (helper); they are coordinated over the authenticated channel (§5) with typed,
validated commands.

### 1.2 Layering diagram

```
renderer ── typed window.desktop.tun.*  (intent + status only; §6)
   │ validated Electron IPC (ipc.ts tun:* intent channels)
   ▼
main ── TunService (service.ts)         state machine + serialized ops + probe + backup
   │      getStatus / init / enable / disable / onStatus
   ▼
main ── policy.ts                       pure helpers: derive DesiredNetworkState,
   │                                    ownership/merge/format (no I/O)
   ▼
main ── adapters/WindowsTunAdapter      privileged boundary: helper client,
   │                                    integrity verify, baseline snapshot/recovery
   ▼
main ── PrivilegedHelperClient          elevation-COM IPC + envelope (§5)
   ▼
elevated ── helper.exe (High IL)        broker: WintunCreateAdapter (driver on demand),
   │                                    apply DesiredNetworkState, snapshot/recover, verify;
   │                                    NO packet session
   ▼
wintun.dll (official, per-arch) ──► signed Wintun kernel driver (loaded inside the
                                    DLL during WintunCreateAdapter, not by a
                                    standalone "load driver" step)
   ▼
mihomo ── opens/reuses the adapter     the ONLY data-plane owner (G1 gate)
```

Non-Windows builds use a `DisabledTunAdapter` returning `{ supported:false,
phase:'unsupported' }` with zero mutation (a fake adapter backs the dev/test path).

### 1.3 Adapter-handoff: an unproven hypothesis (G1), not a settled contract

The data-plane owner is mihomo. The OS-network-config owner is the helper, and the
helper is the only component that can install/load the Wintun driver (it requires
elevation). Therefore the architecture must answer: **can mihomo open and reuse the
adapter that the helper created via `WintunCreateAdapter`?** This is **G1**.

- G1 is **NOT established**. It must be proven by a **real mihomo Windows integration
  test** (gated `windows-latest` job) that mihomo can `WintunOpenAdapter(Name)` (open the
  existing adapter by its stable product name) and run its packet session against the
  adapter the helper created, with no packet handle transferred across the boundary.
- Until G1 passes, the design **does not claim** the handoff works; it is a hypothesis
  with documented steps, a blocking gate, and a re-open path:
  - If G1 **passes**: mihomo opens the helper-created adapter; helper stays with the
    sole OS-network-config role; data plane stays with mihomo. This is the intended path.
  - If G1 **fails** (mihomo cannot reuse a helper-created adapter — e.g. it always
    creates its own): the design **stops and returns to the owner** for a revised
    ownership decision, because the round-2 constraint is that there is **one** OS
    network-config owner and **one** data-plane owner. The design must not silently
    fall back to dual ownership.
- Steps the design fixes **now** (independent of the G1 outcome):
  1. The helper calls `WintunCreateAdapter(Name, TunnelType, RequestedGUID)` while
     elevated (official ABI, §3.0). It returns a `WINTUN_ADAPTER_HANDLE`; this is the
     **only** call that **installs/loads the signed driver on demand** and creates the
     adapter, addressed by the product-specific **name** (e.g. `"Murge TUN"`), **tunnel
     type**, and a product-specific stable **`RequestedGUID`**.
  2. The helper derives the **LUID** via `WintunGetAdapterLUID(Adapter, &luid)` (a `_Out_`
     param on the adapter handle) so the name/GUID→LUID mapping is obtained; it publishes
     `{ name, requestedGuid, luid }`. The helper **never opens a packet session**
     (`WintunStartSession`) and keeps only the adapter handle (not a session) so it never
     touches a packet buffer.
  3. The helper **pins + verifies** the LUID **before** the network-config phase (§10.1).
  4. The network-config phase applies routes/DNS/interface (§10.1). Routes/DNS are always
     written **after** the adapter exists (its LUID/index are known).
  5. mihomo opens/reuses the adapter and becomes the sole packet-I/O owner. **This is G1.**

> **Corrected from the earlier draft.** The Wintun API **does have a user-supplied
> `RequestedGUID` parameter** on `WintunCreateAdapter`. A "stable GUID" is therefore
> realized by passing a **product-specific, stable `RequestedGUID`**, so the adapter is
> addressable by a deterministic GUID for recovery (§3.2, §3.3); the **LUID** is derived
> from the adapter handle (`WintunGetAdapterLUID`) and is used as the routes/DNS/interface
> key. `WintunCreateAdapter` **fails** if the requested GUID is already in use (→
> `conflict`, zero mutation). The earlier claim that "Wintun has no user-supplied GUID
> parameter" is **withdrawn**. The uniqueness invariant stands: the helper enumerates
> Wintun adapters, asserts exactly one Murge adapter by `Name`+`RequestedGUID`, and fails
> closed if a foreign adapter already holds that identity.

---

## 2. Shared contract (`src/shared/tun.ts`)

### 2.1 Canonical `TunPhase`

```ts
export type TunPhase =
  | 'configured'      // supported & verified (helper/driver present), NOT active
  | 'starting'        // enabling: verify → elevate → snapshot → create adapter → apply
  | 'active'          // TUN up and owned by the app (adapter session open)
  | 'failed'          // non-recoverable failure (integrity, adapter create, capture)
  | 'restoring'       // tearing down to baseline (reverse journal order)
  | 'restore-failed'  // could not restore (not a conflict)
  | 'conflict'        // an externally-modified owned item; per-item (never all-or-nothing)
  | 'unsupported'     // platform/build cannot enable TUN
```

There is no separate `disabled`: "off but supported" is `configured`; "cannot be
enabled" is `unsupported`.

### 2.2 `TunStatus`

```ts
export interface TunStatus {
  supported: boolean
  phase: TunPhase
  deviceName: string | null      // Wintun adapter name while active, else null
  luid: string | null            // canonical hex NET_LUID string while active
  port: number | null            // mixed-port the TUN stack proxies to, while active
  stack: string | null           // mihomo tun.stack ("system") while active
  owned: boolean                 // app can prove it wrote the current routes/DNS
  errorMessage: string | null
  conflictDetail: string | null  // per-item detail (LUID/index, family, field)
  updatedAt: string | null
}
export const TUN_LOOPBACK_HOST = '127.0.0.1'
```

### 2.3 IPC channels + gateway (`src/shared/ipc.ts`, `src/shared/gateways.ts`)

```ts
// ipc.ts
tunGetStatus:   'tun:get-status',
tunEnable:      'tun:request-enable',   // INTENT, parameterless (§6)
tunDisable:     'tun:request-disable',  // INTENT, parameterless (§6)
tunStatusEvent: 'tun:status-event',

// gateways.ts
export interface TunGateway {
  getStatus(): Promise<TunStatus>
  requestEnable(): Promise<TunStatus>    // intent only; main performs the real op
  requestDisable(): Promise<TunStatus>   // intent only
  onStatus(l: (s: TunStatus) => void): () => void
}
```

---

## 3. Wintun distribution and on-demand adapter creation (items 1, 2)

### 3.0 Pinned ABI — fixed verbatim from the official wintun.h of the chosen version

The ABI is **pinned to Wintun **0.14.1**** (chosen stable release; the exact release
and its manifest hash are recorded in the release manifest and third-party notice —
**to be re-confirmed against the pinned release's `wintun.h` at implementation time**).
The contract below is copied from the **official `wintun.h`** so that our exported-symbol
and calling-convention assumptions cannot drift from the SDK.

**Source of record**

| Field | Value |
|---|---|
| Header | `wintun.h` from the official Wintun source/release (wintun.net; `git.zx2c4.com/wintun`); copy the exact `typedef`/prototypes into `src/main/tun/wintun-abi.ts` + a pinned `wintun.def` |
| Version | **0.14.1** |
| Architecture | per-arch DLL: `amd64`, `arm64`; **one DLL per arch, ABI fixed for that arch** (never cross-bundle) |
| Calling convention | `WINAPI` (`__stdcall`) on x86-64 (x64 ignores but keep correct for correctness); exported by name (DLL export table) |
| Handle types | `WINTUN_ADAPTER_HANDLE`, `WINTUN_SESSION_HANDLE` (opaque pointers; do not reinterpret elsewhere) |
| `NET_LUID` | 64-bit `NET_LUID` union; serialized as a **canonical hex string** in JSON (§8.1) |
| ABI source of record | **Official `wintun.h` at tag `0.14.1`** (checked into the repo verbatim; DO NOT hand-declare any symbol) — copy the exact `WINTUN_*_FUNC` typedefs into `src/main/tun/wintun-abi.ts` |
| Build-time ABI check | A build step runs `dumpbin /exports` (MSVC) or `llvm-readobj --coff-exports` against the pinned `wintun.dll` and asserts the **exported symbol name set exactly matches** the table above; a runtime check additionally resolves each name via `GetProcAddress` and asserts non-null before first use. A mismatch fails the build (no runtime fallback). |

**RequestedGUID note.** There **is** a user-supplied `RequestedGUID` parameter: passing a
product-specific, stable GUID makes the adapter addressable by that GUID for recovery.
If the GUID is already in use, `WintunCreateAdapter` fails (→ `conflict`, no mutation).
The stable identity for recovery is **`RequestedGUID` + `Name`**, and the wire identity is
the associated **`NET_LUID`**.

**Exported symbols (pinned from the official `wintun.h` of Wintun 0.14.1 — the single ABI source)**

The declarations in the 0.14.1 `wintun.h` are written as function-pointer `typedef`s
(`WINTUN_*_FUNC`); each has a `WINAPI` (`__stdcall`) calling convention. The functions
are:

```
WintunCreateAdapter          WINTUN_ADAPTER_HANDLE WINAPI (Name, TunnelType, RequestedGUID)
WintunOpenAdapter            WINTUN_ADAPTER_HANDLE WINAPI (Name)
WintunCloseAdapter           VOID WINAPI (Adapter)
WintunDeleteDriver           BOOL WINAPI (VOID)             // exported, production policy FORBIDS it
WintunGetAdapterLUID         VOID WINAPI (Adapter, NET_LUID *Luid)
WintunGetRunningDriverVersion DWORD WINAPI (VOID)
WintunSetLogger              VOID WINAPI (WINTUN_LOGGER_CALLBACK)
WintunStartSession           WINTUN_SESSION_HANDLE WINAPI (Adapter, DWORD Capacity)
WintunEndSession             VOID WINAPI (Session)
WintunGetReadWaitEvent       HANDLE WINAPI (Session)
WintunReceivePacket          BYTE *WINAPI (Session, DWORD *PacketSize)
WintunReleaseReceivePacket   VOID WINAPI (Session, const BYTE *Packet)
WintunAllocateSendPacket     BYTE *WINAPI (Session, DWORD PacketSize)
WintunSendPacket             VOID WINAPI (Session, const BYTE *Packet)
```

There is **no `WintunDeleteAdapter`** and **no `WintunFreeSendPacket`** in 0.14.1; either
must never appear in our code, ABI record or calls. `WintunOpenAdapter` **is** exported and
is how a second process (mihomo) opens an existing adapter by name.
`WintunDeleteDriver` **is** exported but the production policy **forbids calling it** — a
Wintun driver is a **shared system resource** that other Wintun consumers (e.g. the
WireGuard app) rely on; we must never remove a driver a pre-existing adapter or another
user may be using (D5).

**Pinned signatures (verbatim from the official 0.14.1 `wintun.h`)**

```c
typedef struct _WINTUN_ADAPTER *WINTUN_ADAPTER_HANDLE;
typedef struct _TUN_SESSION *WINTUN_SESSION_HANDLE;

// Creates a new Wintun adapter. RequestedGUID NULL => system-assigned GUID.
// Returns the adapter handle, else NULL (call GetLastError). Must be released with WintunCloseAdapter.
WINTUN_ADAPTER_HANDLE(WINAPI WINTUN_CREATE_ADAPTER_FUNC)(_In_z_ LPCWSTR Name, _In_z_ LPCWSTR TunnelType, _In_opt_ const GUID *RequestedGUID);

// Opens an existing Wintun adapter by name. Returns a handle, else NULL. Must be released with WintunCloseAdapter.
WINTUN_ADAPTER_HANDLE(WINAPI WINTUN_OPEN_ADAPTER_FUNC)(_In_z_ LPCWSTR Name);

// Releases adapter resources AND, if the adapter was created with WintunCreateAdapter, REMOVES the adapter.
VOID(WINAPI WINTUN_CLOSE_ADAPTER_FUNC)(_In_opt_ WINTUN_ADAPTER_HANDLE Adapter);

// Deletes the Wintun driver if there are no more adapters in use. Exported; FORBIDDEN by production policy.
BOOL(WINAPI WINTUN_DELETE_DRIVER_FUNC)(VOID);

VOID(WINAPI WINTUN_GET_ADAPTER_LUID_FUNC)(_In_ WINTUN_ADAPTER_HANDLE Adapter, _Out_ NET_LUID *Luid);

DWORD(WINAPI WINTUN_GET_RUNNING_DRIVER_VERSION_FUNC)(VOID);
```

> The 0.14.1 header declares these as **function-pointer typedefs** named `WINTUN_*_FUNC`
> (the `WINTUN_ADAPTER_HANDLE(WINAPI ...)` form). The **exported DLL symbols** resolved at
> runtime by `GetProcAddress` are the `Wintun*` names in the export table above
> (`WintunCreateAdapter`, `WintunOpenAdapter`, …). The build-time ABI check (§3.0 / §13)
> resolves each `Wintun*` symbol in `wintun.dll` and asserts its address matches the
> corresponding `WINTUN_*_FUNC` signature.

**Creator-handle lifecycle (the real 0.14.1 semantics)**

- `WintunCreateAdapter` returns the **creator handle**. This handle is the **lifetime
  anchor** of the adapter: per the 0.14.1 header, `WintunCloseAdapter` "releases
  resources and, **if adapter was created with `WintunCreateAdapter`, removes adapter**."
  There is **no** `WintunDeleteAdapter` and **no** `ERROR_REBOOT_REQUIRED`/`delete-pending`
  for adapter removal — removal is **closing the creator handle**, and the only
  reboot-visible artifact is the Wintun **driver** (which we never delete).
- `WintunOpenAdapter(Name)` — a **second** process (mihomo) opens **another handle** by name
  and calls `WintunStartSession(Adapter, Capacity)` to get its own packet session. The
  creator **handle** and the opened **handle** are distinct; both are released by
  `WintunCloseAdapter`.
- `WintunGetAdapterLUID(Adapter, &Luid)` derives the `NET_LUID` (routes/DNS key) from an
  adapter handle.
- **The data plane is owned by mihomo** (§1.1). The helper never opens a session; it only
  holds the **creator handle** for as long as TUN is enabled and releases it (closing =
  removing the adapter) at disable/rollback.
- **`WintunDeleteDriver` is never called.** We ship no `.sys` and never remove a driver that
  another adapter/user may rely on (D5).

### 3.1 Official distribution model

- **Ship the official per-arch `wintun.dll`, never a bare driver file.** The Wintun
  release is distributed at `https://www.wintun.net/` as a ZIP containing `wintun.dll`
  per architecture (`wintun/bin/amd64/...`, `wintun/bin/arm64/...`). The **kernel driver
  is installed/loaded by the DLL on demand**, and an application must **not** distribute
  a file named like the driver directly. All "install the .sys", "upgrade the .sys",
  "delete the .sys" steps are removed.
- **Per-arch bundling.** Bundle `wintun-amd64.dll` / `wintun-arm64.dll` as an
  `extraResources` near `resources/bin/<arch>` (the same per-arch model used for the
  pinned mihomo archive). Never cross-bundle the other arch.
- **Source.** From the official Wintun release (wintun.net); record the exact release
  version + URL in the third-party notice.
- **License / notice compliance.** Capture the Wintun license text from the official
  release, record its SPDX identifier, and add it to `resources/THIRD_PARTY_NOTICES.md`.
  Because the app is `GPL-3.0-only`, confirm compatibility and redistribution obligations
  **before** packaging (a compliance gate).
- **SHA-256 / integrity.** Set the exact per-arch `wintun.dll` SHA-256 in the pinned
  release manifest (same mechanism as `mihomo-artifact.ts`). Runtime re-verifies the
  digest before loading; mismatch ⇒ fail closed, do not load.
- **Signature verification.** `helper.exe` is Authenticode-signed with the project
  certificate and its publisher verified (C1). The Wintun **kernel driver** is installed
  by the DLL (`WintunCreateAdapter`) and is **required to be a signed driver** that
  Windows will load (the OS only loads signed kernel drivers). We do **not** self-sign,
  add a self-signed cert, or spoof the driver's signature. The `wintun.dll` is validated
  by its pinned digest; where Windows can report it, assert the loaded driver's publisher
  matches the Wintun publisher.
- **Safe loading.** `LoadLibraryEx(wintun.dll)` maps the DLL **only** — it does **not**
  install or load the driver. Use the **absolute path** in the (non-writable) install
  dir with the safe search flags (`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` /
  `SetDefaultDllDirectories`), never by short name, so a search-path hijack cannot
  substitute a DLL.

### 3.2 Adapter creation (the helper's elevated act) — correct ABI, no `load_driver` op

The `load_driver` op and every "load the driver once" step are **deleted**. The
installation of the Wintun driver is a **side effect of `WintunCreateAdapter`**, which
requires elevation and is called by the helper. There is therefore no op whose purpose
is "load the driver"; there is only `create_adapter`.

- **`create_adapter`** (helper, elevated). `LoadLibraryEx` the official DLL (absolute path,
  safe flags) → resolve the pinned exports (§3.0) → call:

  ```c
  WINTUN_ADAPTER_HANDLE h = WintunCreateAdapter(
      L"Murge TUN",          // product-specific, stable adapter name
      L"Murge TUN",          // stable opaque tunnel-type string
      &kProductRequestedGuid);// product-specific, stable RequestedGUID (never NULL)
  ```

  - `Name` and `TunnelType` are the **stable, product-specific** values.
  - `RequestedGUID` is a **product-specific stable GUID** so the adapter is addressable by
    a deterministic GUID for recovery (§3.3). If the GUID is already in use,
    `WintunCreateAdapter` **fails** → `conflict`, **zero mutation**.
  - The returned **`WINTUN_ADAPTER_HANDLE` is the creator handle**, and is **the sole
    lifetime anchor of the adapter** (§3.3). Do **not** reinterpret it as a LUID or a
    session.
- **Derive the LUID (routes/DNS key).** `WintunGetAdapterLUID(h, &luid)` (a `_Out_` param,
  on the adapter handle). Publish `{ name, requestedGuid, luid }` with `luid` as a
  **canonical hex string** (§8.1) — this is the key for routes/DNS/interface.
- **Do NOT start a session here.** The helper must **not** open a packet session
  (`WintunStartSession`). The data plane is owned by mihomo (§1.1), which will open its own
  handle with `WintunOpenAdapter(Name)` and start the session. The helper **keeps the
  creator handle open but never the session**.
- **Uniqueness / reservation.** Enumerate Wintun adapters; assert exactly one Murge adapter
  and that no foreign adapter already holds the reserved `Name`/`RequestedGUID`. Otherwise ⇒
  `conflict`, no mutation.
- **Recovery identity.** On restart/recovery, enumerate Wintun adapters and reconcile by
  **`Name` + `RequestedGUID`** (the GUID is the stable address; the LUID is derived per
  adapter). A leftover adapter from an un-applied `create_adapter` is recognized and either
  adopted (if it is this product's) or reconciled without mutation if not provably owned
  (§3.3, §8.4).
- **`probe_integrity`** verifies the helper digest/publisher + the `wintun.dll` digest; it
  does **not** load the driver and does **not** require elevation.

### 3.3 Handle lifecycle, handoff and the G1 ownership probe

**There is no `WintunDeleteAdapter`.** The **only** way a `WintunCreateAdapter`-created
adapter is removed is by calling **`WintunCloseAdapter(creatorHandle)`** — per the 0.14.1
header, closing an adapter handle "releases resources and, if adapter was created with
`WintunCreateAdapter`, **removes adapter**". There is **no `ERROR_REBOOT_REQUIRED`**
adapter-delete return and **no `delete-pending`** journal state (the only reboot-visible
artifact is the Wintun **driver**, which we never delete, and a route/DNS change, which the
helper always restores).

**The creator handle is the adapter's lifetime anchor — this is the central design fact.**

The helper creates the adapter, so it owns the **creator handle**. If the helper closes that
handle while TUN is still enabled, the adapter is removed. This is in **direct tension**
with the discarded "a fresh helper per enable/disable command" idea, which would exit as soon
as the enable transaction finishes: **if the helper exits, it closes its creator handle, and
the adapter disappears.**

The **safety baseline is fixed, not conditional on the probe** (§0.4/§5.5): the helper is
activated per enable, holds the **creator handle for the whole enabled window**, and closes it
only as the final step of `disable` or an emergency restore. So the helper **must
not** exit when the enable transaction completes. The **G1 lifecycle probe**'s job is to (1)
confirm mihomo reuses the same adapter (the actual handoff) and (2) observe whether the
adapter would survive a creator-close (Observed A/B) for a **possible future optimization
only** — it does not gate the baseline. G1 is still a **hard gate before any real TUN work**
(§12). It runs only in the gated disposable `windows-latest` CI
(`MURGE_RUN_REAL_TUN=1` + `win32`) on a snapshot-able, out-of-band-recoverable VM, with
separate owner authorization; it never runs on this dev machine (§0.0 / DEVELOPMENT_SAFETY).

**G1 lifecycle probe (defines the ownership model).** The probe exercises a-d and records
whether the adapter survives step (c):

1. **(a)** helper `WintunCreateAdapter` → holds the **creator handle**; `${name}` exists.
2. **(b)** mihomo `WintunOpenAdapter(name)` → **second handle** + `WintunStartSession` ⇒ a
   live data plane; `${name}` + LUID stable.
3. **(c)** helper **`WintunCloseAdapter(creatorHandle)`** → helper exits.
4. **(d)** observe: does mihomo's session and the adapter `${name}` **still exist**?

**Two observations — but they do NOT select the architecture.** The probe observes one of
these at (d). Both are recorded as evidence; neither decides the safety model below, which is
fixed:

- **Observed A — the adapter is removed when the creator handle closes.** This is what the
  0.14.1 header's wording implies and is the conservative expectation: removal is the creator
  handle's job, so a helper that closes it drops the adapter. **Because the product's safety
  baseline never relies on the adapter outliving the helper**, Observed A changes nothing in
  the model — it merely confirms the helper must stay for the whole enabled window.
- **Observed B — the adapter survives the creator-close while mihomo still holds its own open
  handle.** The adapter lives while some handle keeps it up; mihomo holds one at (d). Under
  Observed B it is conceivable that the helper could exit earlier — but this is a **future
  optimization only**, never the current baseline.

**Safety baseline (fixed — set independently of the probe).** The helper is activated per
enable, binds the single verified client, creates the adapter, and holds the **creator handle
for the entire enabled TUN window**; it only closes that handle (removing the adapter) as the
final step of `disable` or an emergency restore. So the helper's **process lifetime = TUN
enabled lifetime** (§5.5), and removing it is always the helper's own explicit, owned act. The
**G1 probe's required conclusion is that mihomo reuses the same adapter** (opens the same
`${name}` and runs a session); the creator-close **observation (A vs B)** only records whether
we could later optimize (e.g. let the helper exit on enable-completion), and **never** changes
whether the current safety model holds.

- **Enable / valid lifetime.** The helper is activated per enable; mihomo opens a second
  handle + session. The helper **keeps the creator handle open for the whole enabled window**
  and **does not exit** on enable-transaction completion or on idle — it enters a
  **resident-active** phase (§3.4/§5.5) and persists until `disable` or an emergency/exit
  condition. The enable order is therefore **fixed** and does not wait on the probe.
- **Disable / teardown.** main calls the **same** resident helper via the same COM proxy;
  mihomo calls `WintunEndSession` and `WintunCloseAdapter` on its open handle; the helper
  restores routes/DNS per item; the helper then `WintunCloseAdapter(creatorHandle)` — which
  **removes the adapter**; it writes `RECONCILED`, zeroizes keys, exits. No
  `WintunDeleteAdapter`, no `WintunDeleteDriver`.
- **Ownership verification is mandatory.** Before the helper closes the creator handle, it
  re-verifies the adapter is **this product's/instance's** (by `Name` + `RequestedGUID`, and
  the derived LUID); if it cannot prove ownership it **does not** touch the adapter and
  instead records `RECONCILED` with no mutation (§8.4). Pre-existing/shared adapters are
  never removed (D5).

### 3.4 Helper lifetime: resident-active, abnormal exits and helper crash (items 2, 3)

Two failure classes, each with an explicit **bounded** recovery path. Every path terminates
by closing the creator handle so we **never leave a TUN adapter with no data plane**; only a
successful restore ends without a pending journal item.

**Client / kernel abnormal exit (the app or mihomo dies while TUN is enabled).** The helper
**duplicates and watches both** the bound app process handle **and** the mihomo process
handle (the latter obtained when the helper launches/starts the session). While
resident-active it waits on those two handles (plus the command channel). If **either** exits
abnormally:

1. the helper enters a **bounded emergency restore** and first records the failure in the
   journal;
2. it **restores routes/DNS** per item (owned-only, reverse journal order, §8.3/§8.5);
3. **only then** it **closes the creator handle** (`WintunCloseAdapter(creatorHandle)`) — the
   adapter is removed (0.14.1 semantics), because an adapter with no data plane must not stay;
4. it **persists the outcome** (`RECONCILED`, or `RESTORE_FAILED` + preserved journal) and
   exits.

**If the restore fails**, the helper **still closes the creator handle** (so a TUN adapter
with no data plane is never left behind) and records `RESTORE_FAILED`, **keeping the journal**
so the next `init()`/`--recover` can finish the route/DNS restoration. The emergency restore
is capped by an explicit **global maximum recovery timeout**; on expiry it force-closes the
creator handle and exits with `RESTORE_FAILED`.

**The helper's own crash.** If the helper dies while resident-active, **Windows closes its
handles automatically**, and per the 0.14.1 header the adapter is **removed** (the creator
handle is gone). The next `init()`/`--recover` therefore launches a **new recovery helper**:

- the new helper **does not have the old creator handle**, so it **must not record that it
  called `WintunCloseAdapter`** — it did not; the adapter is gone because the OS closed the
  handle;
- it **verifies the adapter is gone** (enumerate by `Name`/`RequestedGUID`/LUID — absent) and
  **restores any residual routes/DNS** item by item against the snapshot/journal (§8.4), then
  writes `RECONCILED`;
- if the adapter **abnormally still exists** but the new helper **cannot prove/own the
  creator handle**, it **marks a conflict**, **preserves the evidence** (snapshot + journal +
  adapter-enumerate result), and **does not touch or delete the adapter** — it never removes a
  pre-existing/foreign adapter (D5). Recovery stops with a conflict, not a destructive delete.

Because enable and disable share the **same helper instance** (§5.5), the creator handle it
closes at disable is the one it owns; recovery only ever handles the cases above. The
distinction between **active idle** and **handshake/command timeout** is explicit: timeouts
apply only to the brief pre-bind handshake window and to individual command request/response
(§4.4) — **never** to a resident-active helper with no IPC traffic.

---

## 4. Helper IPC, authentication and key lifecycle (items 4, 5)

### 4.1 Why the earlier named-pipe/inheritance scheme is rejected

- `ShellExecuteEx(verb=runas)` (the UAC route) creates the elevated process **via the
  shell/elevation broker**; it does **not** propagate a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
  from the caller. **Handles therefore cannot be inherited across `runas`.** Any design
  that has the app create both pipe ends and hand one end to the helper by inheritance is
  not executable through UAC.
- A channel whose endpoint is only a random name + SDDL + a user-readable secret cannot
  stop a **same-user** Medium-IL process from impersonating the app: the endpoint name,
  any `launchSecret` on a command line, in an environment variable, or in a regular file /
  user-registry value is readable by a same-user process, and a same-user actor shares
  the user SID that the DACL grants.

So the design switches to the **Windows-officially-supported secure bootstrap: an
elevated out-of-proc COM server** (the helper), where the OS (AppInfo elevation broker)
authenticates and mediates the rendezvous, so no custom handle must cross elevation and
no same-user secret is placed in a user-readable medium (§5).

### 4.2 Command envelope (schema-validated in the helper) + canonical MAC

```ts
interface HelperCommand {
  v: 1
  op: HelperOp                 // allowlist below
  requestId: string            // monotonic uint64 as a decimal string (§8.1)
  mac: string                  // HMAC-SHA256 over the canonical encoding (§4.3)
  payload: HelperPayload       // op-specific, JSON-schema validated
}
type HelperOp =
  | 'probe_integrity'    // verify helper+wintun digest/publisher (no mutation, no elevation)
  | 'create_adapter'     // WintunCreateAdapter: installs/loads driver + creates adapter (WAL)
  | 'apply_network_state'// apply the typed DesiredNetworkState (routes/DNS/interface) (WAL)
  | 'close_creator_handle'// WintunCloseAdapter(creatorHandle): REMOVES a create-created adapter (§3.3) (WAL)
  | 'snapshot'           // capture/save the BaselineSnapshot BEFORE mutation
  | 'restore'            // per-item owned-only restore, reverse journal order (§8.4)
  | 'get_status'
  | 'health'
```

Rules enforced in the helper:

- `op` outside the allowlist ⇒ reject. `v` must be `1`. `payload` validated against the
  op schema before any side effect. Size-capped (e.g. 4 KiB). No arbitrary path, no raw
  command string, no free-text script.
- `apply_network_state` carries the **typed `DesiredNetworkState`** (_§9_), never
  free-form CLI text. The helper is not a shell.

### 4.3 Key lifecycle and canonical MAC encoding (item 5)

**Secrets.** Two secrets exist: the one-time `launchSecret` (bootstrap only) and the
`sessionKey` (channel lifetime).

- `launchSecret` (256-bit): used **only** to derive `sessionKey` at handshake. Zeroized
  (`RtlSecureZeroMemory`) **immediately after** the handshake completes — it is never
  used again.
- `sessionKey` (derived with HKDF-SHA256(launchSecret, per-session salt + peer-role
  string), 256-bit): the only key used for the message MAC. **Retained for the life of
  the channel** and zeroized only on **channel close / task end** (never earlier, so it
  is available for every message of an active operation).
- **Zeroize on all paths.** `RtlSecureZeroMemory` runs (a) on normal channel close,
  (b) on handshake/command timeout, (c) on exception, and (d) on helper process exit
  (a dedicated cleanup in an `__try/__finally`-style guard plus a process-exit handler
  and a `TerminateGracefully` path). Neither key is ever logged, passed to the renderer,
  or persisted. The app's client zeroizes its copy of `launchSecret` after the handshake
  and its `sessionKey` on teardown.

**Canonical MAC encoding.** The MAC is **not** a bare concatenation such as
`v|op|requestId|payload` (ambiguous because fields may contain the separator and are of
variable length). Instead each field is **length-prefixed** and the payload is canonical:

```
encode(field) = u32le(byteLength(field)) || fieldBytes
canonicalJSON(payload) = minimal/sorted-key, stable JSON of the op payload
mac = HMAC-SHA256(sessionKey,
        encode("v=1")        ||
        encode(op)           ||
        encode(requestId)    ||
        encode(canonicalJSON(payload)))
```

`requestId` is serialized as its 8-byte big-endian uint64 value for the MAC (canonical
numeric), and its wire form is the decimal string. This removes all ambiguity and is
byte-deterministic so both sides compute the same MAC.

### 4.4 Replay, ordering, timeouts

- `requestId` is **monotonic** within a session (a per-session uint64 sequence). A
  bounded replay cache keyed by `requestId` rejects duplicates; a stale/out-of-order id ⇒
  close. (A fresh session's ids never collide because the sequence resets with a fresh
  `sessionKey` and is scoped by the `sessionKey`'s HKDF salt.)
- The helper enforces a **bootstrap handshake timeout** (e.g. 5 s, the pre-bind window) after
  which it exits, a **per-command request/response timeout**, and a **handshake/idle-connect
  timeout on the channel**. These timeouts apply **only** to the brief handshake window and to
  an individual command — they are **not** an idle timeout on a resident-active helper (§3.4,
  §5.5), which must stay up with zero IPC traffic.
- Because the transport is an authenticated COM channel (§5), the OS already provides
  per-message integrity + privacy; the envelope MAC + `requestId` is a **second layer**
  (application-level integrity + replay defense), which is why the key lifecycle above is
  still required.

---

## 5. Elevation + IPC bootstrap (item 4) — executable Win32 sequence

The helper is an **elevated, out-of-proc COM server**; the app is the COM **client**;
the **Windows elevation broker (AppInfo)** is the rendezvous. **No handle is inherited
across elevation** (this is the officially-supported alternative), and **no same-user
secret is placed in a user-readable medium** (the secret is exchanged inside the
authenticated COM call).

### 5.1 Parties and registration (COM Elevation Moniker)

The helper is an **elevated, out-of-proc COM server**; the app is the COM **client**;
the **Windows elevation broker (AppInfo)** is the rendezvous. The client activates the
server through the **COM Elevation Moniker** — the officially documented way to request an
elevated COM server — **not** by a plain `CoCreateInstance` on a `requireAdministrator`
server.

| Side | IL | Role | Build |
|---|---|---|---|
| `.exe` main app (`electron` main) | Medium | COM **client**; the only holder of the `PrivilegedHelperClient` | Electron main |
| `helper.exe` | High (elevated) | COM **server**; the elevated broker | Native, `requireAdministrator`, no console, no network listener |

`helper.exe` is registered **machine-wide** (HKLM, so a per-user `HKCU` registration cannot
override it) as an out-of-proc COM server under a dedicated **`AppID`**:

**`HKLM\Software\Classes\CLSID\{CLSID_PrivilegedHelper}`**

| Value | Value |
|---|---|
| (default) | `Murge Privileged Helper (elevated)` |
| `LocalizedString` | `@C:\Program Files\Murge\resources\bin\helper.exe,-101` |
| `LocalServer32` (default) | `C:\Program Files\Murge\resources\bin\helper.exe` — **absolute path** |
| `LocalServer32\ServerExecutable` | `C:\Program Files\Murge\resources\bin\helper.exe` — explicit module name for the moniker |
| `LocalServer32\AppID` | `{AppID_PrivilegedHelper}` |
| `Elevation\Enabled` | **REG_DWORD `1`** (elevation allowed by the moniker) |
| `Elevation\IconReference` | `@C:\Program Files\Murge\resources\bin\helper.exe,0` — **optional** (custom UAC icon) |

**`HKLM\Software\Classes\AppID\{AppID_PrivilegedHelper}`**

| Value | Value |
|---|---|
| (default) | `Murge Privileged Helper` |
| `RunAs` | **`Interactive User`** — required so the server is activated as the current interactive user's high-integrity token (Activate-as-Activator / Interactive User semantics, per the elevation moniker). **Not** a named/known account. |
| `LaunchPermission` | **Pure allow-list DACL** with **explicit COM rights mask `0xB`** (`EXECUTE|EXECUTE_LOCAL|ACTIVATE_LOCAL`), no `Everyone`/`Users`/`Authenticated Users`, no deny that shadows the owner. Grants local launch + local activation to the authorized user principal, `SYSTEM`, and `Administrators` (install/repair) only. See the exact SDDL + ACE table (+ descriptor-build tests) below. |
| `AccessPermission` | **Pure allow-list DACL** with **explicit COM rights mask `0x3`** (`EXECUTE|EXECUTE_LOCAL`) — grants local access (call/connect) to the authorized user principal + `SYSTEM` only. `Administrators` is **not** granted ordinary call access (it is in the launch list only for install/repair). See the exact SDDL + ACE table below. |

> **Round-6/7 — the DACL is a pure allow-list, never a deny-then-allow, and carries no `DENY`
> at all.** A `DENY Everyone` + `DENY Users` + `ALLOW <ownerSID>` pattern is **rejected**: the
> authorized user is a member of both `Everyone` and `Users`, so the explicit `DENY` entries win
> over the `ALLOW` and the legitimate owner is locked out of activating/calling the helper.
> Instead the DACL is a **complete allow-list** of positive ACEs only — absent SIDs get **no
> effective access** (deny-by-default on a complete DACL). Because the allow-list is complete,
> **no `DENY` ACE is added** (not even `ANONYMOUS LOGON`/`NETWORK`): adding a `DENY` only
> introduces ACE-order / deny-override risk and is unnecessary here, since principals with no
> `ALLOW` ACE already get no access.
>
> **LaunchPermission SDDL** — `D:P` (protected, no inheritance); every ACE uses the **explicit COM rights mask `0xB`** (a single, uniform format; **no** generic `GX`):
> ```
> D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)
> ```
> where each `A;;0xB;;;…` = **Allow** with `COM_RIGHTS_EXECUTE (0x1) | COM_RIGHTS_EXECUTE_LOCAL (0x2) | COM_RIGHTS_ACTIVATE_LOCAL (0x8)`.
>
> **AccessPermission SDDL** — `D:P` protected; every ACE uses the **explicit COM rights mask `0x3`** (single uniform format):
> ```
> D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)
> ```
> where each `A;;0x3;;;…` = **Allow** with `COM_RIGHTS_EXECUTE (0x1) | COM_RIGHTS_EXECUTE_LOCAL (0x2)`.
>
> **No mix of old and new ACEs, and no extra `DENY`.** Every ACE in an ACL uses the **same
> new-style mask** and every one contains **`0x1`** (`COM_RIGHTS_EXECUTE`) — there is **no**
> legacy `0x1`-only ACE mixed alongside a `0x3`/`0xB` ACE. The DACL is a **complete pure
> allow-list**; absent SIDs get **no effective access** (deny-by-default), so **no `DENY`
> `ANONYMOUS LOGON`/`NETWORK` ACE is added** (that only adds ACE-order / deny-override risk and
> is unnecessary on a complete allow-list). `SY` = `S-1-5-18`, `BA` = `S-1-5-32-544`, and
> `<ownerSid>` is the interactive-user SID (`S-1-5-21-<dom>-<rid>`) resolved at install.
>
> These registry values are a **binary `SECURITY_DESCRIPTOR`** (the SDDL string above is the
> `ConvertStringSecurityDescriptorToSecurityDescriptor` source form, `SDDL_REVISION_1`). The
> mask is the **actual COM rights mask**, so there is **no generic-rights → COM-rights
> translation to assume**; the value is written verbatim. Launch grants launch+activate-local;
> Access grants call/connect local. Because **no `COM_RIGHTS_*_REMOTE` bit and no `GA`/`GW` are
> granted**, a network/remote activation or access is denied by DCOM, which also backs the
> "local `ncalrpc` only" requirement in §5.2.
>
> **Per-ACE table** (each `A;;` = Allow; the DACL contains **no `DENY`**):

> | SDDL | ACE | Object SID | allow / deny | COM rights mask | Effective COM rights | Why |
> |---|---|---|---|---|---|---|
> | `Launch` `D:P(A;;0xB;;;SY)…` | `A` | `SYSTEM` `S-1-5-18` | **allow** | `0xB` | `EXECUTE (0x1) + EXECUTE_LOCAL (0x2) + ACTIVATE_LOCAL (0x8)` | The SCM/RPCSS must be able to launch + activate the out-of-proc server; local only. |
> | `Launch` `…(A;;0xB;;;BA)…` | `A` | `Administrators` `S-1-5-32-544` | **allow** | `0xB` | `EXECUTE + EXECUTE_LOCAL + ACTIVATE_LOCAL` | Install/repair can launch/activate (`BA`); **not** granted ordinary call access (absent from `AccessPermission`). |
> | `Launch` `…(A;;0xB;;;<ownerSid>)…` | `A` | Owner user SID `S-1-5-21-<dom>-<rid>` (resolved at install) | **allow** | `0xB` | `EXECUTE + EXECUTE_LOCAL + ACTIVATE_LOCAL` | The **only** interactive user that may launch/activate the helper. |
> | `Access` `D:P(A;;0x3;;;SY)…` | `A` | `SYSTEM` `S-1-5-18` | **allow** | `0x3` | `EXECUTE (0x1) + EXECUTE_LOCAL (0x2)` | The SCM may complete the connect; local only. |
> | `Access` `…(A;;0x3;;;<ownerSid>)…` | `A` | Owner user SID `S-1-5-21-<dom>-<rid>` | **allow** | `0x3` | `EXECUTE + EXECUTE_LOCAL` | The **only** interactive user that may call the helper. `Administrators`, `Everyone`, `Users`, `Authenticated Users` are **absent** ⇒ no effective access. |
>
> **`AccessCheck` verification is required (see §13 descriptor-build tests).** Build the actual
> `SECURITY_DESCRIPTOR` from the stored binary value (or the SDDL above) and assert:
> **owner SID allowed**, **a second normal user denied**, **SYSTEM allowed** for both
> `LaunchPermission` and `AccessPermission`; every COM ACE mask is **strictly** `0xB` or `0x3`
> and **contains `0x1`**; `ConvertStringSecurityDescriptorToSecurityDescriptor` and
> `MakeSelfRelativeSD` succeed; the `REG_BINARY` value round-trips byte-identical; and
> `GetSecurityInfo` reads back the same DACL. (No `ANONYMOUS LOGON`/`NETWORK` ACE is present;
> they are denied by absence on the complete allow-list.)




> Because the server is activated via the **elevation moniker**, `RunAs` must be
> **`Interactive User`** (the moniker's Activate-as-Activator / interactive-user model).
> If you instead configured a specific account in `RunAs`, the elevation moniker would not
> operate in the documented interactive-user fashion; the design therefore explicitly
> rejects a named-account `RunAs`.
>
> The `LocalServer32` path and the optional `ServerExecutable` value must be **absolute and
> in the non-writable install dir**, so a search-path/DLL hijack cannot substitute a binary.
> `Elevation\Enabled` is a **REG_DWORD `1`**, NOT the string `"Enabled"` (a string value is
> not honored by the COM elevation broker). There is **no `ThreadingModel`** under
> `LocalServer32` for an out-of-proc server — it is not a documented/meaningful value here,
> so it must not be emitted.
>
> **Bitness / WOW64 registration location.** Registration goes into the **registry view
> that matches the helper binary's bitness**, selected **explicitly with the
> `KEY_WOW64_64KEY` / `KEY_WOW64_32KEY` flags** on the `RegCreateKeyEx`/`RegOpenKeyEx` calls
> — **not** by spelling out a `WOW6432Node` path, so we never name a `HKLM\Software\Classes`
> variant or a `HKLM\Software\WOW6432Node\Software\Classes` subtree as a literal path. The
> product ships **amd64 and arm64 helpers only (no 32-bit helper)**, so we explicitly
> **register only the 64-bit COM view (`KEY_WOW64_64KEY`)** and **do not register a 32-bit
> COM helper at all**. The running helper is **the same bitness as the Wintun DLL it loads**
> (`wintun-amd64.dll`/`wintun-arm64.dll`, §3.1); because there is no 32-bit helper there is
> no 32-bit registration to produce, and mixing bitness (a 32-bit moniker against a 64-bit
> registration or vice versa) is a registration mismatch the installer must never produce.

### 5.2 Steps (each: process, API, who creates/connects, UAC API, handle inheritance)

1. **Client COM init (app, Medium).** `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)`;
   `CoInitializeSecurity(NULL, -1, NULL, NULL, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
   RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_SECURE_REFS | EOAC_STATIC_CLOAKING, NULL)`.
   This pins **packet-privacy authentication** and **impersonation** for the activating
   process. The app does **not** pre-launch the helper and does **not** use
   `runas`/`ShellExecuteEx` — it activates the COM server (step 2) and the OS requests
   elevation.
2. **Activation via the Elevation Moniker (UAC is the elevation API).**
   ```c
   BIND_OPTS3 bo = {};
   bo.cbStruct  = sizeof(bo);
   bo.hwnd      = hwnd;                    // parent window that owns the UAC prompt
   bo.dwClassContext = CLSCTX_LOCAL_SERVER;
   HRESULT hr = CoGetObject(
       L"Elevation:Administrator!new:{<CLSID_PrivilegedHelper>}",
       &bo, IID_PPV_ARGS(&pHelper));
   ```
   `CoGetObject` with the **`Elevation:Administrator!new:{CLSID}`** moniker is the
   elevation-request point — triggered only by an explicit user action (§10.1 enable).
   The **elevation broker (AppInfo)** shows UAC and starts `helper.exe` at **High IL** by
   the (interactive-user) object the moniker names, honoring the manifest's
   `requireAdministrator`.
3. **Server side (helper, High).** Registers its class factory under its CLSID/AppID, runs
   at High IL. **Handle inheritance:** the design does **not** use
   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`; it requires **no inherited handle** (elevated
   activation via the moniker cannot propagate one).
4. **Channel.** The authenticated COM interface **is** the channel; each request is the
   schema-validated `HelperCommand` envelope (§4) passed as a length-prefixed, size-capped
   byte blob/`IStream`. **No app-created named pipe** and hence no endpoint name leaked to a
   user-readable medium. Before servicing a call the server enforces privacy on the proxy:
   `CoInitializeSecurity(..., RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
   RPC_C_IMP_LEVEL_IMPERSONATE, ...)`; the client sets the same on its proxy with
   `CoSetProxyBlanket(pHelper, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, NULL,
   RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_NONE)`.
5. **Helper authenticates the app (identity binding).** On each privileged call the helper:
   - `CoImpersonateClient()` (and `RpcImpersonateClient()` for pure-RPC parity), then
   - `RpcServerInqCallAttributes(call, RPC_CALL_ATTRIBUTES_V2, &atts)` with
     `atts.Version = 2` and **`atts.Flags = RPC_QUERY_CLIENT_PID`**; read
     **`atts.ClientPID`** (not a field the caller must name differently) → **client PID**.
   - **Transport.** Assert the call arrived over the **local `ncalrpc`** LPC transport
     (LRPC) used by a LocalServer in the same session; reject any `ncacn_ip_tcp`/remote
     transport. (Local RPC is the only protocol the moniker LocalServer uses.)
   - `GetTokenInformation(TokenUser/TokenStatistics/TokenIntegrityLevel)` on the
     impersonation token: assert same **logon session**, same **user SID**, **Medium IL**,
     **token type** (primary/impersonation).
   - The **PID is used only to open and validate the process object**, never as identity by
     itself: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, clientPid)` +
     `QueryFullProcessImageName` → **normalized canonical path**; verify that path's
     **SHA-256 digest** and **Authenticode publisher** match the pinned app identity. A
     same-user impostor — even one with a **reused PID** — fails the path/digest check and
     does not present the **session key**.
   - `CoRevertToSelf()` / `RpcRevertToSelf()` after the check.
6. **App authenticates the helper.** The `bootstrap` method returns the **helper PID**; the
   app `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, helperPid)` +
   `QueryFullProcessImageName` + Authenticode and asserts the helper's canonical path +
   SHA-256 + publisher match the pinned helper. A diverted/per-user registration that
   yields a medium-IL server fails this check, so the app refuses to trust it.
7. **Handshake + key.** Over the authenticated channel the two sides derive `sessionKey`
   (HKDF); the `launchSecret` is exchanged **inside** the authenticated call (never on a
   cmdline/env/file) and `RtlSecureZeroMemory`-zeroized right after the handshake (§4.3).
   The `sessionKey` is retained for the channel life and zeroized on close/exit.

This is a self-consistent, executable sequence using the **documented elevation-moniker
bootstrap**. Because the transport is mutually authenticated and privacy-encrypted, the
same-user-spoofing threat is closed by the OS rather than by a secret in a readable medium.

### 5.3 Least privilege

- UAC is shown only on first enable (explicit user action). `probe_integrity`/`get_status`/
  `health` never prompt UAC.
- The helper runs **High IL but with a restricted token** (the minimal enabled-privilege
  set: `SeLoadDriverPrivilege` for `WintunCreateAdapter`; route/DNS/interface changes via
  the `IP Helper`/`netsh`-equivalent APIs rather than blanket admin).
- The helper is a dedicated process: no console, no network listener of its own, no
  accidental admin shell, and **no** packet session (§1).

### 5.4 Facts to confirm against the pinned Windows target before implementation

The following are asserted from the general Windows model and must be **re-checked against
the exact pinned Windows SDK / minimum-OS target and the exact Wintun release** before any
implementation, because no live lookup was done this session:

- The **elevation-moniker** activation (`CoGetObject("Elevation:Administrator!new:{CLSID}",
  BIND_OPTS3, ...)`) triggers UAC and starts a `requireAdministrator` LocalServer. Confirm
  the exact HKLM `CLSID`/`AppID`/`Elevation`/`LocalServer32` key + value set that produces
  a high-IL `helper.exe` for a Medium-IL activation, and that **`RunAs = "Interactive User"`**
  is the correct setting (the moniker's Activate-as-Activator / interactive-user model).
- **`RPC_CALL_ATTRIBUTES_V2.ClientPID`** with **`Flags = RPC_QUERY_CLIENT_PID`** is available
  and populated on the target; and the client call arrives over the local **`ncalrpc`** LPC
  transport. If the target cannot report the transport/`ClientPID`, fall back to
  `CoImpersonateClient` + `RpcServerInqCallAttributes` on the `RPC_CALL_ATTRIBUTES_V1` +
  token checks and document the exact alternative.
- The **Wintun ABI** pinned in §3.0 matches the shipped `wintun.h`/`wintun.def` for the
  chosen release (export names, `WINAPI` calling convention, handle types, `NET_LUID`), and
  **`WintunCreateAdapter` installs/loads the driver on demand** and accepts a **`RequestedGUID`**.
- Whether mihomo can **open/reuse the helper-created adapter** by name (or the derived LUID) is
  exactly the **G1** question — **not** answered here, and **gated** by the **G1 lifecycle
  probe** (§12).

These checks are a pre-implementation prerequisite and keep the design honest rather than
asserting unverified OS behavior. The design stands on the round-3 fixes regardless; the
checks only pin down which exact OS API calls to make.

### 5.5 Per-enable single-client resident server (item 6)

The helper is **one instance per enabled TUN window**, not per IPC transaction. `enable`
activates it and it stays **resident-active** (§3.4) for the whole enabled window; `disable`
is served by that **same** instance — the main process issues both over the **same COM proxy**
— so the helper still owns the creator handle from `create_adapter` (§3.3). It is **never**
the old "fresh per-command helper" pattern that exits when a single command completes,
because **disable cannot reach a process it never kept alive**.

- **Bound to one client.** On activation the helper registers its class factory and accepts
  **only the first client that passes the identity check** (steps 5–6). Every subsequent
  activation client is **rejected** — including a **second Murge process** that is
  byte-for-byte identical (same path, same Authenticode signature, same SHA-256) but a
  different process: the helper already bound to the first verified client's
  `ClientPID`+logon-session+session-key and refuses a second `ProcessId`. This binding holds
  for the helper's **whole lifetime** (not per command), so no other client can attach to an
  already-resident privileged instance.
- **Resident-active; no idle exit.** From `create_adapter` until teardown the helper holds the
  creator handle and runs **resident-active** (internal state, §10.2). **It does not exit on
  enable-transaction completion and is not subject to an ordinary idle timeout during the
  active window** — the creator handle is what keeps the adapter (and thus the data plane)
  alive, so the helper must persist as long as TUN is enabled, even with zero IPC traffic.
- **Exit conditions (exhaustive).** The helper exits **only** on:
  1. **normal `disable` complete** (routes/DNS restored, creator handle closed, `RECONCILED`
     written, keys zeroized);
  2. **enable failure + recovery complete** (adapter rolled back or reconciled cleanly);
  3. **bound client/kernel death after emergency restore** (§3.4);
  4. **handshake-phase timeout** (the brief pre-bind bootstrap window — distinct from the
     active window);
  5. an explicit **global maximum recovery timeout** (a hard cap on a stuck emergency
     restore, §3.4).
  **No other timer — in particular no idle timeout applies while resident-active.**
- **Why per-enable rather than reusable.** A reusable helper would let an unrelated process
  (or a restarted app with the same binary) attach to a privileged instance. Per-enable
  activation + client binding + the resident-active lifetime closes that; the OS also unloads
  the elevated process when it exits, so there is no lingering High-IL process after disable
  or a crash.
- **No double-activation.** If a `requestEnable` is already in flight (promise-queue
  serialization, §10), the main process does not issue a second activation; a second app
  instance that tries to activate independently is rejected by the client-binding rule (and
  the second instance is already gated by the single-instance app rule where applicable).

---

## 6. Renderer contract (intent-only)

- The renderer has **no access to the helper client, no device/session handle, and no
  privilege**. It only has `TunGateway` (a main-process proxy).
- The renderer may only:
  - **read** `TunStatus` via `getStatus()`/`onStatus()`, and
  - **send a typed, parameterless intent** `requestEnable()`/`requestDisable()` (a click
    that carries no arguments). These are validated IPC intents; authorization, mutation,
    ordering and error handling all happen in the main-process `TunService`, the **sole
    holder of the `PrivilegedHelperClient` handle**.
- There is **no** renderer→helper path, **no** arbitrary parameter, and **no** op to
  mutate state directly. The UI never flips state optimistically; it renders what main reports.

---

## 7. Driver/helper integrity procedure (C1, C2)

- **Manifest:** per-arch `helper.exe` + `wintun.dll` SHA-256 digests and publisher
  thumbprints, validated inside the signed installer and re-checked at runtime (reuse
  `sha256File`, `mihomo-artifact.ts`).
- **Runtime:** every `create_adapter`/`apply_network_state` re-verifies the helper digest +
  publisher and the `wintun.dll` digest. Failure ⇒ `{ phase:'failed'|'unsupported' }`, zero
  mutation, helper not trusted.
- **Fail-closed:** missing manifest, digest mismatch, untrusted signer, unreadable file ⇒
  abort. Self-signed cert allowed only in a CI "smoke" path, never in production activation.

---

## 8. Network snapshot / written / journal model (item 2, item 6)

### 8.0 Trusted state storage, integrity and WAL directory defense (round-6, items 2–4)

**The recovery state is a **trusted, High-IL-only store**, not any user-writable folder (no
`AppData`/`%TEMP%`/application-data).** The path is decided at install and created by the
**elevated helper** (never by the unprivileged installer or the Medium app):

```
%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\
    baseline.json     (BaselineSnapshot)
    written.json      (WrittenState)
    journal.json      (MutationJournal)
    state.manifest    (record set: schemaVersion + per-file SHA-256)
```

- **Created by the elevated helper at first `enable` (or at `--recover`), under a fixed
  layout.** The `<brand-independent-id>` (e.g. `Murge` — a stable, brand-independent token, so
  a rename does not lose recovery state) and the `<ownerSid>` (the authorized user's SID,
  hex/`S-1-5-21-…`) separate per-owner state so one account cannot see or corrupt another's.
- **Owner is `SYSTEM`** (S-1-5-18). The DACL is a **pure allow-list** with **no inheritance**
  and **no deny-that-shadows-owner**:
  * `SYSTEM` — `GA` (full control: create/read/write/delete/change-ACL);
  * `Administrators` — `GA` (full control: install/repair/recovery);
  * **no `owner user SID` ACE** (see below), and it is **not** granted to `Everyone`/`Users`/
    `Authenticated Users`.

  **State-directory DACL (the resolvable SDDL).** Owner `SYSTEM` (`O:SY`), primary group
  `SYSTEM` (`G:SY`), **protected** (`D:P`), **container/object inherit** (`OICI`), a **complete
  pure allow-list** with **no `DENY`**, carrying the **High mandatory-integrity label** with
  `NO_WRITE_UP` (`NW`) and inherit (`OICI`):

  ```
  O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)
  S:(ML;OICI;NW;;;HI)
  ```

  | SDDL ACE | Object SID | allow / deny | Access mask | Inherit | Why |
  |---|---|---|---|---|---|
  | `(A;OICI;GA;;;SY)` | `SYSTEM` `S-1-5-18` | **allow** | `GA` generic-all (0x1F01FF) | object + container | Full control — create/read/write/delete/change-ACL of the store tree. |
  | `(A;OICI;GA;;;BA)` | `Administrators` `S-1-5-32-544` | **allow** | `GA` generic-all (0x1F01FF) | object + container | Install/repair/recovery; full control so a repair can rebuild the store. |
  | (none) | owner user SID `S-1-5-21-<dom>-<rid>` | **absent (no ACE)** | — | — | The Medium owner gets **no raw read** (as required) so the **owner SID ACE is omitted**; the UI reads only the **sanitized** state via helper COM (below). |
  | (none) | `Everyone` / `Users` / `Authenticated Users` | **absent (no ACE)** | — | — | Deny-by-default on a complete ACL ⇒ no access; never granted. |
  | `(ML;OICI;NW;;;HI)` | `High` `S-1-16-12288` (label ACE) | — | `NW` = `NO_WRITE_UP` | object + container | The mandatory-integrity `High` label, inherited, with `NO_WRITE_UP`; `HI` = `S-1-16-12288`. |

  **Why there is **no** `owner SID` ACE (the Medium surface never opens raw files).** The
  helper (activated as the **owner's high-integrity token** via `RunAs = Interactive User`) is a
  member of **`Administrators`** (the COM elevation moniker only runs when the interactive user
  is an administrator or supplies admin credentials), so its token carries **`BA` enabled** and
  reaches the store through the `BA` ACE (`GA`). The **Medium** token of the same user has
  `Administrators` as **deny-only/restricted** (UAC Admin Approval Mode) and has **no** `owner SID`
  ACE, so it is denied **read, write, delete and change-ACL** by **both** the DACL and the **High
  mandatory label** (`NO_WRITE_UP`). The Medium UI reads **only** the sanitized state via helper
  COM and **never** opens a raw `baseline.json`/`journal.json`. This is the **preferred** case the
  reviewer called out — because the Medium surface needs **no raw read**, no `owner SID` file ACE
  is added, and the UI rides COM-sanitized status only. (If a future non-admin helper had to write
  the store, the exact file mask would be asserted by the descriptor-build tests in §13; that is
  not the design here.)

- **The same-user Medium/High split is the point of the store contract.** The helper runs as the
  **owner's high-integrity token** (`RunAs = Interactive User`), which is a member of
  **`Administrators`** (elevation moniker ⇒ the interactive user is an admin or supplied admin
  credentials), so it reaches the store through the **`BA` (`GA`) ACE**. The Medium UI token of
  **the same user SID** has `Administrators` as **deny-only/restricted** (UAC Admin Approval Mode)
  and has **no** `owner SID` ACE in the DACL, so it is denied by the DACL **and** by the
  **`High` mandatory label**. The separation is **mandatory integrity control + the missing owner
  ACE**: the `tun-state` and `<ownerSid>` directories carry the **`High` mandatory label**
  (`S:(ML;OICI;NW;;;HI)`, `HI` = `S-1-16-12288`, `NW` = `NO_WRITE_UP`). A **Medium** token of that
  SID is denied **write / delete / ACL change** (MIC write-up), while the **High** helper passes.
  The Medium surface is therefore **incapable** of writing, deleting or re-ACLing the state
  dir/files — the property the round-6 reviewer requires.
- **Owner reads only the sanitized state via helper COM.** To get state, the helper exposes
  `get_status`/`get_state`, which returns a **sanitized projection** (the current `WrittenState`
  fields the renderer needs, **no** raw `BaselineSnapshot`/`MutationJournal` records, no
  secrets, no LUID/GUID beyond what the UI shows). **Main (Medium) never opens the raw files**;
  there is no Medium-facing read path to `baseline.json`/`journal.json`.
- **Every record is written by the helper only**, always via secure file I/O:
  * open with `CreateFile` and **`FILE_FLAG_OPEN_REPARSE_POINT`** (so a reparse point is
    surfaced, not followed) + `FILE_FLAG_BACKUP_SEMANTICS` for directories;
  * **validate each path component** before use, and **reject** any **symlink / junction /
    mount point / reparse point** on the store path (opening with `FILE_FLAG_OPEN_REPARSE_POINT`
    and querying `FileAttributeTagInfo`/`GetFileInformationByHandle` for
    `FILE_ATTRIBUTE_REPARSE_POINT`), so a planted `junction`/`symlink` cannot redirect the
    store;
  * never **re-open by string path** a location a user can replace — once a file is opened
    (and its `file ID` recorded), reuse that **handle**, and before each append **re-verify** the
    handle still refers to the same object (`FileIdInfo` / `GetFileInformationByHandleEx`),
    matching the recorded `file ID`; a mismatch ⇒ **fail closed**;
  * write to a temp file in the **same directory**, `FlushFileBuffers`, then **atomic
    `ReplaceFile`/rename** into place (so a crash mid-write never leaves a torn record);
  * **never follow a user-controlled path** (no file placed in `%TEMP%`/app-data is promoted to
    an elevated location; the store lives only under `%ProgramData%\<id>\tun-state\<ownerSid>`).
- **Upgrade/uninstall retain the directory.** It is preserved across upgrade and uninstall and
  removed **only** after a safe recovery has completed (no pending `PREPARED`/`APPLIED` record
  and routes/DNS are back to baseline), so losing recovery state does not orphan a live
  interface or a route/DNS change.

**Integrity / authenticity is deterministic — "HMAC-or-digest" is removed.** The **primary
authority is the Medium-unwritable DACL + High mandatory label** above (a same-user attacker
**cannot** write the store at all). On top of that boundary, the records carry
**`schemaVersion` + a SHA-256 digest** (in `state.manifest`) *only to detect accidental
corruption / truncation* — a same-user attacker who could write the store would also rewrite
the digest, so the digest is **not** presented as tamper-proof authenticity. There is **no
disk-state HMAC** claim: if an HMAC were used it would need a key location, key generation,
**DPAPI** protection, rotation and an upgrade/recovery reading path, which we do **not** provide
— so the HMAC language is **deleted** and only the DACL/integrity-label boundary + corruption
detection are claimed. (The **channel** envelope MAC over IPC in §4.3 is a separate, per-message
authenticator over the authenticated COM channel and is **not** a disk-state integrity claim.)

**Fail-closed on any anomaly.** On **read failure, incorrect ACL, wrong owner, discovered
reparse point, or schema/digest anomaly**, the helper performs **zero network modification**
and enters **`restore-failed`** (state machine §10.2), retaining the store for a human/`--recover`
decision — it never proceeds to mutate routes/DNS or close handles from data it could not trust.

### 8.1 Records and type fixes

```ts
// BaselineSnapshot — exact pre-enable OS state (immutable reference for restore)
interface BaselineSnapshot {
  schemaVersion: 1
  instanceId: string
  capturedAt: string
  interfaces: InterfaceSnapshot[]            // keyed by LUID/index
  firewallProfile: string | null
}
interface InterfaceSnapshot {
  luid: string                               // canonical hex NET_LUID string (64-bit, NOT a JS number)
  index: number                              // 32-bit interface index (safe as number)
  description: string
  type: string                               // e.g. "Ethernet"/"Wireless"/"Loopback"
  metric: number | null
  state: string
  ipv4Routes: RouteSnapshot[]
  ipv6Routes: RouteSnapshot[]
  dns: DnsSnapshot[]
}
interface RouteSnapshot {
  destination: string                        // prefix, e.g. "0.0.0.0/0"
  prefixLength: number
  nextHop: string | null
  metric: number
  protocol: string                           // static | dhcp | onlink | ...
  routeStore: 'active' | 'persistent'
}
interface DnsSnapshot {
  server: string
  source: 'dhcp' | 'static' | 'manual'
}

// WrittenState — EXACTLY what the helper wrote (owned reference)
interface WrittenState {
  schemaVersion: 1
  instanceId: string
  writtenAt: string
  routeAdditions: Array<{ luid: string; route: Omit<RouteSnapshot,'source'> }>
  routeDeletions: Array<{ luid: string; route: Omit<RouteSnapshot,'source'> }>
  dnsSets: Array<{ luid: string; servers: string[] }>   // FIX: closing '>' on Array<...>
  metricSets: Array<{ luid: string; metric: number }>
}

// MutationJournal — WRITE-AHEAD, append-only, ordered log (crash recovery)
// Every mutation is a two-phase record: PREPARED (fsync'd BEFORE the mutation) then
// APPLIED. The journal is the authoritative recovery log; the OS is never mutated before
// its PREPARED record is durable on disk (§8.3, §8.4).
interface MutationJournalEntry {
  seq: number
  at: string
  journalType: 'PREPARED' | 'APPLIED' | 'RECONCILED'
  op: string            // createAdapter | deleteAdapter | addRoute | delRoute |
                        // setDns | setMetric | ...
  // target identity, all as canonical types so an un-applied op is recoverable:
  adapterName: string | null       // product adapter name
  requestedGuid: string | null     // product RequestedGUID (stable identity)
  luid: string | null              // canonical hex NET_LUID string (64-bit, not a JS number)
  before: unknown
  after: unknown       // expected value (for APPLIED); null for a not-yet-applied PREPARED
  baselineFingerprint: string   // sha256 of the committed BaselineSnapshot
}
```

> **Type fixes (item 6):** `dnsSets` was `Array<{...>` (unclosed) → now
> `Array<{...}>`. `NET_LUID` is a **64-bit value** and is serialized as a **canonical hex
> string** everywhere in JSON, never a JS number. `requestId` is a **monotonic uint64
> decimal string** (per-session sequence), never a UUID/string mix.

### 8.2 `DesiredNetworkState` (item 3 — the sole-modifier intent)

```ts
interface DesiredNetworkState {
  schemaVersion: 1
  adapter: {
    name: string          // stable product adapter name ("Murge TUN")
    tunnelType: string    // stable opaque tunnel-type string ("Murge TUN")
    requestedGuid: string // stable product RequestedGUID (identity for create/recover)
  }
  routes: Array<{ family: 4 | 6; destination: string; prefixLength: number;
                  nextHop: string | null; metric: number; routeStore: 'active'|'persistent' }>
  dns: Array<{ luid: string; servers: string[]; source: 'static' | 'dhcp' }>
  metrics: Array<{ luid: string; metric: number }>
}
```

Generated by the main process (`policy.deriveDesiredNetworkState(validatedMihomoConfig)`)
from the validated runtime config, and applied verbatim by the helper. Because
`auto-route`/`dns-hijack` are disabled in the runtime config, this is the **only** source
of route/DNS/interface changes.

### 8.3 Write-ahead journal (WAL) — record intent durable BEFORE mutating

The journal is **write-ahead**: the OS is **never mutated before its PREPARED record is
durable on disk**.

- **`BaselineSnapshot` is committed first.** Before any mutation — and before
  `create_adapter` — the helper writes + validates + fsyncs the full `BaselineSnapshot`
  (atomically: temp → validate → rename). If it cannot, it aborts with **zero mutation**.
- **`create_adapter` is itself WAL.** Before calling `WintunCreateAdapter`, the helper
  writes + fsyncs `CREATE_ADAPTER/PREPARED` carrying `{ adapterName, tunnelType,
  requestedGuid }` (the recoverable identity). Only after that record is durable does it
  call `WintunCreateAdapter`. On success it writes `CREATE_ADAPTER/APPLIED` with the
  derived `luid` (from `WintunGetAdapterLUID`) + the handle-derived GUID.
- **Every route/DNS/interface mutation is a two-phase record.** For each op
  (`addRoute`, `delRoute`, `setDns`, `setMetric`): write + fsync the `${op}/PREPARED`
  record with its target identity and expected `after`; mutate the OS; then write
  `${op}/APPLIED` recording the exact resulting values (this is also `WrittenState`).
- **The journal is append-only and ordered.** Crash can occur **between any two records**;
  the durable record stream, not assumptions, is what recovery replays.
- **The WAL is itself protected against directory replacement (§8.0).** On `init`/`--recover`
  the helper first validates the store **directory** — its **owner**, its **DACL** (the
  allow-list/HIGH-label contract) and its **reparse state** (no junction/symlink/mount point).
  The journal file is opened **once across the run**; before **each** `PREPARED`/`APPLIED`/
  `RECONCILED` append the helper **re-verifies that the already-open handle still refers to the
  same object** (`FileIdInfo`/`GetFileInformationByHandleEx` file-ID match) — it **never
  re-opens `journal.json` by string path** (a user-replaceable location). Any mismatch ⇒
  **zero network mutation** + `restore-failed`.

### 8.4 Recovery: reconcile PREPARED-but-unknown against the current OS state

A crash can leave a **PREPARED** record with no matching **APPLIED** — the mutation may or
may not have happened. Recovery must **reconcile by enumeration**, not assume:

- **On next boot / `--recover`.** `TunService.init()`/`--recover` loads `BaselineSnapshot` +
  the journal. For each op from the end backwards:
  - **APPLIED** → undo (reverse the op) subject to the per-item owned-only rule (§8.5);
    then write the matching `RECONCILED` record.
  - **PREPARED without APPLIED** → the mutation's success is **unknown**. Do **not** assume
    it happened or did not. Instead **reconcile against the current OS state**:
    - for `CREATE_ADAPTER`: **`WintunOpenAdapter(Name)`** the product adapter by name and
      verify identity — compare `RequestedGUID` against `WintunGetAdapterLUID(handle,
      &luid)` + `ConvertInterfaceLuidToGuid` (and/or a SetupAPI device match). Only on an
      **exact identity match** do we close the creator handle / run product lifecycle
      cleanup; if the creator handle is already closed (a crash between `APPLIED` and
      cleanup), first **observe whether the adapter auto-disappeared** — if it did, mark
      `RECONCILED` (nothing to undo); if it still exists, it is now just an orphan we never
      created a handle for, so reconcile by name+identity and record `RECONCILED` without
      making an unwanted change. No `WintunDeleteAdapter`.
    - for a route/DNS op: **read the current OS state** for that LUID/prefix; if it matches
      the op's `after`, undo it back to `before`; if it never took effect, mark
      `RECONCILED` (nothing to undo).
- **Per-item owned-only rule (never all-or-nothing).** Undo is per LUID/family/field. If the
  current value still equals what we wrote, restore it to the baseline; if it was changed
  externally, do **not** overwrite — record a **per-item `conflict`** (`conflictDetail`) and
  leave that item. Unrelated items are unaffected; the phase becomes `conflict` only if an
  owned item was externally modified, otherwise restore completes to `configured`.
- **Reverse order.** Undo walks the journal **in reverse** so a dependent op (e.g. a route
  added after an interface metric) is torn down before the dependency it relied on. A
  crash mid-recovery re-runs idempotently (each undo is guarded by the existing
  `RECONCILED` marker).
- **`CLOSE_CREATOR_HANDLE` (commit point).** The adapter is removed **only** by closing the
  creator handle — and this is the **last** undo step, itself WAL:
  `CLOSE_CREATOR_HANDLE/PREPARED` → verify ownership by `Name` + `RequestedGUID` (and the
  derived LUID) → ensure mihomo has already ended its session and closed its open handle →
  `WintunCloseAdapter(creatorHandle)` → `CLOSE_CREATOR_HANDLE/APPLIED` (→ `RECONCILED`).
  There is **no** `WintunDeleteAdapter`, **no** `ERROR_REBOOT_REQUIRED` adapter-delete
  return, and **no** `delete-pending` state. The adapter is reported gone once the handle is
  closed. If ownership cannot be proven, do **not** close the handle; record a per-item
  `conflict` and leave it (D5).

### 8.5 Per-item owned-only restore rule

Restore is **never all-or-nothing**. Treating the whole snapshot as one unit would either
fail everything because one item was externally changed, or overwrite a user's change.
Instead each item is decided independently:

- Compare the **current** OS value against what we wrote (the op's `after`/`WrittenState`).
- If it still equals what we wrote → restore to the `BaselineSnapshot` value.
- If it was **changed externally** → **do not overwrite**; record a per-item `conflict`
  (`conflictDetail`: LUID/index, family, field, expected vs current) and leave it.
- Unrelated items are unaffected; the phase becomes `conflict` only if an owned item was
  externally modified, otherwise restore completes to `configured`.

---

## 9. Config gating (C7) — allow the single-owner activation only

Today `mihomo-config.ts` asserts, for every document, that `tun`/`dns` contain only
`enable` and it must be `false`. Phase 9 changes this with one reviewed, tested change:

- Keep the dev-safe default: non-Windows, or no verified helper, still fails closed and
  rejects a synthesized `tun.enable:true` / `dns` block.
- On Windows, the runtime activation path may synthesize a `tun`/`dns` block **only in the
  running config** (never persisted as a user preference, torn down on disable), and it is
  produced **only** by the main process for the single-owner model:
  - `tun: { enable: true, stack: system, auto-route: false, auto-detect-interface: false }`
  - `dns: { enable: true, hijack: false, nameserver: [mihomo loopback DNS] }`
  - `auto-route` / `auto-detect-interface` / `dns-hijack` are **false/absent** because the
    helper is the sole modifier (Option A, §1.1). The routes/DNS that the helper applies
    come from `DesiredNetworkState` (§8.2), not from mihomo.
- `mihomoConfigErrors` stays the single gate and gains an explicit
  `allowedTunContext: false|'activate'` parameter: `false` everywhere except the
  authorized `activate` path. A profile carrying its own `tun`/`dns`/`rules` still cannot
  slip through.
- The helper is never handed a mihomo config to mutate; it only receives the typed
  `DesiredNetworkState`.

---

## 10. TUN state machine, enable order and UI copy

### 10.1 Enable order (fixed, item 2) — write-ahead

The enable operation runs inside the main-process `promise-queue` (serialized). Every
mutation is **write-ahead**: its `PREPARED` record is durable **before** the OS is touched
(§8.3). The exact order is:

```
 1 verify            probe_integrity (helper + wintun digest/publisher); no elevation, no mutation
 2 elevate/bootstrap activate helper via Elevation:Administrator!new; handshake + sessionKey
 3 BaselineSnapshot  helper writes + fsyncs + verifies the FULL baseline BEFORE any mutation;
                     abort with zero mutation if it cannot
 4 CREATE_ADAPTER/PREPARED  helper writes + fsyncs {adapterName, tunnelType, requestedGuid}
                     BEFORE calling WintunCreateAdapter (recoverable identity)
 5 create adapter    helper calls WintunCreateAdapter(Name, TunnelType, RequestedGUID);
                     installs/loads driver on demand + creates adapter; WintunGetAdapterLUID
                     derives the LUID; assert exactly one Murge adapter (Name+RequestedGUID)
 6 CREATE_ADAPTER/APPLIED  write {adapterName, requestedGuid, luid} and pin the canonical-hex LUID
7 apply routes/DNS  for each op: write ${op}/PREPARED -> mutate OS -> write ${op}/APPLIED
8 start mihomo     mihomo opens/reuses the adapter (G1) and starts its packet session
 9 readiness probe  probe the TUN/loopback path is live; assert routes/DNS present
10 active           phase → active; helper is resident-active (§3.4/§5.5): it keeps the creator
                    handle open for the whole enabled window; renderer gets the true status
```

- **Routes/DNS are always written after adapter creation** (steps 7+ follow step 5–6) so
  their target interface LUID/index already exists.
- **`CREATE_ADAPTER` is write-ahead**: the `PREPARED` record (steps 4) is fsync'd **before**
  `WintunCreateAdapter` (step 5) and the `APPLIED` record (step 6) is written only after it
  succeeds. A crash between 4 and 6 leaves a `CREATE_ADAPTER/PREPARED` record that recovery
  reconciles by **`WintunOpenAdapter(Name)`** + identity verification (§8.4).
- **Baseline/journal live in the trusted state store (§8.0).** Step 3 first creates/validates
  the `%ProgramData%\<id>\tun-state\<ownerSid>\` directory (owner, DACL, mandatory label,
  reparse state) and then writes + fsyncs `BaselineSnapshot` there; every later record lands in
  the same verified store via a held handle. A store/ACL/reparse/integrity anomaly at any step
  ⇒ **zero network mutation** + `restore-failed`.
- **Any failure at any step recovers in reverse journal order** (§8.4), reconciling each
  PREPARED-but-unknown op against the current OS state: failure at step 9 undoes steps 7–6
  then the adapter (closes the creator handle, §3.3); failure at step 5 (or between 4–6)
  reconciles the adapter by `WintunOpenAdapter(Name)` + identity; failure at step 2 (UAC
  cancelled / timeout) leaves **zero mutation**.
- **Disable is the mirror, served by the **same resident helper** (§3.3, §5.5):** main calls
  the same helper over the same COM proxy; mihomo ends its session (`WintunEndSession`) and
  closes its open handle → helper restores routes/DNS per item (reverse WAL order) →
  **`CLOSE_CREATOR_HANDLE/PREPARED` → verify ownership by `Name`+`RequestedGUID`+LUID →
  `WintunCloseAdapter(creatorHandle)` (removes the adapter) →
  `CLOSE_CREATOR_HANDLE/APPLIED`/`RECONCILED`** → reconcile journal → `configured`. There is
  **no** `WintunDeleteAdapter` and **no** `delete-pending`/`RebootRequired` path. The helper
  **holds the creator handle for the entire enabled window** (the fixed safety baseline, §3.3),
  so **disable reaches the same instance** that created the adapter — it never spawns a new
  helper for disable.

### 10.2 Transition table

| Phase | Entry | Allowed actions | On failure |
|---|---|---|---|
| `configured` | init/recovery, end of disable | enable | — |
| `starting` | `requestEnable` intent | verify → snapshot → `create_adapter`/PREPARED→APPLIED → pin LUID → `apply_network_state` (each op PREPARED→APPLIED) → mihomo open → probe | → `restoring` (reverse WAL order) → `restore-failed`/`failed` |
| `active` | routes/DNS applied + mihomo TUN up | disable, teardown | → `restoring` |
| `restoring` | disable/teardown/rollback | per-item owned-only restore, reverse journal order | → `conflict` (per-item) or `restore-failed` (corruption) |
| `failed` | non-recoverable integrity/adapter/capture | retry / report | — |
| `conflict` | an externally-modified owned item | none (report, per-item) | owner/emergency path |
| `unsupported` | non-Windows / no verified helper | none | — |
| `restore-failed` | could not restore (not a conflict) | retry / `--recover` | — |

Invariants: every transition re-verifies ownership + baseline digest; `restoring` is
idempotent; a crash mid-activation reconciles from the journal + baseline on next boot,
or via `--recover`. On the trusted store, a **read failure, wrong ACL, wrong owner,
discovered reparse point, or schema/digest anomaly** (§8.0) ⇒ **zero network mutation** and
`restore-failed` (never proceed to mutate from data that could not be trusted).

> This table is the **renderer-visible** product phase. Alongside it the helper has its own
> internal state machine with a **`resident-active`** state (§3.4/§5.5): from `create_adapter`
> through disable/emergency the helper is `resident-active`, holding the creator handle and
> watching the bound app + mihomo process handles; it is `recovering` during a bounded
> emergency restore; otherwise it is `booting`/`handshake` (short pre-bind window) or
> `exiting`. The helper **never** exits on an idle timeout while `resident-active`.

### 10.3 Canonical UI copy (Chinese, matches `system-proxy` style)

| Phase | UI copy |
|---|---|
| `configured` | TUN 未启用（当前平台支持） |
| `starting` | TUN 正在启动… |
| `active` | TUN 已启用 |
| `failed` | TUN 启用失败 |
| `restoring` | 正在恢复网络设置… |
| `restore-failed` | 网络设置恢复失败 |
| `conflict` | 检测到网络配置被外部修改，未还原该条目 |
| `unsupported` | 当前平台不支持 TUN |

---

## 11. Proposed module/interface layout

| File | Contents | Tests |
|---|---|---|
| `src/shared/tun.ts` | `TunPhase`, `TunStatus`, `TunGateway`, IPC names, `HelperOp`/`HelperCommand`, `DesiredNetworkState` | — |
| `src/shared/schemas/tun.ts` | runtime Zod schema for `TunStatus`, `HelperCommand`, `DesiredNetworkState`, snapshot/written/journal records | valid/invalid/forward-compatible |
| `src/main/tun/service.ts` | `TunService` (state machine, promise-queue, probe, backup, reconcile) | `FakeTunAdapter` + `RecordingBackupStore` |
| `src/main/tun/policy.ts` | pure `deriveDesiredNetworkState`, `isOwned`/`matchesWritten`/`buildBaseline`/canonical-MAC helpers | pure unit |
| `src/main/tun/adapters/windows-tun-adapter.ts` | helper client + integrity verify + snapshot/reconcile | fakes; real path gated |
| `src/main/tun/adapters/disabled-tun-adapter.ts` | `{supported:false, phase:'unsupported'}` for non-win32 | unit |
| `src/main/tun/adapters/fake-tun-adapter.ts` | deterministic in-memory helper for dev/tests | — |
| `src/main/tun/helper-client.ts` | COM elevation activation + identity binding + envelope + key lifecycle | unit (fake COM) |
| `src/main/tun/types.ts` | local types (snapshot/written/journal/DesiredNetworkState, status) | — |
| `src/main/tun/probe.ts` | TUN readiness probe (reuse accumulating-buffer pattern) | unit |

---

## 12. Gates and remaining decisions before implementation

**Hard gates that must pass / be decided first:**

- **G1 (adapter handoff + creator-handle lifetime) — unproven, and it is a hard
  pre-implementation gate.** Before any Phase 9 implementation of the handoff path, run the
  **G1 lifecycle probe** in the gated job, which exercises four steps on a disposable,
  snapshot-able Windows VM and records one decisive fact:
  1. **(a)** helper `WintunCreateAdapter` → holds the **creator handle**; `${name}` exists;
  2. **(b)** mihomo `WintunOpenAdapter(name)` → **second handle** + `WintunStartSession` ⇒
     live data plane;
  3. **(c)** helper `WintunCloseAdapter(creatorHandle)` → helper exits;
  4. **(d)** does mihomo's session **and** the adapter `${name}` **still exist**?
  The probe must **not** expand into full Phase 9 implementation (no helper service, no
  routes/DNS, no persistence, no UAC-bootstrap machinery), and it **never runs on this dev
  machine** (it needs a snapshot-able, out-of-band-recoverable Windows VM + gated CI + a
  separate owner-authorization record — §0.0 / DEVELOPMENT_SAFETY). **Two observations**: if
  the adapter disappears at (c) → **Observed A**; if it survives while mihomo holds a handle →
  **Observed B**. **Neither changes the safety baseline**, which is **fixed** (§0.4/§3.3/§5.5):
  the helper holds the **creator handle for the whole enabled window** and is a **per-enable
  single-client resident server**; the observation only tells us whether a later optimization
  (e.g. letting the helper exit on enable-completion) is plausible. **If G1 fails / cannot be
  completed** (mihomo cannot reuse the helper-created adapter), **stop and return to the
  owner** for the revised ownership decision; do not fall back to dual ownership (§3.3).
- **D4:** helper boot/auto-start for the emergency path. Recommended: **no self-start**;
  `--recover` is run manually. (D2 = standalone helper, so a service is not assumed.)
- **D5:** whether a Wintun **driver/adapter** that pre-existed is ever removed on uninstall.
  Recommended: **never** remove a pre-existing/shared driver; we never ship a `.sys`, and we
  only ever delete an adapter we provably created (§3.3).
- **Certificate provider / trusted publisher** for `helper.exe` (see `CODE_SIGNING.md`).
- **Independent owner authorization** record (who, what, when) before any implementation.
- **DNS-hijack scope**, HTTPS decryption/rewrite visibility, sleep/wake + network-change
  reconciliation depth.

Implementation/testing for the remaining lines proceeds only after design-review sign-off
and separate owner authorization, and only in the gated disposable-Windows job
(`MURGE_RUN_REAL_TUN=1` **and** `win32`, never in default `npm test`).

---

## 13. Test / evidence matrix (item 7)

All real behavior runs only in the gated `windows-latest` job
(`MURGE_RUN_REAL_TUN=1` **and** `win32`), never in default `npm test`. The **access-control /
descriptor-build** rows (`T24`, `T38`–`T40`, and the state-dir DACL/SACL reads) are
**Windows-only unit tests that need no real TUN, no network mutation and no elevated helper** —
they build the `SECURITY_DESCRIPTOR` in-process, so they run in the `win32` job without
`MURGE_RUN_REAL_TUN`.

| # | Test | Assertion | Evidence |
|---|---|---|---|
| T0 | **G1 lifecycle probe (disposable, hard gate)** | (a) helper `WintunCreateAdapter` holds the creator handle; (b) mihomo `WintunOpenAdapter` + `WintunStartSession` ⇒ live data plane; (c) helper `WintunCloseAdapter(creatorHandle)` / exits; (d) assert **whether the adapter/session still exist**. On a snapshot-able VM that is restored out-of-band afterwards | enumerate adapter + session presence at each of a/b/c/d; record **which observation** (A = disappears on creator close, B = survives while mihomo holds a handle) and assert the **fixed baseline** (no observation changes the helper-holds-creator-handle model); machine restored |
| T1 | **Single-owner data plane / adapter handoff (G1)** | After the helper creates the adapter, mihomo **reuses the same GUID/LUID** (RequestedGUID is the stable identity) and there is exactly **one Murge adapter** in the system | enumerate adapter by Name/RequestedGUID/LUID before/after; assert count==1; assert mihomo session binds the same LUID |
| T2 | Ordering: routes/DNS after adapter creation | routes/DNS/interface are written **only after** the adapter exists; a failure before adapter creation leaves zero routes/DNS | journal seq + adapter existence at each step; assert no route/DNS op precedes `createAdapter` |
| T3 | **mihomo emits no route/DNS change** | With `auto-route:false`, `auto-detect-interface:false`, `dns-hijack:false`, mihomo adds/removes **no** route/DNS/interface outside the helper | route/DNS snapshot before+after mihomo start, diff == helper-written set only |
| T4 | Isolate dual-ownership regressions | Assert the runtime config never contains `auto-route:true`/`auto-detect-interface:true`/`dns-hijack:true` when the helper owns OS config | config-validator unit + integration grep |
| T5 | **Elevation moniker bootstrap: same-user malicious race-connect** | A second Medium-IL process cannot activate/connect to the running elevated helper while the app is connected, and cannot impersonate the app | attempt activation/connect from a second medium process; assert rejected (identity binding) |
| T5b | **Second Murge instance race (same path/signature/hash)** | A **second Murge process** — byte-for-byte identical binary (same path, same Authenticode, same SHA-256) — attempts to connect to the running per-enable resident helper; the helper has already bound the first verified client and **rejects** the second | launch second app; assert its activation/connect is rejected; assert it cannot drive the helper |
| T6 | **PID reuse** | A client PID whose process object was reused (exited + replaced) is rejected because path/digest/session-key no longer match | exit the app, let a reused PID connect; assert reject |
| T7 | **Handshake/command timeout + helper exit zeroizes** | A **handshake-phase** timeout or a **command request/response** timeout zeroizes `launchSecret`/`sessionKey` and leaves zero mutation, and the helper exits; a **resident-active** helper receiving **no IPC** does **not** exit | timeout injection in the pre-bind window and per-command; assert no mutation + secrets zeroed; assert the resident-active helper stays (adapter still present) during a long IPC gap |
| T8 | **Replay** | Replayed `HelperCommand` with a stale `requestId` is rejected | replay recorded frame; assert reject |
| T9 | **Crash injection at every journal record boundary (WAL)** | Force-kill the helper at **each durable-journal boundary** (pre-snapshot, post-snapshot, `CREATE_ADAPTER/PREPARED`-written, **mid-`WintunCreateAdapter`**, post-`CREATE_ADAPTER/APPLIED`, pre-`${op}/PREPARED`, mid-route/DNS mutate, post-`${op}/APPLIED`, pre-mihomo, post-probe, `CLOSE_CREATOR_HANDLE/*`); assert next `init()`/`--recover` reconciles each record against the current OS state and restores the baseline | journal replay + before/after route/DNS diff per boundary; for `CREATE_ADAPTER` PREPARED-but-unknown, reconcile by `WintunOpenAdapter(Name)` + identity |
| T10 | Crash recovery restores exact prior state | After a forced kill mid-activation, disable restores routes/DNS to the exact pre-enable state | route/DNS diff vs baseline |
| T11 | Only-one-Murge-adapter uniqueness + RequestedGUID conflict | A foreign adapter holding the reserved `Name`/`RequestedGUID` blocks activation with `conflict`, zero mutation | adapter pre-created with the reserved identity; assert `conflict` |
| T12 | **Adapter removal via creator-handle close (no `WintunDeleteAdapter`)** | After disable, the product adapter is gone **because `WintunCloseAdapter(creatorHandle)` was called** (the only removal path); there is **no** `RebootRequired`/`delete-pending` state; a **pre-existing/foreign** adapter is never removed and is verified by `Name`+`RequestedGUID`+LUID before any close | enumerate adapters; assert product adapter removed only after ownership verified and mihomo session ended; assert foreign adapter present |
| T13 | Uninstall restore runs before deletion | Uninstall runs `--recover`, restores routes/DNS, aborts on corrupt snapshot | `NetworkSnapshot` diff; exit code / `Abort` path |
| T14 | Emergency `--recover` independent of GUI | Kill the app, run `--recover`, assert restored | restored state |
| T15 | Non-Windows / no helper ⇒ unsupported | Non-Windows or no verified helper returns `{supported:false, phase:'unsupported'}`, zero mutation | status probe unit + CI |
| T16 | **Resident-active survives a long IPC gap** | After `enable`, a long period with **no IPC/messages** between app and helper leaves the adapter and routes/DNS **intact** (the helper is resident-active and does not idle-exit) | wait > idle timeout; enumerate adapter + route/DNS diff vs applied; assert still present (clock-accelerated in test) |
| T17 | **Disable uses the SAME helper instance as enable** | `disable` is served by the **same** helper process that handled `enable` (the one holding the creator handle); evidence records **enable helper PID == disable helper PID**, and disable reaches the creator handle | helper PID logged at enable + disable; assert equal; assert creator handle closed at disable |
| T18 | **App crashes while TUN enabled ⇒ emergency restore** | Force-kill the bound **app** process; the helper (which watches the app process handle) runs the bounded emergency restore: routes/DNS first, then closes the creator handle, then persists the outcome and exits | force-kill app; assert routes/DNS restored, adapter removed, `RECONCILED` (or `RESTORE_FAILED` + journal kept), helper exited |
| T19 | **mihomo crashes while TUN enabled ⇒ emergency restore** | Force-kill the **mihomo** process; the helper (which watches the mihomo process handle) runs the bounded emergency restore | force-kill mihomo; assert same restore sequence + outcome |
| T20 | **Helper crashes ⇒ adapter auto-removed + next recovery** | Force-kill the **helper**; Windows closes its creator handle so the adapter is removed; the next `init()`/`--recover` launches a **new** recovery helper that **does not claim** to call `WintunCloseAdapter`, verifies the adapter is gone, and restores residual routes/DNS | force-kill helper; assert adapter gone + new recovery helper reconciles `RECONCILED`; assert it did **not** record a `WintunCloseAdapter` |
| T21 | **New recovery helper has no old creator handle** | A recovery helper started after a crash has **no** handle from the dead helper; it must **not** try to close a creator handle and instead decides restoration from the journal + current OS adapter state | assert recovery path branches to "adapter gone / conflict" without a creator-handle close |
| T22 | **Helper crash leaves no intact-but-orphaned adapter** | After helper crash, no Murge adapter remains with a **live data plane but no owning helper**; if an adapter is observed still present, the new helper marks a `conflict`, keeps evidence, and does **not** delete it (D5) | enumerate adapter; assert either absent or `conflict` + evidence + no delete |
| T23 | **Foreign/preexisting adapter never removed on recover** | A pre-existing/foreign adapter sharing the reserved identity is never removed, even during recovery of an owned adapter | pre-create foreign adapter; run recover; assert it remains |

| T24 | **COM ACL is a pure allow-list (AccessCheck)** | The stored `LaunchPermission`/`AccessPermission` (+ state-dir DACL) `SECURITY_DESCRIPTOR` gives **owner SID allowed**, **second normal user denied**, **SYSTEM allowed**, and grants **no** `Everyone`/`Users`/`Authenticated Users` ACE (and **no** `DENY` ACE — `ANONYMOUS LOGON`/`NETWORK` are denied by absence, not by a `DENY`). The exact COM-mask assertions are the descriptor-build group below (`T32`–`T40`) | `AccessCheck` against the built descriptor for owner / second-user / SYSTEM tokens; assert the matrix (owner=allow, second-user=deny, system=allow); assert no `Everyone`/`Users`/`AuthUsers` ACE and no `DENY` ACE |
| T25 | **State-dir owner/DACL/reparse validated on startup** | On `init`/`--recover` the helper validates the store dir owner = SYSTEM, the allow-list DACL and reparse state; a **wrong owner** or **wrong ACL** ⇒ **zero network mutation** + `restore-failed` | pre-set wrong owner/ACL on the dir; start recovery; assert no route/DNS change + `restore-failed` + store retained |
| T26 | **Reparse point on the store path is rejected** | A **symlink / junction / mount point** planted on the store path (dir or a record file) is detected (`FILE_FLAG_OPEN_REPARSE_POINT` + reparse-tag query) and the operation **fails closed** | create junction/symlink/mount on `tun-state\<ownerSid>` or on a record file; assert detection + fail-closed + no mutation |
| T27 | **WAL handle/file-ID re-verify (directory swap)** | If the journal **directory** is swapped between appends (replaced with another dir of the same name), the already-open handle's **file ID** no longer matches the recorded one ⇒ the next `PREPARED`/`APPLIED`/`RECONCILED` append **fails closed** | record file ID; swap the dir; append; assert mismatch → fail-closed, no mutation, no re-open-by-string |
| T28 | **Journal truncation / tamper / schema+digest anomaly** | A truncated, tampered or schema/digest-mismatched journal (or `state.manifest` mismatch) is detected and **zero network modification** occurs; recovery enters `restore-failed` | truncate/tamper `journal.json` / `state.manifest`; assert detect + no mutation + `restore-failed` |
| T29 | **State-dir ACL modified by a lower-trust process** | Changing the state-dir DACL to add a user/Everyone ACE, or to remove the owner ACE, is **not** possible from Medium (MIC write-up) and, if observed, the helper **fails closed** | attempt ACL change from Medium; assert blocked (MIC); assert helper re-verifies ACL and fails closed |
| T30 | **Medium-IL owner cannot write/delete/change-ACL the store** | The same user's **Medium** token cannot create/modify/delete/ACL a file in the High-labeled store (MIC write-up) while the **High** helper can | attempt create/write/delete/SetSecurity from a Medium token; assert denied (access denied / MIC); assert the High helper can |
| T31 | **Uninstall retains store until safe recovery** | Uninstall retains `%ProgramData%\<id>\tun-state\<ownerSid>\` and cleans it **only** after a safe recovery completes (no pending record + routes/DNS back to baseline) | simulate pending `PREPARED`; run uninstall; assert store retained + no cleanup; after clean recovery assert cleanup |
| T32 | **Descriptor-build: SDDL → `SECURITY_DESCRIPTOR`** | `ConvertStringSecurityDescriptorToSecurityDescriptor` succeeds on the `LaunchPermission` SDDL, the `AccessPermission` SDDL **and** the state-dir SDDL (`O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)S:(ML;OICI;NW;;;HI)`), yielding a valid descriptor | call the API on each SDDL string; assert success + non-null descriptor + `GetSecurityDescriptorLength` reasonable |
| T33 | **Descriptor-build: `MakeSelfRelativeSD`** | The converted descriptor converts to **self-relative** form (required for `REG_BINARY`) without error | call `MakeSelfRelativeSD`; assert success + output length set + non-null |
| T34 | **Descriptor-build: `REG_BINARY` round-trip** | Writing the self-relative descriptor as a `REG_BINARY` value then reading it back yields **byte-identical** data | write bytes to the registry `LaunchPermission`/`AccessPermission`/state key; read back; assert byte equality (and that it is `REG_BINARY`) |
| T35 | **Descriptor-build: `GetSecurityInfo` readback** | `GetSecurityInfo` on the created state dir reads back a DACL/SACL **matching** the descriptor we set (owner SYSTEM, allow-list DACL, `High` label with `NO_WRITE_UP`) | apply the SDDL, then `GetSecurityInfo`; assert owner SID + DACL ACE count + SACL label |
| T36 | **`AccessCheck` — `LaunchPermission`** | The built Launch descriptor grants **owner SID = allow**, a **second normal user = deny**, **SYSTEM = allow**; no `Everyone`/`Users`/`Authenticated Users` ACE grants access | `AccessCheck` with tokens for owner / second normal user / SYSTEM; assert the allow/deny matrix + no other ACE grants |
| T37 | **`AccessCheck` — `AccessPermission`** | The built Access descriptor grants **owner SID = allow**, **second normal user = deny** (SYSTEM is granted launch/activate but is **not** given ordinary call access) | `AccessCheck` with owner + second-user tokens; assert owner allow, second-user deny |
| T38 | **COM ACE mask equality** | Every ACE in `LaunchPermission` has mask **strictly `0xB`**; every ACE in `AccessPermission` has mask **strictly `0x3`**; **no** generic `GX`/`GA` ACE; and **every** COM ACE contains the `0x1` (`COM_RIGHTS_EXECUTE`) bit | enumerate ACEs on the built descriptors; assert each mask == `0xB` or `0x3` and `mask & 0x1 == 0x1` |
| T39 | **State-dir High mandatory label + `NO_WRITE_UP`** | The store dir carries the **`High`** mandatory-integrity label (`S:(ML;OICI;NW;;;HI)`, `HI` = `S-1-16-12288`) with `NW`/`NO_WRITE_UP` and `OICI` inheritance | `GetSecurityInfo` SACL readback; assert a `SYSTEM_MANDATORY_LABEL_ACE` with the `S-1-16-12288` SID and `NO_WRITE_UP` |
| T40 | **Store dir Medium vs High** | A **Medium** token of the owner SID **cannot write / delete / change-ACL** a file in the `tun-state` dir, while the **High** helper token can (covered by MIC + the missing owner ACE) | try create/write/delete/SetSecurity from a Medium token (assert access denied / MIC); assert the High helper can; cross-refs T25/T29/T30 |

