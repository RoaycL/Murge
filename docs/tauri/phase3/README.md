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
- **80 live** in the Rust dispatch: `app:get-brand|get-info`,
  `app-settings:get|set`, 14 of 17 `profiles:*`, all 10 `overrides:*`
  (JS kind fails open inside `validate`/`apply`), all 15 typed-model
  `get|set|preview` channels, all 4 `usage-history:*`, `kernel:get-status|
  start|stop`, `kernel-manager:get-state|set-enabled|set-channel|
  list-versions|install`, `runtime:get-summary|get-external-ip`, and 20 of
  23 `mihomo:*` (internet-latency + 2 stream events staged).
- **41 intentionally fail closed** with `PROTOCOL_ERROR:UNSUPPORTED` via the
  dispatch fallthrough, mapping exactly to the later phases: mihomo streams +
  internet-latency (3B/3D), subscription fetching +
  Sub-Store + icons + network-interfaces (3C), system-proxy + TUN lifecycle +
  privileged provider content (3D), startup + tray-adjacent (4), updates (5).
  No channel is silently dropped or no-ops.

## Verification (Linux ARM64, real execution)

- Rust: `cargo test` — **183 passed / 0 failed**, zero warnings:
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
