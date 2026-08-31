# Application update design

Status: design complete; implementation disabled until the owner selects a signing provider and release channel.

## Security boundary

- Windows updates use the existing per-machine NSIS target and `electron-updater`; no renderer-controlled feed URL, headers, file path or installer arguments are accepted.
- Production update metadata and every installer are published only by the release workflow. HTTPS is transport, not trust: metadata SHA-512 and Windows Authenticode publisher verification are both mandatory.
- `win.verifyUpdateCodeSignature` remains enabled. The owner-supplied publisher allowlist is embedded at build time; certificate rotation temporarily allows the old and new subjects.
- Unsigned CI artifacts never enter an update feed. A missing/invalid signature, checksum mismatch, version regression or malformed metadata is a terminal, visible failure with no install attempt.
- Updates are manual: check and download require explicit user actions; installation uses the updater's manual mode only after Murge confirms TUN, system proxy and mihomo are stopped. Shutdown/logoff never starts an installer.

## State machine

`disabled -> idle -> checking -> available -> downloading -> downloaded -> installing`

Every active state may enter `failed`; cancel returns to `idle`. The renderer receives verified state only and cannot select a URL or local executable. `allowDowngrade` is false in normal operation.

## Install and rollback

1. Record the running version and update metadata without credentials.
2. Run the existing ordered network shutdown. Any unconfirmed TUN/service/proxy cleanup blocks installation.
3. Revalidate the cached installer's metadata checksum and Authenticode publisher immediately before install.
4. Invoke the per-machine NSIS installer. Existing install hooks upgrade the LocalSystem TUN service fail-closed.
5. On first launch, run storage migrations transactionally and write a version-health marker only after main/preload/renderer IPC and service status checks pass.
6. If startup health fails, recovery instructions offer the previous signed installer. Automated downgrade is deliberately excluded until a tested A/B app installation mechanism exists.

Rollback releases always increment the public version and contain the reverted code; they are not lower-version downgrades. Release metadata retains at least the current and previous signed installers plus checksums and source archives.

## Required evidence before enabling

- Owner selects stable/beta feeds and the Windows signing provider/publisher names.
- Clean install, N-1 upgrade, interrupted download, corrupt metadata, wrong signer, service-stop failure and rollback-release matrices pass on disposable Windows VMs.
- Update never enables TUN, proxy or kernel; app data survives; diagnostics contain no feed credentials.

References: electron-builder's NSIS updater validates modern update metadata and Windows code signatures; manual installation avoids session-end installer races.
