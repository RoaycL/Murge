## Summary

<!-- One-line description of what this change does and why. -->

## Scope

<!-- Check every area this PR touches. -->

- [ ] Contracts / IPC surface
- [ ] Main-process services
- [ ] Renderer UI
- [ ] Runtime schema validation
- [ ] Tests / test infrastructure
- [ ] CI / tooling
- [ ] Docs / roadmap

## Changed contracts

<!-- List every IPC channel, shared type, schema or error code added/renamed/removed.
     Note any message-shape or behavior changes that affect other surfaces. -->

- ...

## Test commands & results

<!-- Paste the exact commands run and their results. -->

```bash
npm run brand:check
npm run typecheck
npm test
npm run build
```

## Runtime evidence

<!-- Prove the change runs against a real (or mocked) environment.
     Unsplash-license or fixture-based evidence is fine; state what was used.
     Do not mutate the host machine's network state on a dev box. -->

- [ ] I exercised the affected path and observed the expected result
- [ ] Evidence: (screenshot / log / test output)

## UI verification

<!-- If this changes any rendered view, attach a screenshot. -->

- [ ] Screenshot attached at the minimum window size (`934x672`), when applicable

## Security & safety

- [ ] Inputs from the renderer are validated before reaching a service
- [ ] No host network/TUN/DNS/system-proxy mutation outside a controlled target
- [ ] No secrets committed

## Checklist

- [ ] Added/updated unit tests
- [ ] CI passes on a clean checkout
- [ ] Brand-neutral source (no hard-coded product name in source files)
