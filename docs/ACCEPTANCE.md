# Framework acceptance criteria

## Current milestone

- [ ] Default development commands do not start a real kernel or mutate system networking.
- [ ] macOS system proxy and TUN implementations are absent or explicitly blocked.
- [ ] `npm install` completes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm run brand:check` passes.
- [ ] Development window opens at no less than 934×672.
- [ ] Default route is Activity.
- [ ] Activity geometry matches `UI_SPEC.md`.
- [ ] A 934×672 screenshot has been compared directly with `ui-reference/murge-ui-preview.html` and all deviations are documented.
- [ ] Overview switches are local visual prototypes only.
- [ ] Navigation placeholders render without errors.
- [ ] Renderer has no Node access.
- [ ] The kernel lifecycle remains visibly marked as unimplemented.
- [ ] API and handoff documents identify source references and uncertainty.

## Future runtime evidence

A command returning success is not enough. Runtime tasks must prove the relevant layer:

- Kernel: executable path, version, PID, controller listener and `/version`.
- System proxy: before/after OS settings and effective request route.
- TUN: service/driver state, route table, DNS path and a captured non-proxy-aware request.
- Profile switch: validation, active path/config and retained unsupported fields.
- Update: signature/checksum, version change, restart and rollback behavior.
