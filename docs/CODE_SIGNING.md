# Code Signing

This document describes the inputs and workflow for Windows and macOS code
signing so a release build can be produced reproducibly. It documents the
*shape* of the inputs and where they live in CI. It contains no secrets: no
certificate, no private key, no password.

## Why

Unsigned Windows binaries trigger SmartScreen "Unknown publisher" warnings and
are blocked on some enterprise policies. Signing with a code-signing certificate
lets Windows attest the publisher and integrity of the packaged application and
installer.

## Current status

- The application is **not yet signed**. No certificate is configured.
- The installer and executable are produced by `electron-builder`. Signing is
  applied at package time when a signing configuration is present.

## Electronic signing inputs

These values are required to sign a Windows build. They must be supplied as
environment variables at package time; they are **never** stored in the
repository.

| Variable                        | Body                          | Purpose                                            |
| ------------------------------- | ----------------------------- | -------------------------------------------------- |
| `WIN_CSC_LINK`                  | path or base64 of the `.pfx` | Certificate + private key bundle                   |
| `WIN_CSC_KEY_PASSWORD`          | password for the `.pfx`       | Unlocks the private key                             |

For certificate/file-signing scopes that require an external service, an
additional attestation credential is needed. The exact service and variable name
are an owner decision and are intentionally left unset here.

For macOS (not part of this phase but documented for symmetry):

| Variable        | Body                                   | Purpose                       |
| --------------- | -------------------------------------- | ----------------------------- |
| `CSC_LINK`      | `.p12` (Developer ID + private key)    | Sign the .app and `.dmg`      |
| `CSC_KEY_PASSWORD` | password for the `.p12`             | Unlocks the private key        |
| `APPLE_ID`      | Apple account email                     | Notarization                   |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password | Notarization      |
| `APPLE_TEAM_ID` | Team ID                                 | Notarization                   |

## Self-signing vs. trusted signing

A self-signed certificate only proves *who made the file* to the person who
installed that same certificate's root first. It does **not** make SmartScreen
trust the publisher. Self-signing can be useful for internal test builds but is
not a substitute for a certificate issued by a public CA (e.g. the trusted
Windows code-signing roots). A CI "smoke" job may sign with a self-signed cert
just to exercise the packaging path end-to-end; it must never be promoted as a
release signing artifact.

## Where signing is applied in this repo

- `electron-builder.config.mjs` is the single packaging configuration. It reads
  signing settings from the environment via electron-builder's built-in
  `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` handling; no certificate path is
  hardcoded.
- `.github/workflows/ci.yml` contains the `package-win` job. It does **not**
  contain secrets. In a real release, the signing secrets would be supplied as
  encrypted GitHub Actions secrets referenced by name, never inlined.

## Steps to produce a signed build (owner/operator)

1. Obtain a code-signing certificate and its password.
2. Store them as CI secrets or in the operator's environment (`.env`-style
   tooling must be gitignored).
3. Run the package step with those variables exported:
   ```sh
   WIN_CSC_LINK=/path/to/cert.pfx
   WIN_CSC_KEY_PASSWORD=***  # from the operator environment, never committed
   npm run package:win
   ```
4. Verify the signature on the artifact:
   ```sh
   powershell -Command "Get-AuthenticodeSignature .\dist\*.exe"
   ```

## Security rules

- Never commit a certificate, private key, or password.
- Never log a certificate or secret in CI output. CI secrets are masked by
  default; do not echo them.
- A `.pfx`/`.p12` is a secret. Treat it as such and rotate it if it ever leaves
  a controlled environment.

## Out of scope (owner decision)

- Choosing a certificate provider and the specific trust model.
- Configuring notarization for macOS.
- Auto-signed nightly builds — setting that up changes release policy and is
  deferred to the owner.
