# Development machine network safety

## Current machine restriction

The current development machine is a Mac that the owner may be using through a remote connection. Losing its network path could lock the owner out.

Until the owner explicitly removes this restriction in writing, every human or AI contributor must follow these rules on this machine.

## Prohibited actions

- Do not start a real mihomo process.
- Do not enable or change the macOS system proxy.
- Do not enable TUN or install a network extension, driver, daemon or privileged helper.
- Do not change DNS, routes, interfaces, packet filters, firewall rules or forwarding settings.
- Do not load or test the owner's real subscriptions, nodes, credentials or active proxy configuration.
- Do not run integration tests that bind proxy ports or attempt transparent traffic capture.
- Do not add an automatic startup path that launches the real kernel during application development.

This prohibition applies even when a task says to “finish,” “verify,” “run the app,” or “test end to end.” Those phrases do not authorize network mutation on this Mac.

## Allowed work

- Develop and review renderer UI with deterministic fixture data.
- Run type checks, builds, linting and unit tests.
- Test IPC contracts using mocks.
- Develop `KernelSupervisor` against a harmless fixture process that does not open network listeners.
- Test the mihomo client against an in-process mock HTTP/WebSocket server bound only for the duration of a scoped test, provided it does not change system networking or proxy settings.
- Write Windows-specific system proxy and TUN code without executing it on this Mac.
- Produce Windows test plans and CI jobs for later execution on a disposable Windows environment.

## Required implementation guards

- Real kernel startup must remain opt-in and disabled by default in development builds.
- macOS implementations of system proxy and TUN services must return an explicit unsupported/blocked result in this project milestone.
- Network-mutating services must be injected behind interfaces so tests use fakes.
- No module may perform network mutation at import time, application startup or renderer mount.
- Any future integration test requiring a real kernel, proxy, TUN, DNS or route change must be tagged and excluded from default test commands.

## Future authorization

Real network integration testing requires all of the following:

1. Explicit owner approval for the exact test and machine.
2. A rollback plan that has been reviewed before the test.
3. An independent recovery path that does not depend on the network being modified.
4. Before/after evidence for settings, process, listener, route and DNS state.

Absent all four conditions, stop and use mocks.
