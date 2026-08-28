# Snapshot the three HKCU Internet Settings system-proxy values as a JSON object.
#
# CI-only helper used by .github/workflows/ci.yml. It reads the registry through
# `reg.exe query` (NOT `Get-ItemPropertyValue`) because GH Actions' pwsh throws
# on a MISSING named property even with `-ErrorAction SilentlyContinue`, which is
# the case for a never-set ProxyServer / ProxyOverride. It emits one JSON object
# per value describing {exists, type, value} so the before/after comparison is the
# exact exists + registry type + raw value triple, not a bare scalar.
#
# Output (single JSON object on stdout, nothing else):
#   { "proxyEnable":   {exists,type,value},
#     "proxyServer":   {exists,type,value},
#     "proxyOverride": {exists,type,value} }
#
# For a value that is not present, `type` is "none" and `value` is null. REG_DWORD
# / REG_QWORD values are emitted as numbers (hex from reg.exe is decoded), while
# REG_SZ / REG_EXPAND_SZ / REG_MULTI_SZ / REG_BINARY are emitted as strings.
param(
  [string]$Key = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
)

$ErrorActionPreference = 'Stop'

$names = @('ProxyEnable', 'ProxyServer', 'ProxyOverride')

# Returns {exists,type,value} for a single value name, or null when absent.
function Convert-RegValue {
  param(
    [string]$Name,
    [string]$Type,
    [string]$Data
  )
  $normalizedType = $Type.ToUpperInvariant()
  switch ($normalizedType) {
    'REG_DWORD' {
      $hex = ($Data -replace '^0[xX]', '').Trim()
      if ($hex -eq '') { $number = 0 } else { $number = [Convert]::ToInt64($hex, 16) }
      return @{ exists = $true; type = $normalizedType; value = [int64]$number }
    }
    'REG_QWORD' {
      $hex = ($Data -replace '^0[xX]', '').Trim()
      if ($hex -eq '') { $number = 0 } else { $number = [Convert]::ToInt64($hex, 16) }
      return @{ exists = $true; type = $normalizedType; value = [int64]$number }
    }
    'REG_MULTI_SZ' {
      # Multi-line data is joined with ';' to keep the value a single string.
      $parts = @()
      foreach ($line in ($Data -split "`r?`n")) {
        $t = $line.TrimEnd()
        if ($t.Length -gt 0) { $parts += $t }
      }
      return @{ exists = $true; type = $normalizedType; value = ($parts -join ';') }
    }
    'REG_BINARY' {
      return @{ exists = $true; type = $normalizedType; value = $Data.Trim() }
    }
    default {
      # REG_SZ / REG_EXPAND_SZ (and any unknown REG_*): preserve the literal value.
      return @{ exists = $true; type = $normalizedType; value = $Data.TrimEnd() }
    }
  }
}

$raw = & reg.exe query $Key 2>$null
$exitCode = $LASTEXITCODE

$found = @{}
if ($exitCode -eq 0 -and $null -ne $raw) {
  foreach ($line in $raw) {
    $m = [regex]::Match($line, '^\s+(\S+)\s+(REG_[A-Z]+)\s+(.*)$')
    if ($m.Success) {
      $found[$m.Groups[1].Value] = Convert-RegValue -Name $m.Groups[1].Value -Type $m.Groups[2].Value -Data $m.Groups[3].Value
    }
  }
}

$snapshot = [ordered]@{}
foreach ($name in $names) {
  if ($found.ContainsKey($name)) {
    $snapshot[$name] = $found[$name]
  } else {
    $snapshot[$name] = @{ exists = $false; type = 'none'; value = $null }
  }
}

$snapshot | ConvertTo-Json -Depth 5 -Compress
