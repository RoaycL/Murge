# Murge {{VERSION}}

Windows release candidate for the mihomo-based desktop client.

## Included

- Windows x64 installer with explicit mihomo kernel lifecycle.
- TUN service: installs a privileged Windows TUN service that runs the active
  profile so TUN actually proxies traffic.
- TUN switch on the Overview (概览) page next to the system-proxy toggle for
  one-click enable/disable; the config page keeps the full lifecycle panel.
- Turning TUN on automatically stops the safe loopback kernel first (the two are
  mutually exclusive), so no manual stop is needed; an owned system proxy is
  restored before the kernel stops.
- The system proxy and TUN can now be enabled together: while TUN is on, the
  Overview 系统代理 switch points the proxy at the live TUN child instead of
  erroring, and turning TUN off restores the proxy so it is never left aimed at
  a dead port.
- Profile, activity, connection, policy, provider, rule, DNS and log tools.
- Verified Windows system-proxy enable, exact restore and recovery path.
- Tray, optional start-on-login, diagnostics and brand-configurable desktop UI.
- Project documentation translated to Chinese.

## Deliberately excluded

- HTTP capture, HTTPS decryption, rewrite, LAN listeners and automatic updates.
- Windows arm64 installers remain test-only until the installed lifecycle is
  verified on real arm64 hardware.

## Verification and recovery

This release is intentionally **not Authenticode-signed** by owner decision.
Windows will display an **Unknown publisher** warning. Verify the installer
against `SHA256SUMS.txt` and download it only from the official GitHub Release.
See `docs/NETWORK_RECOVERY.md` in the matching source tag for emergency
system-proxy recovery.

This draft must not be published until the release-candidate checklist and
owner approval are complete.
