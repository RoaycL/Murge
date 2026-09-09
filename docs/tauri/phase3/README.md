# Phase 3A — Safe local state slices (in progress)

Status: **In progress** — three slices landed, the rest staged.

## Landed

### 0. Shared error module (`src-tauri/src/error.rs`)

`IpcError` encodes the `PROTOCOL_ERROR:<CODE>::<message>` wire format with
typed constructors (`invalid_argument`, `not_found`, `unsupported`,
`internal`); the TS bridge decodes with the SAME shared helper, so error
mapping stays shell-independent.

### 1. Brand + AppInfo + App settings (`src-tauri/src/{brand,app_info,paths,settings}.rs`)

- Brand: the Rust binary embeds the SAME `brand.config.json` (`include_str!`)
  and fails startup on an invalid document — the Electron `parseBrandConfig`
  gate, byte-for-byte.
- AppInfo: `version` from the crate version, `platform` in Electron's
  `process.platform` vocabulary (`win32`/`darwin`/`linux`/`other`) and `arch`
  in Node's (`x64`/`arm64`/`ia32`) — renderer branching stays shell-agnostic.
- App settings: byte-compatible port of `src/main/app-settings/service.ts`:
  - read: ENOENT → defaults; corrupt → quarantine to
    `app-settings.json.corrupt-<epoch-ms>` then defaults (evidence preserved);
  - parse: strict per-field salvage with defaults; `kernelEnabled` always
    true (deprecated field migrated); `delayTestUrl` validated on the READ
    path only (the TS `set()` stores raw strings — same quirk preserved);
  - write: mkdir -p → temp `.app-settings.json.<uuid>.tmp` → 2-space pretty
    JSON + trailing newline → atomic rename;
  - patch merge: field-for-field TS parity (invalid values keep current);
  - dev builds keep an in-memory mirror (never touch real user data).

### 2. Profiles + source metadata (`src-tauri/src/{profiles,profile_service,profile_parse,redact,validate}.rs`)

Byte-compatible ports of `profile-repository.ts` + `profile-service.ts` +
`config-validator.ts` + `profile-diagnostics.ts` + `proxy-group-order.ts` +
`provider-configs.ts` + `redactCredentials`:

- Layout: `<root>/<id>.yaml` (verbatim document) + `<id>.meta.json` (compact
  JSON, insertion-order keys via serde_json `preserve_order`) +
  `active.json`. Reads/writes confined to the root; ids restricted to
  `[A-Za-z0-9_-]+`; lexical (non-symlink-following) root containment.
- Writes: temp `.tmp-<ms>-<uuid>` → fsync → rename, 0o600 on Unix (a profile
  YAML can embed proxy credentials). Failed writes clean their temp file.
- Import commit order: document → meta → activation pointer (a partially
  imported profile is never listed); names unique case-insensitively; torn
  meta files are skipped by `list`; deleting the active profile clears the
  pointer.
- Documents are never re-serialized wholesale: the scalar edit engine
  (`replaceScalar`/`insertKey`) preserves unknown keys, their order and
  inline comments verbatim, and updates `size` after edits.
- Validation gates activation, import, edits and replaces: structural pass
  (empty doc, duplicate top-level keys with 1-based lines, tab indent,
  unbalanced flow collections, missing top-level keys, optional proxy-section
  requirement) + non-blocking compatibility warnings (obsolete
  `global-client-fingerprint`/`udp` keys). Warnings never reject. The
  semantic `mihomo -t` pass arrives with the Phase 3D privileged slice; the
  dev-mode Electron validator is also structural-only, so behavior matches
  today's dev semantics. Chinese message copy preserved verbatim.
- Source store: raw subscription URLs live only in the OS credential store
  (keyring, `windows-native` backend — the Tauri equivalent of Electron
  safeStorage DPAPI); the renderer-visible metadata keeps only the
  credential-redacted URL. Dev builds use a memory store. `setSourceUrl`
  refuses non-url profiles with the same Chinese copy.
- Redaction: userinfo strip, secret-looking query params (`***REDACTED***`),
  20+ char hex path segments (`[UUID_REDACTED]`), regex fallback for
  malformed targets, free-form text handling — `isRedactedUrl` staged for 3C.
- Group order + provider catalog: parsed from the active profile document
  (the controller cannot supply Go-map order). The enhanced-document
  composition lands with the overrides slice; with all overrides disabled the
  enhanced document IS the raw document, so this staging is
  behavior-identical. Provider config serializes `testUrl` in camelCase with
  absent fields omitted.

### 3. Overrides (增强/覆写) (`src-tauri/src/{override_model,override_apply,override_service}.rs`)

Rust ports of `shared/overrides.ts` (model + `redactOverrideContent`),
`kernel/overrides/override-service.ts` and `apply-overrides.ts`:

- Model: `OverrideItem` with the exact coerce semantics (unknown kinds →
  `yaml`, unknown scopes → `global`, `profileId` only honored for profile
  scope, `未命名覆写` fallback, camelCase serialization with `profileId`
  always present), plus `redactOverrideContent` (userinfo, secret-looking
  keys case-insensitive, 64-hex → `***`).
- Store: `overrides.json` in the app-data namespace — 2-space pretty JSON +
  trailing newline, temp + atomic rename, lazy load, corrupt → empty list,
  `order` always equals the array index (reindex after remove/move), serial
  mutations via mutex. CRUD + `setEnabled` + `move(up|down)` with the same
  覆写不存在 error copy; out-of-range moves are no-ops.
- Apply engine: parse base → apply in `order` → re-serialize; deep merge with
  `+key` (prepend) / `key+` (append) list modifiers and stringified-value
  dedupe; plain objects merge recursively; malformed YAML overrides fail OPEN
  per-item with 覆写「name」YAML 解析失败 warnings; an unparseable base is
  returned verbatim. `profileKernelConfigErrors` gate ported (empty doc,
  top-level mapping requirement, proxies/proxy-groups/proxy-providers/rules
  presence) for the last-known-good capture and chain validation.
- 预演/校验/回滚: `preview` (redacted baseText/appliedText + warnings +
  unavailable against the ACTIVE profile), `validate` (per-item structural
  checks + whole-chain introduced-errors-only semantics + 基础配置 warning),
  `lastKnownGood` snapshot captured on every structurally-valid result and
  `resetToLastGood` rollback — all with the Electron copy verbatim.
- The preview/validate resolver reads the active profile (document + id)
  through the profiles service, mirroring the Electron composition.

**Documented differences (staging):**
- `js` overrides need a JS engine in Rust; they fail OPEN with an explicit
  warning (JS 覆写需要 JS 沙箱…) and validate() reports them not runnable.
  Never approximated by a weaker sandbox. (Lands with a later slice.)
- YAML re-serialization uses `yaml-rust2`'s emitter: no 80-column folding and
  quoted scalars where `yaml.stringify` folded — semantically equivalent for
  mihomo; the runtime config text is generated by the same engine so both
  shells agree on what the kernel receives byte-wise per shell.
- YAML parse-error message wording follows the Rust parser engine
  (engine-specific copy, same semantic gate).

### 4. Typed single-model stores (核心/地理数据/DNS/嗅探器/TUN 配置) (`src-tauri/src/{enhancements,net_validators}.rs`)

Rust ports of the five identical single-model services and their shared
models — `core-settings-service.ts` + `shared/core-settings.ts`,
`geodata-settings-service.ts` + `shared/geodata.ts`,
`dns-enhancement-service.ts` + `shared/dns.ts`,
`sniffer-enhancement-service.ts` + `shared/sniffer.ts`,
`tun-config-service.ts` + `shared/tun-config.ts`:

- One generic `ModelStore` implements the exact shared persistence contract:
  file in the app-data namespace, 2-space pretty JSON + trailing newline,
  temp `.<file>.<epoch-ms>.tmp` + atomic rename, lazy load-through cache,
  corrupt/missing -> defaults (re-coerced), envelope keys `enhancement` /
  `config` (or envelope-free for core + geodata, exactly like the TS
  services), serial mutations. Dev (no app-data root) is memory-only.
- `coerce*` functions port each model field-for-field: core (allowlisted
  runtime keys, controller-secret `/^(?:|[0-9a-f]{64})$/`, duplicate active
  ports reset all four, `interfaceName` trim+255 cap), geodata (HTTP(S)
  source-URL validation with empty-allowed, interval bounds 1..=168,
  per-entry fallback to `DEFAULT_GEOX_URLS`), sniffer (probe families fall
  back to the curated defaults, party-parity skip lists verbatim), TUN
  (stack/device/MTU validators, `dns-hijack` entry grammar, route CIDR
  filtering, list keys emitted only when non-empty), DNS (`normal` ->
  `redir-host` migration, respectRules false when proxyServerNameserver is
  empty, hosts/nameserverPolicy maps from entries).
- `build*Block` ports emit the same mihomo keys with the same
  conditional-emission rules (fake-ip keys only in fake-ip mode, hosts and
  nameserver-policy as maps, core `interface-name` only when set, TUN
  route lists only when non-empty). Previews render through the Rust YAML
  emitter (documented formatting difference — semantically neutral).
- Migrations ride the load path: core `storageVersion: 2` with the v0.9.0
  mixed/http default-swap tuple fix; TUN legacy 9000 MTU -> 1500.
- Previews never write. DNS preview redacts every nameserver string
  (`redactServer` userinfo masking) and the core preview keeps the
  `（下次启动时自动生成）` secret placeholder and the conditional
  `external-ui` panel keys verbatim.
- `net_validators.rs` ports `shared/net.ts` (IPv4/IPv6, CIDR, hostname,
  mihomo domain patterns, address-or-CIDR) plus the DNS nameserver and
  default-nameserver grammars for the schema-validation slice.

**Documented differences (staging):**
- The Electron zod IPC schemas reject invalid `set` payloads before the
  service runs; the Tauri shell relies on coerce-on-set (same end state —
  an invalid payload converges to safe defaults) — the validator functions
  are ported and staged for a later schema slice.
- Preview YAML text follows the Rust emitter's quoting/folding (see the
  overrides slice note).

### 5. Usage history (`src-tauri/src/usage.rs`)

Rust ports of `shared/usage.ts`, `services/usage-history-store.ts` and
`services/usage-history-service.ts`:

- Model: hourly byte buckets with the exact coerce semantics (non-negative
  finite numbers only, `bucketStart` floored, `up`/`down` rounded, `count`
  floored defaulting to 0, the `countType: "connections"` marker preserved),
  bounded sorted lists (newest `USAGE_MAX_BUCKETS` = 720 retained), window
  aggregation with fixed-length zero-filled slots (`1h/24h/7d/30d` grids,
  day-slot folding for `7d/30d`), 1-based ranking with zero-bucket omission,
  value-desc/earliest-first tie order and the `limit` cap, capacity facts.
- Store: `<app-data>/usage-history/usage-history.json` — compact JSON +
  trailing newline, temp `.<file>.<uuid>.tmp` + rename with the
  EPERM/EACCES/EBUSY retry ladder, stale-temp pruning on read, corrupt file
  -> empty database (never an error), and the pre-0.8.5 count reset (legacy
  buckets without the marker keep bytes but zero `count`).
- Service: rate integration over the interval since the previous sample
  (`0`-interval guards against non-monotonic clocks — a back-dated sample
  contributes zero bytes and never regresses the cursor), hourly bucket
  rolls, newest-wins trimming, connection counting for newly observed ids
  only, the 10 s persist throttle (`0` disables), clear/flush/capacity.
  Numbers serialize through a `JSON.stringify`-parity helper (integral
  floats emit without a decimal point).
- The traffic/connections sources attach in the Phase 3B/3D controller
  slice; the record/flush surface is compiled and staged (documented).

### File logging (staged, no IPC surface)

`FileLogService` has NO IPC channel in Electron (main-process only
consumer); it is intentionally not ported yet — it lands with the 3B
controller slice that produces the app/core log lines it writes.

### 6. Active-config inspection (`src-tauri/src/inspection.rs`)

Rust ports of `main/profiles/profile-config-inspection.ts`,
`kernel/dns/apply-dns.ts`, `kernel/sniffer/apply-sniffer.ts` and
`kernel/profile-kernel-config.ts` (`buildProfileKernelConfig`):

- `build_profile_kernel_config`: content sections preserved
  (`proxies`/`proxy-groups`/`rules`/…), the host-network surface neutralized
  (`tun`, `listeners`, `redir-port`/`tproxy-port`, `ss-config`/`vmess-config`/
  `tuic-server`, every extra `external-controller-*` variant and
  `external-doh-server` removed; `dns.listen` stripped), app-critical keys
  forced (`mixed-port`, optional `port`/`socks-port`, `external-controller`,
  `allow-lan`/`bind-address`, 64-hex `secret`, optional metacubexd panel,
  `mode` normalized), controlled core/geodata models read back when enabled
  (profile sub-map merged with the model winning the spread, DNS `ipv6`
  synced, `interface-name` removed when empty), and the same INVALID_ARGUMENT
  rejections (port ranges, `listener ports must differ`, secret grammar,
  unparseable top level).
- `apply_dns_to_document` / `apply_sniffer_to_document`: the model's block
  merges over the profile's own section keys (unknown keys preserved);
  disabled or unparseable base returns the base verbatim with the exact
  warnings (基础配置文件无法解析，已跳过 DNS/Sniffer 增强).
- `inspect_active_profile_config`: per-section excerpts (CORE_KEYS /
  GEODATA_KEYS picks, `secret` masked to `********`, empty renders 未配置),
  managed-key lists, the Chinese notes verbatim, and the compatibility
  diagnostics.
- Channel: `profiles:inspect-active-config` now composes the ACTIVE profile
  through overrides → DNS enhancement → sniffer enhancement →
  `build_profile_kernel_config` (14 of 17 profile channels live). The
  kernel-runtime knobs (bound ports, TUN phase, generated secret) arrive with
  the 3B/3D supervisor slices; until then the core-settings model is the
  authoritative source and the Electron pre-kernel fallbacks apply (mixed-port
  7890, controller 9090, 64-zero secret, TUN disabled).

**Documented differences (staging):**
- yaml-rust2 does not resolve YAML anchors/merge keys (`<<`), so anchor-heavy
  profiles carry the unexpanded form into the runtime copy (the overrides
  slice already documents the emitter differences).
- `documentDnsEnabled` (TUN dns-hijack decision input) ports with the 3D
  privileged slice.

### 7. Kernel supervisor + version manager + runtime summary (`src-tauri/src/kernel.rs`)

First Phase 3B slice — the lifecycle state machines, channel-ready:

- `KernelSupervisor` ports the TS state machine with the serialized-queue
  semantics (`start`/`stop` run one at a time): `get-status`, `start`
  (already running/starting/stopping is idempotent; a fresh start runs the
  resolver step), `stop` (idempotent on `stopped`, clean `stopped` landing
  with `lastError` cleared). The binary resolver is the
  `DisabledKernelResolver` port — a fresh start records `phase: failed` +
  the exact Electron copy (Kernel execution is disabled…) as `lastError` and
  propagates the same UNSUPPORTED error, until the artifact pipeline lands.
- `KernelManagerService` ports `buildState` (settings-mirrored channel +
  specific version, pinned stable version `v1.19.30` from
  `resources/mihomo-assets.json`, effective-version labels `预览版`/`Smart`),
  `setEnabled` -> smart/stable delegation, `setChannel` (same-channel no-op
  clearing the error, `specific` rejected with the service-mode copy,
  preview/smart attempt-then-rollback with the 安装…内核失败 copy and the
  previous settings untouched), `listVersions`/`install` (the GitHub-API
  downloader stages with the network slice; the unsupported guards fire with
  the verbatim copies, invalid version tags rejected first with
  无效的版本号：…). `specificVersionsSupported` is false in this milestone,
  which byte-for-byte matches the Electron service-mode behavior.
- `runtime:get-summary` ports `buildRuntimeSummary` with its fail-safe
  fallbacks (mode `rule` when the controller is unreachable — which it always
  is in this milestone —, ACTIVE profile name or the brand default
  `Murge Default`, ownership flags false); `runtime:get-external-ip` returns
  null unless the kernel runs (the probe lands with the controller client).
- 10 channels live: `kernel:get-status|start|stop`,
  `kernel-manager:get-state|set-enabled|set-channel|list-versions|install`,
  `runtime:get-summary|get-external-ip`. Status/events (`kernel:status-event`
  etc.) emit with the controller slice, when transitions actually occur at
  runtime.

### 8. Mihomo controller REST client + 20 live channels (`src-tauri/src/mihomo.rs`)

Second Phase 3B slice — the typed controller client, channel-ready:

- `MihomoClient` ports `mihomo-client.ts` over `reqwest` (rustls — the same
  choice clash-verge-rev ships): every endpoint of the TS client (version,
  configs get/patch/reload, proxies/select, rules, providers get/refresh/
  healthcheck, delay tests incl. provider + group, DNS query, cache flushes,
  connections + close) with the verbatim error mapping (transport ->
  UPSTREAM_UNREACHABLE, timeout -> UPSTREAM_TIMEOUT, 401 -> UNAUTHORIZED,
  504 -> UPSTREAM_TIMEOUT, 503 -> UPSTREAM_TEST_FAILED, other non-2xx ->
  UPSTREAM_HTTP_ERROR, invalid JSON -> INVALID_UPSTREAM). Provider refreshes
  keep the 45s budget; delay tests raise their timeout by +3s.
- `encodeURIComponent` parity for path segments (CJK group/node names) and
  the exact renderer-argument validators from `shared/schemas/ipc.ts`
  (non-empty-name, proxy selection, connection id, strict delay options that
  REJECT renderer-supplied probe URLs, allowlisted config patch that
  excludes `tun`, DNS hostname + 7-type set, log cursor).
- Payload parsers port `shared/schemas/mihomo.ts` (required primitives,
  passthrough, null-connections normalization, DNS/flag validation) with the
  same INVALID_UPSTREAM wire errors.
- `MihomoLogBuffer` (monotonic seq, FIFO eviction at 2000, high-water clear)
  serves `mihomo:logs-snapshot|clear-logs` today; the live log/traffic/
  connections EVENTS tap it from the stream slice.
- `ProxySelectionStore` (proxy-selections.json, temp+rename, fail-open) +
  the selection gateway (resolve active profile -> PUT -> record, shared
  mutation boundary) + `restore_selections` replay are in place for the 3D
  kernel start path.
- The group-member delay test ports `MihomoService::groupMemberDelayTest`:
  NOT_FOUND guard with the verbatim copy, global-scope/profile-url/owner-
  testUrl chain, provider-owner index (1s cache) with 404 fall-through.
- Known staging differences (documented): the controller endpoint/secret are
  read from the coerced core-settings model (Electron production wires the
  kernel's materialized config; rebinding lands with the 3D kernel slice);
  YAML merge keys (`<<`) resolve one level deep for `url`/`name`; the
  `mihomo:internet-latency` channel stays staged (needs raw-socket gateway
  RTT + system resolver probes, lands with the 3D system slice); the three
  push-stream EVENT channels stay staged with the emit pipeline.
- 20 channels live: `mihomo:get-config|patch-config|get-proxies|
  select-proxy|get-rules|get-proxy-providers|refresh-proxy-provider|
  health-check-proxy-provider|get-rule-providers|refresh-rule-provider|
  delay-test|group-member-delay-test|group-delay-test|get-connections|
  close-connection|dns-query|flush-dns-cache|flush-fakeip-cache|
  logs-snapshot|clear-logs`. With no running kernel the REST channels fail
  UPSTREAM_UNREACHABLE — the exact typed error the renderer already handles.

### 9. Push-stream transports + event emit pipeline (`src-tauri/src/events.rs`)

Third Phase 3B slice — the push streams and the renderer event wiring:

- `MihomoStreams` ports the three shared WebSocket transports
  (`/traffic`, `/connections`, `/logs`) over tokio-tungstenite with the TS
  reconnect semantics verbatim: reconnect forever while listeners remain
  (`maxRetries: 0`), exponential backoff (250 ms base, 5 s cap, +/-20%
  jitter), the attempt counter resets only after a socket stayed open past
  the 10 s "stable" window, and every failure surfaces to the stream-error
  hub immediately (never waiting for retries to exhaust).
- Message handling ports the service parse boundary: traffic samples are
  stamped with an arrival `timestamp`, log messages tap the shared
  `MihomoLogBuffer` (retention independent of subscribers; the event copy
  and the retained copy agree on `seq`), connections normalize null -> [],
  and parse failures emit the exact `MihomoStreamError` shape
  (`{ code, message: "<source> stream: <message>", source, kind }`).
- `EventHub` mirrors the TS `Set<listener>` + unsubscribe contract (clone =
  same hub; used by the streams, the stream-error hub, kernel status and
  kernel-manager state).
- `start_forwarding` ports the register-ipc push forwarder: one
  subscription per channel at startup, delivered to every renderer through
  Tauri's broadcast emit (`mihomo:traffic-event|connections-event|
  log-event|stream-error-event`, `kernel:status-event`,
  `kernel-manager:state-event`). The supervisor's `setStatus` and the
  manager's `commit` now fan out through their hubs, matching the TS
  EventEmitter contract. The streams bind the core-settings controller
  endpoint at startup exactly like the REST client (rebinds at 3D).
- Remaining event channels stay staged with their owning slices:
  `app:navigate-event` (window slice), `system-proxy:status-event` /
  `tun:status-event` (3D), `updates:state-event` (Phase 5). The `logSink`
  file capture lands with the Phase 4 logging slice.

### 10. Subscription fetch pipeline (`src-tauri/src/subscription.rs`)

Fourth Phase 3B/3C slice — the network fetch of remote subscriptions:

- `SubscriptionFetcher` ports `subscription-fetcher.ts` verbatim: the SSRF
  allow-list (one `is_public_address` predicate for literal hosts AND every
  DNS answer — v4 private/loopback/CGNAT/benchmarking/TEST-NET/multicast/
  reserved, v6 mapped-v4/0000::/8/NAT64/discard/2001::/23/documentation/6to4/
  ULA/link-local/multicast), the fake-ip DNS carve-out (an ALL-198.18.0.0/15
  answer is trusted on HTTPS only), per-hop redirect validation with a
  budget of 5, the streaming 2 MiB size cap (trips mid-stream, never
  buffers first), the 30 s whole-sweep timeout, and the
  `ClashforWindows/0.20.39` request headers.
- Credential hygiene: the stored envelope and every user-visible message use
  `redact_credentials`; the private raw URL goes to the OS credential store
  (`KeyringProfileSourceStore`), delete removes it,
  `profiles:get|set-source-url` remain the only private-URL APIs.
- Display name: Content-Disposition filename (RFC 5987 first) → final-URL
  filename (token-like segments rejected) → URL host → 远程订阅.
- Transport composition: `fetch_with_fallback` prefers the system-proxy-aware
  client and falls back to direct ONLY on a transport-level failure
  (`UPSTREAM_UNREACHABLE`); HTTP failures never retry across routes. The
  proxy client itself is wired by the 3D system-proxy slice; until then
  fetches go direct.
- `ProfilesService::import_from_url` / `update_from_source` port the TS
  composition byte-for-byte, including the rollback (a secure-store failure
  deletes the just-created import), the validate-before-write rule on
  update, and both Chinese error copies (没有远程订阅地址 / 缺少原始订阅地址).
- Un-staged: `profiles:import-from-url`, `profiles:update-from-source`
  (81/121 live invoke arms). Still staged on the network path:
  `profiles:get-provider-content` (3D).

### 11. Icons + network interfaces (`src-tauri/src/icons.rs`)

Fifth Phase 3B/3C slice — the three desktop-integration channels:

- `app:list-network-interfaces` ports the `os.networkInterfaces()` handler:
  interface names carrying at least one address, sanitized (non-empty,
  ≤255, no control characters) and sorted (84/121 live invoke arms).
- `app:get-cached-icon` ports `RemoteIconCache` verbatim: persistent
  stale-if-error cache keyed by SHA-256 of the semantic key (a refresh
  re-downloads and overwrites; a failed refresh keeps the cached value),
  HTTPS-only SSRF validation on every hop (public-IP allow-list with the
  icon-specific fake-ip DNS carve-out — no scheme gate needed because the
  scheme check is unconditional), ≤5 redirects, 12 s whole-sweep timeout,
  512 KiB cap, a seven-type image mime allow-list, base64 data-URL output,
  in-flight refresh dedup (a per-key `OnceCell` mirrors the TS promise
  map), and the LRU prune (256 files / 96 MiB, oldest mtime first). The
  URL itself never touches disk — only the hashed key and image bytes.
- `app:get-process-icon` ports the Windows shell-icon handler: local
  drive paths only (`^[a-zA-Z]:\` + `.exe`, ≤1024 chars) so renderer
  input can never make the shell resolve a UNC/SMB path, 512-entry LRU
  memory cache, real extraction via SHGetFileInfoW → GetDIBits → PNG
  behind `#[cfg(windows)]` (compile-gated; Windows verification is a
  deferred-to-CI item), null on every other platform and every failure —
  exactly the TS null contract (no channel ever throws here).
- All three return null/[] quietly on invalid input (no protocol errors),
  matching the Electron handlers.
- Un-staged: `app:get-process-icon`, `app:get-cached-icon`,
  `app:list-network-interfaces` — **84/121 live invoke arms**. Remaining 3C/3D:
  Sub-Store, internet-latency, mihomo stream-event un-staging, system
  proxy + TUN + privileged provider content (3D), tray/startup (4),
  updates (5).

### 12. INTERNET-latency sample (`src-tauri/src/{route_latency,internet_latency}.rs`)

Sixth Phase 3B/3C slice — the last staged mihomo channel:

- `route_latency.rs` ports `route-latency-service.ts` verbatim: the
  read-only default-gateway detection (Linux /proc/net/route row with
  destination `00000000` decoded little-endian; Windows `route print
  0.0.0.0` first active row; macOS `route -n get default`), and the
  first-hop RTT as a TCP connect handshake to the gateway itself (its DNS
  proxy on :53 first, then the admin UI on :80, 1.2 s timeout) — no raw
  packets, no host mutation.
- `internet_latency.rs` ports the service: `gatewayMs` from the gateway
  probe, `dnsMs` timed end-to-end around the kernel `/dns/query` NS probe
  (system-resolver UDP fallback on controller failure — a response or a
  definitive negative proves the round trip), `proxyMs`+`proxyNode` from
  the node selected by the first selectable group (Selector/URLTest/
  Fallback, GLOBAL skipped, DIRECT/REJECT placeholders skipped) in the
  ACTIVE profile's declared `proxy-groups` order. Every slot degrades
  independently to `null` — a degraded path renders as an em dash, never a
  fake number, never a card-wide error.
- Note: `mihomo:internet-latency` is un-staged as an invoke arm; the six
  event channels from slice 9 stay counted on the emit side, so the invoke
  total reads **84/121** with **37 staged** (six of them emit-live already)..

### 13. Egress metadata (`src-tauri/src/network_metadata.rs`)

Fourth Phase 3C slice — 5 channels un-staged:

- The shared model ports verbatim: three privacy-explicit providers
  (`ipwhois` / `ipapi` / `ipinfo`, display order, function-free wire shape,
  `kind: "ip-geo"`), per-provider parse (ipwhois `success!==false` +
  `connection.asn`; ipapi `status==="success"` + `query`/`as`; ipinfo
  `org`??`asn`), the `ASxxxx` normalizer, and the byte-verbatim Chinese
  copies (`查询失败，请重试` / `内核未运行，无法查询出口信息` /
  `数据源返回了无法解析的响应`).
- `NetworkMetadataService` ports the state machine: bounded in-memory cache
  (4 entries, 30min TTL, oldest-fetchedAt eviction), single-flight resolve,
  per-provider isolation in the whole-set sweep, `selectProvider` restoring
  a cached provider to ready / resetting an uncached one to idle. Nothing is
  persisted to disk.
- The mixed-port transport ports `fetchMetadataJsonViaProxy` verbatim: an
  absolute-form `GET` request line to `127.0.0.1:<mixed-port>` (Host header
  = the real target, `Connection: close`, Accept json), plain-http only,
  5s timeout, any transport/status/parse failure resolves null.
- The production composition reads the kernel supervisor phase (non-running
  fails closed with the kernel copy), then the LIVE controller `/configs`
  for `mixed-port` ?? `port` > 0 — exactly the TS `when-ready.ts` wiring.
- Un-staged `network-metadata:get-providers|get-state|select-provider|
  resolve|resolve-all` (**89/121 live invoke arms**, 32 fail-closed).

### 14. Common-service unlock probes (`src-tauri/src/unlock.rs`)

Fifth Phase 3C slice — the last 3C network channels, 2 un-staged:

- The ten pure detectors port verdict-for-verdict from
  `service-detectors.ts` (参考 clash-verge-rev 的解锁测试 crate): ChatGPT
  (compliance `unsupported_country` + trace region), Claude (loc= against
  the 10-country blocklist), Gemini (the `,2,1,200,"` payload marker →
  alpha-3 code vs the 9-entry list), Grok (homepage gate + trace; the
  declared-but-unused blocklist kept for parity), Netflix (fast.com CDN →
  403 ban → title gates 404/403/200/301 → stage-3 location 4th-segment
  pre-dash region), Disney+ (device-assertion → token-exchange → graphql
  countryCode/inSupportedLocation walk with the JP short-circuit), TikTok
  (keyword blocklist, trace region wins, homepage `region` marker
  pre-dash fallback), YouTube Premium (availability keywords + `GL`), GitHub
  (homepage gate + trace), Spotify (country-selector gate + market).
- Shared helpers are the Verge copies: `classifyBlockedStatus`
  (403/451 → unsupported, other non-2xx → error), `traceLocation` (loc=
  line, uppercased), `extractQuotedField` (first case-insensitive
  `"key":"value"` match).
- The transport ports the probe session: ONE reqwest client per service
  test (session-scoped cookie jar for the Disney+ flow), fixed
  `http://127.0.0.1:<mixed-port>` proxy, Chrome UA, redirect-following,
  8s per-request timeout, 1 MiB body cap; every transport failure
  degrades to `{status: null}` → the detector's `error` verdict.
- Fail-closed composition: the mixed port resolves from the LIVE
  controller `/configs` (`mixed-port` > 0); kernel down is the typed
  `UPSTREAM_UNREACHABLE::内核未运行，无法通过当前节点执行解锁测试。` — never a
  DIRECT sample. Unknown service names are the byte-verbatim TS
  `invalid unlock service: ...` INVALID_ARGUMENT copy.
- Un-staged `network:unlock-test-all|unlock-test-one` (**91/121 live
  invoke arms**, 30 fail-closed).

### 15. OS login-item state (`src-tauri/src/startup.rs`)

Sixth Phase 3C slice — 开机自启, 2 channels un-staged (Phase 4 prep, the
invoke surface first):

- The `ScheduledTaskStartupAdapter` ladder ports verbatim: per-user
  Scheduled Task via `schtasks /query|create|delete /tn io.murge.desktop`
  (the byte-verbatim logon-trigger XML with `Delay PT3S`, `Priority 3`,
  `LeastPrivilege`, `ExecutionTimeLimit PT0S`, UTF-16 BOM task file), the
  stable HKCU Run-key fallback written and verified directly, and the
  legacy plain-Run-value adapter behind it. A present task owns the
  registration; task creation denied degrades to the Run key, and the
  legacy entry is retired the moment the task owns registration.
- The service serializes operations (read-after-write ownership),
  reports divergence without pretending the requested value won
  (`系统未确认开机启动设置`), and fails closed `unsupported` off-Windows.
- `refreshRegistration` maintenance ports with its triggers: the one-shot
  non-blocking pass at shell startup (migrates v0.9.x Run-key users to the
  task, rewrites stale `--hidden` args) and the `app-settings:set` hook
  when `silentLaunch` moves.
- The runner is injectable (8s timeout, CREATE_NO_WINDOW, 1 MiB cap on the
  real `schtasks`/`reg` children), so the win32 ladder is exercised
  off-Windows exactly like the TS tests.
- Un-staged `startup:get-status|set-enabled` (**93/121 live invoke arms**,
  28 fail-closed).

### 16. Sub-Store lifecycle (`src-tauri/src/{substore,substore_zip}.rs`)

Seventh Phase 3C slice — 初步接入, 5 channels un-staged:

- The service ports the full lifecycle state machine: single-flight
  ensure (phases idle/starting/running/downloading/error), staged asset
  acquisition with SHA-256 digest pinning (default-tag digests must match
  the app-embedded values), atomic staged-commit with backup/rollback,
  generation-based operation cancellation, health polling (300ms cadence,
  20s budget), and proxy-mode restarts only on an actual flag change.
- The pinned defaults (tags `2.38.2`/`2.31.2`, sha256 digests, port base
  38324, GitHub API/download URLs) port byte-for-byte; every failure copy
  is the Chinese TS text (`GitHub 请求失败：…`, `下载失败：SHA-256 校验不匹配`,
  `Sub-Store 暂存资源不完整`, `没有可用的本地端口`, `Sub-Store 启动超时`, …).
- The worker runs the backend bundle as a fully-constructed-environment
  child process (`SUB_STORE_BACKEND_MERGE=1` on ONE loopback port — the
  same-origin decision; the env never inherits the host, proxy env appears
  only when `subStoreUseProxy` is on and the mixed port resolves).
- `substore_zip.rs` ports the narrow ZIP reader verbatim (EOCD scan,
  central-directory walk, stored+deflate only, CRC32 verify, absolute/`..`
  path rejection, single-top-level strip) with flate2 + crc32fast.
- The renderer-facing 5 channels: `substore:get-state` (snapshot mirrors
  the PERSISTED settings), `ensure-running`, `stop`, `check-update`,
  `open-external` (the TS `parseSubStoreExternalUrl` copy + the platform
  opener). The `app-settings:set` arm feeds `onSettings` on every change,
  and shell startup hydrates mirrors then prepares assets in the
  background when enabled (the TS when-ready hydration).
- Un-staged `substore:get-state|ensure-running|stop|check-update|
  open-external` (slice 16).

### 17. System proxy (`src-tauri/src/system_proxy.rs`)

First Phase 3D slice — 所有权感知系统代理, 6 channels un-staged:

- The full decision machine ports: strict policy helpers (`ProxyOverride`
  merge with insertion-ordered local-first dedup, exact-registry-type
  equality, pre-enable restorability validation, loopback target gate),
  the ownership state machine (single-flight serialization, staged
  enable with read-back verification, confirmed rollback on partial
  apply, conflict fail-closed on external takeover, strict restore with
  read-back verify + delete-on-success), the 30s guard
  (degradation repaired / takeover never fought), network down/up
  latching, init crash recovery, and the kernel-shutdown restore.
- The backup bundle schema ports strictly (literal schemaVersion 1,
  loopback-only target, offset-ISO createdAt, exact-key objects, registry
  triple consistency, safe-integer bounds) — a corrupt bundle fails
  closed and is never trusted to write back.
- The Windows adapter ports the `reg.exe` argv builders (per-type restore
  incl. `reg delete` for absent values) and the byte-for-byte PowerShell
  scripts (the .NET registry snapshot read with 3×75ms retries and the
  WinINet refresh); the runner is injectable so the argv/script layer is
  tested on Linux. Non-Windows production gets the disabled adapter and
  the `unsupported` phase — honest, never a fake write.
- The live probe composes kernel running → authenticated controller → a
  `/configs` mixed-port → parallel HTTP CONNECT + SOCKS5 greeting socket
  probes (the loopback-literal CONNECT, never an external dial), with the
  exact failure copies (`内核未运行，无法启用系统代理`, `内核混合端口未就绪（N）：…`).
- Renderer channels: `system-proxy:get-status|enable|disable|
  get-proxy-bypass|set-proxy-bypass|preview-proxy-bypass`; enable/disable
  are intent-first (`systemProxyDesired` persists before the registry
  work) and enable starts the kernel when it is not running. Status
  transitions forward to every renderer as `system-proxy:status-event`.
- Un-staged 6 channels (**104/121 live invoke arms**, 17 fail-closed; the
  remaining staged set is TUN (3) + updates (5) + the listen-side event
  channels).

### 18. TUN lifecycle (`src-tauri/src/tun.rs`)

Second Phase 3D slice — TUN 生命周期协调器, 3 channels un-staged:

- The state machine ports as a pure transition table (`configured →
  starting → active → restoring → …`, the conflict latch with the
  disable-only escape, the `restore-failed` enable retry, the
  unsupported phase) with the exact machine copies
  (`Invalid TUN transition: {phase} + {intent}` with TUN_INVALID_TRANSITION,
  `TUN conflict transition requires conflictDetail` with INVALID_ARGUMENT).
- The coordinator ports: serial renderer-independent serialization, the
  readiness generation fence (a disable/re-enable cycle invalidates late
  probe results; a probe failure warns with
  `TUN_DATA_PLANE_UNCONFIRMED` instead of tearing down a usable TUN),
  startup reconciliation of an interrupted transaction, emergency
  disable (before-quit / recovery CLI), host-exit reset, and the
  machine-code audit log (bounded 128KB/1000 entries, detail codes only —
  never secrets).
- The privileged mutation stays behind the injected `TunMutationAdapter`
  seam with the fail-closed `GatedTunMutationAdapter` — the SAME boundary
  this Electron build ships (`Windows TUN service transport is not
  available in this build`, TUN_IMPLEMENTATION_GATED) until the G1
  helper design review. Honest: no fake Wintun/routes/DNS calls.
- Renderer channels: `tun:get-status|enable|disable`; enable/disable are
  intent-first (`tunDesired` persists before the transition) and carry
  the standard intent (`{shortName} TUN`, mixed stack). Status
  transitions forward as `tun:status-event`, and the ordered-kernel-gate
  semantics land: `kernel:stop` now restores the owned system proxy
  BEFORE the shared core stops, and a supervisor `failed` phase triggers
  the system-proxy crash recovery.
- Un-staged 3 channels (**107/121 live invoke arms**, 14 fail-closed; the
  remaining set is updates (5) + the listen-side event channels).

### 19. Application updates (`src-tauri/src/updates.rs`)

Third Phase 3D slice — 应用更新状态机, 4 invoke channels un-staged:

- The `UpdateService` state machine ports completely: the driver seam
  (`configure/check/download/quit_and_install` + a normalized event
  stream), the in-flight coalescing (only `checking`/`downloading`
  refuse re-entry — a downloaded update is deliberately NOT terminal),
  the `downloadedBeforeCheck` restore semantics (a failed newer check
  keeps the old package installable, a sync driver failure is reduced
  into the same terminal `error` state), download only from
  `available`, install only when `canInstall`, and the mid-session
  feed polling (10 min cadence, first tick deferred, generation-gated
  stop).
- The exact unsupported copy is preserved byte-for-byte:
  `当前构建不支持自动更新（仅安装版可用）`. The production driver is the
  fail-closed `GatedUpdaterDriver` (`supported: false`) — this build has
  no update feed, and the service honestly reports that instead of
  pretending to update. `coerce_update_state` ports for renderer payload
  hardening.
- Renderer channels: `updates:get-state|check|download|install`; state
  transitions forward as `updates:state-event`.
- Un-staged 4 channels (**111/121 live invoke arms**; the remaining set
  is the listen-side event channels, which land with their
  emitter-side producers).

### 20. Event channels + provider-content gate alignment

Fourth Phase 3D slice — verification + the provider-content gate:

- **All 10 remaining staged channels are listen-side event channels, and
  every one already has a live emitter side in the Rust shell**:
  `mihomo:traffic|connections|log|stream-error-event` + the
  stream-error/kernel/kernel-manager hubs (events.rs `start_forwarding`),
  `system-proxy:status-event` / `tun:status-event` / `updates:state-event`
  (slice 17/18/19 wiring), and `app:navigate-event` — which has no Rust
  producer because its only producer is the window-adapter deep-link /
  notification path (the Phase 4 tray + window slice). They stay staged in
  the channel-count sense (no invoke arm exists for an emit-only channel)
  but are NOT missing implementations.
- `profiles:get-provider-content` now matches the exact Electron handler
  shape instead of a generic UNSUPPORTED: kind validation first
  (`INVALID_ARGUMENT::外部资源类型无效`), then the mihomo-name parse
  (`INVALID_ARGUMENT::name must be a non-empty string`), then the reader
  gate (`INTERNAL::当前运行方式不支持读取外部资源内容` — the same copy the
  Electron build surfaces when no service client is composed). The reader
  routes through the privileged Go service (named pipe), which lands with
  the real-kernel slice.

### 21. Pinned mihomo artifact pipeline (`src-tauri/src/mihomo_artifact.rs`)

Fifth Phase 3D slice — 内核工件管线 (the real-kernel spawn prerequisite):

- `resources/mihomo-assets.json` embeds at build time (`include_str!`) as
  the single source of truth: pinned `v1.19.30`, the official release
  base and the per-platform verified digests (win32 x64/arm64 zip,
  linux arm64 gz — the same catalog the Electron build pins).
- `download_and_verify_mihomo` ports the stream-and-hash contract: the
  reqwest transport follows redirects, refuses a content-length above
  `size + 64 KiB` before streaming, caps the body mid-stream and enforces
  the 120 s budget; the written archive is rejected with
  `ARTIFACT_HASH_MISMATCH` (exact copy, file removed) unless BOTH the
  SHA-256 and the byte size match the pinned values. A digest-matched
  but wrong-sized body fails the byte check — the archive is never
  extracted on any mismatch.
- `extract_mihomo` ports the extraction guards: gz via flate2, zip via
  the pinned Sub-Store reader (no shell-out, unlike the TS PowerShell
  fallback), the destination-escape check, symlink refusal, chmod 0755
  on non-Windows and the stable target rename (`mihomo`/`mihomo.exe`).
- Provenance ports: the atomic `.mihomo-verified` marker (tmp + rename)
  with strict shape; reuse re-hashes the on-disk binary every time, so a
  tampered, truncated, forged or cross-platform binary is quarantined
  (binary + marker removed) and re-resolved from a fresh verified
  archive.
- `build_mihomo_asset_from_release` ports the specific-version path:
  name match + upstream release digest/size, so a specific-version
  install is still verified to the byte.
- The supervisor keeps the DisabledKernelResolver gate until the spawn +
  controller-ready composition lands (the next slice); the pipeline
  module is complete and unit-tested standalone (like the Sub-Store zip
  reader in slice 16).

Sixth Phase 3D slice — 内核进程监督器 (the full `supervisor.ts` lifecycle
machine, previously a disabled stub):

- `kernel_process.rs` ports the injected-seam architecture:
  `KernelBinaryResolver` / `KernelConfigStore` / `KernelProcessAdapter` +
  `KernelProcessSink` / `KernelWatchdog` traits, with the Fake/Stub test
  harness mirroring `tests/kernel-supervisor.test.ts` (28 Rust cases,
  including the TS log-buffer byte-cap tests).
- Lifecycle parity: single serialized lifecycle queue (`withLifecycle`
  chain → tokio Mutex) so a stop submitted during an in-flight start waits;
  idempotent double-start; `KERNEL_RUNNING` refusal while a process is
  still tracked (survived-SIGKILL case); stale-pid handling before spawn;
  SIGTERM → bounded wait → SIGKILL → bounded wait ladder;
  never-reported-stopped survivor (pid + handle kept, config preserved for
  a later stop() retry); no-PID spawn → `KERNEL_SPAWN_FAILED` +
  `Kernel process did not report a PID.`; readiness marker on accumulated
  stdout (start-timeout copy exact) with the ORIGINAL error code preserved
  through the abort path (`KERNEL_CRASHED` on exit-during-start,
  `KERNEL_START_TIMEOUT`, resolver UNSUPPORTED pass-through); post-exit
  `exitWork` ordering (config cleanup → exit-wait release →
  stopped/failed + crash-restart schedule) so stop()/start() never finish
  while a secret-bearing workspace remains on disk; operational `error`
  events keep a live pid tracked (KERNEL_SPAWN_FAILED readiness reject)
  but clean up a dead one; crash restarts back off exponentially
  (250ms → 5s cap), respect the maxRestarts budget, are invalidated by a
  stop()/start() epoch bump, and refill after a sustained run
  (restartBudgetResetMs 60s); the rolling log honors both caps
  (256 KiB / 4000 entries); the crash-watchdog attach point is a
  `KernelDependencies` seam (Job-Object attach lands with the Windows
  production slice).
- Stores: `TempKernelConfigStore` (isolated `kernel-workspace-` temp dir,
  harmless fixture config, cleanup refuses outside-workspace) and
  `StrictMihomoConfigStore` (per-run `mihomo-workspace-` child, persistent
  kernel home `-d` never cleaned, `MIHOMO_PLATFORM`/`MIHOMO_ARCH` env,
  `-f config -d home` args, strict 64-hex secret gate with the TS copy,
  profile-document passthrough via `build_profile_kernel_config`).
  `generate_mihomo_config` ports the strict loopback-only YAML shape
  (port uniqueness + 64-hex secret + log-level allowlist) and
  `random_secret()` the CSPRNG 64-hex controller secret.
- Adapters: the real Unix `NodeKernelProcessAdapter` (tokio process,
  inherited-free env, pipe readers feeding the sink, SIGTERM/SIGKILL via
  libc, exit code/signal surfaced through the sink) unit-tested against
  `/bin/sh`; the `MihomoKernelBinaryResolver` resolves the pinned verified
  artifact via slice ㉑ (`resolve_mihomo`) behind an explicit
  `allow_real` gate plus the `内核已停用：…` enabled-gate copy.
- `KernelServices::new()` composes the disabled resolver by default
  (fail-closed UNSUPPORTED, unchanged wire behavior); `kernel:start` /
  `kernel:stop` / auto-start are now async. The `ControllerReadyKernelGateway`
  port also lands in this slice (the authenticated `/version` probe via
  `MihomoVersionProbe`/`VersionProbe`, 10 s deadline / 100 ms retry, the
  exact `mihomo process started but its authenticated loopback controller
  did not become ready.` KERNEL_START_TIMEOUT copy, half-ready stop
  pass-through) — it composes over the supervisor when the real-kernel
  wiring activates with the installer.
- Verify: `cargo test --lib` 334 passed / 0 failed / 0 warnings (28 new
  supervisor-lifecycle cases); channel audit unchanged 121 / 111 live /
  0 unmapped; `npm run typecheck` green; vitest 1905 passed / 7 skipped.

Seventh Phase 3D slice — 内核配置校验与门禁 (the `mihomo-config.ts` strict
schema + `profile-kernel-config.ts` structural gate + geodata seeding):

- `kernel_config_validation.rs` builds the YAML node tree from yaml-rust2's
  EVENT stream (duplicate pairs, aliases, explicit tags and missing values
  are preserved — the hash-based `YamlLoader` would silently swallow them)
  and then runs the TS-shaped walk with byte-identical copies:
  `unknown top-level key:` / `duplicate key: X` / `config must not use YAML
  aliases` / `key X uses a YAML tag, which is not allowed` /
  `top-level keys must be plain scalar strings` / the exact per-key
  port/boolean/mode/log-level/ipv6/controller/secret/ui checks (unprivileged
  1024–65535 range, `warn` not `warning`, core-schema scalar classification
  so quoted values never masquerade as numbers/booleans) and the nested
  tun/dns/rules allowlist. `validateMihomoConfigYaml` →
  `Unsafe mihomo config: …` INVALID_ARGUMENT; unresolved `*anchor` maps onto
  the same alias error the TS parser produces.
- `profileKernelConfigErrors` ports with the Chinese copies (配置文档为空 /
  YAML 解析错误 / 配置顶层必须是一个 YAML 映射 / 文档缺少 proxies、
  proxy-groups、proxy-providers 或 rules 段); top-level merge-key content is
  approximated for the content check (documented).
- `generateMihomoConfig` fixed to the TS contract: unprivileged port range
  with the `Invalid mixed-port: must be an unprivileged integer port between
  1024 and 65535, got N` copy, required ports (no defaults), the
  `Unsupported mihomo mode: X; Phase 7 requires 'direct'` gate and `warn`
  level.
- `StrictMihomoConfigStore` reworked to the TS `MihomoKernelConfigStore`
  ordering: secret → config document → schema validation BEFORE any
  directory exists (a bad secret or degenerate profile leaves no
  `mihomo-workspace-*` child), profile branch via
  `build_profile_kernel_config` gated by the profile errors
  (`配置文件构建失败：…`), owned-dir tracking so cleanup deletes ONLY the
  exact per-run child (never the stable kernel home), and
  `seedGeodataFiles` (five installer artifacts, fail-open, mtime-refresh,
  `MIHOMO_GEODATA_SEEDED` diagnostics).
- `sanitizeMihomoConfig` ports (secret line + stray 64-hex token redaction).
- Verify: `cargo test --lib` 369 passed / 0 failed / 0 warnings (32 new
  validation/gate/seed cases); channel audit unchanged 121 / 111 live /
  0 unmapped; typecheck green; vitest 1905 passed / 7 skipped.

Eighth Phase 3D slice — quit-lifecycle dispose hook (the Electron
`lifecycle-adapter.ts` dispose step that must never be skipped):

- `RunEvent::Exit` now terminates the Sub-Store worker SYNCHRONOUSLY
  (`start_kill` — the exit path cannot await a spawned task) under the same
  "dispose during app shutdown; assets persist" contract; `dispose()` also
  invalidates every in-flight generation so a raced ensure/update lands
  fail-closed.
- The ordered quit gateway (proxy restore BEFORE kernel stop, no-quit-on
  failed-restore) already runs through the `kernel:stop` arm and the
  failed-phase crash hook; TUN `handleHostExit` stays with the Phase 4
  lifecycle-adapter slice where it can be awaited ahead of process teardown
  (the gated adapter owns no device, so nothing is skipped today).

Ninth Phase 3D slice — live runtime-config layer (the
`main/kernel/live-config-reloader.ts` contract + the external-IP probe):

- `live_config.rs` ports the reloader verbatim: `reload_if_running` rebuilds
  the EXACT startup document (active profile → overrides → DNS → sniffer via
  `resolve_enhanced_document`, the strict direct config without one) and PUTs
  it to `/configs` WITHOUT `force=true` (mihomo keeps the bound listeners);
  it returns `false` (deferred) when the kernel is not running/starting.
  `patch_sections` applies `dns|sniffer|geodata` through the partial PATCH
  endpoint: geodata falls back to `build_geodata_block` PER KEY at the top
  level, dns/sniffer degrade to `{"enable":false}` when absent, the TUN
  dns-hijack is re-patched ONLY when the kernel runs TUN AND the list
  actually differs (an unchanged block can recreate the Windows adapter),
  and a DNS patch flushes both caches best-effort (`tokio::join!` over the
  two POSTs — `Promise.allSettled` parity). Mode is runtime intent folded
  into the SAME atomic reload (document branch only, direct/global only) —
  never a second PATCH that could fail after the new document committed.
- Dispatch wiring (TS parity): the dns/sniffer/geodata `:set` arms run the
  `EnhancementApplyCoordinator` semantics — persist → live-apply → on
  failure roll the model back to the previous value, re-apply the restored
  model best-effort, then rethrow. `core-settings:set` stays a PLAIN
  persist (the TS core gateway is NOT live-wrapped; a first-round wiring
  mistake was reverted before landing). `runtime:get-external-ip` now runs
  the REAL chain: phase must be exactly `running`, the port comes from the
  controller `/configs` (`mixed-port` ?? `port`), the probe is an
  absolute-form GET through the mixed port (plain http targets only,
  5 s default), and every failure degrades to `null` (`extract_ip` keeps
  the TS first-line-exact-quad-else-scan semantics, no octet-range check).
- Profile auto-reload gateway: the mutating `profiles:*` arms
  (import/import-from-url with the activate flag, activate, delete-of-
  active, edit-document with auto-activate, replace-document,
  update-from-source-when-active) hot-reload first via `reloadIfRunning`,
  then fall back to the ordered restart (`reloadKernelForActiveProfile`):
  the system proxy restores BEFORE the stop, is re-enabled only when it was
  owned before the restart, the document is restored BEFORE the pointer
  (restoreEdit order), delete-of-active keeps NO rollback, and the
  active profile's remembered node picks are replayed after a successful
  reload (`restore_selections`, best-effort).
- `RUNTIME_UPDATE` (a process-wide `tokio::sync::Mutex`): kernel start/stop
  and every runtime-config update are mutually exclusive — the
  `ModeTransitionController` serialization, staged at dispatcher level
  (the Phase 4 lifecycle adapter moves it into the kernel gateway).
- Verify: `cargo test --lib` 386 passed / 0 failed / 0 warnings (17
  reloader/probe cases + a dispatch-level rollback integration); channel
  audit unchanged 121 / 111 live / 0 unmapped; typecheck green; vitest
  1905 passed / 7 skipped.

Eleventh Phase 3D slice — TUN profile generators (the
`main/tun/mihomo-tun-config.ts` port, 750 lines):

- `tun_profile.rs` ports all four exports. The BOOTSTRAP profile
  (`generate_mihomo_tun_config` + strict `mihomo_tun_config_errors`) is the
  exact top-level-allowlist Phase-9B document: `mode: direct`,
  `MATCH,DIRECT`, controlled fake-ip DNS block with JSON-quoted filter
  entries (a bare `*` is an alias token), the device/stack/mtu/hijack/route
  folds from the persisted TUN model (the stock `Mihomo` device counts as
  "not customized" so the brand-derived `<shortName> TUN` intent wins), and
  self-validation before returning.
- The PROXIED profile (`generate_proxied_tun_config` +
  `proxied_tun_config_errors`) carries real subscription content:
  `build_profile_kernel_config` is REUSED verbatim (the same neutralization
  the main kernel gets), forbidden capabilities are STRIPPED not rejected
  (the service-side `forbiddenTopKeys` list in lockstep), unsafe provider
  `path`s are rewritten to deterministic contained locations
  (`./<section>/<safe-name>.<ext>`) instead of failing the subscription,
  literal proxy endpoint IPs are added to `route-exclude-address` (a tunnel
  cannot carry its own socket), `tun` is re-added on top of the transform
  that removed it, and DNS takeover follows clash-party's `controlDns=false`
  default: never force-enabled, port-53 hijacking CLEARED when no live DNS
  module can answer, fake-ip defaults filled only when the profile omitted
  them. Validation holds the NON-NEGOTIABLES the privileged service
  re-checks (no public bind, no unauthenticated controller surface, no
  alias/tag tricks, TUN on, the auto-route black-hole rule) and the 2 MiB
  service ceiling fails with the Chinese copy.
- `build_payload`'s staged TUN rejection is GONE: the live reloader now
  composes both TUN branches exactly like the TS (`tunEnabled` from the
  controller's reported tun state, proxied for profile documents,
  bootstrap without one); the privileged-service client that would SUBMIT
  them stays with the real-kernel slice.
- Verify: `cargo test --lib` 398 passed / 0 failed / 0 warnings (12
  generator/validator cases incl. hostile provider paths/names); channel
  audit unchanged; typecheck green; vitest unchanged.

Twelfth Phase 3D slice — TUN hot-switch adapter (the production mutation
path, `main/tun/hot-switch-adapter.ts` + `data-plane-readiness.ts` +
`documentDnsEnabled`):

- `tun_hot_switch.rs` ports `MihomoHotSwitchTunAdapter`: TUN switches on the
  ALREADY-RUNNING kernel through its loopback controller (no process stop,
  no listener rebind, the system-proxy target never changes). Enable =
  previous tun block ∪ rebuilt `build_tun_block` (the stock `Mihomo` device
  defers to the intent device) with `enable: true`; clash-party DNS-takeover
  parity clears `dns-hijack` when the FINAL active document (the same
  enhanced pipeline the kernel materializes) leaves the DNS module off —
  the authoritative flag comes from `resolve_enhanced_document`, never from
  the controller snapshot (GET /configs does not expose the dns block).
  The patch is CONFIRMED with a follow-up GET (`TUN_HOT_SWITCH_ENABLE_NOT_APPLIED`
  when it did not stick); a failed patch rolls the previous block back, and
  a failed rollback is the `TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED` machine
  code. Restore re-patches `enable: false` and reports
  `TUN_HOT_SWITCH_DISABLE_NOT_APPLIED` when the disable did not stick.
- `wait_for_tun_data_plane_ready` ports the probe: a responsive controller
  only proves the config parsed — one real DIRECT delay test through the
  regional endpoints (msftconnecttest + hicloud, ALTERNATIVES not a
  sequence, Promise.any parity) confirms the route; 150 ms retry inside the
  bounded 20 s window, then the exact `TUN data-plane readiness timed out`
  KERNEL_START_TIMEOUT copy. It runs in the BACKGROUND of a locally
  confirmed enable (diagnostics only — never a 20-second UI block or a
  false rollback on a restricted network).
- `document_dns_enabled` ports with the apply fail-safe (unparseable →
  disabled). The composition root now selects the adapter exactly like the
  TS (`tunSupported ? hotSwitch : Gated`): dev and non-Windows keep the
  fail-closed gate; the hot-switch path (controller REST only) is fully
  exercised against the mock controller.
- Verify: `cargo test --lib` 404 passed / 0 failed / 0 warnings (6 new
  hot-switch/readiness cases); channel audit unchanged 121 / 111 live /
  0 unmapped; typecheck green; vitest 1905 passed / 7 skipped.

Thirteenth Phase 3D slice — real-kernel composition (the TS
`when-ready.ts` supervisor three-way split + `ControllerReadyKernelGateway` +
strict-store live resolvers):

- `KernelServices` now composes by environment exactly like the TS build:
  dev resolves the harmless fixture (`FixtureKernelBinaryResolver` →
  `node src/main/testing/kernel-fixture.mjs`, `TempKernelConfigStore`, the
  `fixture-ready` stdout readiness marker, no ready gate); packaged Windows
  resolves the verified real mihomo artifact
  (`MihomoKernelBinaryResolver { allow_real: true, workspace:
  profileRoot/kernel }`, the strict `MihomoKernelConfigStore` shape with the
  runtime workspace child + persistent geodata home, live
  `resolveActiveDocument` / `resolveCore` / `resolveGeodata` closures read
  through managed state at start time); every other production environment
  stays fail-closed. The controller secret is seeded exactly once when a
  fresh install has none (when-ready.ts parity) and validated by the strict
  store before any directory exists.
- The controller-ready gate: production start additionally waits for the
  loopback controller's authenticated /version (10 s window / 100 ms retry,
  the TS defaults); a timeout stops the half-ready process and fails with
  the typed KERNEL_START_TIMEOUT copy. `kernel:start`,
  `system-proxy:enable`'s auto-start and the profile-reload restart fallback
  all route through the gate; stop passes straight through. Dev keeps the
  raw supervisor (the fixture reports readiness by stdout).
- The bundled-archive + version-selection resolver hooks landed with the
  transport seam: a missing installer bundle fails with the exact
  `Bundled mihomo archive is missing: {filename}` ARTIFACT_DOWNLOAD_FAILED
  copy, and the archive is still streamed/hashed by the verifier (never
  trusted for existing on disk). `version_selection`/`ensure_specific_binary`
  are wired as inert seams until the version-install slice flips
  `specific_versions_supported`.
- Watchdog release parity: the supervisor now releases (then drops) the
  crash watchdog on graceful stop and on process exit — the TS
  `watchdog?.release()` contract (a killed GUI must never leave the Job
  Object holding the released kernel either way).
- Verify: `cargo test --lib` 408 passed / 0 failed / 0 warnings (dev fixture
  start/stop to running when node is present; bad-secret fail-closed; ready
  gate passthroughs unchanged); build + test profiles both 0-warning;
  typecheck green; vitest 1905 passed / 7 skipped.

Fourteenth Phase 3D slice — version install (the `kernel-manager-service.ts`
install surface, un-staging the artifact pipeline):

- The GitHub release-metadata client lands (`githubRequest` port, 30 s
  bound, the exact timeout/failure/status error copies) and
  `specificVersionsSupported` flips to TRUE — the Tauri build has no
  Windows privileged service, so the TS service-mode gate never fires.
  The staged guards (`当前 Windows 服务模式…`) are gone.
- `listVersions` / `install` / `setChannel` / `setEnabled` are now async
  and port the full state machine: installing/versionsLoading transient
  flags with an emit before the await, tag-shape validation before any
  network work (`无效的版本号：…`), the
  `获取版本列表失败` fallback, per-version workspaces under
  `versions/<v>` with the `.mihomo-asset.json` sidecar cache (a later
  start reuses the same verified digest offline), the
  `未找到 {platform}/{arch} 的 mihomo {version} 资产` ARTIFACT_DOWNLOAD_FAILED
  copy, and channel persistence ONLY after the install succeeded.
- `applyInstalledKernelVersionFinal` ports as the manager's apply handler
  wired at composition: a live kernel restarts through the
  profile-reload coordinator (proxy restore before stop, the new
  `rollbackActive` option restoring the durable channel/version pair when
  the restart cannot be applied), then the applied version is VERIFIED —
  a mismatch rolls back, restarts on the previous selection and throws
  `内核版本未生效：请求 {v}，实际 {actual}` (ARTIFACT_HASH_MISMATCH).
  The apply runs inside the shared RUNTIME_UPDATE gate (the TS
  modeController serialization point, now hoisted to kernel.rs).
- The kernel resolver now routes `specific`+version, `preview` and `smart`
  through `ensureVersionBinary` — the same byte-level verification as the
  stable build, never trusting an on-disk file. `isEnabled` stays true.
- Verify: `cargo test --lib` 413 passed / 0 failed / 0 warnings (scripted
  GitHub seams throughout — no test touches the network; sidecar cache,
  rollback-on-apply-failure, missing-asset copy, resolver routing); build
  + test profiles 0-warning; typecheck green; vitest 1905 passed /
  7 skipped.

Fifteenth Phase 3D slice — bounded file logging (the `file-log-service.ts`
surface: application / kernel / Sub-Store daily logs):

- `shared/log-redaction.ts` ports verbatim as `redact_log_text` — the five
  ordered passes (Bearer/Basic, secret query keys via the `SENSITIVE_KEY`
  regex, secret `key: value` pairs, inline userinfo, fixed-width 64-hex
  controller secrets), case-insensitive like the TS `/gi`.
- `src/file_log.rs` is the `FileLogService` port: one file per kind per
  LOCAL day, lines rendered + capped at 64 KiB + redacted at ENQUEUE time
  (preserving call order), a single ordered consumer, the 10 MiB cap
  retaining the newest 50% around the incoming line plus the exact
  truncation marker, 7-day retention sweeping only `^(app|core|substore)-
  YYYY-MM-DD\.log$`, and the memoized-once failed initialize.
- The parity load-bearing detail: tokio's `fs::File` buffers completed
  `write_all` calls internally, so the consumer `shutdown()`s the handle
  BEFORE advancing the flush watermark — `flush()` (seq-tracked through a
  watch channel) resolves when the bytes are actually durable, matching the
  TS `await appendFile(...)`. A 300-round burst test locks the contract.
- Wiring mirrors `bootstrap.ts` / `when-ready.ts`: the startup
  `version/platform/arch` line (module `startup`), the kernel `/logs` tap
  (`logSink` -> `writeCore`, independent of who subscribes), and the
  Sub-Store worker stdout/stderr pipes -> `writeSubStore` (replacing the
  staged `Stdio::null()`; `on_log` is injectable for tests).
- Verify: `cargo test --lib` 426 passed / 0 failed / 1 ignored (the
  documented 85 s burst), 0 warnings both profiles, 20x full-suite sweep
  with zero flakes after the shutdown fix; typecheck + vitest unchanged.

Sixteenth Phase 3D slice — the quit lifecycle (`quit-guard.ts` +
`lifecycle-adapter.ts`, Phase 4's `runQuitFlow` port pulled forward):

- `src/lifecycle.rs` ports the before-quit decision verbatim:
  `run_quit_flow` (restore MUST confirm, or stop/dispose/quit never run and
  post-restore cleanup failures are swallowed — never blocking), the 3×
  250 ms bounded restore retry, and `restore_network_before_quit` (owned
  proxy restore BEFORE kernel stop, then TUN `emergency_disable`, all inside
  the shared `RUNTIME_UPDATE` gate).
- Tauri wiring: `RunEvent::ExitRequested` with `code: None` (user
  interaction / last window closed — the `window-all-closed` TS default) is
  prevented once, the one idempotent shutdown flow runs, and the real exit
  goes through `AppHandle::exit(0)` (re-entering `ExitRequested` with a
  code, which passes straight through). `RunEvent::Exit` stays as the
  synchronous residual dispose.
- The TS `waitForProfileOperations` maps to acquire-and-release of the
  `RUNTIME_UPDATE` gate (draining accepted dispatcher mutations WITHOUT
  holding the boundary — holding it across the flow would deadlock against
  the restore step's own acquisition). Each step re-acquires separately,
  matching the TS `runExclusive` sections.
- The dispose step covers Sub-Store worker termination, the update-service
  dispose, and the file-log shutdown marker + flush (`application shutdown
  completed`); tray/IPC/exit-monitor/intent-recovery dispose follows their
  own slices. `session_ending` keeps the TS parameter for the Windows
  CI slice (Tauri exposes no session-end event); the updater restart path
  must call the flow explicitly when that slice lands (Tauri restarts skip
  `code: None`).
- Verify: 5 new unit tests (restore-failed skips everything, confirmed
  order, cleanup errors never block, retry transient/permanent), 431 total,
  0 warnings, 15x sweep clean; typecheck + vitest unchanged.

### Dispatch surface

`desktop_ipc` now serves: `app:get-brand`, `app:get-info`,
`app-settings:get|set`, all 17 `profiles:*` channels (14 fully implemented;
`import-from-url`/`update-from-source` fail closed with UNSUPPORTED until the
Phase 3C network slice; `get-provider-content` until the Phase 3D privileged
slice), all 10 `overrides:*` channels (fully implemented except the JS
kind, which fails open per the staging note above), all 15 typed
model channels (`dns|sniffer|tun-config|core-settings|geodata-settings`
× `get|set|preview` — fully implemented), and all 4 `usage-history:*`
channels (`get-window`/`rank`/`clear`/`get-capacity` — fully implemented;
recording attaches with the kernel streams). Unknown channels keep failing
closed with UNSUPPORTED — never a silent no-op.

## Channel-coverage audit (against the Electron IPC surface)

Every string in the shared `src/shared/ipc.ts` IPC const was matched against
the Rust dispatch (mechanical scan, not a manual claim):

- **121 real channels** in the Electron surface (two earlier apparent extras
  were TypeScript type literals, not channels).
- **85 live** in the Rust dispatch: `app:get-brand|get-info`,
  `app-settings:get|set`, 14 of 17 `profiles:*`, all 10 `overrides:*`
  (JS kind fails open inside `validate`/`apply`), all 15 typed-model
  `get|set|preview` channels, all 4 `usage-history:*`, `kernel:get-status|
  start|stop`, `kernel-manager:get-state|set-enabled|set-channel|
  list-versions|install`, `runtime:get-summary|get-external-ip`, and 20 of
  23 `mihomo:*` (internet-latency + 2 stream events staged).
- **36 intentionally fail closed** with `PROTOCOL_ERROR:UNSUPPORTED` via the
  dispatch fallthrough, mapping exactly to the later phases: mihomo streams +
  internet-latency (3B/3D), subscription fetching +
  Sub-Store + icons + network-interfaces (3C), system-proxy + TUN lifecycle +
  privileged provider content (3D), startup + tray-adjacent (4), updates (5).
  No channel is silently dropped or no-ops.

## Verification (Linux ARM64, real execution)

- Rust: `cargo test` — **306 passed / 0 failed**, zero warnings:
  - brand parse/gate (1), app-info vocabulary (2), paths namespace/dev (3),
  - settings store: defaults, quarantine, atomic format, patch merge,
    delayTestUrl read/set split, dev memory store, field salvage (7),
  - dispatch: brand/info/settings round trip/profiles flow/staged-fail-closed/
    unknown/non-string args (6),
  - profiles repository: round trips, compact+ordered meta JSON, unique
    names, activate pointer, stale pointer, delete-clears-pointer, edit
    comment preservation + size update, insert-with-marker, empty-doc insert,
    id sanitize, URL redaction, memory source store, replace-from-source,
    torn meta skip, 0600 perms (14+),
  - validation: empty/duplicate-with-line/tab/flow/missing-keys/clean/
    warnings/error-copy (8),
  - parse: group order (document order, tolerant), provider catalog (both
    sections, camelCase `testUrl`, tolerant) (5),
  - redaction: userinfo/params/hex/short-hex/clean/malformed/free-text/
    is-redacted (8),
  - override model: coerce defaults, profile-scope id, redaction
    (userinfo/keys/case-insensitive/hex64/empty) (5),
  - override engine: scalar/object merge, append/prepend dedupe, fail-open
    item, unparseable base, staged JS, non-runnable items, order semantics,
    content validation, kernel-config gate, chain semantics, round-trip
    serialization, input validation (11),
  - override service: CRUD round trip + persisted format, missing/corrupt
    file, remove/setEnabled reindex, move semantics, unknown-id copy,
    preview unavailable/apply+redact, validate item errors / warnings,
    last-known-good capture + rollback, scoping via preview (11),
  - net validators: IPv4/IPv6/CIDR/hostname/domain-rule forms (4),
  - typed models: core defaults/coercion/port-swap migration/store round
    trip/preview conditionals (5), geodata defaults+URLs/block+preview/store
    (3), sniffer defaults/port tokens/block emission/store (4), TUN
    coercion/hijack forms/legacy-MTU migration/block+preview (4), DNS
    defaults/nameserver forms/respectRules guard/`normal` migration/block
    maps/preview redaction/store (7),
  - usage history: bucket coerce+bound, window aggregation (slot fill/
    fold/exclusion/totals), ranking (order/tie/limit/bad metric), capacity,
    store round trip (compact JSON + legacy count reset + corrupt file),
    stale-temp pruning, rate integration (first sample zero, back-dated
    guard), hourly rolls + bound, connection counting + clear, persist +
    reload, rank channel shape (10), dispatch: usage channels (1),
  - inspection: kernel-config forcing/stripping (3), core/geodata readback +
    panel (2), option rejections (1), DNS/sniffer apply merge + fail-open +
    disabled (2), inspection sections/notes/masking/empty (2), dispatch:
    inspect unavailable-without-profile + full composition (2),
  - kernel: supervisor start-fail/stop-idempotent (2), manager defaults/
    channel transitions/enabled delegation/staged list+install (4), runtime
    summary profile-or-default + external-ip null (2), dispatch: kernel
    channels + runtime summary (2),
  - mihomo: mock-controller request success/error/unreachable/delay (4),
    encodeURIComponent + argument validators (2), payload parsers (1), log
    buffer (2), selection store (1), group-url parser (1), member test
    NOT_FOUND/provider-url/404-fallthrough/nested-group (4), select+restore
    (2), dispatch: channels through mock controller (1), unreachable without
    kernel (1), group member test with profile url (1).
- TypeScript: `npm run typecheck` green; `npx vitest run` 1905 passed / 7
  skipped (unchanged — renderer untouched by this slice).

## Next (3A remainder)

overrides / DNS / sniffer / core / geodata / TUN-config persistence, usage
history + file logging, dialog/clipboard/open-directory equivalents — then
3B (controller + streams), 3C (downloads/Sub-Store), 3D (privileged core).
