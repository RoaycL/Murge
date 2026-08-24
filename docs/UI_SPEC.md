# UI specification

## Normative visual reference

The owner-approved interactive reference is [`ui-reference/murge-ui-preview.html`](ui-reference/murge-ui-preview.html). It is part of the repository and is the primary authority for geometry, spacing, card composition, navigation hierarchy and visual state.

Implementation agents must open the relevant reference page before changing Vue or CSS. If this document, existing production UI and the reference differ visually, the reference wins unless the owner explicitly approves an exception. Do not invent replacement layouts or add decorative components.

## Reference boundary

The UI follows the observed information architecture, density, spacing and card proportions of the installed Surge for Mac interface. Do not copy vendor trademarks, icons, illustrations or proprietary text. Windows system controls, keyboard behavior and accessibility remain native to the target platform.

## Reference viewport

- Baseline content viewport: `934 × 672` CSS pixels.
- Sidebar: `205 px`.
- Main content lane: `729 px`.
- Dashboard content width: `709 px`.
- Minimum window: `934 × 672`.
- At larger sizes, preserve card dimensions and add breathing room; do not stretch charts into a different aspect ratio without a dedicated responsive design.

## Global layout

- Translucent cool-gray to faint-lilac application background.
- Fixed left navigation grouped as primary, client, proxy and HTTP tools.
- Selected navigation row: 38 px height, 9 px radius, quiet gray fill.
- Main page begins at x=210 relative to the reference window and y≈45.
- Page title: 28 px, compact line height, strong but not black-heavy weight.
- Card surface: 19 px radius, subtle translucent fill and low-elevation shadow.
- No visible application logo in the upper-left navigation region.

## Activity page

The Activity page is the default route.

### Header

- Title on the left.
- Compact status pills for system proxy and TUN on the right.
- Four runtime facts below: network, profile, outbound mode and external IP.

### Dashboard geometry

- Two columns, each 347 px wide, with a 15 px gap.
- Three 165–166 px rows with 15 px gaps.
- Left column: latency, active connections, total traffic.
- Right top: two equal upload/download cards.
- Right lower: one card spanning two rows for hourly traffic and ranking.

### Data behavior

- Live rates update at most once per second in the UI.
- Keep graph animation under 200 ms and disable it for reduced-motion users.
- Total counters use IEC/decimal units consistently; select one policy and test boundary values.
- Process ranking is derived from the latest connection snapshot and local aggregation, not from `/traffic` alone.
- Empty, connecting, disconnected and permission-denied states must keep the same geometry.

## Overview page

- Sections use a small magenta heading.
- Two cards per row, 337 px each, 15 px gap.
- Each card contains title, concise explanation, trailing switch and bottom status.
- A visual switch is never proof that an OS setting succeeded. Update it only after main-process verification.

## Navigation mapping

| UI page | mihomo/source capability | Framework state |
|---|---|---|
| Activity | `/traffic`, `/connections`, `/configs`, `/version` | Visual shell |
| Overview | `/configs`, Windows proxy service, TUN service | Visual shell |
| Processes | `/connections` aggregation | Visual shell |
| Devices | `/connections` source aggregation | Visual shell |
| Policies | `/proxies`, `/group` | Visual shell |
| Rules | `/rules`, `/providers/rules` | Visual shell |
| Capture | local connection event history | Visual shell; capability pending |
| Decrypt | no direct equivalent; feature decision required | Visual shell only |
| Rewrite | no direct equivalent; feature decision required | Visual shell only |

## Accessibility

- Full keyboard navigation and visible focus indicators.
- Minimum interactive target 32 px; 38 px for sidebar rows.
- Never encode alive/error state using color alone.
- Charts require accessible labels and a textual current value.
- Respect Windows high contrast and reduced motion.

## Visual review rule

For every page, capture at exactly 934×672 and compare it beside `ui-reference/murge-ui-preview.html`. A reviewer must approve geometry before live data integration changes the page. Every intentional difference must be documented in the pull request and approved by the owner.
