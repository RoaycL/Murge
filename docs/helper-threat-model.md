# Phase 9 — Windows TUN privileged helper: threat model

> Status: **draft for design review.** This document is design/analysis only. It
> authorizes no network mutation. It is the deliverable for the first Phase 9
> roadmap line ("Write and approve helper/privilege threat model") and is the
> input to the design-review gate that precedes all Windows implementation and
> testing. Nothing here may be executed on this development machine; all real
> behavior is verified only in the disposable `windows-latest` CI environment and
> must remain gated behind explicit owner authorization (see
> `DEVELOPMENT_SAFETY.md`).

---

## 1. Purpose and scope

This threat model defines what a **TUN enabled mode** on Windows protects, who the
hostile actors are, and the controls the privileged helper must implement so that
transparent capture never disconnects the machine and can always be undone.

In scope:

- The privileged helper binary, its installation service (if any), and the TUN
  device it uses (wintun / equivalent).
- The inter-process channel between the unprivileged Electron main process and
  the privileged helper.
- The configuration, DNS, IPv4/IPv6 route and interface mutations the helper
  performs, their reversal, and their recovery after crash.
- The Windows driver/signing and integrity-verification path.

Out of scope:

- The mihomo kernel process lifecycle, controller secret, and REST/WebSocket
  security (covered by Phase 7 and `ARCHITECTURE.md`).
- macOS network behavior (explicitly unsupported in this milestone).
- Reverse-proxy, TLS-decryption and rewrite behavior (Phase 10 UI and an owner
  decision; see ROADMAP owner backlog).
- The application update channel design (Phase 10/11).

Grounding references: `docs/ARCHITECTURE.md` (process model, `TunService`),
`docs/CODE_SIGNING.md`, `src/main/kernel/mihomo-config.ts` and
`src/main/kernel/mihomo-artifact.ts` (existing SHA-256 integrity and
`tun.enable:false` gating), `src/main/system-proxy/*` (established
interface/adapter/backup-store and fail-closed pattern the helper must mirror).

---

## 2. Assets

| Asset | Sensitivity | Why it matters |
|---|---|---|
| Machine network path / connectivity | High | The owner may rely on this machine remotely. Losing it locks the owner out, so the helper must be reversible and recoverable out-of-band. |
| TUN device + its packets | High | Transparent capture of all non-proxy-aware traffic; a hostile actor with the device can read/mutate traffic or exfiltrate it. |
| DNS configuration and resolution | High | Hijacking DNS is both a capture primitive and a poisoning/redirection attack surface. |
| IPv4/IPv6 route table, interface metrics, firewall rules | High | A malicious or buggy helper could blackhole, redirect or fragment traffic. |
| Helper binary, its service, and any helper-secret | High | The helper runs elevated; its compromise is a host compromise. |
| Stored baseline state (pre-TUN route/DNS/interface snapshot) | High | The rollback source of truth. An attacker that forges or corrupts it blocks clean disable and can leave the system broken. |
| Kerberos/admin credentials and integrity level | High | Elevation must not expose admin to a lower-trust surface. |
| IPC channel between app and helper | High | Spoofing/tampering here defeats fail-closed and allows unauthorized mutation. |
| Event/log evidence of route/DNS/service changes | Medium | Required for recovery, diagnosis and the Phase 9 evidence record. |
| The renderer and its stores | Low/Medium | Must never see helper credentials, device handles, or privileged paths. |

---

## 3. Trust boundaries and components

```text
                       ┌─────────────────────────────┐
Low IL                │ Vue renderer                 │
 (unprivileged)       │  window.desktop API          │
                       └───────────┬─────────────────┘
                                   │ validated Electron IPC (contextIsolation, sandbox)
                                   ▼
Medium IL             ┌─────────────────────────────┐
 (installer / app)    │ Electron MAIN               │
                       │  ┌───────────────┐          │
                       │  │ TunService    │──────────┼──┐ 1. IPC (named pipe / RPC)
                       │  │ (config, ops) │          │  │    policy, schema, per-op auth
                       │  └───────────────┘          │  │
                       └───────────┬─────────────────┘  │
                                   │ 2. elevation        │
                                   │    (UAC consent,    │
                                   │     least privilege)│
                                   ▼  (High IL)          ▼
                 ┌─────────────────────────────┐    ┌─────────────────────┐
High IL          │ PRIVILEGED HELPER            │    │ 3. Driver/file     │
 (elevated)      │  - owns wintun device        │    │    integrity +      │
                 │  - routes/DNS/interface      │    │    Authenticode     │
                 │  - baseline snapshot + undo  │    │    verification      │
                 └───────────┬─────────────────┘    └──────────┬──────────┘
                             │ 4. wintun API / ioctl          │
                             ▼                                 ▼
                    ┌──────────────────────────────────────────────┐
                    │ WINTUN driver (signed) + Windows firewall/routes│
                    └──────────────────────────────────────────────┘
```

Integrity levels (Windows IL): the renderer and app run at **Medium IL**; the
helper runs at **High IL** (or as an elevated service) in a narrow, dedicated
process. It must never be a shell or a general-purpose admin surface.

Definition of a **clear trust boundary**: the elevated helper is the only
component that may (a) create a TUN device, (b) add/remove routes, or (c) change
DNS or interface metrics. The app may only *request* these as typed, validated,
per-operation commands, and never carry raw PowerShell/`reg.exe`/`ip` command
strings across the boundary (mirroring the existing no-concatenated-command rule).

---

## 4. Actors / attacker models

| Actor | Trust | Motivation / access |
|---|---|---|
| Local user (owner) | Legitimate | Wants transparent capture; the only party allowed to initiate elevation. |
| Unprivileged local process running as the same user | Untrusted | Medium-IL malware, downloaded content, a compromised renderer. May try to talk to the helper, tamper with helper/driver files, or fake app→helper requests. |
| Higher-privilege process (already-elevated malware) | Untrusted | Already owns the box; cannot be fully defended against, but must not be *made easier* (no network-mutation helper that blindly accepts commands). |
| Malicious web/mail content delivered to the user | Untrusted | Drives the local unprivileged actor above (e.g., via a crafted download that is later run). |
| Remote network actor | Untrusted | May race the helper's route/DNS changes or exploit a wide-open TUN. |
| Privileged-helper compromise (the helper itself) | Untrusted-if-compromised | The boundary must be small so a helper bug or hijack has a bounded blast radius and is detectable. |

---

## 5. Design assumptions (must be confirmed in design review)

These are decisions the threat model assumes; each has an owner-decision flag in
§10.

- **A1. Device model.** TUN uses the signed **wintun** driver (WireGuard's model)
  supplied by the project or by a vendor whose binary is checksum/signature
  verified. A pure userspace Tap/go implementation is only acceptable if it needs
  no kernel driver above Medium IL — otherwise specify it.
- **A2. Helper shape.** A small, purpose-built privileged **helper executable**
  (or a Windows service) rather than elevating the entire Electron app. The app
  stays Medium IL.
- **A3. Elevation trigger.** Elevation is always **explicit user action** (UAC
  consent / a button) and never implied, auto-elevated or performed at app start.
- **A4. Route/DNS/DNS-hijack ownership.** The helper owns route/DNS/interface
  mutation and keeps a byte-identical, schema-versioned **baseline snapshot**
  written **before** the first mutation (mirrors `FileSystemProxyBackupStore`).
- **A5. mihomo config gating.** Today `mihomo.config.ts` enforces
  `tun.enable:false` (and `dns.enable:false`) for every document. Phase 9 must
  relax this **only** on Windows, only when the helper is present and
  authorized, and only for the runtime activation — never change the dev-safe
  default. Relaxation must be a deliberate, reviewed change with tests.
- **A6. Fail-closed.** If the helper cannot prove it is the expected binary with a
  verified signature/checksum, or IPC cannot be authenticated, activation must
  fail and perform **zero** mutation.
- **A7. Least-privilege IPC.** The helper exposes one minimal command set. Each
  command is authorized by policy in the helper; the app does not carry privilege.

---

## 6. STRIDE threat enumeration

Legend — controls are **C1 .. C13** defined in §7. "Owner" = design-review /
owner decision item.

| ID | STRIDE | Asset | Threat / scenario | Impact | Primary controls |
|---|---|---|---|---|---|
| T01 | Spoofing | IPC | A Medium-IL process impersonates the app and sends `create_tun` / `add_route` / `set_dns` to the helper. | Unauthorized network rewrite | C3, C4, C6 |
| T02 | Spoofing | Helper binary | An attacker drops a malicious DLL/exe in place of the helper or wintun next to a writable path. | Elevation / network rewrite | C1, C2, C3 |
| T03 | Spoofing | Route/DNS | A remote or local actor advertises a conflicting route/DNS after activation. | Traffic redirection / blackhole | C7, C8, C11, C13 |
| T04 | Tampering | Baseline snapshot | An attacker edits the stored pre-TUN snapshot so disable restores the *wrong* state. | Permanent misconfig / lockout | C4, C8, C9, C10, C12 |
| T05 | Tampering | Helper/service config | Registry/service keys or helper config are modified by a lower-trust actor. | Persist / weaken the helper | C2, C3, C6, C13 |
| T06 | Tampering | TUN packets | A component or network actor reads/writes packets on the device out of policy. | Confidentiality / integrity of traffic | C6, C11, C13 |
| T07 | Repudiation | Evidence | The helper performs a network mutation but an operator/owner cannot attribute or revert it. | Unrecoverable broken state | C9, C12, C13 |
| T08 | Info disclosure | Helper creds / device handle | A low-privilege process reads helper IPC or memory and extracts the device handle or any helper secret. | Capture/mutation primitives | C3, C6, C12 |
| T09 | Info disclosure | Packets / DNS | DNS hijack leaks the requested domains or a mis-configured TUN exposes traffic to a wrong interface. | Confidentiality | C1, C6, C11 |
| T10 | DoS | Machine network path | A buggy/elevated helper or a malicious request leaves a bad route/DNS and disconnects the machine. | Owner lockout | C7, C8, C9, C10, C12 |
| T11 | DoS | Helper service | An over-eager or over-broad helper task is started repeatedly, or holds the TUN device open, blocking other uses. | Resource exhaustion | C5, C7 |
| T12 | Elevation of privilege | Helper | A vulnerability in the helper (parsing, IPC, driver ABI) lets a Medium-IL caller gain admin. | Full host compromise | C3, C4, C6, C7, C13 |
| T13 | Elevation of privilege | Driver | A privileged driver is loaded from a tampered/poorly-signed source. | Kernel compromise | C1, C2, C3 |
| T14 | Elevation of privilege | Elevation flow | The app auto-elevates, or a UAC "consent" is bypassed, so a low-trust actor triggers admin work. | Unauthorized admin | C5, C6, C13 |
| T15 | Tampering | Config gating | A profile-driven `tun`/`dns` block slips past the merge validator and activates TUN in a non-authorized (or dev) build. | Network mutation in a safe env | C7, C13, Owner |

---

## 7. Control requirements

Groups integrate with (and reuse) existing project patterns.

### C1 — Verified supply chain / signed artifacts (owner-driven)

- The helper, its service and the wintun driver are **Authenticode-signed** with a
  certificate that the app trusts by pinned thumbprint, not by the OS trust store
  alone (see `CODE_SIGNING.md` inputs; certificate provider is an owner decision).
- Activation verifies, **before** any mutation:
  - the helper's SHA-256 matches a pinned release manifest (mirror
    `mihomo-artifact.ts` `sha256File`/`binarySha256`), **and**
  - `Get-AuthenticodeSignature` for the helper reports the expected publisher
    (and the driver is a known-signed wintun/Store-signed device).
- A self-signed cert is acceptable only for a CI "smoke" path and never a release
  artifact; it must not be trusted by the production activation path.

### C2 — Tamper-resistant placement

- Install the helper and the driver under `Program Files` (or the per-user
  equivalent only if the helper does not need Medium-trust-protected placement). No
  temp-dir or per-user-writable drop of an elevated binary.
- The directory ACL protects files from Medium-IL writes; the service/registry keys
  are created with the restrictive DACL intended for an elevated object.
- Never promote a file placed in, or a path resolved from, an attacker-writable
  directory (e.g. `%TEMP%`, app-data subfolders writable by the same user) to an
  elevated command.

### C3 — Authenticated, authorized IPC

- The app→helper channel is a **named pipe** (or equivalent) created by the helper
  with a service-specific **SDDL** that grants the pipe only to the helper and to
  the app identity (or a dedicated service SID the app holds), and denies Everyone
  / Users. The pipe is **not** world-readable.
- Each request is a **typed, schema-validated message** with:
  - a per-session random nonce/challenge to prevent replay and reflection,
  - an operation identifier from a **fixed allowlist** (`create_tun`,
    `teardown_tun`, `apply_routes`, `apply_dns`, `snapshot`, `restore`,
    `get_status`, `health`),
  - an app-generated, once-per-operation request id (idempotency/replay guard),
  - a JSON-schema validation in the helper (mirror the "validate every IPC arg"
    rule; TS types are not runtime validation), and
  - a strict size cap to bound parsing.
- The helper authorizes **each** operation by policy; it does not trust the app as
  a blanket admin.

### C4 — Baseline snapshot before first mutation (fail-closed)

- Before the first route/DNS/interface mutation of an activation, the helper writes
  a schema-versioned, **byte-identical** snapshot (routes, IPv4/IPv6 default
  gateways, DNS client server addresses, interface metrics, adapter enable state,
  firewall profile state) to a location the app reads back for the UI but that the
  helper owns and can restore from **atomically** (write temp → validate → rename),
  mirroring `FileSystemProxyBackupStore`.
- A failure to write/verify the snapshot **aborts** with zero mutation.

### C5 — Explicit elevation, least privilege

- No auto-elevation. Activation is triggered only by an explicit user action.
- The app opens the helper through a consent that the user sees; the helper runs
  **High IL** but with a **restricted token** whose enabled privileges are exactly
  those needed (e.g. `SeLoadDriverPrivilege` when installing wintun, route add/delete
  are granted via the DNS/route APIs rather than blanket admin).
- The helper is a dedicated process without a console, no network listener of its
  own (other than its IPC), and no accidental admin shell.

### C6 — Renderer/secret isolation & least surface

- The helper/device handle and any helper secret **never** cross into preload/renderer.
- The helper exposes no general-purpose command, no arbitrary path argument, and no
  raw PowerShell/command string (enforced by schema + allowlist, §C3).
- The renderer only displays `status`/phase from `get_status`; it cannot flip state
  optimistically (mirror the existing proxy rule).

### C7 — Config gating authority

- Relaxing `tun.enable:false`/`dns.enable:false` in `mihomo-config.ts` is a **single,
  reviewed change** with tests that (a) keep the dev-safe default and (b) only allow
  activation when the Windows helper is present and authorized. A profile that
  attempts to enable TUN/DNS outside that path keeps failing closed.
- A non-Windows build must return an explicit **unsupported/blocked** result (per
  `DEVELOPMENT_SAFETY.md`), never silently enable TUN.

### C8 — Owned-only restore (no clobbering)

- Disable/rollback restores only the baseline values recorded by the helper and
  only when the current values still **match** what the helper previously wrote
  (owned-state semantics, mirroring `isOwned`/`matchesPrevious` in the proxy
  adapter). A conflict (external modification) produces a typed
  `TUN_STATE_CONFLICT` with structured detail and performs **no** mutation.

### C9 — Idempotent, crash-safe disable & emergency path

- Disable/restore is idempotent and safe to re-run; a re-entrant or failed disable
  never leaves a partially-applied state.
- An **emergency disable** path is independent of the GUI and of the mihomo
  process: a documented, owner-runnable recovery (service command, a bundled
  `--recover` mode, or a `.cmd` that the helper accepts) that restores the baseline
  snapshot even if the app is dead. It must not require the network it is about to
  fix.

### C10 — Recovery after forced termination / crash

- The helper records its mutations and their intended undo in an on-disk journal the
  app reads on next boot to reconcile. If the helper is killed mid-activation, the
  next `init()` (or the emergency path) reconciles against the journal + baseline
  and restores. Tested with forced termination at each state.

### C11 — Route/DNS/IPv4/IPv6 coexistence (no loss of connectivity)

- The route/DNS rules must preserve loopback, LAN and the machine's own
  connectivity; auto-route excludes the management/loopback path. IPv4 **and** IPv6
  default routes and DNS servers are both recorded and restored.
- DNS hijack is scoped to the TUN interface name with an explicit exclusion list and
  fails closed if the expected adapter's physical properties are missing.
- Sleep/wake and network-change (interface up/down, DHCP renew) events are
  re-reconciled: on resume or change, the helper re-asserts TUN and re-verifies the
  baseline is unmodified, and fails closed on conflict.

### C12 — Integrity/authenticity of evidence

- A structured, machine-readable record (`service`, route, DNS, TUN device, phase
  transitions, snapshot digests) is written at each transition; the snapshot and
  journal are HMAC/digest-protected or at least digest-verified on read so a
  tampered baseline is detected (C04/C07 mitigation) rather than silently trusted.
- Logs must not contain credentials, subscription URLs, controller secrets, or
  plaintext helper secrets.

### C13 — Test/evidence gating (disposable Windows only)

- All real TUN behavior is exercised only by a **gated** Windows CI job that:
  - is skipped unless `MURGE_RUN_REAL_TUN=1` **and** `win32` (so it never runs in
    default `npm test`),
  - snaps a host `NetworkSnapshot` before/after and **fails closed** if any
    safety-relevant field changed unexpectedly,
  - proves the helper **never loses VM connectivity**, that disable/uninstall
    returns routes and DNS to the exact prior state, and that recovery survives
    forced process termination,
  - records service, route, DNS and non-proxy-aware-request evidence.

---

## 8. Fail-closed invariants (asserted in code and tests)

1. **No verified helper, no mutation.** Activation with an unverified
   signature/checksum or failed IPC authentication performs zero mutation.
2. **No snapshot, no mutation.** Baseline is written and verified before the first
   change.
3. **Conflict ⇒ no restore.** An externally-modified route/DNS is reported, never
   overwritten silently.
4. **Renderer never commands.** The renderer reads status; only the serialized
   main-process `TunService` (promise-queue, mirroring the proxy service) issues
   commands.
5. **No elevated shell.** No raw command strings, no arbitrary paths, a fixed
   command allowlist.
6. **Mac/no-driver ⇒ explicit unsupported/blocked.** Non-Windows builds never
   enable TUN.

---

## 9. Mapping to Phase 9 roadmap lines

| Roadmap line | Primary threats | Controls exercised |
|---|---|---|
| Write and approve helper/privilege threat model | (this doc) | — |
| Define install/upgrade/rollback/uninstall behavior | T02, T04, T05, T10 | C1, C2, C4, C8, C9, C10, C12 |
| Implement explicit elevation flow | T12, T14 | C5, C6, C13 |
| Verify driver/helper signature and binary integrity | T01, T02, T13 | C1, C2 |
| Implement TUN configured/starting/active/failed states | T10, T11 | C5, C7, C13 |
| Add emergency disable and cleanup path independent of GUI | T07, T10 | C9, C10 |
| Test DNS, IPv4, IPv6, sleep/wake, network change, crash recovery | T03, T06, T10 | C10, C11, C13 |
| Record service/route/DNS & non-proxy-aware request evidence | T07, T08 | C12, C13 |

---

## 10. Owner decisions (resolved + remaining)

Resolved by the owner (in force for implementation):

1. **D1 — Device model:** **Signed wintun (WireGuard model).** (A1, C1, C2.)
2. **D2 — Helper shape:** **Standalone elevated helper** process, not a Windows
   service. (A2, C2, C5.) Note: changing D2 to a service later would require revoking
   this because the design-review package (`docs/helper-design.md`) assumes a
   standalone helper.
3. **D3 — Driver install timing:** **On first enable** (staged from the installer at
   install time, installed at the user's first explicit enable). (A3.)

Still to decide before implementation starts:

4. **Certificate provider & trust model.** Which CA/cert for the helper and driver;
   wintun is already signed by a vendor — confirm this is the relied-on artifact and
   that we pin its publisher. (Affects C1 — see `CODE_SIGNING.md`.)
4. **DNS hijack scope.** Whether DNS is delegated to mihomo's dns-hijack, to the
   helper, or left to the system-proxy path, and the exclusion list. (Affects C11.)
5. **D4 — emergency/boot behavior.** Whether the helper is allowed to start on boot
   to service the emergency path (recommended: no auto-start; `--recover` run
   manually). (Affects C9.)
6. **D5 — pre-existing driver removal.** Whether a wintun driver that **pre-existed**
   the app is ever removed on uninstall (recommended: never remove a pre-existing/
   shared driver). (Affects §5.2 of the install doc.)
7. **HTTPS decryption/rewrite visibility.** Whether these pages remain visible /
   experimental / removed in v1 (already in the owner backlog; affects whether the
   TUN device also covers proxied HTTPS or only transparent/non-proxy-aware flows).
8. **Sleep/wake and network-change reconciliation depth.** (Affects C11; a test
   plan is required before implementation.)

---

## 11. Open questions for the design review

- Does the project accept that Phase 9 runs *only* on a disposable Windows VM with a
  snapshot and an out-of-band recovery path, and that it will never execute on the
  development machine?
- Should TUN be **opt-in and off by default** (recommended), and shown as
  "unsupported" on non-Windows builds?
- What is the exact **owner authorization** the helper must receive before it will
  perform a mutation, and how is that recorded for repro?
- Which existing patterns (backup store, owned-state restore, promise-queue mutex,
  fail-closed adapter) should the helper re-use, and where is the boundary allowed
  to diverge?
