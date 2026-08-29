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

## 0. Review resolutions (summary of the seven fixes)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Fictitious standalone `load_driver` step; `LoadLibraryEx(wintun.dll)` claimed to pre-install the driver | **Removed.** The driver is installed/loaded **inside `WintunCreateAdapter`** (§3). The helper elevates then calls `WintunCreateAdapter` with a product-specific adapter **name + tunnel type** and a stable **name→LUID** identity; it obtains and pins the **LUID before** the network-config phase. **mihomo-reuse-of-the-pre-created-adapter is G1 — an unproven hypothesis** that must be proven by a real mihomo Windows integration test before it is treated as a settled contract (§1.3, §12). |
| 2 | Enable order wrong; no guarantee routes/DNS follow adapter creation | New fixed order in §10.1: verify → elevate/bootstrap → BaselineSnapshot → helper creates adapter → get & pin LUID → write MutationJournal intent → apply routes/DNS → start mihomo/open adapter → readiness probe → active. **Any failure recovers in reverse journal order** (§8.4). |
| 3 | Dual OS-network-config ownership (helper `apply_routes`/`apply_dns` **and** mihomo `auto-route`/`dns-hijack`) | **One owner only — Option A.** The helper is the **sole** route/DNS/interface modifier; mihomo's runtime config is synthesized with `auto-route:false`, `auto-detect-interface:false`, `dns-hijack:false` so mihomo **never** touches routes/DNS; the main process generates a precise **typed `DesiredNetworkState`** that the helper applies verbatim (§1.1, §9). |
| 4 | IPC/UAC bootstrap self-contradictory (app creates both ends + helper inherits client end, yet helper is server calling `GetNamedPipeClientProcessId`; `expectedHelperPid`/`expectedAppPid` swapped); `runas` cannot inherit handles | **Rewritten as an executable Win32 sequence** using the **officially-supported elevation-COM-server bootstrap**. `runas`/`ShellExecuteEx` cannot propagate an inheritable-handle list, so the inherited-handle scheme is removed. §5 gives process, API, server/client roles, UAC API, handle-inheritance answer, and app/helper PID binding via `RpcServerInqCallAttributes(...).ClientProcessId` + token + signature. |
| 5 | Key lifecycle wrong (zeroed launchSecret at the wrong time / not retaining sessionKey); MAC used ambiguous `v\|op\|requestId\|payload` concatenation | Zero **only `launchSecret`** after handshake; **retain `sessionKey`** until channel close/task end; `RtlSecureZeroMemory` on **all** paths (normal, timeout, exception, helper exit). MAC now uses **length-prefixed canonical encoding** (§4.2, §4.3). |
| 6 | `dnsSets` missing `>`; `NET_LUID` as a JS number; `requestId` a UUID/string mix | Fixed in §8.1: `dnsSets: DnsSet[]` (closing `>`); **LUID as a canonical hex string** (never a JS number — a 64-bit value); `requestId` as a **monotonic uint64 decimal string** with an explicit per-session sequence. |
| 7 | Test matrix incomplete | Expanded in §13: single-Murge-adapter + same GUID/LUID reuse; routes/DNS always after adapter creation; mihomo emits no route/DNS change outside the helper; UAC-bootstrap adversarial tests (same-user race-connect, PID reuse, process exit, timeout, replay); crash injection at every journal boundary. |

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
  1. The helper calls `WintunCreateAdapter(LUID*, Name, TunnelType, Session*)` while
     elevated. This **installs/loads the signed driver on demand** and creates the
     adapter with the product-specific **name** (e.g. `"Murge TUN"`) and **tunnel type**
     (a stable opaque string, e.g. `"Murge TUN"`).
  2. The helper obtains the **LUID** from `WintunCreateAdapter` and re-derives/verifies
     it via `WintunGetAdapterLUID(Name, &luid)` so the name→LUID mapping is stable.
     The helper **closes its own session handle** (`WintunEndSession`/`WintunCloseAdapter`,
     keeping the adapter alive by name/LUID) so it never holds a packet session.
  3. The helper **pins + verifies** the LUID **before** the network-config phase (§10.1).
  4. The network-config phase applies routes/DNS/interface (§10.1). Routes/DNS are always
     written **after** the adapter exists (its LUID/index are known).
  5. mihomo opens/reuses the adapter and becomes the sole packet-I/O owner. **This is G1.**

> The Wintun API has **no user-supplied GUID parameter**; `WintunCreateAdapter` returns
> a driver-assigned 64-bit **LUID**. A "stable GUID" is therefore realized as a **stable
> adapter name** whose LUID is re-derivable and **unique**: the helper asserts exactly
> one Murge adapter exists (enumerate Wintun adapters by name; if more than one or if a
> foreign adapter already holds the name, fail closed for `conflict`).

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

### 3.2 Adapter creation (the helper's elevated act) — no `load_driver` op

The `load_driver` op and every "load the driver once" step are **deleted**. The
installation of the Wintun driver is a **side effect of `WintunCreateAdapter`**, which
requires elevation and is called by the helper. There is therefore no op whose purpose
is "load the driver"; there is only `create_adapter`.

- **`create_adapter`** (helper, elevated):
  `LoadLibraryEx` the official DLL (absolute path, safe flags) → `WintunCreateAdapter(
  &luid, L"Murge TUN", L"Murge TUN", &session)`.
  - Product-specific, **stable adapter name** and **tunnel type** string.
  - Returns the 64-bit **LUID** and a session handle. The helper **does not keep the
    session** for packet I/O; it obtains the LUID, verifies name→LUID via
    `WintunGetAdapterLUID`, closes its session, and publishes
    `{ name, luid }` (luid as a canonical hex string).
  - **Uniqueness:** enumerate Wintun adapters; assert exactly one Murge adapter and that
    no foreign adapter holds the reserved name. Otherwise ⇒ `conflict`, no mutation.
- **Adapter identity type.** LUID is a 64-bit `NET_LUID` union. Over the wire (and in
  every JSON record) it is serialized as a **canonical hex string** (e.g.
  `"0x0000000000000001"`), never a JS number (a 64-bit value exceeds `Number.MAX_SAFE_INTEGER`).
- **Life cycle.** Create at enable (inside `WintunCreateAdapter`), teardown at disable /
  process exit; when the last session handle closes the driver releases the adapter. The
  OS-level routes/DNS written by the helper are restored by the helper (it owns them and
  records the baseline before changing them, §8).
- **`probe_integrity`** now verifies the helper digest/publisher + the `wintun.dll` digest;
  it does **not** load the driver and does **not** require elevation.

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
  | 'create_adapter'     // WintunCreateAdapter: installs/loads driver + creates adapter
  | 'apply_network_state'// apply the typed DesiredNetworkState (routes/DNS/interface)
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

### 5.1 Parties and registration

| Side | IL | Role | Build |
|---|---|---|---|
| `.exe` main app (`electron` main) | Medium | COM **client**; the only holder of the `PrivilegedHelperClient` | Electron main |
| `helper.exe` | High (elevated) | COM **server**; the elevated broker | Native, `requireAdministrator`, no console, no network listener |

`helper.exe` is registered machine-wide (HKLM, so a per-user `HKCU` registration cannot
override it) as an out-of-proc COM server under a dedicated `AppID`, with:
- a `<requestedExecutionLevel level="requireAdministrator"/>` manifest, and
- a restrictive `LaunchPermission`/`AccessPermission` DACL (deny `Everyone`/`Users`;
  grant only the elevated helper identity + the authorized app principal), and
- `AuthenticationLevel`/`ImpersonationLevel` set so the channel runs with **mutual auth +
  packet privacy**.

### 5.2 Steps (each: process, API, who creates/connects, UAC API, handle inheritance)

1. **Client side (app, Medium).** `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)`;
   `CoInitializeSecurity(..., RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE,
   EOAC_SECURE_REFS | EOAC_STATIC_CLOAKING, NULL, ...)`.
2. **Activation (UAC is the elevation API).** The app calls
   `CoCreateInstance(CLSID_MurgeTunHelper, NULL, CLSCTX_LOCAL_SERVER, IID_IMurgeTunHelper,
   &iface)`. Because `helper.exe` declares `requireAdministrator`, the **elevation broker
   (AppInfo)** shows UAC and starts `helper.exe` at **High IL**. This is the exact point
   where elevation is requested — triggered only by an explicit user action (§10.1 enable).
   The app does **not** pre-launch the helper for UAC (no `runas`/`ShellExecuteEx`).
3. **Server side (helper, High).** Registers its class factory; on activation it is running
   high-IL. **Handle inheritance:** the design **does not** use `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`;
   it requires **no inherited handle** — `runas`/elevated activation cannot propagate one.
4. **Channel.** The authenticated COM interface **is** the channel. Each request is a
   schema-validated `HelperCommand` envelope (§4) passed as the interface parameter (a
   length-prefixed, size-capped byte blob / `IStream`). There is **no app-created named
   pipe** and **no** endpoint name to leak into a user-readable medium.
5. **Helper authenticates the app (identity binding).** On each privileged method call the
   helper:
   - `RpcImpersonateClient()` (COM) / `CoImpersonateClient()`, then
   - `RpcServerInqCallAttributes(..., RPC_CALL_ATTRIBUTES_V2, &atts)`; assert
     `atts.ClientProcessId` (Win8.1+) is set → **client (app) PID**.
   - `GetTokenInformation(TokenUser/TokenStatistics/TokenIntegrityLevel)` on the
     impersonation token: assert same **logon session**, same **user SID**, **Medium IL**,
     **token type** (primary/impersonation). A Medium-IL same-user process that is not the
     genuine app is still rejected because it cannot satisfy the path/digest/publisher
     check and does not present the **session key**.
   - `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, appPid)` + `QueryFullProcessImageName`
     → **normalized canonical path**; verify that path's **SHA-256 digest** and
     **Authenticode publisher** match the pinned app identity. A same-user impostor with a
     different path/digest/signer is rejected.
   - `CoRevertToSelf()` / `RpcRevertToSelf()` after the check.
6. **App authenticates the helper.** Because COM activation is machine-wide and elevation-
   mediated, the app verifies it activated the genuine helper: the first method call
   (`bootstrap`) returns the **helper PID** and the app then `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
   helperPid)` + `QueryFullProcessImageName` + `Get-AuthenticodeSignature`-equivalent and
   asserts the helper's canonical path + SHA-256 + publisher match the pinned helper. If a
   per-user registration tried to divert the CLSID, the resulting medium-IL server fails
   this check, so the app refuses to trust it.
7. **Handshake + key.** Over the authenticated channel the two sides derive `sessionKey`
   (HKDF). The `launchSecret` is exchanged **inside** the authenticated call (never on a
   cmdline/env/file), and is `RtlSecureZeroMemory`-zeroized right after the handshake
   (§4.3). The `sessionKey` is retained for the channel life and zeroized on close/exit.

This yields a self-consistent, executable sequence. Because the transport itself is
mutually authenticated and encrypted, the same-user-spoofing threat that motivated the
old pipe inheritance is closed by the OS rather than by a secret in a readable medium.

### 5.3 Least privilege

- UAC is shown only on first enable (explicit user action). `probe_integrity`/`get_status`/
  `health` never prompt UAC.
- The helper runs **High IL but with a restricted token** (the minimal enabled-privilege
  set: `SeLoadDriverPrivilege` for `WintunCreateAdapter`; route/DNS/interface changes via
  the `IP Helper`/`netsh`-equivalent APIs rather than blanket admin).
- The helper is a dedicated process: no console, no network listener of its own, no
  accidental admin shell, and **no** packet session (§1).

### 5.4 Facts to confirm against the pinned Windows target before implementation

The following are asserted from the general, documented Windows model and must be
**re-checked against the exact pinned Windows SDK / minimum-OS target and the exact Wintun
release** before any implementation, because no live lookup was done this session:

- **Elevated out-of-proc COM activation over `requireAdministrator` + a dedicated HKLM
  `AppID`** is accepted by the OS and triggers the UAC prompt (rather than requiring a
  `RunAs` AppID account). Confirm the exact registration key/value set that yields an
  elevation prompt for a Medium-IL `CoCreateInstance` client.
- `RpcServerInqCallAttributes` with `RPC_CALL_ATTRIBUTES_V2.ClientProcessId` is **available
  and populated** on the target (Windows 8.1+); if not, fall back to the documented
  `RpcImpersonateClient` + `QuerySecurityContextToken`/token checks and obtain the client
  PID another way.
- The Wintun API surface (`WintunCreateAdapter`/`WintunGetAdapterLUID`/`WintunOpenAdapter`/
  session life cycle) and its exact signature/semantics for the pinned release; in
  particular that **`WintunCreateAdapter` installs/loads the driver on demand** (so no
  separate `load_driver` op is needed) and that the **LUID is driver-assigned** (Wintun
  accepts no user-supplied GUID). If the pinned version differs, re-document §3 accordingly.
- Whether mihomo can **open/reuse a helper-created adapter** by LUID/name is exactly the
  **G1** question and is **not** answered here — it is a blocking gate to be proven by the
  real Windows integration test.

These checks are a pre-implementation prerequisite and keep the design honest rather than
asserting unverified OS behavior. The design stands on the round-2 fixes regardless; the
checks only pin down which exact OS API calls to make.

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

// MutationJournal — append-only, ordered log of every mutation (crash recovery)
interface MutationJournalEntry {
  seq: number
  at: string
  op: string            // createAdapter | addRoute | delRoute | setDns | setMetric | ...
  luid: string          // canonical hex NET_LUID string
  before: unknown
  after: unknown
  baselineFingerprint: string   // sha256 of the BaselineSnapshot
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

### 8.3 Per-item owned-only restore (never all-or-nothing)

- Before the first mutation the helper writes the `BaselineSnapshot` (atomically:
  temp → validate → rename) and aborts with zero mutation if it cannot.
- Every mutation is appended to the `MutationJournal`, and its exact resulting values are
  recorded in `WrittenState`.
- Restore compares the current OS state against `WrittenState` **per item** (per LUID, per
  family, per field):
  - If the current value still equals what `WrittenState` says we wrote, restore it to the
    `BaselineSnapshot` value.
  - If the current value was changed externally, do not overwrite; record a **per-item
    conflict** (`conflictDetail`: LUID/index, family, field, expected vs current).
  - Unrelated items are unaffected. The phase becomes `conflict` only if any owned item was
    externally modified; otherwise restore completes to `configured`.

### 8.4 Reverse-journal-order recovery (item 2)

- The `MutationJournal` is the **authoritative undo log**. On any failure during activation
  (adapter create, LUID pin, route/DNS apply, mihomo open, readiness probe), the helper
  walks the journal **in reverse order** and undoes each recorded op back to its `before`
  value, **per item** and subject to the per-item owned-only rule above. It does **not**
  skip around; the reverse order guarantees a foreign dependency (e.g. a route added after
  an interface metric) is torn down before the dependency it relied on.
- **Crash recovery:** on next boot, `TunService.init()` reads the `MutationJournal` +
  `BaselineSnapshot`; if the journal is non-empty and not reconciled, it replays the reverse
  of each op (or restores from baseline where the current state still matches
  `WrittenState`). The owner can also run the emergency `--recover` path.
- **Crash-injection boundaries** are enumerated in §13 so that reverse-order recovery is
  tested at every step boundary, not just at the end.

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

### 10.1 Enable order (fixed, item 2)

The enable operation runs inside the main-process `promise-queue` (serialized). The exact
order is:

```
 1 verify            probe_integrity (helper + wintun digest/publisher); no elevation, no mutation
 2 elevate/bootstrap show UAC via elevation-COM activation; handshake + derive sessionKey
 3 BaselineSnapshot  helper writes + verifies the FULL baseline BEFORE any OS mutation
 4 create adapter    helper (elevated) calls WintunCreateAdapter → installs/loads driver
                     + creates adapter (name + tunnel type) + returns LUID
 5 pin & verify LUID helper re-derives via WintunGetAdapterLUID(name), asserts exactly one
                     Murge adapter, pins the canonical-hex LUID; aborts if ambiguous
 6 write journal intent helper appends createAdapter + the intended DesiredNetworkState to
                     the MutationJournal (undo target recorded before applying)
 7 apply routes/DNS helper applies DesiredNetworkState (routes, per-interface DNS, metrics)
 8 start mihomo     mihomo opens/reuses the adapter (G1) and starts its packet session
 9 readiness probe  probe the TUN/loopback path is live; assert routes/DNS present
10 active           phase → active; renderer gets the true status
```

- **Routes/DNS are always written after adapter creation** (steps 6–7 follow step 4–5) so
  their target interface LUID/index already exists.
- **Any failure at any step recovers in reverse journal order** (§8.4): e.g. failure at
  step 9 undoes step 7, 6, 5, 4 (adapter) in that reverse order, then the baseline is
  intact; failure at step 4 undoes the adapter; failure at step 2 (UAC cancelled / timeout)
  leaves zero mutation.
- Disable is the mirror: teardown mihomo → restore routes/DNS per item → close adapter →
  reconcile journal → `configured`.

### 10.2 Transition table

| Phase | Entry | Allowed actions | On failure |
|---|---|---|---|
| `configured` | init/recovery, end of disable | enable | — |
| `starting` | `requestEnable` intent | verify → snapshot → create_adapter → pin LUID → apply_network_state → mihomo open → probe | → `restoring` (reverse journal order) → `restore-failed`/`failed` |
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

- **G1 (adapter handoff) — unproven.** Prove with a real mihomo Windows integration test
  that mihomo can open and reuse the helper-created adapter (by LUID/name). Until it
  passes, the handoff is **not** a settled contract and Phase 9 implementation of the
  handoff path must not start. **If G1 fails, stop and return to the owner** for a revised
  ownership decision; do not fall back to dual ownership.
- **D4:** helper boot/auto-start for the emergency path. Recommended: **no self-start**;
  `--recover` is run manually. (D2 = standalone helper, so a service is not assumed.)
- **D5:** whether a Wintun **driver** that pre-existed is ever removed on uninstall.
  Recommended: **never** remove a pre-existing/shared driver; we never ship a `.sys`.
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
| T1 | **Single-owner data plane / adapter handoff (G1)** | After the helper creates the adapter, mihomo **reuses the same LUID** (Wintun has no user-supplied GUID for the app to pin; stable identity is name→LUID) and there is exactly **one Murge adapter** in the system | enumerate adapter by name/LUID before/after; assert count==1; assert mihomo session binds the same LUID |
| T2 | Ordering: routes/DNS after adapter creation | routes/DNS/interface are written **only after** the adapter exists; a failure before adapter creation leaves zero routes/DNS | journal seq + adapter existence at each step; assert no route/DNS op precedes `createAdapter` |
| T3 | **mihomo emits no route/DNS change** | With `auto-route:false`, `auto-detect-interface:false`, `dns-hijack:false`, mihomo adds/removes **no** route/DNS/interface outside the helper | route/DNS snapshot before+after mihomo start, diff == helper-written set only |
| T4 | Isolate dual-ownership regressions | Assert the runtime config never contains `auto-route:true`/`auto-detect-interface:true`/`dns-hijack:true` when the helper owns OS config | config-validator unit + integration grep |
| T5 | **UAC bootstrap: same-user malicious race-connect** | A second Medium-IL process cannot open/activate the helper while the app is connected, and cannot impersonate the app | attempt activation/connect from a second medium process; assert rejected (identity binding) |
| T6 | **UAC bootstrap: PID reuse** | A client PID whose process object was reused (exited + replaced) is rejected because path/digest/session-key no longer match | exit the app, let a reused PID connect; assert reject |
| T7 | **UAC bootstrap: process exit / timeout** | Handshake/command timeout and helper process exit zeroize `launchSecret`/`sessionKey` and leave zero mutation | timeout injection; assert no mutation + secrets zeroed (hard-to-verify locally; assert via cleanup path) |
| T8 | **UAC bootstrap: replay** | Replayed `HelperCommand` with a stale `requestId` is rejected | replay recorded frame; assert reject |
| T9 | **Crash injection at every journal boundary** | Force-kill the helper at each of the §10.1 step boundaries (pre-snapshot, post-snapshot, pre-createAdapter, post-createAdapter, pre-apply, mid-apply, post-apply, pre-mihomo, post-probe); assert next `init()`/`--recover` reverses the journal in order and restores the baseline | journal replay + before/after route/DNS diff per boundary |
| T10 | Crash recovery restores exact prior state | After a forced kill mid-activation, disable restores routes/DNS to the exact pre-enable state | route/DNS diff vs baseline |
| T11 | Verifies only-one-Murge-adapter uniqueness | A foreign adapter holding the reserved name blocks activation with `conflict`, zero mutation | adapter pre-created with the reserved name; assert `conflict` |
| T12 | Uninstall restore runs before deletion | Uninstall runs `--recover`, restores routes/DNS, aborts on corrupt snapshot | `NetworkSnapshot` diff; exit code / `Abort` path |
| T13 | Emergency `--recover` independent of GUI | Kill the app, run `--recover`, assert restored | restored state |
| T14 | Non-Windows / no helper ⇒ unsupported | Non-Windows or no verified helper returns `{supported:false, phase:'unsupported'}`, zero mutation | status probe unit + CI |
