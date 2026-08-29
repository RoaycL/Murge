# Phase 9 — Windows TUN privileged helper: design review package (rev. 2)

> Status: **draft for design review (rev. 2).** Design/contract level only. No code
> execution, no network mutation, no driver/route/DNS change performed on this
> machine. This revision resolves the six must-fix items from the first review.
> The implementation gate remains **NOT met** and requires design-review sign-off
> plus separate owner authorization before any Windows implementation.

Decisions supplied by the owner (in force):

- **D1 = Signed Wintun (WireGuard driver + official DLL).**
- **D2 = Standalone elevated helper process** (not a Windows service).
- **D3 = Driver loaded on first enable** (DLL staged from the installer, loaded at
  the user's first explicit enable).

Companion docs: `docs/helper-threat-model.md`, `docs/helper-install-upgrade-rollback.md`.
Conventions referenced: `src/shared/system-proxy.ts`, `src/shared/ipc.ts`,
`src/shared/gateways.ts`, `src/main/system-proxy/service.ts` & `adapters/*`,
`src/main/kernel/mihomo-config.ts`, `src/main/kernel/mihomo-artifact.ts`.

---

## 0. Review resolutions (summary of the six fixes)

| # | Finding | Resolution (this document) |
|---|---|---|
| 1 | Ambiguous TUN data-plane ownership (helper creates/owns Wintun **and** mihomo enables `tun`) | **Single data-plane owner = mihomo.** The helper is a **privilege/verification/recovery broker**; it never creates or holds a Wintun session for packet I/O. §1, §3, §9. |
| 2 | Distributed `wintun.sys` staging/install/upgrade and a self-signed driver cert — not the official model | Rewritten to the **official distribution model**: ship per-arch `wintun.dll`, never a bare `wintun.sys`; remove driver-file staging/self-signed flows; add source/license/SHA-256/signature-verify/safe `LoadLibraryEx`/adapter-lifecycle. §3. |
| 3 | Same-user SID + random pipe name + nonce cannot stop a same-user process spoofing Murge | Pipe client **PID + token/session + canonical path + signature/hash** validated; **one-time bootstrap credential bound to the expected PID** delivered over an inherited handle; secure transfer, timeouts, replay cache, credential zeroing. §5. |
| 4 | Snapshot only held two default gateways + a global DNS list; restore was all-or-nothing | Per-**LUID/index** IPv4/IPv6 routes (prefix/next-hop/metric/protocol/store), per-interface DNS with order + DHCP/static source, interface metric/state; split into **BaselineSnapshot / WrittenState / MutationJournal**; **per-item owned-only** restore (never all-or-nothing). §8. |
| 5 | State-machine set not unified across install doc, shared types, state table, UI copy | One canonical `TunPhase` union (`configured/starting/active/failed` + `restoring/restore-failed/conflict/unsupported`) used verbatim in the shared type, the state table, the install doc and the UI copy. §4, §10. |
| 6 | Renderer contract contradicted (could only read status, yet `TunGateway.enable/disable` exposed) | Renderer may only send a **typed, parameterless intent** (`requestEnable`/`requestDisable`); it never touches the helper, passes arbitrary args, or mutates state. §6, §12. |

---

## 1. Architectural layering and the single data-plane owner

### 1.1 Ownership split (item 1)

The double-ownership is removed by giving each plane exactly one owner:

| Plane | Owner | Responsibility |
|---|---|---|
| **TUN data plane** (packet read/write, adapter session) | **mihomo** (supervised kernel, `tun.stack: system`) | Creates the Wintun adapter session, reads/writes packets, owns the capture. |
| **OS privilege plane** (driver load, route/DNS/interface mutation, baseline, recovery) | **helper** (elevated broker) | Loads the signed Wintun driver once, applies the route/DNS set requested by mihomo's config, records/restores the baseline, verifies integrity, provides recovery. |
| **Decision plane** (what TUN/DNS/routes to use) | **mihomo config** (validated) | Produces the desired route/DNS/adapter set; the helper only executes the validated, typed result. |

The helper therefore **never holds a Wintun session handle and never touches packet
buffers**. There is exactly one TUN device owner (mihomo) and one OS-mutation owner
(helper); they communicate over the authenticated pipe (§5) with typed, validated
commands.

### 1.2 Layering diagram

```
renderer ── typed window.desktop.tun.*  (intent + status only; §6/§12)
   │ validated Electron IPC (ipc.ts tun:* intent channels)
   ▼
main ── TunService (service.ts)         state machine + serialized ops + probe + backup
   │      getStatus / init / enable / disable / onStatus
   ▼
main ── policy.ts                       pure ownership/merge/format helpers (no I/O)
   ▼
main ── adapters/WindowsTunAdapter      privileged boundary: helper client, driver load,
   │      integrity verify, baseline snapshot/recovery (no packet I/O)
   ▼
main ── PrivilegedHelperClient          named-pipe IPC (§5)
   ▼
elevated ── helper.exe (High IL)        broker: load Wintun driver, apply routes/DNS,
   │                                      snapshot/recover, verify; NO session/packets
   ▼
wintun.dll (official, per-arch) ──► signed Wintun kernel driver (loaded via the DLL)
   ▼
mihomo ── Wintun adapter session        the ONLY data-plane owner
```

Non-Windows builds use a `DisabledTunAdapter` returning `{ supported:false,
phase:'unsupported' }` with zero mutation (a fake adapter backs the dev/test path).

### 1.3 Conditional adapter-handoff protocol (only if the Wintun device needs elevation)

The primary model is **mihomo creates the adapter** because the helper pre-loaded
the signed Wintun driver (§9). The implementation must assert at first enable
whether `WintunCreateAdapter`/`WintunOpenAdapter` succeeds from a Medium-IL mihomo
process while the driver is already loaded. If — and only if — that runtime check
shows creation needs elevation, use this handoff so **mihomo still owns the data
plane**: the helper does not hold the session, it only fabricates the device.

1. The helper calls `WintunCreateAdapter` (elevated) and **closes its own
   session**; the driver keeps the adapter alive by the adapter **name/LUID**.
2. The helper publishes the device **name + LUID** (never a raw handle) over the
   authenticated pipe as `provision_adapter: { name, luid }`. A raw packet/session
   handle is **not** transferred (no `DuplicateHandle` of a driver handle into the
   app/helper); the driver's access control governs `WintunOpenAdapter`.
3. mihomo calls `WintunOpenAdapter(name)` to obtain its own session handle and
   becomes the **sole** packet-I/O owner; the helper releases no further Wintun
   reference and never reads/writes a packet.
4. On disable/crash, mihomo's session close releases the adapter; the helper then
   restores routes/DNS (per item, §8).

This keeps exactly one data-plane owner (mihomo) in both paths; the helper never
holds a device session or packet buffer.

---

## 2. Shared contract (`src/shared/tun.ts`)

### 2.1 Canonical `TunPhase` (item 5)

```ts
export type TunPhase =
  | 'configured'      // supported & verified (helper/driver present), NOT active
  | 'starting'        // enabling: integrity verification + driver load + applying
  | 'active'          // TUN up and owned by the app
  | 'failed'          // non-recoverable failure (integrity, driver load, capture)
  | 'restoring'       // tearing down to baseline
  | 'restore-failed'  // could not restore (not a conflict)
  | 'conflict'        // an externally-modified owned item; per-item (never all-or-nothing)
  | 'unsupported'     // platform/build cannot enable TUN
```

This set is used **verbatim** in the shared type, the state table (§10), the install
doc, and the UI copy (§10.2). There is no separate `disabled`: "off but supported" is
`configured`; "cannot be enabled" is `unsupported`.

### 2.2 `TunStatus`

```ts
export interface TunStatus {
  supported: boolean
  phase: TunPhase
  deviceName: string | null      // Wintun adapter name while active, else null
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
tunGetStatus:    'tun:get-status',
tunEnable:       'tun:request-enable',   // INTENT, parameterless (§6)
tunDisable:      'tun:request-disable',  // INTENT, parameterless (§6)
tunStatusEvent:  'tun:status-event',

// gateways.ts
export interface TunGateway {
  getStatus(): Promise<TunStatus>
  requestEnable(): Promise<TunStatus>    // intent only; main performs the real op
  requestDisable(): Promise<TunStatus>   // intent only
  onStatus(l: (s: TunStatus) => void): () => void
}
```

---

## 3. Wintun distribution and safe loading model (item 2)

This follows the **official Wintun distribution model**:

- **Ship the official per-arch `wintun.dll`, never a bare driver file.** The Wintun
  release is distributed by the Wintun project at `https://www.wintun.net/` as a ZIP
  containing `wintun.dll` per architecture (`wintun/bin/amd64/...`,
  `wintun/bin/arm64/...`). The kernel driver is loaded **through the DLL**, and an
  application must **not** distribute a file named like the driver directly. All
  driver-file staging, "install the .sys", "upgrade the .sys" and "delete the .sys"
  steps are therefore removed.
- **Per-arch bundling.** Bundle `wintun-amd64.dll` / `wintun-arm64.dll` as an
  `extraResources` near `resources/bin/<arch>` (the same per-arch model used for the
  pinned mihomo archive). Never cross-bundle the other arch.
- **Source.** From the official Wintun release (wintun.net). Record the exact release
  version + URL in the third-party notice.
- **License / notice compliance.** Capture the Wintun license text that ships with
  the official release, record its SPDX identifier, and add it to
  `resources/THIRD_PARTY_NOTICES.md` (and the source-offer/notice list). Because the
  app is `GPL-3.0-only`, confirm the Wintun license is compatible and that bundling
  the DLL (which loads/installs the Wintun driver) meets redistribution obligations.
  This is a compliance check that must pass **before** packaging.
- **SHA-256 / integrity.** Set the exact per-arch `wintun.dll` SHA-256 in the pinned
  release manifest (same mechanism as `mihomo-artifact.ts`). Runtime re-verifies the
  digest before loading; a mismatch ⇒ fail closed, do not load.
- **Signature verification.** Our `helper.exe` is Authenticode-signed with the
  project certificate and its publisher verified (C1). The Wintun **kernel driver**
  is loaded through the DLL and is **required to be a signed driver** that Windows
  will load (the OS only loads signed kernel drivers). We do not self-sign, add a
  self-signed cert, or attempt to spoof the driver's signature. Wintun's DLL is
  validated by the pinned digest; where the OS can report it, we assert the loaded
  driver's publisher matches the Wintun publisher.
- **Safe loading.** Load `wintun.dll` with `LoadLibraryEx` from the **absolute path**
  in the (non-writable) install dir, using the safe search flags
  (`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` and/or `SET_DEFAULT_LOAD_DIR` via
  `SetDefaultDllDirectories`), so a `cwd`/`System32`/search-path hijack by a
  lower-trust process cannot substitute a DLL. Never load by short name.
- **Adapter life cycle.** Adapter creation and packet I/O are owned by **mihomo** (§1).
  The helper's only driver role is to load it **once** so the driver is present for
  mihomo (§9). The adapter session is created/closed by mihomo: create on enable,
  close on disable or process exit; when the last session handle closes, the driver
  releases the adapter. A crash leaves the driver loaded (harmless) and the OS-level
  routes/DNS to be restored by the helper (which owns those and records the baseline
  before changing them, §8).

---

## 4. Helper IPC and authentication hardening (item 3)

The simple SID + random-pipe-name + nonce model is rejected. The contract requires
each of the following; a failure in any one ⇒ close and fail closed (zero mutation).

### 4.1 Endpoint is not name-discoverable

- The channel is a **named pipe** whose **name is a per-launch 256-bit random value**,
  and whose **SDDL** denies `Everyone` and the built-in `Users` group, granting only
  the helper's principal and the explicitly authorized app principal. Defense in
  depth only: the primary gate is the handle, not the SDDL.

### 4.2 One-time bootstrap credential bound to the expected PID

- The app creates both ends of the channel and **hands the client end to the helper
  by handle inheritance** (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`) at `CreateProcess`.
  The endpoint name is **never** put on the command line, environment, a regular
  file, or a user-readable registry value — those are all readable by a same-user
  process, so they are forbidden channels.
- The app generates a **256-bit one-time `launchSecret`** and the **expected helper
  PID** (from `CreateProcess`). The app writes `{ launchSecret, expectedHelperPid }`
  to the helper over the already-open inherited-handle channel as the **first**
  message; this is the only medium neither a same-user process nor an on-path loader
  can observe. The helper retains the secret only for the handshake and zeroizes it
  immediately after.

### 4.3 Client (app) identity validation — server-side

The helper is the **IPC server** and validates the **connecting client**:

- **PID:** `GetNamedPipeClientProcessId` yields the real client PID; it must equal the
  **expected app PID** (provided at bootstrap, or derived from the client token).
- **Token / session:** `ImpersonateNamedPipeClient` + token query must show the same
  **logon session**, the same **user SID**, and the expected **token type / integrity
  level** (the app's Medium-IL token). A Medium-IL same-user process that is *not*
  the app is rejected even though it shares the user SID.
- **Path / signature / hash:** `QueryFullProcessImageName` → **normalized canonical
  path**; verify that path's **SHA-256 digest** and **Authenticode publisher** match
  the pinned, signed app identity. A same-user impostor with a different path, hash,
  or signer is rejected.
- **Nonce + session key:** after bootstrap, the helper issues a per-session nonce; each
  message is bound to a **session key derived** from the `launchSecret` (HMAC) and
  carries a **monotonic `requestId`**.
- **Replay cache:** a bounded cache keyed by `requestId` rejects duplicates; a replay
  or an out-of-order/old id ⇒ close.
- **Timeouts:** the helper enforces a **bootstrap handshake timeout** (e.g. 5 s) after
  which it exits, a **per-command timeout**, and closes idle channels.
- **Credential zeroing:** the `launchSecret` and session key are kept only in memory,
  never logged, and **zeroized** (`RtlSecureZeroMemory`) on handshake complete, on
  task end, and on helper exit.

### 4.4 Command envelope (schema-validated in the helper)

```ts
interface HelperCommand {
  v: 1
  op: HelperOp                 // allowlist below
  requestId: string            // monotonic; replayed ⇒ reject
  mac: string                  // HMAC(sessionKey, v|op|requestId|payload)
  payload: HelperPayload       // op-specific, JSON-schema validated
}
type HelperOp =
  | 'probe_integrity'   // verify helper+wintun digest/publisher (no mutation, no elevation)
  | 'load_driver'       // load the signed Wintun driver once (idempotent; first enable)
  | 'apply_routes'      // apply the validated route set mihomo requested (OS privilege)
  | 'apply_dns'         // apply the validated per-interface DNS set (OS privilege)
  | 'snapshot'          // capture/save the BaselineSnapshot BEFORE mutation
  | 'restore'           // per-item owned-only restore (§8)
  | 'get_status'
  | 'health'
```

Rules enforced in the helper:

- `op` outside the allowlist ⇒ reject. `v` must be 1. `payload` validated against the
  op schema before any side effect. Size-capped (e.g. 4 KiB). No arbitrary path, no
  raw command string, no free-text script.
- **`apply_routes`/`apply_dns` are typed, validated structures** produced by mihomo's
  config (auto-route/dns-hijack), not free-form CLI text. The helper is not a shell.

---

## 5. Elevation flow (explicit, least-privilege)

1. Renderer shows an enable control; the user clicks it → `requestEnable` intent (§6).
2. Main `TunService.enable()` runs in the promise-queue:
   - **Preflight (no elevation):** `probe_integrity` verifies the helper + wintun
     digest/publisher. On failure ⇒ `{ phase:'unsupported'|'failed' }`, zero write.
   - **Driver load (first enable only):** the helper requests UAC consent and loads
     the signed Wintun driver via the **official DLL**. Only the minimal privilege is
     granted (restricted High-IL token with the minimal enabled-privilege set).
   - **Baseline before mutation (§8):** `snapshot` records the BaselineSnapshot
     (temp+rename, digest-verified) and **aborts with zero mutation if it cannot**.
   - **Apply:** `apply_routes` / `apply_dns` apply the validated set; mihomo then
     brings up its own **Wintun adapter session** (the single data-plane owner).
   - The renderer is updated only from returned/pushed status; it never flips
     optimistically.
3. `probe_integrity`/`get_status`/`health` never prompt UAC.

---

## 6. Renderer contract (item 6)

- The renderer has **no access to the helper client, no device/session handle, and no
  privilege**. It only has `TunGateway` (a main-process proxy).
- The renderer may only:
  - **read** `TunStatus` via `getStatus()`/`onStatus()`, and
  - **send a typed, parameterless intent** `requestEnable()`/`requestDisable()`
    (a click that carries no arguments). These are validated IPC intents; the actual
    authorization, mutation, ordering and error handling all happen in the
    main-process `TunService`, which is the **sole holder of the `PrivilegedHelperClient`
    handle**.
- There is **no** renderer→helper path, **no** arbitrary parameter, and **no** op to
  mutate state directly. The UI never calls `getStatus` to justify an optimistic flip;
  it renders the status main reports.

---

## 7. Driver/helper integrity procedure (C1, C2)

- **Manifest:** per-arch `helper.exe` + `wintun.dll` SHA-256 digests and publisher
  thumbprints, validated inside the signed installer and re-checked at runtime
  (reuse `sha256File`, `mihomo-artifact.ts`).
- **Runtime:** every `load_driver`/`apply_*` re-verifies the helper digest + publisher
  and the wintun digest. Failure ⇒ `{ phase:'failed'|'unsupported' }`, zero mutation,
  helper not trusted.
- **Fail-closed:** missing manifest, digest mismatch, untrusted signer, unreadable
  file ⇒ abort. Self-signed cert allowed only in a CI "smoke" path, never in the
  production activation path.

---

## 8. Network snapshot model (item 4)

### 8.1 Three distinct records — no collapsing into a single "snapshot"

```ts
// BaselineSnapshot — the exact pre-enable OS state (immutable reference for restore)
interface BaselineSnapshot {
  schemaVersion: 1
  instanceId: string
  capturedAt: string
  interfaces: InterfaceSnapshot[]           // keyed by LUID/index
  firewallProfile: string | null
}
interface InterfaceSnapshot {
  luid: number                              // network interface LUID (index)
  index: number
  description: string
  type: string                              // e.g. "Ethernet"/"Wireless"/"Loopback"
  metric: number | null                     // interface metric (per-family overrides where set)
  state: string                             // connected/disconnected/...
  ipv4Routes: RouteSnapshot[]               // FULL route table rows for this LUID
  ipv6Routes: RouteSnapshot[]               // FULL route table rows for this LUID
  dns: DnsSnapshot[]                        // ordered DNS servers for this interface
}
interface RouteSnapshot {
  destination: string                       // prefix, e.g. "0.0.0.0/0" won't be included verbatim;
                                            // we record the actual prefix, not just the gateway
  prefixLength: number
  nextHop: string | null                    // gateway, or null for on-link
  metric: number
  protocol: string                          // static | dhcp | onlink | ... (route store/protocol)
  routeStore: 'active' | 'persistent'       // which store the route lives in
}
interface DnsSnapshot {
  server: string
  source: 'dhcp' | 'static' | 'manual'      // where the entry came from
}

// WrittenState — EXACTLY what the helper wrote on this activation (owned reference)
interface WrittenState {
  schemaVersion: 1
  instanceId: string
  writtenAt: string
  routeAdditions: Array<{ luid: number; route: Omit<RouteSnapshot,'source'> }>
  routeDeletions: Array<{ luid: number; route: Omit<RouteSnapshot,'source'> }>
  dnsSets: Array<{ luid: number; servers: string[] }
  metricSets: Array<{ luid: number; metric: number }>
}

// MutationJournal — append-only, ordered log of every mutation (crash recovery)
interface MutationJournalEntry {
  seq: number
  at: string
  op: string                    // addRoute | delRoute | setDns | setMetric | loadDriver | ...
  luid: number
  before: unknown               // value before the op
  after: unknown                // value after the op
  baselineFingerprint: string   // sha256 of the BaselineSnapshot so recovery detects drift
}
```

### 8.2 Per-item owned-only restore (never all-or-nothing)

- **Before the first mutation** the helper writes the `BaselineSnapshot` (atomically:
  temp → validate → rename) and **aborts with zero mutation if it cannot**.
- **Every mutation is appended to the `MutationJournal`**, and the exact resulting
  values are recorded in `WrittenState`.
- **Restore** compares the **current OS state** against `WrittenState` **per item**
  (per LUID, per address family, per field):
  - If an item's current value **still equals** what `WrittenState` says we wrote, we
    restore it to its `BaselineSnapshot` value.
  - If the item's current value was **changed externally**, we do **not** overwrite it;
    we record a **per-item conflict** (`conflictDetail`: LUID/index, family, field,
    expected vs current) in the `ConflictDetail` list.
  - **Unrelated items are unaffected.** An external change to route `X` does **not**
    block restoring route `Y` or the DNS on interface `Z`, and does not cause us to
    stampede into overwriting other externally-changed items. The phase becomes
    `conflict` only if any owned item was externally modified; otherwise restore
    completes to `configured`.
- **Crash recovery:** on next boot, `TunService.init()` reads the `MutationJournal` +
    `BaselineSnapshot`; if the journal is non-empty and not reconciled, it replays the
    reverse of each recorded op (or, per-item, restores from the baseline where the
    current state still matches `WrittenState`). The owner can also run the emergency
    `--recover` path, which does the same without the GUI or mihomo.

---

## 9. Config gating (C7) — how `tun.enable:false` relaxes for the single owner

Today `mihomo-config.ts` asserts, for every document, that `tun`/`dns` contain only
`enable` and it must be `false`, and refuses to merge any profile-provided
`tun`/`dns`/`rules` block.

Phase 9 change (single, reviewed, tested change):

- Keep the dev-safe default: non-Windows, or no verified helper, still fails closed
  and rejects `tun.enable:true`.
- On Windows, the runtime activation may synthesize a `tun.enable:true` (`stack:
  system`, plus `dns-hijack`, `auto-route`, `auto-detect-interface`) block, written
  only to the **running** config, never persisted as a user preference, torn down on
  disable. This is the **only** source of a `tun` block; a profile carrying its own
  `tun`/`dns`/`rules` still cannot slip through.
- `mihomoConfigErrors` stays the single gate and gains an `allowTun: boolean` (or an
  explicit `allowedTunContext`) that is `false` everywhere except the authorized
  activate path.
- Because **mihomo owns the data plane** (§1), mihomo creates the Wintun adapter
  session directly after the helper loads the driver; the helper does **not** enable
  `tun` itself. The helper is never handed a mihomo config to mutate.

---

## 10. TUN state machine and UI copy (item 5)

### 10.1 Transition table

| Phase | Entry | Allowed actions | On failure |
|---|---|---|---|
| `configured` | init/recovery, end of disable | enable | — |
| `starting` | `requestEnable` intent | probe_integrity → load_driver → snapshot → apply_routes/apply_dns → mihomo creates TUN | → `restoring` (undo partial) → `restore-failed`/`failed` |
| `active` | routes/DNS applied + mihomo TUN up | disable, teardown | → `restoring` |
| `restoring` | disable/teardown/rollback | per-item owned-only restore | → `conflict` (per-item) or `restore-failed` (corruption) |
| `failed` | non-recoverable integrity/driver/capture | retry / report | — |
| `conflict` | an externally-modified owned item | none (report, per-item) | owner/emergency path |
| `unsupported` | non-Windows / no verified helper | none | — |
| `restore-failed` | could not restore (not a conflict) | retry / `--recover` | — |

Invariants: every transition re-verifies ownership + baseline digest; `restoring` is
idempotent; a crash mid-activation reconciles from the journal + baseline on next
boot, or via `--recover`.

### 10.2 Canonical UI copy (Chinese, matches `system-proxy` style)

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
| `src/shared/tun.ts` | `TunPhase`, `TunStatus`, `TunGateway`, IPC names, `HelperOp`/`HelperCommand` | — |
| `src/shared/schemas/tun.ts` | runtime Zod schema for `TunStatus`, `HelperCommand`, snapshot/written/journal records | valid/invalid/forward-compatible |
| `src/main/tun/service.ts` | `TunService` (state machine, promise-queue, probe, backup, reconcile) | `FakeTunAdapter` + `RecordingBackupStore` |
| `src/main/tun/policy.ts` | pure per-item `isOwned`/`matchesWritten`/`buildBaseline`/format helpers | pure unit |
| `src/main/tun/adapters/windows-tun-adapter.ts` | helper client + driver load + integrity verify + snapshot/reconcile | fakes; real path gated |
| `src/main/tun/adapters/disabled-tun-adapter.ts` | `{supported:false, phase:'unsupported'}` for non-win32 | unit |
| `src/main/tun/adapters/fake-tun-adapter.ts` | deterministic in-memory helper for dev/tests | — |
| `src/main/tun/helper-client.ts` | named pipe + SDDL + bootstrap handshake + PID/token/path/sig/hash + envelope | unit (fake pipe) |
| `src/main/tun/types.ts` | local types (snapshot/written/journal, status) | — |
| `src/main/tun/probe.ts` | TUN readiness probe (reuse accumulating-buffer pattern) | unit |

---

## 12. Remaining decisions before implementation

- **D4:** helper boot/auto-start for the emergency path. Recommended: **no self-start**;
  `--recover` is run manually. (D2 = standalone helper, so a service is not assumed.)
- **D5:** whether a Wintun **driver** that pre-existed is ever removed on uninstall.
  Recommended: **never** remove a pre-existing/shared driver. (Per the official model
  we never ship a `.sys`, so at most we load the official driver; we do not delete it.)
- **Certificate provider / trusted publisher** for `helper.exe` (see `CODE_SIGNING.md`).
- **DNS-hijack scope**, HTTPS decryption/rewrite visibility, sleep/wake + network-change
  reconciliation depth, and the exact owner-authorization record.

Implementation/testing for the remaining lines proceeds only after design-review
sign-off and separate owner authorization, and only in the gated disposable-Windows
job (`MURGE_RUN_REAL_TUN=1` **and** `win32`, never in default `npm test`).
