# Phase 9 — Windows TUN privileged helper: design review package

> Status: **draft for design review.** Design/contract level only. No code execution,
> no network mutation, no driver/route/DNS change performed on this machine. This is
> the review artifact the Phase 9 entry gate requires before any implementation. It
> resolves the owner decisions already supplied (signed wintun; standalone elevated
> helper, driver on first enable) and defines the concrete contracts the
> implementation must satisfy.

Decisions in force (owner-supplied):

- **D1 = Signed wintun (WireGuard model).**
- **D2 = Standalone elevated helper process** (not a Windows service).
- **D3 = Driver installed on first enable** (staged at app install, installed at the
  moment the user first enables TUN).

Companion docs: `docs/helper-threat-model.md` (T01–T15, controls C1–C13),
`docs/helper-install-upgrade-rollback.md` (install/upgrade/rollback/uninstall).
Repositories referenced for conventions: `src/shared/system-proxy.ts`,
`src/shared/ipc.ts`, `src/shared/gateways.ts`, `src/main/system-proxy/service.ts`
& `adapters/*`, `src/main/kernel/mihomo-config.ts`, `src/main/kernel/mihomo-artifact.ts`.

---

## 1. Architectural layering (mirrors the system-proxy pattern)

```
renderer ── typed window.desktop.tun.* (status only, no command)
   │ validated Electron IPC (ipc.ts tun:* channels, TUN_GATEWAY gateway)
   ▼
main ── TunService (service.ts)        state machine + serialized ops + probe + backup
   │        getStatus/init/enable/disable/onStatus
   ▼
main ── policy.ts                       pure ownership/merge/format helpers (no I/O)
   │
   ▼
main ── adapters/WindowsTunAdapter      privileged boundary; owns the high-IL client
   │        (helper) + driver install + integrity verify + baseline snapshot
   │
   ▼
main ── helper client (PrivilegedHelperClient)   named-pipe IPC to the helper
   │
   ▼
elevated ── helper.exe (High IL)        owns wintun device, routes, DNS, interface
                                          metrics; only mutation-capable component
   │
   ▼
wintun.sys (signed) + OS routes/DNS/firewall
```

Non-Windows builds use a `DisabledTunAdapter` that returns
`{ supported:false, phase:'unsupported' }` and performs zero mutation (a fake
adapter backs the dev/test path). This matches `system-proxy/:factory.ts`.

---

## 2. Shared contract (`src/shared/tun.ts`)

Mirrors `system-proxy.ts` so the renderer only ever reports state, never commands.

```ts
export type TunPhase =
  | 'disabled'          // never enabled, or cleanly restored
  | 'configuring'       // running preflight: integrity verify + driver install
  | 'starting'          // helper launching TUN, applying routes/DNS
  | 'active'            // TUN up and owned by the app
  | 'stopping'          // tearing down
  | 'restoring'         // restoring baseline snapshot
  | 'restore-failed'
  | 'conflict'          // external route/DNS change; app will NOT overwrite
  | 'unsupported'       // non-Windows / driver absent / feature off

export interface TunStatus {
  supported: boolean
  phase: TunPhase
  /** TUN adapter name (e.g. "Mihomo") when active, else null. */
  deviceName: string | null
  /** Mixed-port the TUN stack proxies to, while active, else null. */
  port: number | null
  /** mihomo tun.stack ("system"/"gvisor"/"mixed") reported while active, else null. */
  stack: string | null
  /** True when the app can prove it wrote the current routes/DNS (owned). */
  owned: boolean
  errorMessage: string | null
  conflictDetail: string | null
  updatedAt: string | null
}

export const TUN_LOOPBACK_HOST = '127.0.0.1'   // helper may only point at this
```

The renderer reads `getStatus()` and `onStatus()`; it never calls enable/disable
directly (mirrors the proxy rule). `enable`/`disable` are serialized in main via a
promise-queue mutex.

---

## 3. IPC contract (`src/shared/tun.ts` channels + `TunGateway`)

```ts
// ipc.ts additions
tunGetStatus:      'tun:get-status',
tunEnable:         'tun:enable',
tunDisable:        'tun:disable',
tunStatusEvent:    'tun:status-event',

// gateways.ts addition
export interface TunGateway {
  getStatus(): Promise<TunStatus>
  enable(): Promise<TunStatus>
  disable(): Promise<TunStatus>
  onStatus(listener: (s: TunStatus) => void): () => void
}
```

### 3.1 App → helper named pipe (the privileged boundary)

Two channels:

1. **Control channel** — long-lived, the app sends typed command messages.
2. **Status channel** — the helper pushes phase transitions back via a
   helper-owned event message.

Both are **named pipes** created by the **helper** (High IL) with a restrictive
**SDDL** granting ONLY:
- the helper's own SID, and
- a service/app SID or the app's principal that the helper explicitly authorizes.

The pipe is created **not** world-readable (deny `Everyone`, deny the built-in
`Users` group). A per-session **random instance token** is embedded in the pipe
name so a lower-trust process cannot predict or bind the endpoint.

### 3.2 Command envelope (schema-validated in the helper)

```ts
interface HelperCommand {
  v: 1                                   // protocol version
  op: HelperOp                           // fixed allowlist (below)
  requestId: string                      // app-generated UUID (replay/idempotency)
  nonce: string                          // helper-issued per-session challenge
  payload: HelperPayload                  // op-specific, JSON schema validated
}
type HelperOp =
  | 'probe_integrity'   // verify helper+dwintun signature/checksum (no mutation)
  | 'install_driver'    // stage/verify driver (idempotent) — first enable
  | 'create_tun'        // bring up wintun, apply routes/DNS (baseline written first)
  | 'teardown_tun'
  | 'apply_routes'
  | 'apply_dns'
  | 'restore'           // restore baseline snapshot (owned-only)
  | 'get_status'
  | 'health'
```

Rules enforced in the helper:

- No `op` outside the allowlist → reject.
- `payload` validated against the op's JSON schema before any side effect.
- `v` must equal 1.
- `requestId` must be new for a mutation op (idempotency guard).
- Strict size cap on the message (e.g. 4 KiB) to bound parsing.
- No arbitrary path, no raw command string, no free-text script — the existing
  "no concatenated PowerShell" rule is carried across the boundary.

---

## 4. Elevation flow (explicit, least-privilege)

1. Renderer shows an `enable` control; the user clicks it (explicit action).
2. Main `TunService.enable()` runs in the promise-queue:
   - **Preflight (no elevation yet):** verify the helper + wintun SHA-256 against a
     pinned release manifest and the helper's Authenticode publisher (C1). On
     failure → `{ phase:'unsupported'|'restore-failed', errorMessage }`, zero write.
   - **Driver install (first enable only):** if wintun is not already present, the
     helper requests elevation via UAC consent (Helper, not the whole app) and
     loads the signed driver. Only `SeLoadDriverPrivilege` is granted; the helper
     token is a **restricted token** with a minimal enabled-privilege set.
   - **Baseline write before mutation (C4):** the helper records a versioned,
     byte-identical snapshot of current routes (IPv4 + IPv6 default gateways), DNS
     client servers, adapter enable state, interface metrics and firewall profile
     state — atomically (temp → validate → rename) — and **aborts with zero mutation
     if it cannot**.
   - **Activate:** helper creates the wintun device, applies routes/DNS, and mihomo
     activates `tun` (see §7 config gating).
   - The renderer is updated only from the returned/pushed status; it never flips
     optimistically.

`probe_integrity`/`get_status`/`health` are **non-elevating** and never prompt UAC.

---

## 5. Driver/helper integrity procedure (C1, C2 — PowerShell-free where possible)

- **Manifest.** A pinned release manifest (mirroring `mihomo-artifact.ts`
  `ReleaseArtifact` + `sha256File`) lists per-arch `helper.exe` and `wintun.sys`
  SHA-256 digests plus publisher thumbprints. It is validated inside the signed
  installer artifact and re-checked at runtime.
- **Runtime check.** `probe_integrity` (and every activation) computes the helper
  SHA-256 (reuse `sha256File`), verifies it equals the manifest digest, and verifies
  `Get-AuthenticodeSignature` reports the expected publisher. The wintun driver is
  validated as a known-signed vendor driver (matches the manifest publisher).
- **Fail-closed.** A digest mismatch, an untrusted signer, a missing manifest, or an
  unreadable file ⇒ `{ phase:'unsupported', errorMessage }` and **zero mutation**;
  the helper is never launched or trusted.
- Self-signed certificates are permitted only for a CI "smoke" path and are never
  accepted by the production activation path.

---

## 6. Baseline snapshot (`src/main/system-proxy/backup-schema.ts` precedent)

```ts
interface TunBaselineSnapshot {
  schemaVersion: 1
  instanceId: string
  createdAt: string
  routes: { ipv4DefaultGateway: string | null; ipv6DefaultGateway: string | null }
  dns: string[]                       // DNS client server addresses
  adapters: { name: string; enabled: boolean; metrics: number }[]
  firewallProfile: string | null
}
```

Written **before** first mutation, atomically (temp+rename), and owned by the helper.
Restore is allowed only when current values still match what the helper wrote
(`owned`), mirroring `isOwned`/`matchesPrevious`; a conflict yields
`{ phase:'conflict', conflictDetail }` and no mutation.

---

## 7. mihomo config gating (C7) — how the `tun.enable:false` rule relaxes

Today `mihomo-config.ts` asserts, for every document, `tun`/`dns` may contain only
`enable` and it must be `false`, and refuses to merge any profile-provided
`tun`/`dns`/`rules` block.

Phase 9 change (a single, reviewed, tested change):

- Keep the dev-safe default: a non-Windows build, a build with no helper, or any
  path where the helper is not **authorized and verified**, still fails closed and
  rejects `tun.enable:true`.
- On Windows, only when the `TunService` is in `configuring`/`active` and the helper
  has passed `probe_integrity`, the runtime activation may synthesize a
  `tun.enable:true` (plus `dns-hijack`, `auto-route`, `auto-detect-interface`,
  `stack`) block that is **written only to the running config**, never persisted as
  a user preference, and is torn down on disable.
- The refactor keeps `mihomoConfigErrors` the single gate; it gains an
  `allowTun: boolean` parameter (or an explicit `allowedTunContext`) that is `false`
  in every path except the authorized activate path. A profile carrying its own
  `tun`/`dns`/`rules` still cannot slip through; the synthesized block is the only
  source.

---

## 8. TUN state machine (configured/starting/active/failed)

| Phase | Entry | Allowed actions | On failure |
|---|---|---|---|
| `disabled` | init/recovery | enable | — |
| `configuring` | enable→preflight | (verify + driver install) | → `unsupported`/`restore-failed`, zero write |
| `starting` | preflight ok | apply routes/DNS | → `restore` (undo any partial) → `restore-failed`/`disabled` |
| `active` | routes/DNS applied | disable, teardown | → `restore` |
| `stopping` | disable | teardown + restore | → `restore` |
| `restoring` | teardown/rollback | restore baseline | → `restore-failed` on conflict/corruption |
| `conflict` | external route/DNS change | none (report) | owner/emergency path |
| `unsupported` | non-Windows / no driver / bad integrity | none | — |

Invariants:

- Every transition re-verifies ownership and the baseline digest.
- `restore` is idempotent and safe to re-run; a re-entrant disable never leaves a
  partially-applied state.
- On process crash mid-activation, `TunService.init()` reconciles from the helper
  journal + baseline on next boot (C10), or the owner runs `--recover`.

---

## 9. Proposed module/interface layout

| File | Contents | Tests |
|---|---|---|
| `src/shared/tun.ts` | `TunPhase`, `TunStatus`, `TunGateway`, IPC channel names, `TunCommand`/`HelperOp` types | — |
| `src/shared/schemas/tun.ts` | runtime Zod schema for `TunStatus` and helper command envelope | valid/invalid/forward-compatible fixtures |
| `src/main/tun/service.ts` | `TunService` (state machine, promise-queue, probe, backup) | `FakeTunAdapter` + `RecordingBackupStore` (same shape as the proxy tests) |
| `src/main/tun/policy.ts` | pure `isOwned`/`matchesPrevious`/`buildSnapshot`/format helpers | pure unit tests |
| `src/main/tun/adapters/windows-tun-adapter.ts` | elevated client + driver install + integrity verify + snapshot; calls `PrivilegedHelperClient` | fakes; real path gated |
| `src/main/tun/adapters/disabled-tun-adapter.ts` | returns `{supported:false, phase:'unsupported'}` for non-win32 | unit |
| `src/main/tun/adapters/fake-tun-adapter.ts` | deterministic in-memory helper for dev/tests | — |
| `src/main/tun/helper-client.ts` | named-pipe + SDDL + envelope + nonce/requestId + schema validation | unit (fake pipe) |
| `src/main/tun/types.ts` | local types (snapshot, journal, status) | — |
| `src/main/tun/probe.ts` | TUN readiness probe (reuses accumulating-buffer pattern) | unit |

---

## 10. Remaining decisions/authorization before implementation

- **D4:** Whether the helper is allowed to start on boot to service the emergency
  path (threat-model §10, install doc D4). This affects `D2` (a standalone helper vs.
  a boot-started helper). Default recommendation: **no auto-start**; the emergency
  path runs `--recover` manually.
- **D5:** Whether a wintun driver that **pre-existed** the app is ever removed on
  uninstall. Recommendation: **never** remove a pre-existing/shared driver.
- **Threat-model §10 / §11 items:** DNS-hijack scope, HTTPS decryption/rewrite
  visibility, sleep/wake + network-change reconciliation depth, emergency disable
  surface, and the exact owner-authorization record.

Implementation/testing for all of the above proceeds only after design-review
sign-off and separate owner authorization, and only in the gated disposable-Windows
job (`MURGE_RUN_REAL_TUN=1` **and** `win32`, never in default `npm test`).
