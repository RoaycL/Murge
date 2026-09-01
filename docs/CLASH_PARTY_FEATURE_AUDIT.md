# Clash Party page audit and Murge enhancement backlog

Status date: 2026-08-31

This document audits the ten supplied Clash Party screenshots against the
current Murge implementation. A visible switch is not counted as supported
unless Murge has a typed renderer → IPC → main-process contract, confirmed
runtime state and a recovery/error path.

The screenshots are a feature reference, not a visual reference. Murge keeps
its approved Surge-derived information architecture and brand-configurable
product identity.

## Summary

Murge already covers the daily core path: profiles from URL/file/manual input,
kernel lifecycle and version selection, policies, rules, providers, live
connections, per-connection close, process/device aggregation, logs, DNS
diagnostics, system-proxy ownership, tray/startup and update scaffolding.

The largest missing product capability is a deterministic configuration
enhancement pipeline. DNS, sniffer, TUN and advanced core settings must be
implemented as typed inputs to that pipeline rather than independent controls
that overwrite subscription YAML.

## Page-by-page comparison

| Screenshot/page | Clash Party capability | Murge status | Work required |
| --- | --- | --- | --- |
| System proxy | Host, manual/PAC mode, UWP loopback helper, default/custom bypass list | Partial | Murge owns and restores the Windows manual proxy safely. Editable bypass policy with verified read-back is done: the `ProxyBypassPolicy` is authoritative for the written `ProxyOverride` when enabled (mandatory local/private entries merged with the user's custom list), preserves the OS list when disabled, re-applies live with conflict + read-back verification, and always restores the pre-enable value verbatim. PAC and UWP remain separate, Windows-only features. Never periodically overwrite state owned by another process. |
| Virtual adapter | TUN stack, adapter name, strict route, auto route/interface, MTU, DNS hijack and excluded ranges | Gated partial | Service, coordinator, IPC and UI wiring exist, but release support is blocked on the isolated Windows recovery matrix. Do not expose advanced controls until every field is represented in the signed intent and rollback evidence. |
| DNS settings | Enable, enhanced mode, fake-IP range/filter, IPv6, respect-rules and nameserver groups | Partial | Murge has DNS query/cache actions and preserves profile DNS. Add a declarative DNS override editor, schema validation, preview and last-known-good rollback. |
| Domain sniffer | Enable, destination override, IP mapping options, HTTP/TLS/QUIC ports, skip/force domains and skipped CIDRs | Missing | Add a typed sniffer override model. Validate ports, domains and CIDRs before materializing the runtime config. |
| Connections | Live/closed tabs, totals, filter, columns, per-row close/pause controls | Strong partial | Murge already has shared streaming, search, detail and confirmed single-close. Added totals, sorting and confirmed batch close. Closed-history and column chooser remain. Pause is not promised by the current mihomo contract. |
| External resources | GeoIP/GeoSite/MMDB/ASN sources, data mode, update interval, proxy/rule provider refresh and details | Partial | Provider list/refresh/health data exists. Add geodata source policy, download integrity, atomic replace, update schedule and provider detail. QR export must redact credentials and be opt-in. |
| Overrides | URL/local import and ordered override items | Missing / P0 | Add versioned YAML overrides first: global and profile scope, order, enable/disable, preview/diff, validation, atomic writes and rollback. JavaScript is a later trusted-code feature, not a security sandbox. |
| Core settings | Kernel selection, mixed/SOCKS/HTTP ports, listen address, secret, dashboard, IPv6, LAN/auth and 1-RTT | Partial | Stable/specific kernel management and mixed port are present. Add controlled port/listen/LAN fields with collision checks. Controller secret stays app-owned and must not be revealed or freely edited. |
| Network information | Egress IP provider, country/city/ASN, copy/reveal and connection topology | Partial | Murge exposes best-effort egress IP. Add privacy-explicit provider selection and cached metadata. Topology is a derived visualization and must label incomplete mihomo data. |
| Usage | 1h/24h/7d/30d history; sessions/upload/download/total; device/domain/proxy/process ranking | Missing | Add bounded local time-series persistence, retention, aggregation and clear-data action. Never persist controller secrets, full URLs or raw profile content. |
| Sub-Store entry | Embedded/linked subscription transformer | Missing | Defer until the override pipeline is stable. Prefer an explicit external integration over silently hosting a privileged remote panel. |

## Existing Murge capabilities that must not be rebuilt

- Typed `ProtocolErrorCode` classification already spans renderer and main;
  enhance detail transport instead of introducing a second error family.
- `/traffic`, `/connections` and `/logs` already use shared WebSockets with
  backoff, jitter, stable-window reset, listener cleanup and renderer silence
  watchdogs.
- Production ports are dynamically selected. The remaining issue is the
  probe-to-bind race; startup should retry on a verified collision.
- Raw subscription URLs are not persisted; stored source metadata is redacted.
- Deep-link registration and single-instance forwarding already exist.
- TUN follows Murge's privileged-service ownership and recovery architecture.
  Do not replace it with an elevated Electron renderer.

## Configuration enhancement pipeline

The required order is:

```text
immutable source profile
  -> parse YAML
  -> ordered global YAML overrides
  -> ordered profile YAML overrides
  -> typed DNS/sniffer/core rule operations
  -> Murge safety ownership transform
  -> structural and semantic validation
  -> user-visible diff/preview
  -> atomic last-known-good runtime materialization
```

Rules:

1. Subscription refresh never edits or deletes user overrides.
2. Every override has a stable ID, schema version, scope, enabled state and
   deterministic order.
3. Invalid YAML, invalid fields and semantic conflicts fail closed. The
   previous valid runtime config remains active.
4. Arrays use explicit replace/prepend/append/remove operations; generic deep
   merge must not silently replace `rules`, `proxies` or `proxy-groups`.
5. Safety-owned controller address/secret, public listeners, system proxy and
   TUN ownership cannot be overridden by a subscription or enhancement.
6. Node `vm` is not a security boundary. A future JavaScript override is
   labelled trusted local code and runs in a separately constrained process
   with a timeout, memory ceiling and no file/network/module access.

## Delivery TODO

### P0 — Declarative enhancement foundation

- [ ] Define versioned override schemas and shared gateway contracts.
- [ ] Implement atomic override repository with stable ordering.
- [ ] Implement deterministic map merge plus explicit sequence operations.
- [ ] Apply global overrides, then profile overrides, before safety transforms.
- [ ] Produce validation result and redacted before/after diff without applying.
- [ ] Preserve and recover the last-known-good materialized configuration.
- [ ] Add Vue management page: create, import, edit, reorder, enable and scope.
- [ ] Cover malformed YAML, duplicate IDs, sequence behavior, safety conflicts,
      refresh persistence and crash-safe writes.

### P1 — Controlled DNS, sniffer and core settings

- [x] DNS shared schema and editor: enable, enhanced mode
      (`fake-ip`/`redir-host`/`normal`), fake-IP range, fake-IP filter mode/list,
      IPv6, respect-rules, hosts/use-hosts, default-nameserver,
      proxy-server-nameserver, direct-nameserver, nameserver, fallback and
      nameserver-policy. (`src/shared/dns.ts`, `DnsSettingsPanel.vue`, the
      `dns-enhancement.json` service and the `dns:` generator at `v0.1.14`. The
      model is strict/zod-validated at IPC, and generated list keys are only
      emitted when non-empty.)
- [x] Validate DNS server schemes, IPs, domains and CIDRs; render a redacted
      effective-config preview; preserve the last-known-good config on failure.
      (Every server scheme `udp|tcp|tls|https|h3|quic|dhcp`, IP, hostname, domain
      pattern and CIDR is validated before persist/materialize; preview is
      redacted (`***` for userinfo); on any invalid/unparseable input the
      pipeline fails open to the base/default so a broken enhancement never
      reaches the kernel — a fail-open last-known-good guarantee.)
- [ ] Sniffer shared schema and editor: enable, override-destination,
      force-dns-mapping, parse-pure-ip, HTTP/TLS/QUIC ports, skip-domain,
      force-domain, skip-src-address and skip-dst-address.
      (Shipped at `v0.1.15`: `SnifferEnhancement` in `src/shared/sniffer.ts` plus
      the `SnifferSettingsPanel` editor on the Config page; port token, domain
      pattern and CIDR validation happen in the IPC schema before any persist.)
- [ ] Validate and normalize single ports/ranges, domain patterns and IPv4/IPv6
      CIDRs; add parse-back and fixture coverage for the generated `sniffer:`
      block.
      (Shipped at `v0.1.15`: `isValidPortToken`, `isValidAddressOrCidr` and the
      shared `net.ts` validators back the strict `snifferEnhancementSchema`; the
      IPC schema is unit-tested for bad ports/domains/CIDRs, and
      `apply-sniffer`/`sniffer-enhancement-service` tests assert the generated
      `sniffer:` block round-trips through parse-back, including empty-list
      omission and preserved non-owned keys.)
- [x] TUN shared schema and editor: stack, device/adapter identity, MTU,
      strict-route, auto-route, auto-detect-interface, DNS hijack,
      route-address, route-exclude-address and explicitly supported optional
      mihomo fields.
      (Shipped at `v0.1.16`, **config model only**, marked
      `implementation-complete / runtime-unverified`:
      `TunConfigModel` in `src/shared/tun-config.ts` plus the strict
      `tunConfigSchema` at IPC; the `TunConfigPanel.vue` editor on the Config
      page; the `tun-config.json` service and the `buildTunBlock` generator
      folded into the mihomo-owned bootstrap via `readTunConfig`. **The TUN
      lifecycle/error UI is the next item below.**)
- [x] TUN lifecycle UI: unsupported, stopped, starting, active, stopping,
      restoring, restore-failed, conflict and failed; add retry and emergency
      disable without depending on a responsive renderer.
      (Shipped at **v0.1.17**, marked `implementation-complete /
      runtime-unverified` — pinned to the `TunPhase` enum so `stopped`/`stopping`
      map to `configured`/a paused coordinator; `TunLifecyclePanel.vue` on the
      Config page renders the phase via `TUN_UI_COPY`, surfaces
      `errorMessage`/`conflictDetail`, derives enable-only-from-`configured`/
      `failed` (retry) and disable-while-networking-owned gating from the pure
      `src/renderer/src/lib/tun-lifecycle.ts` helper, and the `tun` Pinia store
      mirrors coordinator status via `connect`/`disconnect` while capturing
      action errors with `toProtocolError`. The renderer never elevates: disable
      routes to the coordinator's `emergencyDisable`, which stays callable
      without a renderer. Non-Windows/dev builds render `unsupported`; not a
      release TUN enablement.)
- [ ] Wire TUN only through the existing privileged service/named pipe,
      integrity checks, coordinator and mutation journal. Do not elevate the
      Electron renderer and do not allow the subscription to become a second
      route/DNS owner.
- [x] Complete all DNS/sniffer/TUN gateways, IPC validation, Pinia stores,
      fixtures, generators, preview/diff and network-silent tests before the
      Windows test campaign. (DNS / Sniffer / TUN each ship a shared model +
      strict zod schema, IPC gate + preload block + Pinia store + Config page
      panel, an atomic-persist service and a config generator with parse-back
      assertions; the composed `tests/network-silent-config.integration.test.ts`
      exercises the real profile + DNS + Sniffer + `buildProfileKernelConfig`
      pipeline in-memory and asserts loopback-only / no public bind /
      `dns.listen`-stripped / parse-back-valid output. Non-Windows/dev builds
      keep TUN `unsupported`; not a release TUN enablement.)
- [ ] Controlled ports/listen/LAN/auth editor with pre-bind validation.
- [ ] Editable system-proxy bypass policy with exact restore and conflict tests.
- [ ] Preserve typed error `details` and `operation` across Electron IPC.

### P2 — Resources and observability

- [ ] Geodata source registry with HTTPS allowlist, hashes, atomic replacement,
      manual refresh and bounded scheduling.
      (Controlled geodata *policy* — geodata-mode / geoip-mode / geo-auto-update /
      geo-update-interval / optional geo-x-url — is implemented as a typed,
      persisted model that is authoritative when enabled (read-back) and overrides
      the profile (conflict handling) in v0.1.20. The registry itself — HTTPS
      allowlist, download integrity/hashes, atomic replacement, manual refresh,
      bounded scheduling — remains.)
- [ ] Provider detail view and batch result reporting.
- [ ] Connections closed-history model and configurable visible columns.
- [ ] Bounded usage database, 1h/24h/7d/30d buckets and four ranking views.
- [ ] Network metadata provider selection, cache, privacy copy and failure state.
- [ ] Read-only topology derived from current connections/rules/proxy chains.

### P3 — Optional integrations

- [ ] Local backup/export and transactional restore with manifest/checksums.
- [ ] Encrypted WebDAV backup with conflicts, rotation and credential storage.
- [ ] Global shortcuts and shell-specific proxy environment export.
- [ ] Traffic floating window and richer tray states.
- [ ] Sub-Store/deep-link enhancements after threat and privacy review.
- [ ] Trusted-code JavaScript overrides only after process-isolation review.

### Windows-only release gates

- [ ] Install an implementation-complete build on an isolated, snapshot-able
      Windows VM with an out-of-band recovery console.
- [ ] Verify TUN enable/disable, adapter identity/reuse, IPv4, IPv6, DNS hijack,
      DNS leak behavior, strict route, exclusions and LAN reachability.
- [ ] Verify sleep/wake, Wi-Fi/Ethernet change, DHCP/network-profile change and
      temporary controller/network loss.
- [ ] Force-kill the GUI, mihomo and privileged service independently at every
      mutation-journal boundary; verify bounded recovery after restart.
- [ ] Verify normal disable, failed enable, forced termination, reboot and
      uninstall restore the exact previous routes, DNS, proxy and service state.
- [ ] Verify retry and emergency disable after restore failure without spawning
      a second kernel, adapter or ownership session.
- [ ] Record sanitized before/after evidence, process/service state, adapter
      identity, route tables and DNS state against an immutable build/tag.
- [ ] Keep TUN labelled `runtime-unverified` until every required row passes;
      implementation and mock tests alone cannot promote it to supported.
- [ ] Validate PAC/UWP behavior on clean supported Windows versions.
- [ ] Prove install, upgrade, uninstall and emergency recovery leave exact prior
      proxy/routes/DNS state.

## Reference implementation policy

- Clash Party's Node main-process organization may inform contracts and data
  flow, but React UI code is translated into Murge's Vue/Pinia architecture.
- Clash Verge Rev's Rust code is a behavioral reference only; do not translate
  unsafe assumptions or copy Rust implementation mechanically.
- Preserve upstream GPL notices where code is actually adapted. Record source,
  commit and affected files in `THIRD_PARTY_NOTICES.md` before merging copied or
  derivative implementation.
- Screenshots and third-party names are not Murge assets. No Clash Party logos,
  gradients, icons or branding are copied.
