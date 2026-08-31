# Release-candidate checklist

Record evidence against the immutable tag and SHA. A green build from another
commit is not release evidence.

## Build identity and licensing

- [ ] Tag exactly matches `package.json` version.
- [ ] `npm ci`, brand check, license check, typecheck, tests and build pass at the tag.
- [ ] GPL-3.0-only text, third-party notices, retained licenses and source-access
      instructions are present in both installers.
- [ ] SHA-256 checksums are generated from the uploaded bytes.
- [ ] Authenticode reports `Valid` for installer, application executable and
      privileged service, with the approved publisher.

## Windows x64 matrix

Use a clean snapshot for each row and preserve before/after evidence.

| Matrix | Required result |
| --- | --- |
| Clean install, no profile | Visible UI; no mihomo process; no proxy/TUN/DNS/route mutation |
| Invalid profile import | Validation error; active profile and runtime remain unchanged |
| Valid profile + kernel | Authenticated loopback controller; explicit start and clean stop |
| System proxy enable/disable | Live mixed-port protocol probe; exact registry restoration |
| Forced app termination with owned proxy | Next launch or recovery command restores exact baseline |
| N-1 to RC upgrade | Profiles retained; network restored before replacement; new version visible |
| RC uninstall | Owned proxy restored; service removed; program files removed; profiles retained |
| Tray and login start | Visible tray; login starts UI/tray only; kernel and network remain off |

TUN rows are intentionally absent from the first RC because TUN is excluded.

## Physical-machine and visual checks

- [ ] Windows Defender/SmartScreen publisher is correct.
- [ ] Main window, tray and startup behavior pass on the designated machine.
- [ ] Keyboard focus, labels, contrast and reduced-motion checks pass.
- [ ] Owner approves final 934×672 screenshots.

## Publish decision

- [ ] No P0/P1 recovery, credential, signing or licensing issue is open.
- [ ] Release evidence JSON, checksums and notes are attached to the draft.
- [ ] Owner explicitly approves publishing the draft.
