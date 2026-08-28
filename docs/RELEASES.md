# Automated Windows release builds

Pushing a version tag creates a draft GitHub Release containing the Windows x64
and arm64 NSIS installers plus `SHA256SUMS.txt`.

1. Update `package.json` to the intended version and commit it.
2. Wait for the normal `main` CI workflow to pass.
3. Create and push the matching tag, for example `v0.1.0` for version `0.1.0`.
4. Open GitHub Releases and download/test the assets from the generated draft.
5. Review the GPL-3.0-only license asset, signing status, checksums and final
   release notes before manually publishing the draft.

The workflow refuses a tag that does not exactly equal `v` plus the
`package.json` version. Re-running a draft build replaces its assets, but it
refuses to overwrite an already-published release. It never downloads or starts
mihomo and does not modify system proxy, TUN, DNS, routes or firewall settings.
