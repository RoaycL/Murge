# Verify the current HKCU Internet Settings system-proxy state exactly equals a
# baseline snapshot (exists + registry type + raw value for all three values).
#
# CI-only helper used by .github/workflows/ci.yml. It snapshots the live registry
# (via system-proxy-snapshot.ps1) and deep-compares ProxyEnable / ProxyServer /
# ProxyOverride as {exists, type, value} triples — the P1#5 fix replaces the old
# bare `ProxyEnable -eq 0` scalar check. Used both for the real-windows final
# consistency check and the package-win post-uninstall / external-restore checks.
#
# Usage:
#   pwsh -NoProfile -File scripts/system-proxy-verify.ps1 -Baseline <baseline.json> \
#        [-SnapshotScript <scripts/system-proxy-snapshot.ps1>] [-Label <text>]
#
# Exit code 0 => exact match (PASS). Exit code 1 => mismatch / error (FAIL).
param(
  [Parameter(Mandatory = $true)][string]$Baseline,
  [string]$SnapshotScript = '',
  [string]$Label = 'system-proxy'
)

$ErrorActionPreference = 'Stop'

if ($SnapshotScript -eq '') {
  $SnapshotScript = Join-Path $PSScriptRoot 'system-proxy-snapshot.ps1'
}
if (-not (Test-Path $Baseline)) {
  Write-Output ("[$Label] FATAL: baseline file not found: $Baseline")
  exit 1
}

$baselineData = Get-Content -Raw -Path $Baseline | ConvertFrom-Json
if ($null -eq $baselineData) {
  Write-Output ("[$Label] FATAL: baseline JSON is empty/invalid")
  exit 1
}

function Assert-ExactValue {
  param($Name, $Expected, $Actual)
  $path = "$Label::$Name"
  if ($Expected.exists -ne $Actual.exists) {
    Write-Host ("[$path] exists mismatch: expected=$($Expected.exists) actual=$($Actual.exists)")
    return $false
  }
  if (-not [string]::Equals([string]$Expected.type, [string]$Actual.type, [System.StringComparison]::Ordinal)) {
    Write-Host ("[$path] type mismatch: expected='$($Expected.type)' actual='$($Actual.type)'")
    return $false
  }
  $e = $Expected.value
  $a = $Actual.value
  if ($null -eq $e -and $null -eq $a) {
    return $true
  }
  if ($e -is [string] -or $a -is [string]) {
    # Registry strings must be the EXACT raw value (ordinal, case-sensitive).
    $es = if ($null -eq $e) { '' } else { [string]$e }
    $as = if ($null -eq $a) { '' } else { [string]$a }
    if (-not [string]::Equals($es, $as, [System.StringComparison]::Ordinal)) {
      Write-Host ("[$path] value mismatch (string): expected='$es' actual='$as'")
      return $false
    }
    return $true
  }
  if ($e -ne $a) {
    Write-Host ("[$path] value mismatch (number): expected=$e actual=$a")
    return $false
  }
  return $true
}

$json = & $SnapshotScript
$current = $json | ConvertFrom-Json
if ($null -eq $current) {
  Write-Output ("[$Label] FATAL: could not snapshot current registry state")
  exit 1
}

$names = @('ProxyEnable', 'ProxyServer', 'ProxyOverride')
$allOk = $true
foreach ($name in $names) {
  if (-not (Assert-ExactValue -Name $name -Expected $baselineData.$name -Actual $current.$name)) {
    $allOk = $false
  }
}

if ($allOk) {
  Write-Output ("[$Label] PASS (exists/type/value exact match for ProxyEnable, ProxyServer, ProxyOverride)")
  exit 0
}

Write-Output ("[$Label] FAIL")
exit 1
