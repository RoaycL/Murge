# Phase 9B — mihomo-owned Windows TUN

Status: native service and desktop wiring implemented; Windows runtime evidence pending.

This decision supersedes the Phase 9 design in `helper-design.md` wherever that
design asks the privileged helper to create a Wintun adapter, apply routes or
DNS, or prove that mihomo can reuse a helper-created adapter (the former G1
gate). Those documents remain as an audit trail and must not be used as the
implementation specification.

## Decision

The Electron application remains an ordinary user process. A narrowly scoped,
privileged Windows service starts, stops and supervises one verified mihomo
process. Mihomo is the **only owner** of Wintun, interface, route and DNS state.
The service never calls Wintun APIs and never edits routes, DNS, firewall or
system proxy settings itself.

This follows the proven shape used by other mihomo desktop clients: mihomo is
given a TUN-enabled configuration and owns the adapter lifecycle. We retain a
smaller privilege boundary than clients which restart the entire Electron app
as administrator: only the service and its child mihomo process are elevated.

## Trust boundaries

1. The renderer may request only `enable`, `disable` and `status`. It cannot
   submit executable paths, command lines, config paths, environment variables,
   routes, DNS servers or service commands.
2. The ordinary main process generates a strict TUN profile from typed intent.
3. The service accepts a fixed protocol and resolves all executable/config/state
   locations from its installation-owned directories. It verifies the packaged
   mihomo digest before every launch and uses a fixed argument vector with
   `shell:false` semantics.
4. Mihomo alone creates/opens Wintun and applies/removes its generated network
   state. The initial profile fixes `auto-route:true`,
   `auto-detect-interface:true` and `strict-route:false`.
5. Service state and recovery records contain no controller secret and live in
   an administrator-owned, non-reparse directory. The controller binds only to
   loopback and uses an ephemeral 256-bit secret.

## Lifecycle

Enable is: validate typed intent → materialize strict config → ask service to
start the verified packaged mihomo → wait for authenticated loopback controller
readiness → active. A readiness failure asks the service to stop the exact child
and reports failure; it never starts another child while ownership is uncertain.

Disable is: ask service to stop the exact owned child → wait for confirmed exit
→ let mihomo unwind its own TUN state → configured. Stop timeout or uncertain
ownership is `restore-failed`; the UI must not claim that networking was
restored.

At service startup, an owned live child is reconciled and supervised. A stale
record with no matching process is cleared without changing networking. A live
process whose executable identity does not match is never killed and is
reported as conflict. Login never auto-enables TUN.

## Configuration boundary

`src/main/tun/mihomo-tun-config.ts` is the only Phase 9B TUN profile generator.
It uses a real YAML parser and an exact schema. The separate Phase 7 safe config
generator remains TUN-disabled and must not be weakened.

Initial Windows-lab defaults are deliberately conservative: DIRECT mode,
`allow-lan:false`, IPv6 disabled, loopback controller, `mixed` stack,
`auto-route:true`, `auto-detect-interface:true`, `strict-route:false`, DNS
hijack to mihomo, and `MATCH,DIRECT`. Proxy profile integration comes only after
this lifecycle passes isolated Windows tests.

## Install, upgrade and uninstall

- Installation registers the service and its restrictive service ACL. No TUN is
  enabled during install, update, login or application launch.
- Upgrade first disables an owned active session and confirms child exit, then
  replaces service/core assets. Failure leaves the previous version recoverable.
- Uninstall first performs the same confirmed stop. It removes only application
  service/state files; it never removes a shared/pre-existing Wintun driver.
- The service is not a generic command runner and exposes no arbitrary process,
  filesystem or network-mutation operation.

## Evidence gate

macOS/Linux CI may validate schemas, state machines, protocol authorization,
binary manifests and Windows compilation only. It must never claim runtime TUN
success. Phase 9 runtime completion requires an isolated Windows VM with a
recoverable snapshot and out-of-band console, proving at minimum:

1. enable creates exactly one product adapter and controller becomes ready;
2. traffic and DNS work through TUN without a route loop;
3. disable, app crash, service restart and mihomo crash converge safely;
4. no second child starts while ownership is uncertain;
5. upgrade/uninstall leave no owned process, route or DNS residue;
6. ordinary users cannot alter service assets or invoke unapproved operations.

Until that evidence is attached, Phase 9B is implementation-complete only at
the non-network/code-contract level, not runtime-approved.

## Implemented components

- `native/tun-service`: Go Windows Service, strict duplicate implementation of
  the profile boundary, digest-verified packaged archive extraction, exact PID
  path/digest reconciliation, administrator-only state, owner-SID Named Pipe,
  fail-closed install/upgrade/uninstall and x64/arm64 cross-compilation.
- `src/main/tun/named-pipe-transport.ts`: bounded one-request/one-response local
  transport; no renderer-controlled pipe or command names.
- Electron IPC/preload/store/UI wiring with safe-kernel/system-proxy/TUN mutual
  exclusion and quit-time confirmed TUN stop.
- CI compiles both service architectures and the Windows packaging job proves
  the idle service installs, starts without launching mihomo, and is removed.

The CI service check is intentionally non-network. It does not enable TUN and
does not replace the isolated Windows evidence matrix above.
