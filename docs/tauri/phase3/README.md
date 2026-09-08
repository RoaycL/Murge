# Phase 3A — Safe local state slices (in progress)

Status: **In progress** — two slices landed, the rest staged.

## Landed

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

### Dispatch surface

`desktop_ipc` now serves: `app:get-brand`, `app:get-info`,
`app-settings:get|set`, and all 17 `profiles:*` channels (13 fully
implemented; `import-from-url`/`update-from-source` fail closed with
UNSUPPORTED until the Phase 3C network slice; `get-provider-content` until
the Phase 3D privileged slice; `inspect-active-config` until the
effective-document composition slice). Unknown channels keep failing closed
with UNSUPPORTED — never a silent no-op.

## Verification (Linux ARM64, real execution)

- Rust: `cargo test` — **70 passed / 0 failed**, zero warnings:
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
    is-redacted (8).
- TypeScript: `npm run typecheck` green; `npx vitest run` 1905 passed / 7
  skipped (unchanged — renderer untouched by this slice).

## Next (3A remainder)

overrides / DNS / sniffer / core / geodata / TUN-config persistence, usage
history + file logging, dialog/clipboard/open-directory equivalents — then
3B (controller + streams), 3C (downloads/Sub-Store), 3D (privileged core).
