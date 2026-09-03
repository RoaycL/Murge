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
It uses a real YAML parser. The separate Phase 7 safe config generator remains
TUN-disabled and must not be weakened.

Two profiles exist:

- **`generateProxiedTunConfig`** — the normal path. It reuses
  `buildProfileKernelConfig` (the main kernel's safety transform) on the ACTIVE
  profile document, then re-adds the `tun:` block that transform deliberately
  strips. The user's `proxies`, `proxy-groups`, `proxy-providers`, `rules`,
  `rule-providers` and resolver split are preserved, so TUN actually proxies.
- **`generateMihomoTunConfig`** — the conservative DIRECT bootstrap, retained as
  the fallback when no profile is active. A rule-mode config with no proxies would
  reference groups that do not exist and mihomo would refuse to start.

### Relaxed proxy-content gating (threat-model C7 reviewed change)

The original Phase 9B profile pinned `mode:direct` + `rules:[MATCH,DIRECT]`,
which by construction could not proxy. Enabling real proxying required relaxing
that gate in BOTH enforcement points (`mihomoTunConfigErrors` in TypeScript and
`validateTunProfile` in Go). Per `helper-threat-model.md` C7 this is recorded as a
single, deliberate change rather than a silent removal.

**Now allowed** (proxy CONTENT — the user's routing intent):
`mode: rule`, `proxies`, `proxy-groups`, `proxy-providers`, `rules`,
`rule-providers`, a full `dns` block (nameserver/fallback splits), `ipv6`,
`strict-route`, custom `fake-ip-range`, extra `dns-hijack` entries, and other
ordinary mihomo top-level keys.

**Still refused** (structural boundary — non-negotiable, and re-checked
independently by the service because the ordinary main process is not trusted):

- `allow-lan: true`, and any `bind-address` off loopback
- `external-controller` not on `127.0.0.1`, or a `secret` that is not 64-hex
- extra inbounds: `port`, `socks-port`, `redir-port`, `tproxy-port`, `listeners`,
  and `tunnels` (which binds arbitrary local ports and forwards them to arbitrary
  hosts)
- unauthenticated controller surfaces: `external-controller-unix`,
  `external-controller-pipe`, `external-controller-tls`,
  `external-controller-routing-mark`, `external-doh-server`, and
  `external-controller-cors` (which widens who may reach the controller)
- host clock mutation: `ntp`, whose `write-to-system: true` lets this
  SYSTEM-privileged process set the machine clock — which can invalidate
  certificate validity windows and Kerberos tickets host-wide
- remote-archive download/extract: `external-ui`, `external-ui-url`,
  `external-ui-name`. mihomo would fetch that ZIP and unpack it under the
  configured directory as SYSTEM; Murge ships its own UI, so these are never
  legitimate. The generator STRIPS them (a real subscription may carry one and
  must stay usable) while both validators still REFUSE them, so a hand-authored
  or tampered profile submitted straight to the pipe fails closed.
- arbitrary file write via provider cache paths: `proxy-providers.*.path` and
  `rule-providers.*.path` are WRITE targets for the privileged child, so an
  absolute path, a drive-relative path (`C:x`), an alternate data stream or a
  `..` escape is refused. The generator rewrites an unsafe path to a contained
  `./<section>/<name>.yaml` so the provider still works. mihomo enforces its own
  "subpath of home directory" rule, but this service is the boundary and must not
  have to trust it.
- `dns.listen` (a public DNS bind), `dns.enable:false`, non-`fake-ip` enhanced mode
- `tun.enable:false`, a malformed `tun.device`, an unknown `tun.stack`
- YAML aliases, non-core-schema tags (matched against an allowlist, NOT a `!!`
  prefix test — `!!python/object` starts with `!!`), and multiple documents
- a profile over the service's 64 KiB `maxProfileBytes` ceiling

The residual risk is explicit: a compromised main process could direct this
SYSTEM-privileged child at attacker-chosen proxy nodes and rules. It still cannot
bind a public port, expose an unauthenticated controller, substitute the binary or
run an arbitrary command. That is a strictly smaller surface than clients which
run an elevated mihomo with no service-side validation at all.

### Mutual exclusion

TUN remains mutually exclusive with the **safe kernel** (both run a mihomo and
bind a mixed-port). TUN and the **system proxy** may now be enabled together:
`TunAwareSystemProxyProbe` resolves the proxy target to the live TUN session's
mixed-port while the main kernel is stopped, and still socket-probes it
(TCP + HTTP CONNECT + SOCKS5) before the registry is touched. When a TUN session
stops serving, the owned proxy is restored through the same
`restoreBeforeKernelUnavailable` path the main-kernel crash hook uses, so the
registry never keeps pointing at a dead port.

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
