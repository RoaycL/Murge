# Murge desktop framework

An Electron + Vue 3 framework for a Windows-first network client powered by a separately supervised mihomo process.

This milestone intentionally contains the application shell, visual language, typed IPC boundaries, mihomo HTTP client foundation and implementation specifications. It does **not** claim production-ready proxy, TUN, update or service-management behavior.

## Start the UI development build

```bash
npm install
npm run dev
```

The default Activity page uses deterministic fixture values so visual work does not depend on a running kernel. Set `MURGE_DEV_CONTROLLER` and `MURGE_DEV_SECRET` only while an implementation agent is wiring real data.

## Handoff reading order

1. [`docs/DEVELOPMENT_SAFETY.md`](docs/DEVELOPMENT_SAFETY.md)
2. [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md)
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
4. [`docs/UI_SPEC.md`](docs/UI_SPEC.md)
5. [`docs/MIHOMO_API.md`](docs/MIHOMO_API.md)
6. [`docs/BRANDING.md`](docs/BRANDING.md)
7. [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)

> Safety gate: this Mac may be the owner's active remote connection. Do not start a real kernel or modify its proxy, TUN, DNS, routes, firewall or other network state. The complete mandatory rules are in `docs/DEVELOPMENT_SAFETY.md`.

## Project status

- Electron security defaults: scaffolded
- Vue router and application shell: scaffolded
- Activity and Overview reference UI: scaffolded
- Typed renderer/preload/main IPC contract: scaffolded
- Basic mihomo REST client: scaffolded
- Kernel process supervisor: interface only
- WebSocket streams: specification only
- Windows system proxy and TUN: specification only
- Installer signing and update channel: not implemented

## Naming

The product name is not an architectural identifier. Rename the project through [`brand.config.json`](brand.config.json); see [`docs/BRANDING.md`](docs/BRANDING.md).

## Licensing note

The application license has intentionally not been selected in this framework milestone. The bundled or distributed mihomo binary is GPL-3.0 licensed and must be accompanied by the notices and corresponding-source access required by that license. Obtain project-owner approval before adding a repository license or publishing binary releases.
