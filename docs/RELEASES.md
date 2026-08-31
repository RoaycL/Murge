# Automated Windows release builds

Pushing a version tag creates a draft GitHub Release containing intentionally
unsigned Windows x64 and arm64 NSIS installers, deterministic release notes,
release evidence and `SHA256SUMS.txt`. Windows displays Unknown publisher.

1. Update `package.json` to the intended version and commit it.
2. Wait for the normal `main` CI workflow to pass.
3. Create and push the matching tag, for example `v0.1.0` for version `0.1.0`.
4. Open GitHub Releases and download/test the assets from the generated draft.
5. Complete `RELEASE_CANDIDATE_CHECKLIST.md`, including the N-1 upgrade matrix.
6. Review the explicit unsigned evidence, checksums and final screenshots before manually
   publishing the draft with explicit owner approval.

The workflow refuses a tag that does not exactly equal `v` plus the
`package.json` version. Re-running a draft build replaces its assets, but it
refuses to overwrite an already-published release. Packaging downloads and
SHA-256-verifies the pinned official mihomo archives for inclusion in the two
installers; it does not modify system proxy, TUN, DNS, routes or firewall
settings. The main CI job separately runs the installed x64 archive against the
loopback-only safe-direct configuration and proves cleanup.

The first RC supports x64. arm64 remains a test artifact until installed
lifecycle evidence exists on real Windows arm64 hardware. TUN and the other
excluded surfaces listed in `RELEASE_SCOPE.md` must remain hidden.
