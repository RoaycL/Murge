# Phase 9 — Windows TUN privileged helper: design review package (rev. 3)

> Status: **draft for design review (rev. 3).** Design/contract level only. No code
> execution, no network mutation, no driver/route/DNS change performed on this
> machine. This revision resolves the seven must-fix items from the second review.
> The implementation gate remains **NOT met** and requires design-review sign-off
> plus separate owner authorization before any Windows implementation. In
> particular **G1 (mihomo reuses the helper-created adapter) is an unproven
> hypothesis** and is a hard blocking gate, not an established contract.

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

### 0.2 Round 3 review fixes (rev.4 — this revision)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Wintun ABI wrong: `WintunCreateAdapter(LUID*, Name, TunnelType, Session*)` is an incorrect signature | **Fixed verbatim from the official `wintun.h`** (§3.0, pinned **0.14.1**, recorded arch/exported-symbols/header-source): `WintunCreateAdapter(Name, TunnelType, RequestedGUID) -> WINTUN_ADAPTER_HANDLE`; `WintunGetAdapterLUID(Adapter, &Luid)`; `WintunStartSession(Adapter, Capacity)` creates the packet session; `WintunEndSession`/`WintunCloseAdapter`/`WintunDeleteAdapter` are distinct. The "**Wintun has no RequestedGUID parameter**" assertion is **withdrawn** — `RequestedGUID` is a real parameter (§3.0, §3.2). Pinned version + arch + exported symbols + header source recorded. |
| 2 | Elevation bootstrap used plain `CoCreateInstance` + `requireAdministrator` instead of the official COM elevation moniker | **Rewritten to the COM Elevation Moniker flow** (§5.1–§5.2): client uses `CoGetObject("Elevation:Administrator!new:{CLSID}", BIND_OPTS3, ...)`; full HKLM `CLSID`/`LocalizedString`/`Elevation`/`LocalServer32` (absolute path + `ServerExecutable`)/`AppID`/`LaunchPermission`/`AccessPermission` listed; `RunAs = "Interactive User"` (Activate-as-Activator); explicit `CoInitializeSecurity`/`CoSetProxyBlanket` authn/impersonation/packet-privacy params. |
| 3 | RPC client PID wrong: used `RPC_CALL_ATTRIBUTES_V2.ClientProcessId` | **Fixed to `RPC_CALL_ATTRIBUTES_V2.ClientPID`** with `Flags = RPC_QUERY_CLIENT_PID`; assert the call arrived over local **`ncalrpc`**; the PID is used **only to open and validate the process object** (path/digest/publisher/session-key), never as identity by itself (§5.2, §5.4). |
| 4 | Journal not truly write-ahead (the adapter was created, then the journal intent written) | **True write-ahead journal** (§8.3–§8.4): `BaselineSnapshot` committed first; `CREATE_ADAPTER/PREPARED` (fsync'd **before** `WintunCreateAdapter`); `CREATE_ADAPTER/APPLIED` after; every route/DNS op is `PREPARED` → mutate → `APPLIED`; crash between any two records is reconciled by **enumerating the product adapter / current OS state** (PREPARED-but-unknown). |
| 5 | No explicit adapter deletion; claimed last-session/handle close auto-deletes | **Explicit deletion** (§3.3): mihomo ends the session; helper enumerates + verifies the **product-owned** adapter; `WintunDeleteAdapter`; `RebootRequired` handled as `delete-pending`; only own-instance/product adapters deleted; `DELETE_ADAPTER/RECONCILED` written on success. The automatic-deletion claim is **removed**. |
| 6 | Reusable elevated helper let a second process attach | **Per-activation, short-lived elevated server** (§5.5): each enable uses `Elevation:Administrator!new` to create a fresh server that **binds to the first verified client**, **rejects all other clients** (including a second Murge process with identical path/signature/hash), and **exits** on transaction complete/cancel/timeout. Second-instance race test added (§13). |
| 7 | G1 still un-proven | Keep as a **hard pre-implementation gate**. A **minimal, one-shot disposable Windows probe** (create adapter → verify same GUID/LUID → delete + restore) runs first; it does **not** expand into full Phase 9 implementation (§12, §13). |

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
  test** (gated `windows-latest` job) that mihomo can `WintunOpenAdapter(luid)` (or
  otherwise bind to the existing device by its stable name) and run its packet session
  against the adapter the helper created, with no packet handle transferred across the
  boundary.
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

**Exported symbols (pinned from the official `wintun.def`/exports)**

```
WintunCreateAdapter
WintunOpenAdapter
WintunCloseAdapter
WintunDeleteAdapter
WintunGetAdapterLUID
WintunStartSession
WintunEndSession
WintunGetReadWaitEvent
WintunReceivePacket
WintunReleaseReceivePacket
WintunAllocateSendPacket
WintunSendPacket
WintunFreeSendPacket
```

**Pinned signatures (from official `wintun.h`, Wintun 0.14.x)**

```c
typedef struct _WINTUN_ADAPTER_HANDLE__ *WINTUN_ADAPTER_HANDLE;
typedef struct _WINTUN_SESSION_HANDLE__ *WINTUN_SESSION_HANDLE;

// Creates (and installs/loads the driver for) an adapter. RequestedGUID may be NULL
// for an OS-assigned GUID. Requires elevation. Returns a handle, else NULL.
WINTUN_ADAPTER_HANDLE WINAPI WintunCreateAdapter(
    _In_ const WCHAR *Name,
    _In_ const WCHAR *TunnelType,
    _In_opt_ const GUID *RequestedGUID);

void WINAPI WintunCloseAdapter(_In_ WINTUN_ADAPTER_HANDLE Adapter);      // close handle; adapter persists
void WINAPI WintunDeleteAdapter(_In_ WINTUN_ADAPTER_HANDLE Adapter);     // remove the adapter (may require reboot)
void WINAPI WintunGetAdapterLUID(_In_ WINTUN_ADAPTER_HANDLE Adapter, _Out_ NET_LUID *Luid);

// Starts the packet session. Returns a session handle, else NULL.
WINTUN_SESSION_HANDLE WINAPI WintunStartSession(_In_ WINTUN_ADAPTER_HANDLE Adapter, _In_ DWORD Capacity);
void WINAPI WintunEndSession(_In_ WINTUN_SESSION_HANDLE Session);
```

**Semantics that must never be conflated**

- `WintunCreateAdapter(Name, TunnelType, RequestedGUID)` → `WINTUN_ADAPTER_HANDLE`.
  **This is the only function that installs/loads the signed driver** (on demand), and it
  returns the adapter **handle** (NOT a LUID and NOT a session).
- `WintunGetAdapterLUID(Adapter, &Luid)` — the **only** way to get the adapter's
  `NET_LUID` (routes/DNS/interface key). It is a `_Out_` param on an adapter **handle**,
  not a return value and not a session call.
- `WintunStartSession(Adapter, Capacity)` — **this** creates the packet session; the
  parameter is a **capacity** (ring-buffer bytes), not a `LUID*`/`Session*`. The session is
  the data-plane transfer handle; the **helper does not use it** (§1.1).
- `WintunEndSession(Session)` ends a session; `WintunCloseAdapter(Adapter)` **closes the
  handle only** (the adapter **remains** registered and usable by other processes by
  name/LUID); `WintunDeleteAdapter(Adapter)` **removes the adapter** (and may return
  `ERROR_DRIVER_COMMAND`/warn a reboot). These are distinct — **closing the last session
  or handle does NOT delete the adapter** (§3.3).

> **Corrected from the earlier draft.** There is a **user-supplied `RequestedGUID`
> parameter**: passing a product-specific, stable GUID attempts to make the adapter
> addressable by that GUID. If the GUID is already in use, `WintunCreateAdapter` fails
> (→ `conflict`, no mutation). The stable identity for recovery is the **RequestedGUID +
> Name**, and the wire identity is the associated **`NET_LUID`**.

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
is "load the driver"; there is only `create_adapter` (and its delete counterpart).

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
  - The returned **`WINTUN_ADAPTER_HANDLE`** is the **only** durable object to derive the
    identity from. Do **not** reinterpret it as a LUID or a session.
- **Derive the LUID (routes/DNS key).** `WintunGetAdapterLUID(h, &luid)` (a `_Out_` param,
  on the adapter handle). Publish `{ name, requestedGuid, luid }` with `luid` as a
  **canonical hex string** (§8.1) — this is the key for routes/DNS/interface.
- **Do NOT start a session here.** The helper must **not** open a packet session
  (`WintunStartSession`). The data plane is owned by mihomo (§1.1), which will start the
  session. The helper **keeps the adapter handle open but never the session**; it releases
  the handle only at teardown (§3.3).
- **Uniqueness / reservation.** Enumerate Wintun adapters; assert exactly one Murge adapter
  and that no foreign adapter already holds the reserved `Name`/`RequestedGUID`. Otherwise ⇒
  `conflict`, no mutation.
- **Recovery identity.** On restart/recovery, enumerate Wintun adapters and reconcile by
  **`Name` + `RequestedGUID`** (the GUID is the stable address; the LUID is derived per
  adapter). A leftover adapter from an un-applied `create_adapter` is recognized and either
  adopted (if it is this product's) or renamed/removed only if provably owned (§3.3, §8.4).
- **Life cycle.** Created at enable; **removed** at disable / rollback via
  `WintunDeleteAdapter` (§3.3), **not** by simply closing the last handle/session. The
  routes/DNS written by the helper are always restored by the helper (it owns them and
  records the baseline **before** changing them, §8).
- **`probe_integrity`** verifies the helper digest/publisher + the `wintun.dll` digest; it
  does **not** load the driver and does **not** require elevation.

### 3.3 Adapter deletion — explicit, product-owned, reboot-aware

Closing the last session/handle does **not** delete the Wintun adapter. Deletion is an
explicit, owned, verified act:

1. **mihomo ends the session.** The data-plane owner calls `WintunEndSession` on its
   session and releases the adapter handle. (The helper never held a session.)
2. **Helper enumerates + verifies ownership.** The helper enumerates Wintun adapters,
   finds the one it created for this enable (matched by `Name` + `RequestedGUID`, with the
   derived LUID), and **proves it belongs to this product/instance** (not a pre-existing or
   foreign adapter). If it cannot prove ownership, it does **not** delete.
3. **`WintunDeleteAdapter(h)`.** On success the adapter is removed.
4. **`RebootRequired` handling.** If Windows reports that a reboot is required before the
   adapter fully clears (`ERROR_REBOOT_REQUIRED` / the delete is deferred), the helper
   records `delete-pending` in the journal so the next `init()`/`--recover` retries the
   delete (idempotent) rather than reporting the adapter as gone.
5. **Only own-instance/product adapters are ever deleted.** A pre-existing or shared Wintun
   adapter is left in place (D5, recommended: never remove a pre-existing driver/adapter).
6. **Journal.** After a confirmed delete, write the journal `DELETE_ADAPTER/RECONCILED`
   record (§8). A delete that is not yet confirmed stays `DELETE_ADAPTER/PREPARED` (or
   `delete-pending`) so recovery can re-run it against the current OS state.

**No claim of automatic deletion.** The design does **not** state that closing the last
session or handle auto-deletes the adapter; the driver releases a session when the last
session/handle closes, but the **adapter object persists until `WintunDeleteAdapter`** is
called for it.

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
  | 'delete_adapter'     // WintunDeleteAdapter, product-owned-only, reboot-aware (WAL)
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
- The helper enforces a **bootstrap handshake timeout** (e.g. 5 s) after which it exits, a
  **per-command timeout**, and closes idle channels.
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
| `LocalServer32\ThreadingModel` | `Both` |
| `LocalServer32\AppID` | `{AppID_PrivilegedHelper}` |
| `Elevation` (subkey, default value) | `Enabled` |

**`HKLM\Software\Classes\AppID\{AppID_PrivilegedHelper}`**

| Value | Value |
|---|---|
| (default) | `Murge Privileged Helper` |
| `RunAs` | **`Interactive User`** — required so the server is activated as the current interactive user's high-integrity token (Activate-as-Activator / Interactive User semantics, per the elevation moniker). **Not** a named/known account. |
| `LaunchPermission` | **Restrictive DACL**: deny `Everyone`/`Users`; grant `Launch` only to the authorized interactive-user principal + `SYSTEM` (the SCM/RPCSS must launch it). |
| `AccessPermission` | **Restrictive DACL**: deny `Everyone`/`Users`; grant access only to the authorized interactive-user principal + `SYSTEM`. |

> Because the server is activated via the **elevation moniker**, `RunAs` must be
> **`Interactive User`** (the moniker's Activate-as-Activator / interactive-user model).
> If you instead configured a specific account in `RunAs`, the elevation moniker would not
> operate in the documented interactive-user fashion; the design therefore explicitly
> rejects a named-account `RunAs`.
>
> The `LocalServer32` path and the optional `ServerExecutable` value must be **absolute and
> in the non-writable install dir**, so a search-path/DLL hijack cannot substitute a binary.
> `Elevation` is a **subkey** whose default value is `Enabled` — without it the moniker
> cannot request elevation.

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
- Whether mihomo can **open/reuse a helper-created adapter** by LUID/GUID is exactly the
  **G1** question — **not** answered here, and **gated** by the one-shot probe (§12).

These checks are a pre-implementation prerequisite and keep the design honest rather than
asserting unverified OS behavior. The design stands on the round-3 fixes regardless; the
checks only pin down which exact OS API calls to make.

### 5.5 Per-activation server lifetime and single-client binding (item 6)

Each `enable`/`disable` creates a **fresh, short-lived** elevated COM server via
`Elevation:Administrator!new:{CLSID}` — the same CLSID does **not** yield a reusable
long-lived helper.

- **Bound to one client.** On activation the helper registers its class factory and
  accepts **only the first client that passes the identity check** (steps 5–6). Every
  subsequent activation client is **rejected** — including a **second Murge process** that
  is byte-for-byte identical (same path, same Authenticode signature, same SHA-256) but is a
  different process: the helper already bound to the first verified client's
  `ClientPID`+logon-session+session-key and refuses a second `ProcessId`.
- **Exit conditions.** The server exits when: the transaction (enable or disable) completes,
  the user cancels/declines or the activation times out, the channel idles past a timeout,
  or the bound client's process handle signals exit (helper watches the client PID). No
  keep-alive; no indefinite wait.
- **Why not reuse.** A reusable helper would let an unrelated process (or a restarted app
  with the same binary) attach to a privileged instance. Per-activation creation + client
  binding + exit-on-idle closes that; the OS also unloads the elevated process when it
  exits, so there is no lingering High-IL process.
- **No double-activation.** If a `requestEnable` is already in flight (promise-queue
  serialization, §10), the main process does not issue a second activation; a second app
  instance that tries to activate independently is rejected by the client-binding rule
  (and the second instance is already gated by the single-instance app rule where
  applicable).

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

### 8.4 Recovery: reconcile PREPARED-but-unknown against the current OS state

A crash can leave a **PREPARED** record with no matching **APPLIED** — the mutation may or
may not have happened. Recovery must **reconcile by enumeration**, not assume:

- **On next boot / `--recover`.** `TunService.init()`/`--recover` loads `BaselineSnapshot` +
  the journal. For each op from the end backwards:
  - **APPLIED** → undo (reverse the op) subject to the per-item owned-only rule (§8.5);
    then write the matching `RECONCILED` record.
  - **PREPARED without APPLIED** → the mutation's success is **unknown**. Do **not** assume
    it happened or did not. Instead **reconcile against the current OS state**:
    - for `CREATE_ADAPTER`: **enumerate Wintun adapters** and find the product adapter by
      `Name` + `RequestedGUID`. If present, the create happened (adopt it, record
      `CREATE_ADAPTER/RECONCILED` and delete it or keep it per ownership); if absent, the
      create did not happen (record `RECONCILED`, nothing to undo).
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
- **`DELETE_ADAPTER` (commit point).** The delete of the adapter is the **last** undo step
  and is itself WAL: `DELETE_ADAPTER/PREPARED` → `WintunDeleteAdapter` →
  `DELETE_ADAPTER/APPLIED` (→ `RECONCILED`). If the delete needs a reboot
  (`ERROR_REBOOT_REQUIRED`), record `delete-pending` so the next `init()`/`--recover`
  retries it idempotently; the adapter is only reported gone once the delete is confirmed.

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
 6 CREATE_ADAPTER/APPLIED  write {luid, handle-derived GUID} and pin the canonical-hex LUID
7 apply routes/DNS  for each op: write ${op}/PREPARED -> mutate OS -> write ${op}/APPLIED
8 start mihomo     mihomo opens/reuses the adapter (G1) and starts its packet session
 9 readiness probe  probe the TUN/loopback path is live; assert routes/DNS present
10 active           phase → active; renderer gets the true status
```

- **Routes/DNS are always written after adapter creation** (steps 7+ follow step 5–6) so
  their target interface LUID/index already exists.
- **`CREATE_ADAPTER` is write-ahead**: the `PREPARED` record (steps 4) is fsync'd **before**
  `WintunCreateAdapter` (step 5) and the `APPLIED` record (step 6) is written only after it
  succeeds. A crash between 4 and 6 leaves a `CREATE_ADAPTER/PREPARED` record that recovery
  reconciles by **enumerating Wintun adapters** for `Name`+`RequestedGUID` (§8.4).
- **Any failure at any step recovers in reverse journal order** (§8.4), reconciling each
  PREPARED-but-unknown op against the current OS state: failure at step 9 undoes steps 7–6
  then the adapter (§3.3); failure at step 5 (or between 4–6) reconciles the adapter by
  enumeration; failure at step 2 (UAC cancelled / timeout) leaves **zero mutation**.
- **Disable is the mirror, with explicit adapter deletion (§3.3):** teardown mihomo
  (`WintunEndSession`) → restore routes/DNS per item (reverse WAL order) →
  **`DELETE_ADAPTER/PREPARED` → `WintunDeleteAdapter` (product-owned, verified) →
  `DELETE_ADAPTER/APPLIED`/`RECONCILED`**, handling `RebootRequired` as `delete-pending` →
  reconcile journal → `configured`.

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
or via `--recover`.

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

- **G1 (adapter handoff) — unproven, and it is a hard pre-implementation gate.** Before any
  Phase 9 implementation of the handoff path, run a **minimal, one-shot, disposable Windows
  probe** in the gated job that only: creates the adapter (`WintunCreateAdapter`),
  **verifies mihomo can reuse it by the same GUID/LUID**, then **immediately deletes the
  adapter and restores**, leaving the machine clean. The probe must **not** expand into full
  Phase 9 implementation (no helper service, no routes/DNS, no persistence, no UAC-bootstrap
  machinery). **If G1 fails, stop and return to the owner** for a revised ownership
  decision; do not fall back to dual ownership.
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
(`MURGE_RUN_REAL_TUN=1` **and** `win32`), never in default `npm test`.

| # | Test | Assertion | Evidence |
|---|---|---|---|
| T0 | **G1 one-shot probe (minimal, disposable)** | `WintunCreateAdapter` → mihomo **reuses the same GUID/LUID** → immediately `WintunDeleteAdapter`; machine restored. Runs **before** any Phase 9 helper work | adapter enumerate before/after; assert mihomo session bound the same LUID; assert clean delete |
| T1 | **Single-owner data plane / adapter handoff (G1)** | After the helper creates the adapter, mihomo **reuses the same GUID/LUID** (RequestedGUID is the stable identity) and there is exactly **one Murge adapter** in the system | enumerate adapter by Name/RequestedGUID/LUID before/after; assert count==1; assert mihomo session binds the same LUID |
| T2 | Ordering: routes/DNS after adapter creation | routes/DNS/interface are written **only after** the adapter exists; a failure before adapter creation leaves zero routes/DNS | journal seq + adapter existence at each step; assert no route/DNS op precedes `createAdapter` |
| T3 | **mihomo emits no route/DNS change** | With `auto-route:false`, `auto-detect-interface:false`, `dns-hijack:false`, mihomo adds/removes **no** route/DNS/interface outside the helper | route/DNS snapshot before+after mihomo start, diff == helper-written set only |
| T4 | Isolate dual-ownership regressions | Assert the runtime config never contains `auto-route:true`/`auto-detect-interface:true`/`dns-hijack:true` when the helper owns OS config | config-validator unit + integration grep |
| T5 | **Elevation moniker bootstrap: same-user malicious race-connect** | A second Medium-IL process cannot activate/connect to the running elevated helper while the app is connected, and cannot impersonate the app | attempt activation/connect from a second medium process; assert rejected (identity binding) |
| T5b | **Second Murge instance race (same path/signature/hash)** | A **second Murge process** — byte-for-byte identical binary (same path, same Authenticode, same SHA-256) — attempts to connect to the running per-activation helper; the helper has already bound the first verified client and **rejects** the second | launch second app; assert its activation/connect is rejected; assert it cannot drive the helper |
| T6 | **PID reuse** | A client PID whose process object was reused (exited + replaced) is rejected because path/digest/session-key no longer match | exit the app, let a reused PID connect; assert reject |
| T7 | **Process exit / timeout** | Handshake/command timeout and helper process exit zeroize `launchSecret`/`sessionKey` and leave zero mutation, and the per-activation server **exits** | timeout injection; assert no mutation + secrets zeroed (assert via cleanup path) + helper process gone |
| T8 | **Replay** | Replayed `HelperCommand` with a stale `requestId` is rejected | replay recorded frame; assert reject |
| T9 | **Crash injection at every journal record boundary (WAL)** | Force-kill the helper at **each durable-journal boundary** (pre-snapshot, post-snapshot, `CREATE_ADAPTER/PREPARED`-written, **mid-`WintunCreateAdapter`**, post-`CREATE_ADAPTER/APPLIED`, pre-`${op}/PREPARED`, mid-route/DNS mutate, post-`${op}/APPLIED`, pre-mihomo, post-probe, `DELETE_ADAPTER/*`); assert next `init()`/`--recover` reconciles each record against the current OS state and restores the baseline | journal replay + before/after route/DNS diff per boundary; enumerate adapter for `CREATE_ADAPTER` PREPARED-but-unknown |
| T10 | Crash recovery restores exact prior state | After a forced kill mid-activation, disable restores routes/DNS to the exact pre-enable state | route/DNS diff vs baseline |
| T11 | Only-one-Murge-adapter uniqueness + RequestedGUID conflict | A foreign adapter holding the reserved `Name`/`RequestedGUID` blocks activation with `conflict`, zero mutation | adapter pre-created with the reserved identity; assert `conflict` |
| T12 | **Adapter deletion is explicit + reboot-aware** | After disable, the product adapter is gone; if `WintunDeleteAdapter` reports `RebootRequired`, the journal records `delete-pending` and the next `init()`/`--recover` retries; a **pre-existing/foreign** adapter is never deleted | enumerate adapters; assert product adapter deleted and foreign adapter present; assert delete-pending journal record |
| T13 | Uninstall restore runs before deletion | Uninstall runs `--recover`, restores routes/DNS, aborts on corrupt snapshot | `NetworkSnapshot` diff; exit code / `Abort` path |
| T14 | Emergency `--recover` independent of GUI | Kill the app, run `--recover`, assert restored | restored state |
| T15 | Non-Windows / no helper ⇒ unsupported | Non-Windows or no verified helper returns `{supported:false, phase:'unsupported'}`, zero mutation | status probe unit + CI |
