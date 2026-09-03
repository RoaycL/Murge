# Murge {{VERSION}}

Windows release candidate for the mihomo-based desktop client.

## Included

- Windows x64 installer with explicit mihomo kernel lifecycle.
- TUN service: installs a privileged Windows TUN service that runs the active
  profile so TUN actually proxies traffic.
- TUN switch on the Overview (概览) page next to the system-proxy toggle for
  one-click enable/disable; the config page keeps the full lifecycle panel.
- Single-kernel (社区式 mihomo) model: one mihomo serves both the system proxy
  (mixed-port) and TUN. Enabling TUN restarts that same kernel with
  admin/service privileges and injects the `tun` config; the data plane
  (rules / groups / delay-test / logs) always reads the one live controller.
  The "-安全直连内核" concept is removed.
- The system proxy and TUN are no longer mutually exclusive: a logical kernel
  keeps running across TUN toggles, so enabling TUN no longer darkens the rules
  / groups / policy / log views. An owned system proxy is restored only on an
  explicit kernel stop.
- The system-proxy enable path now re-adopts a stale owned bundle whose port
  moved between sessions instead of reporting a bogus "外部修改" conflict; a
  genuine external edit still surfaces a conflict.
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
