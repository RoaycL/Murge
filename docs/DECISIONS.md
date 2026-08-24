# Architecture decisions

## ADR-001: Electron + Vue 3

Status: accepted by project owner.

The UI must be developed and previewed on macOS while targeting Windows. Electron provides a consistent renderer and native main-process boundary. The cost is higher memory usage than WinUI; the framework mitigates this by bounding telemetry history and keeping one upstream WebSocket per stream.

## ADR-002: mihomo is a supervised external process

Status: accepted for framework design.

The GUI does not embed or fork the kernel. It supervises a separately packaged executable and communicates through the documented controller API. This creates a clear upgrade, logging and failure boundary.

## ADR-003: brand config is data

Status: accepted by project owner.

Product identity is loaded from `brand.config.json`. Internal modules use neutral names. Installer config reads the same source so a rename is not a source-tree rewrite.

## ADR-004: reference-size-first UI

Status: accepted for the development milestone.

The approved UI is reviewed at 934×672. Responsive expansion comes later and may not change reference geometry without explicit approval.
