<#
.SYNOPSIS
  Local Phase 9B TUN runtime evidence harness — SAFE subset (no network mutation).

.DESCRIPTION
  Builds service-config.json next to tun-service.exe and launches the service in
  an ELEVATED console process via a wrapper (accept the UAC prompt once). It
  then proves on this real machine:

    1. the service starts and opens its named pipe (idle lifecycle);
    2. `status` reports an idle/stopped session with no error;
    3. `reconcile` clears any stale ownership without mutating networking;
    4. a TUN-policy-violating `start` request is REJECTED (server closes the pipe
       without a response) and does NOT spawn a mihomo process.

  None of these rows touch networking. Enable real TUN (Wintun adapter, routes,
  DNS) is intentionally NOT part of this harness; per the Phase 9B evidence gate
  it must run in an isolated, snapshot-able Windows lab.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File scripts\tun-runtime-evidence.ps1
#>

param(
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Log([string]$m) { Write-Host "[tun-evidence] $m" }

if (-not $ExePath) { $ExePath = Join-Path $root 'resources\tun-service\x64\tun-service.exe' }
if (-not (Test-Path -LiteralPath $ExePath)) { throw "service not found: $ExePath" }
$bootstrap = Split-Path -Parent $ExePath
$template = Get-Content (Join-Path $bootstrap 'service-template.json') -Raw | ConvertFrom-Json
$archivePath = Join-Path $root ('resources\bin\x64\' + $template.archiveFilename)
if (-not (Test-Path -LiteralPath $archivePath)) { throw "mihomo archive not found: $archivePath" }
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower() -ne $template.archiveSha256) { throw 'mihomo archive SHA-256 mismatch' }

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$clientPath = (Get-Command node.exe).Source
$clientHash = (Get-FileHash -LiteralPath $clientPath -Algorithm SHA256).Hash.ToLower()
$stateDir = Join-Path $bootstrap 'state'

# The harness reuses the product's real service identity, so its console instance
# would listen on the SAME pipe name as an INSTALLED service. Two hazards follow:
# the first-instance pipe creation fails, or the requests below are answered by
# the installed service while the log still credits the harness — evidence
# attributed to the wrong process. Refuse up front instead.
$installed = & sc.exe query $template.serviceName 2>&1
if ($LASTEXITCODE -eq 0) {
  $state = ($installed | Select-String -Pattern 'STATE\s+:\s+\d+\s+(\w+)').Matches.Groups[1].Value
  if ($state -ne 'STOPPED') {
    throw "the installed service '$($template.serviceName)' is $state and shares this pipe name; stop it before running this harness so the evidence cannot come from the wrong process"
  }
  Log "installed service present but STOPPED — safe to bind the pipe"
}

$config = [ordered]@{
  serviceName = $template.serviceName; pipeName = $template.pipeName; allowedSid = $sid
  archivePath = $archivePath; archiveSha256 = $template.archiveSha256; archiveInnerName = $template.archiveInnerName
  stateDirectory = $stateDir; allowedClientPath = $clientPath; allowedClientSha256 = $clientHash
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $bootstrap 'service-config.json') -Encoding utf8
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Log 'service-config written'

$markerStart = Join-Path $env:TEMP 'tsvc.start'
$markerStop = Join-Path $env:TEMP 'tsvc.stop'
$markerDone = Join-Path $env:TEMP 'tsvc.done'
$errPath = Join-Path $env:TEMP 'tsvc.err'
Remove-Item $markerStart, $markerStop, $markerDone, $errPath -ErrorAction SilentlyContinue

# Elevated (RunAs) processes do NOT inherit the caller's environment, so bake the
# absolute paths directly into the wrapper script (via literal placeholders).
$wrap = @'
$ErrorActionPreference = 'Continue'
$exe = '__EXE__'
$err = '__ERR__'
$start = '__START__'
$stop = '__STOP__'
$done = '__DONE__'
$p = Start-Process -FilePath $exe -ArgumentList '--console' -NoNewWindow -PassThru -RedirectStandardError $err
Set-Content -LiteralPath $start -Value ('started pid=' + $p.Id)
while (-not (Test-Path $stop)) {
  Start-Sleep -Milliseconds 300
  if ($p.HasExited) { Set-Content $done -Value ('exited code=' + $p.ExitCode); break }
}
if (-not $p.HasExited) { $p | Stop-Process -Force -ErrorAction SilentlyContinue }
Set-Content $done -Value 'cleaned'
'@
$wrap = $wrap.Replace('__EXE__', $ExePath).Replace('__ERR__', $errPath).Replace('__START__', $markerStart).Replace('__STOP__', $markerStop).Replace('__DONE__', $markerDone)
$wrapPath = Join-Path $env:TEMP 'tsvc-wrap.ps1'
$wrap | Set-Content -LiteralPath $wrapPath -Encoding utf8

$client = @'
const net = require('node:net');
const pipe = process.argv[2];
const req = process.argv[3];
const c = net.createConnection(pipe);
let b = Buffer.alloc(0);
c.on('connect', () => c.write(req + '\n'));
c.on('data', d => { b = Buffer.concat([b, d]); const i = b.indexOf(10); if (i >= 0) { process.stdout.write(b.subarray(0, i).toString()); c.end(); setTimeout(() => process.exit(0), 50); } });
c.on('error', e => { process.stderr.write('ERR ' + e.message); process.exit(2); });
c.on('close', () => { if (b.length === 0) { process.stdout.write('SERVER-REJECTED'); process.exit(0); } });
setTimeout(() => { process.stderr.write('TIMEOUT'); process.exit(3); }, 8000);
'@
$clientPath = Join-Path $env:TEMP 'tsvc-client.cjs'
$client | Set-Content -LiteralPath $clientPath -Encoding utf8

function Invoke-Pipe([string]$requestJson) {
  $full = '\\.\pipe\' + $template.pipeName
  return node $clientPath $full $requestJson 2>&1
}

function Stop-ElevatedService([int]$ServicePid) {
  # Kill ONLY the process this harness launched. `taskkill /IM tun-service.exe`
  # matches by IMAGE NAME, so it also terminates the INSTALLED Windows service's
  # own tun-service.exe: SCM then restarts it per the recovery actions, the
  # harness kills it again, and after the third strike SCM gives up and leaves
  # the real service STOPPED with WIN32_EXIT_CODE 1067. The elevated wrapper
  # already stops its own child by PID, so this is only a belt-and-braces sweep
  # for the case where the wrapper itself died before its cleanup ran.
  if ($ServicePid -le 0) { return }
  $kill = "& taskkill.exe /PID $ServicePid /T /F 2>&1 | Out-Null"
  $k = Join-Path $env:TEMP 'tsvc-kill.ps1'
  $kill | Set-Content -LiteralPath $k -Encoding utf8
  Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$k`"" -Verb RunAs -Wait -WindowStyle Hidden 2>&1 | Out-Null
  Remove-Item $k -ErrorAction SilentlyContinue
}

function Get-LaunchedServicePid {
  if (-not (Test-Path -LiteralPath $markerStart)) { return 0 }
  $match = [regex]::Match((Get-Content -LiteralPath $markerStart -Raw), 'pid=(\d+)')
  if (-not $match.Success) { return 0 }
  return [int]$match.Groups[1].Value
}

try {
  Log 'launching elevated service wrapper (accept the UAC prompt)'
  Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$wrapPath`"" -Verb RunAs -WindowStyle Hidden 2>&1 | Out-Null
  Start-Sleep -Seconds 4
  if (Test-Path $markerDone) { throw "service exited: $(Get-Content $markerDone) (see $errPath)" }
  Log 'service running'

  $statusResp = Invoke-Pipe (@{ protocolVersion = 2; requestId = '100'; operation = 'status' } | ConvertTo-Json -Compress)
  Log "status      -> $statusResp"
  if ($statusResp -notmatch '"outcome":"stopped"') { throw "expected idle status, got: $statusResp" }

  $reconcileResp = Invoke-Pipe (@{ protocolVersion = 2; requestId = '101'; operation = 'reconcile' } | ConvertTo-Json -Compress)
  Log "reconcile   -> $reconcileResp"
  if ($reconcileResp -notmatch '"outcome":"stopped"') { throw "expected idle reconcile, got: $reconcileResp" }

  $existingMihomo = @(Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue).Count

  $unsafeProfile = "mixed-port: 7890`nallow-lan: false`nmode: direct`nlog-level: info`nipv6: false`nexternal-controller: 127.0.0.1:19901`nsecret: " + ('aa' * 32) + "`ntun:`n  enable: false`n  device: Murge TUN`n  stack: mixed`ndns:`n  enable: true`n  enhanced-mode: fake-ip`n  fake-ip-range: 198.18.0.1/16`n  nameserver:`n    - system`nrules:`n  - MATCH,DIRECT`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($unsafeProfile)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLower()
  $unsafeReq = @{ protocolVersion = 2; requestId = '102'; operation = 'start'; sessionId = '00000000-0000-4000-8000-000000000001'; profile = $unsafeProfile; profileSha256 = $digest }
  $unsafeResp = Invoke-Pipe ($unsafeReq | ConvertTo-Json -Compress)
  Log "unsafe start -> $unsafeResp"
  if ($unsafeResp -notmatch 'SERVER-REJECTED') { throw "expected unsafe start to be rejected, got: $unsafeResp" }

  $afterMihomo = @(Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue).Count
  Log "mihomo before=$existingMihomo after=$afterMihomo (must be unchanged)"
  if ($afterMihomo -gt $existingMihomo) { throw 'unsafe request spawned a mihomo process' }

  Log '==== SAFE EVIDENCE PASSED (idle lifecycle + TUN profile-boundary) ===='
} finally {
  # Read the launched PID BEFORE the marker files are removed below.
  $launchedPid = Get-LaunchedServicePid
  Set-Content -LiteralPath $markerStop -Value 'stop'
  Start-Sleep -Seconds 2
  Stop-ElevatedService $launchedPid
  Remove-Item $markerStart, $markerStop, $markerDone, $errPath, $wrapPath, $clientPath -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $bootstrap 'service-config.json') -Force -ErrorAction SilentlyContinue
  # The service re-ACLs its state directory to SYSTEM + Administrators only, so an
  # unelevated `rd` cannot delete it and would silently leave a directory inside
  # the repository that the current user cannot even enumerate (`git status` then
  # reports "Permission denied"). Remove it elevated, and verify it is gone.
  if (Test-Path $stateDir) {
    $rd = Join-Path $env:TEMP 'tsvc-rd.ps1'
    "& cmd.exe /c 'rd /s /q `"$stateDir`"' 2>&1 | Out-Null" | Set-Content -LiteralPath $rd -Encoding utf8
    Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$rd`"" -Verb RunAs -Wait -WindowStyle Hidden 2>&1 | Out-Null
    Remove-Item $rd -ErrorAction SilentlyContinue
    if (Test-Path $stateDir) {
      Write-Warning "could not remove '$stateDir' (it is ACLed to SYSTEM/Administrators). Delete it from an elevated shell: rd /s /q `"$stateDir`""
    }
  }
}
