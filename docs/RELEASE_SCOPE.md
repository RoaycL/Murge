# First release-candidate scope

This file freezes the public feature surface for the first Windows release
candidate. The application is GPL-3.0-only. Windows x64 is the verified target;
Windows arm64 may be packaged for testing but is not a supported release target
until its installed lifecycle is exercised on real arm64 hardware.

## Included

- Explicit mihomo kernel start/stop with a loopback-only authenticated controller.
- Profile import, validation, activation, rename, removal and supported edits.
- Activity, connections, process/device grouping, policies, providers and rules.
- Verified Windows system-proxy enable, restore, crash recovery and uninstall recovery.
- Logs, DNS query/cache tools, appearance, start-on-login, tray, About and a
  privacy-safe diagnostics export.

## Excluded and hidden

- TUN: the G1 reuse and real route/DNS recovery gate is not proven.
- HTTP capture, HTTPS decryption and rewrite: the former visual placeholder
  source files were removed because there is no completed backend or security lifecycle.
- Panel: its former placeholder source was removed.
- Automatic application/kernel updates: signer, update channel and update keys
  are not configured.
- LAN listener controls: the release remains loopback-only.

Excluded features must not appear in navigation, settings, Overview, or as
directly reachable hash routes. `src/shared/release-scope.ts` is the executable
allowlist and `tests/release-scope.test.ts` prevents those pages from returning
accidentally, including an assertion that the removed placeholder source files
do not return.

## Release gates still requiring owner or Windows evidence

- Trusted Authenticode signing of the installer, app executable and privileged service.
- Clean x64 VM install/upgrade/uninstall matrix using the actual RC artifacts.
- Tray, login-start and forced-process recovery evidence on Windows.
- Final 934×672 screenshot approval.
- Explicit owner confirmation before a draft GitHub Release is published.
