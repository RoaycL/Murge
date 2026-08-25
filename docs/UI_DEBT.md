# UI debt log

Deferred visual issues, to be resolved in the unified visual-acceptance phase
(the final pixel-alignment pass using the normative 934×672 reference and a
shared capture environment). Do NOT fix these items in feature phases.

> Ownership was accepted on the Activity milestone (commit `36572ee`) on the
> understanding that the items below are recorded and deferred, not dropped.

## UI-DEBT-001 — Total-card ratio bar whitespace

The 总计 card's ratio bar uses a `grid` with fixed `fr` column tracks
(`grid-template-columns: 68fr 32fr`) *and* each child also declares its own
percentage width. The two width models stack, producing a visible blank gap
between the DIRECT and 代理 segments (and/or clipping at the trailing edge).

- Where: `.total-bar` in `src/renderer/src/styles/base.css`; the two segment
  children in the 总计 card.
- Fix (deferred): pick ONE width model. Either keep the `grid` columns and drop
  the children's percentage widths, or drop the `grid` and rely on the
  children's percentages inside a flex row. Do not carry both.
- Do not treat the current 68/32 split as final.

## UI-DEBT-002 — "今日" is not a cumulative statistic

The 今日 / 总计 figure currently derives from the *active-connection* summary
(`connections.summary.directDownload + proxyDownload`), which is a live
snapshot, not a true cumulative categorized total.

- Do NOT expose this as a stable shared contract.
- Do NOT reuse it as the source for 总计 on other pages.
- It is a provisional display value only for the Activity page. When real
  cumulative per-category data lands, replace the source and drop this
  provisional one.

## UI-DEBT-003 — Activity vs reference ~3–11px drift

The Activity page is still ~3–11px off the normative reference in position and
width (notably the title/runtime-context strip is ~5px wider because of the
695px content-box vs the reference's 690 + padding; the total-bar and dashboard
margins differ by a few px).

- Final acceptance MUST use the same 934×672 capture environment and compare
  RAW pixels (impl vs reference).
- Do NOT substitute normalized proportions/ratios for acceptance. Normalized
  comparison is fine as a diagnostic, never as the accept gate.

## UI-DEBT-004 — Activity latency card and hourly bars are still hardcoded

Phase 3 wired the Activity speed cards, active-connection counts, process/domain
ranking and the 总计 breakdown to live mock IPC data, but three regions of
`src/renderer/src/views/ActivityView.vue` are still static placeholders:

- The INTERNET latency card (`6 ms`, `路由 ≤1 ms`, `DNS 11 ms`,
  `Hong Kong 01 73 ms`) — hardcoded in the template.
- The hourly-traffic bar chart (`const bars = [...]`) — a fixed literal array.
- The "1 DHCP 设备" figure in the connections card.

These are intentionally deferred, not wired, because the data does not come from
the P0 streams already integrated:

- Real latency requires a routing/DNS probe plus a selected-node delay
  (`/proxies/:name/delay`, and a diagnostic path for route/DNS) — see the P2
  `/dns/query` capability in `MIHOMO_API.md`.
- A truthful hourly series requires the app to persist sampled traffic deltas
  over time (the `/traffic` stream only yields instantaneous rate + cumulative
  totals), which is the same durable-history gap called out in UI-DEBT-002.

Constraints until then:

- Do NOT present these three regions as live data or reuse them as a shared
  contract. They exist only to hold the 934×672 geometry stable.
- When the latency probe and durable traffic history land, replace the
  hardcoded values and add the disconnected/empty states for these two cards
  (the connections card already switches on `connStatus`).

## UI-DEBT-005 — Configuration & provider-setting pages are functional-only

Phase 5 added `ConfigView.vue` (profile list / activate / rename / delete / import)
and `ProviderSettingsView.vue` (mode + mixed-port scalar editing) using the shared
tokens and the generic `.import-card` / `.field` / `.profile-row` styles. They are
wired to the profile gateway and pass the Phase 5 exit criteria, but they were NOT
pixel-tuned against the 934×672 reference:

- Inputs, buttons and row spacing reuse the provisional `.import-card` idiom
  rather than the page-specific geometry used by the Activity/Policy pages.
- No dedicated empty/error artwork; they fall back to the generic `.empty-state`.
- The profile list has no per-profile detail drawer/editor yet; editing is
  scalar-only for `mode` and `mixed-port`, everything else is preserved verbatim.

**Development machine note (mkdtemp semantics):**  
The profile root directory is created via `mkdtemp` at application startup
(`src/main/index.ts:113`). This means:
- A fresh temp directory is created each launch; old profiles are orphaned in
  system temp and never seen again by the app.
- Profiles do NOT persist across restarts on this development Mac.
- This is intentional for safety (no real mihomo process, no network mutation),
  but is easily misread as "restores from the same directory after a restart".

Defer the visual pass to the unified visual-acceptance phase. Functional behavior
must not be reworked for layout reasons.

## UI-DEBT-006 — Profile storage uses mkdtemp (ephemeral per-launch)

Phase 5 stores profiles in a `mkdtemp` directory under `/tmp` (`index.ts:113`).
This means:

- Each application launch creates a fresh profile directory; old profiles are
  orphaned in system temp and never recovered on restart.
- The ephemeral store is intentional for development safety (no persistent
  credential exposure), but it contradicts user expectations of "profiles survive
  restart".
- On production Windows builds, this must be replaced with a stable app-data
  path (e.g., `%LOCALAPPDATA%\Murge\profiles`) so profiles persist across
  launches.

Until then, treat Phase 5 as mock-only: profiles exist only within a single
session. Document this clearly in the UI if users ask where their profiles go.

## UI-DEBT-007 — Subscription refresh is deferred (credentials are not stored)

Phase 5 persists only the REDACTED subscription URL (`ProfileSubscription.url`),
in both the profile metadata and anything the renderer receives. Credentials are
never written to disk or sent to the renderer — this is required by the Phase 5
exit criterion "logs never contain subscription credentials".

A direct consequence: there is no stored secret to re-fetch with, so
"refresh subscription" cannot be implemented purely from the persisted metadata.

Deferred to a later phase (alongside durable storage, UI-DEBT-006):

- A secure secret store (e.g. Electron `safeStorage`) that holds the full
  credential-bearing URL encrypted at rest, keyed by profile id.
- A refresh action that asks the main process to re-fetch using that stored
  secret and re-import, without the credential ever crossing IPC.

Until then:

- Treat "refresh subscription" as a not-yet-available feature.
- Re-importing from the original URL remains the supported way to update content.
- Do NOT reintroduce a credential-bearing field on `ProfileSubscription` to work
  around this; that would reopen the plaintext-at-rest leak.
