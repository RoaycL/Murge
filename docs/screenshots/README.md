# Phase 3 — Activity, implementation vs. normative reference

Both captures below are **934 × 672** content-viewport screenshots (Electron `useContentSize`);
`docs/ui-reference/murge-ui-preview.html` is the owner-approved normative reference.

> Screenshots were produced headlessly (Xvfb :99) from the `electron-vite` production build
> (`out/renderer/index.html`) with an injected `window.desktop` feeding mock-shaped live data so the
> Activity view exercises its live stream at the reference canvas size. The harness lives outside the
> repository (`/tmp/murge-shots/`) and is **not** part of the shipped app. The shipped app in dev wires
> the in-process mock server (`src/main/testing/mock-mihomo-server.ts`); in production it talks to the
> real controller.

Open `activity-comparison.html` for the two captures side by side.

| Capture | File |
| --- | --- |
| Implementation | `activity-impl-934x672.png` |
| Normative reference | `activity-ref-934x672.png` |

## Data source changed (fixture → live mock stream)

| Element | Before (fixture) | Now (live/mock) |
| --- | --- | --- |
| 活动连接 total | fixed 120 | live snapshot count (5 from mock) |
| 总计 (down+up) | fixed "2.3 MB" style | live `totalDownload` via `formatBytesParts` ("8.1 MB") |
| 速率 | fixed numbers | live `traffic.current.up/down` via `formatRate`, framed 1/s |
| 排名 (top processes) | hard-coded rows | aggregated from `connections` snapshot (5 rows: Browser … Desktop) |
| DIRECT / proxy | fixed split | computed from snapshot `chains` (DIRECT vs proxy) |
| 延迟 | static "6ms" | static "6ms" (no live latency endpoint in scope) |

The rank row **counts and widths** now come from the mock aggregation; the reference used representative
fixtures, so the numbers/total differ but the layout density is preserved (the list still fills the same
rows, downloads now formatted compactly).

## Added within the reference geometry (no size/position change)

Resilient stream states were added without shifting the fixed grid:

- `traffic/connections` stores expose `loading | live | disconnected | error`; the Activity view shows a
  small dot + label (`.stream-state`) only in non-live states. In the healthy live state (as captured)
  **no** indicator is drawn, so the geometry is identical to the reference. Confirmed by capture probe:
  `streamState: null` while live.
- On disconnect/error the dot is amber/red via scoped classes (`.online-dot.pending` / `.online-dot.offline`);
  labels "载入中 / 已断开 / 数据异常".
- Header pills dim (`pill-dim`) when `systemProxyEnabled` / `tunEnabled` are false.

## Intentional deviations to be owner-approved

1. **Resilient stream-state indicators** (dot + label) are new affordances the reference does not draw.
   They render only on non-live states, so the reference-state (healthy) pixel geometry is unchanged.
2. **Live totals & rank density** — fixture values replaced by mock-derived values; sizes, counts and the
   DIRECT/proxy split change by data, not by geometry.

## Verification

- `npm run build` (brand:check + typecheck + electron-vite build) → exit 0.
- `vitest` → 121 passing (includes `tests/mihomo-service.test.ts`, `tests/stores.test.ts` for the live
  forwarding and stream-error mapping).
- Capture confirmed (DOM probe while live): route `#/activity`, `.dashboard-grid` present, 2 `.speed-card`
  sparklines with real `d` paths (10-point series), 5 `.rank-row`, 活动连接 = 5, 总计 = 8.1 MB.

## Note on visual review

This session's model has no image input, so the two PNGs were verified structurally (content size 934×672,
non-trivial rendered size, DOM probe above) rather than by eyeballing pixels. Please open the two PNGs and
approve the deviations above before merging.
