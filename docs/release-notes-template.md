# Murge {{VERSION}}

Windows release candidate for the mihomo-based desktop client.

## Included

- Windows x64 installer with explicit mihomo kernel lifecycle.
- Profile, activity, connection, policy, provider, rule, DNS and log tools.
- Verified Windows system-proxy enable, exact restore and recovery path.
- Tray, optional start-on-login, diagnostics and brand-configurable desktop UI.

## Deliberately excluded

- TUN, HTTP capture, HTTPS decryption, rewrite, LAN listeners and automatic updates.
- Windows arm64 is not a supported target until its installed lifecycle is
  verified on real arm64 hardware.

## Verification and recovery

This release is intentionally **not Authenticode-signed** by owner decision.
Windows will display an **Unknown publisher** warning. Verify the installer
against `SHA256SUMS.txt` and download it only from the official GitHub Release.
See `docs/NETWORK_RECOVERY.md` in the matching source tag for emergency
system-proxy recovery.

This draft must not be published until the release-candidate checklist and
owner approval are complete.
