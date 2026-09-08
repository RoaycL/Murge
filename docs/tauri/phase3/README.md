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

## Verification (Linux ARM64, real execution)

- Rust: `cargo test` — **150 passed / 0 failed**, zero warnings:
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
    inspect unavailable-without-profile + full composition (2).
- TypeScript: `npm run typecheck` green; `npx vitest run` 1905 passed / 7
  skipped (unchanged — renderer untouched by this slice).

## Next (3A remainder)

overrides / DNS / sniffer / core / geodata / TUN-config persistence, usage
history + file logging, dialog/clipboard/open-directory equivalents — then
3B (controller + streams), 3C (downloads/Sub-Store), 3D (privileged core).
