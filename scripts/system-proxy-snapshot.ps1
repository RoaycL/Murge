# Snapshot the three HKCU Internet Settings system-proxy values as a JSON object.
#
# CI-only helper used by .github/workflows/ci.yml. It reads the registry through
# the SAME .NET reader as the main app (`windows-helpers.ts`) and the standalone
# recovery helper (`recover-system-proxy.mjs`) — NOT `reg.exe` text parsing and
# NOT `Get-ItemPropertyValue` (which throws on a MISSING named property in GH
# Actions' pwsh even with `-ErrorAction SilentlyContinue`). `[Microsoft.Win32.Registry]`
# returns the EXACT stored string, the exact `RegistryValueKind` (REG_SZ vs
# REG_EXPAND_SZ vs REG_BINARY), and never expands environment names, so a REG_SZ
# with leading/trailing spaces or a REG_EXPAND_SZ with `%VAR%` round-trips.
#
# Output (single JSON object on stdout, nothing else):
#   { "ProxyEnable":{exists,type,value}, "ProxyServer":{...}, "ProxyOverride":{...} }
#
# REG_DWORD / REG_QWORD are emitted as numbers, REG_BINARY as an UPPERCASE hex
# string, REG_MULTI_SZ joined with ';', REG_SZ / REG_EXPAND_SZ as the exact
# string. A missing value is `{exists:false,type:'none',value:null}`.
param(
  [string]$Key = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
)

$ErrorActionPreference = 'Stop'

$names = @('ProxyEnable', 'ProxyServer', 'ProxyOverride')

# Translate the full HKCU\... path supplied (or its default) into the subkey path.
$subKeyPath = $Key
if ($subKeyPath -match '^HKCU\\(.+)$') { $subKeyPath = $Matches[1] }

$subKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKeyPath)

$snapshot = [ordered]@{}
foreach ($name in $names) {
  $exists = $false
  $type = 'none'
  $value = $null
  if ($null -ne $subKey) {
    try {
      $kind = $subKey.GetValueKind($name)
      $raw = $subKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $exists = $true
      $type = switch ([string]$kind) {
        'String'       { 'REG_SZ' }
        'ExpandString' { 'REG_EXPAND_SZ' }
        'MultiString'  { 'REG_MULTI_SZ' }
        'Binary'       { 'REG_BINARY' }
        'DWord'        { 'REG_DWORD' }
        'QWord'        { 'REG_QWORD' }
        default        { 'none' }
      }
      if ($type -eq 'none') {
        $exists = $false
        $value = $null
      } elseif ($null -eq $raw) {
        # A present value with no data (e.g. an empty REG_SZ) — never a number.
        $exists = $true
        $value = ''
      } else {
        $value = switch ($type) {
          'REG_DWORD'    { [int64]$raw }
          'REG_QWORD'    { [int64]$raw }
          'REG_BINARY'   { ([System.BitConverter]::ToString([byte[]]$raw) -replace '-', '') }
          'REG_MULTI_SZ' { ([string[]]$raw) -join ';' }
          default        { [string]$raw }
        }
      }
    } catch {
      # GetValueKind throws for a named value that is not present -> absent.
      $exists = $false
      $type = 'none'
      $value = $null
    }
  }
  $snapshot[$name] = @{ exists = $exists; type = $type; value = $value }
}

$snapshot | ConvertTo-Json -Depth 5 -Compress
