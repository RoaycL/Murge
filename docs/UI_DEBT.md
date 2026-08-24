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
