param(
  [Parameter(Mandatory = $true)][string]$PreviousInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [Parameter(Mandatory = $true)][string]$ProductName,
  [Parameter(Mandatory = $true)][string]$ExecutableName,
  [Parameter(Mandatory = $true)][string]$AppId
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:MURGE_RUN_RC_MATRIX -ne '1') {
  throw 'RC upgrade matrix is restricted to an explicit disposable GitHub Actions Windows runner'
}
if (-not $IsWindows) { throw 'RC upgrade matrix requires Windows' }

function Invoke-BoundedProcess {
  param([string]$FilePath, [string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds = 180)
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    throw "$Label timed out after $TimeoutSeconds seconds"
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "$Label exited with code $($process.ExitCode)" }
}

function Get-InstalledExecutable {
  $path = Join-Path (Join-Path $env:ProgramFiles $ProductName) "$ExecutableName.exe"
  if (-not (Test-Path $path)) { throw "installed executable not found: $path" }
  return $path
}

function Get-Uninstaller([string]$Executable) {
  $dir = Split-Path -Parent $Executable
  $uninstaller = Get-ChildItem -Path $dir -Filter 'Uninstall *.exe' -File | Select-Object -First 1
  if (-not $uninstaller) { throw "uninstaller not found in $dir" }
  return $uninstaller.FullName
}

$profileRoot = Join-Path (Join-Path $env:APPDATA $AppId) 'profiles'
$sentinel = Join-Path $profileRoot '.rc-upgrade-sentinel'
$installed = $null
$baselineProxy = (& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'system-proxy-snapshot.ps1') | ConvertFrom-Json | ConvertTo-Json -Depth 8 -Compress)
$serviceName = $null
try {
  if (Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue) { throw 'runner is not clean: mihomo already running' }
  if (Test-Path (Join-Path $env:ProgramFiles $ProductName)) { throw 'runner is not clean: product already installed' }

  Invoke-BoundedProcess -FilePath $PreviousInstaller -Arguments @('/S') -Label 'previous-version install'
  $installed = Get-InstalledExecutable
  $previousVersion = (Get-Item $installed).VersionInfo.ProductVersion
  $serviceTemplate = Get-Content (Join-Path (Split-Path -Parent $installed) 'resources\tun-service\service-template.json') -Raw | ConvertFrom-Json
  $serviceName = $serviceTemplate.serviceName
  if ((Get-Service -Name $serviceName -ErrorAction Stop).Status -ne 'Running') { throw 'privileged service is not running after install' }
  New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
  'profile-retention-evidence' | Set-Content -Path $sentinel -Encoding ascii

  Invoke-BoundedProcess -FilePath $CandidateInstaller -Arguments @('/S') -Label 'candidate upgrade'
  $installed = Get-InstalledExecutable
  $actualVersion = (Get-Item $installed).VersionInfo.ProductVersion
  if ($actualVersion -ne $CandidateVersion) { throw "candidate version '$actualVersion' != '$CandidateVersion'" }
  if (-not (Test-Path $sentinel)) { throw 'profile sentinel did not survive upgrade' }
  if (Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue) { throw 'install/upgrade unexpectedly started mihomo' }
  $afterUpgradeProxy = (& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'system-proxy-snapshot.ps1') | ConvertFrom-Json | ConvertTo-Json -Depth 8 -Compress)
  if ($afterUpgradeProxy -ne $baselineProxy) { throw 'install/upgrade changed system proxy without user intent' }

  $uninstaller = Get-Uninstaller $installed
  Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S') -Label 'candidate uninstall'
  Start-Sleep -Seconds 3
  if (Test-Path $installed) { throw 'program files remain after uninstall' }
  if ($serviceName -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { throw 'privileged service remains after uninstall' }
  if (-not (Test-Path $sentinel)) { throw 'profile sentinel did not survive uninstall' }
  $afterUninstallProxy = (& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'system-proxy-snapshot.ps1') | ConvertFrom-Json | ConvertTo-Json -Depth 8 -Compress)
  if ($afterUninstallProxy -ne $baselineProxy) { throw 'uninstall changed system proxy without ownership' }
  Write-Host "RC_UPGRADE_MATRIX=PASS previous=$previousVersion candidate=$actualVersion"
} finally {
  if ($installed -and (Test-Path $installed)) {
    try { Invoke-BoundedProcess -FilePath (Get-Uninstaller $installed) -Arguments @('/S') -Label 'finally uninstall' } catch { Write-Warning $_ }
  }
  Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
