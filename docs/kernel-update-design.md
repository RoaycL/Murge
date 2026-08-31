# Kernel update design

Status: design complete; implementation disabled until the owner selects a pinned channel.

## Decision

Murge does **not** call mihomo's `/upgrade` endpoint. Phase 9B's LocalSystem service owns the executable and must preserve its fixed-command, fixed-asset integrity boundary. Kernel releases are therefore selected by a Murge-maintained, signed release manifest and installed as part of an application release or a future narrowly scoped service operation.

## Manifest and trust

Each channel manifest is repository-owned and contains only:

- schema version, channel, mihomo version and minimum Murge version;
- exact platform/architecture, archive filename, archive inner filename, byte size and SHA-256;
- HTTPS source URL from the allowlisted MetaCubeX release origin;
- release timestamp and an offline release-signing-key signature over canonical JSON.

The public verification key is pinned in the application/service. Redirects to non-allowlisted origins, unknown fields, wrong architecture, digest mismatch, signature failure and version regression fail closed. Renderer input cannot add a channel or URL.

## Staging and activation

1. Download to an unprivileged staging directory with byte/time limits; never execute it there.
2. Verify manifest signature, archive size/hash and exact single expected inner executable.
3. Ask the service for status. An owned/running TUN child blocks activation.
4. The elevated service re-verifies the same manifest and archive, extracts into a new administrator-only version slot, hashes the core and atomically switches the selected slot.
5. Start a loopback-only `MATCH,DIRECT`, TUN/DNS-disabled validation process; authenticate `/version`; stop and confirm it.
6. Mark the slot healthy. The next real start uses only that immutable slot.

The service retains the previous healthy slot. A failed validation or failed first start atomically restores that slot. It never deletes the last known-good core. Garbage collection retains at least two healthy versions and runs only while no child is owned.

## Channel policy

- `stable`: owner-approved mihomo versions only; default once enabled.
- `beta`: explicit opt-in, never silently inherited from an application prerelease.
- `pinned`: no network check; the version bundled with the installed Murge release.

Until the owner chooses channels and supplies the manifest signing key, the UI reports `disabled`; the existing `resources/mihomo-assets.json` remains the sole build-time pinned catalog.

## Required evidence before enabling

Test wrong signer/hash/architecture, zip traversal/duplicate entries, interrupted download, disk-full atomicity, service/TUN ownership conflicts, crash at every slot-switch boundary, validation failure, first-start failure, downgrade refusal and successful rollback on Windows x64 and any selected arm64 release target.
