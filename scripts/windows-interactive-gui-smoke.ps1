param(
  [string]$InstallerPath = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$TimeoutSeconds = 120
  )
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    throw "$Label timed out after $TimeoutSeconds seconds"
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "$Label exited with code $($process.ExitCode)" }
}

$brand = Get-Content brand.config.json -Raw | ConvertFrom-Json
if (-not $InstallerPath) {
  $InstallerPath = (Get-ChildItem dist -Filter '*Setup-*-x64.exe' -File | Select-Object -First 1).FullName
}
if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) { throw 'x64 installer not found' }

$installDir = Join-Path $env:ProgramFiles $brand.productName
$exe = Join-Path $installDir "$($brand.executableName).exe"
$uninstaller = $null
$gui = $null

try {
  Invoke-BoundedProcess -FilePath $InstallerPath -Arguments @('/S') -Label 'silent installer' -TimeoutSeconds 180
  if (-not (Test-Path $exe)) { throw "installed executable missing: $exe" }

  # These probes execute the real packaged main entry, app.asar and preload in
  # an interactive desktop session. They deliberately remain outside hosted CI.
  Invoke-BoundedProcess -FilePath $exe -Arguments @('--packaging-smoke') -Label 'packaging smoke'
  Invoke-BoundedProcess -FilePath $exe -Arguments @('--kernel-smoke') -Label 'bundled kernel smoke'
  Invoke-BoundedProcess -FilePath $exe -Arguments @('--ui-smoke') -Label 'preload IPC smoke'

  $env:MURGE_CI_HIDDEN_START = '1'
  try {
    Invoke-BoundedProcess -FilePath $exe -Arguments @('--hidden', '--hidden-smoke') -Label 'hidden tray smoke'
  } finally {
    Remove-Item Env:MURGE_CI_HIDDEN_START -ErrorAction SilentlyContinue
  }

  # Keep this clean-install window probe independent from the persisted
  # auto-start preference. The switch is honored only under GITHUB_ACTIONS.
  $gui = Start-Process -FilePath $exe -ArgumentList @('--no-kernel-autostart') -PassThru
  $windowReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    $live = Get-Process -Id $gui.Id -ErrorAction SilentlyContinue
    if (-not $live) { throw 'packaged GUI exited before creating a window' }
    if ($live.MainWindowHandle -ne 0) {
      $windowReady = $true
      Write-Host "GUI_WINDOW=PASS pid=$($live.Id) title='$($live.MainWindowTitle)'"
      break
    }
  }
  if (-not $windowReady) { throw 'packaged GUI did not create a visible window within 30 seconds' }
  if (Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue) {
    throw 'plain GUI launch unexpectedly left mihomo running on the clean lab'
  }
} finally {
  if ($gui) {
    Stop-Process -Id $gui.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $gui.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  if (Test-Path $installDir) {
    $uninstaller = Get-ChildItem $installDir -Filter 'Uninstall *.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if ($uninstaller) {
    Invoke-BoundedProcess -FilePath $uninstaller.FullName -Arguments @('/S') -Label 'silent uninstaller' -TimeoutSeconds 180
  }
}

if (Test-Path $exe) { throw 'installed executable remained after uninstall' }
Write-Host 'INTERACTIVE_WINDOWS_GUI_SMOKE=PASS'
