# Murge desktop framework

An Electron + Vue 3 framework for a Windows-first network client powered by a separately supervised mihomo process.

The project currently implements the Phase 1–7 application shell, typed IPC,
profiles, mihomo REST/WebSocket transport, Windows packaging, and an explicitly
user-triggered safe-direct kernel lifecycle. System proxy, TUN, DNS takeover,
automatic updates and service management are **not** implemented yet.

## Start the UI development build

```bash
npm install
npm run dev
```

Development uses an in-process loopback mock controller and a harmless fixture
process. It never starts real mihomo or changes system networking. Packaged
Windows builds also start stopped; the verified kernel is downloaded and run
only after the user presses “启动” in Overview, with a loopback-only
`MATCH,DIRECT` configuration.

## Handoff reading order

1. [`docs/DEVELOPMENT_SAFETY.md`](docs/DEVELOPMENT_SAFETY.md)
2. [`docs/ui-reference/murge-ui-preview.html`](docs/ui-reference/murge-ui-preview.html)
3. [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md)
4. [`docs/ROADMAP.md`](docs/ROADMAP.md)
5. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
6. [`docs/UI_SPEC.md`](docs/UI_SPEC.md)
7. [`docs/MIHOMO_API.md`](docs/MIHOMO_API.md)
8. [`docs/BRANDING.md`](docs/BRANDING.md)
9. [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)

> Safety gate: this Mac may be the owner's active remote connection. Do not start a real kernel or modify its proxy, TUN, DNS, routes, firewall or other network state. The complete mandatory rules are in `docs/DEVELOPMENT_SAFETY.md`.

## Project status

- Electron security defaults: implemented
- Vue router and application shell: implemented
- Activity and Overview UI: implemented; final cross-page pixel pass pending
- Typed renderer/preload/main IPC contract: implemented and runtime-validated
- Mihomo REST/WebSocket transport: implemented
- Kernel process supervisor: implemented; real Windows start is explicit only
- Profiles/subscriptions and stable production storage: implemented
- Windows x64/arm64 packaging and GitHub draft releases: implemented
- Windows system proxy and TUN: specification only
- Installer signing and update channel: not implemented

## Naming

The product name is not an architectural identifier. Rename the project through [`brand.config.json`](brand.config.json); see [`docs/BRANDING.md`](docs/BRANDING.md).

## Licensing note

Murge is free software licensed under the
[GNU General Public License version 3 only](LICENSE) (`GPL-3.0-only`). Tagged
release builds fail closed unless the complete root license and matching
`package.json` SPDX identifier are present. Third-party components remain under
their respective licenses; see [`resources/THIRD_PARTY_NOTICES.md`](resources/THIRD_PARTY_NOTICES.md).
