# Emergency Windows network recovery

The first release candidate supports Windows system proxy and excludes TUN.
These steps do not delete profiles.

## Preferred recovery

1. Exit the application normally. The main process restores an owned system
   proxy before stopping mihomo.
2. If the UI is unavailable, run the installed executable from an ordinary
   PowerShell window:

   ```powershell
   & "$env:ProgramFiles\Murge\murge.exe" --restore-system-proxy
   ```

   A successful exit means either the exact saved state was restored or Murge
   no longer owns the current proxy values. A conflict is not overwritten.
3. Relaunch the application and verify Overview reports system proxy disabled.

## If the application was already removed

Do not guess or clear organization-managed proxy/PAC values. Reinstall the same
version, run the recovery command above, then uninstall normally. The profile
and owned-backup directory is intentionally preserved by uninstall so recovery
remains possible.

## Evidence to retain

Before making a manual change, capture the three HKCU Internet Settings values:
`ProxyEnable`, `ProxyServer`, and `ProxyOverride`. Record the application version
and attach the privacy-safe diagnostics bundle. Never publish profile YAML,
controller secrets, raw logs, destination addresses or subscription URLs.

TUN/route/DNS recovery instructions are intentionally not offered because TUN
is not part of this RC. A build exposing TUN must not be published under this
scope.
