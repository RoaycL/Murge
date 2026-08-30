$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Version = '0.14.1'
$ArchiveSha256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51'
$HeaderSha256 = '510a5984fbf73efd21a61ada60edfe05e1a38a77c8c47f6d62e0ab1cdbdd460f'
$DllSha256 = @{
  amd64 = 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce'
  arm64 = 'f7ba89005544be9d85231a9e0d5f23b2d15b3311667e2dad0debd344918a3f80'
}

if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP is required' }
if (-not $env:VSCMD_ARG_TGT_ARCH) { throw 'Run inside a Visual Studio developer shell' }

$Arch = switch ($env:VSCMD_ARG_TGT_ARCH.ToLowerInvariant()) {
  'x64' { 'amd64' }
  'arm64' { 'arm64' }
  default { throw "Unsupported target architecture: $env:VSCMD_ARG_TGT_ARCH" }
}
$Work = Join-Path $env:RUNNER_TEMP "murge-wintun-sdk-$Version-$Arch"
$Archive = Join-Path $Work "wintun-$Version.zip"
$Extracted = Join-Path $Work 'sdk'
New-Item -ItemType Directory -Path $Work -Force | Out-Null

Invoke-WebRequest -UseBasicParsing -Uri "https://www.wintun.net/builds/wintun-$Version.zip" -OutFile $Archive
if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ArchiveSha256) {
  throw 'Official Wintun archive SHA-256 mismatch'
}
Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force

$Header = Join-Path $Extracted 'wintun/include/wintun.h'
$Dll = Join-Path $Extracted "wintun/bin/$Arch/wintun.dll"
if ((Get-FileHash $Header -Algorithm SHA256).Hash.ToLowerInvariant() -ne $HeaderSha256) {
  throw 'Official wintun.h SHA-256 mismatch'
}
if ((Get-FileHash $Dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $DllSha256[$Arch]) {
  throw "Official $Arch wintun.dll SHA-256 mismatch"
}

$Source = Join-Path $PSScriptRoot '../native/wintun-abi-audit/abi-audit.cpp'
$Exe = Join-Path $Work 'wintun-abi-audit.exe'
& cl.exe /nologo /std:c++20 /EHsc /W4 /WX "/I$(Split-Path $Header)" $Source "/Fe:$Exe"
if ($LASTEXITCODE -ne 0) { throw 'Wintun ABI audit compilation failed' }
& $Exe $Dll
if ($LASTEXITCODE -ne 0) { throw 'Wintun ABI export audit failed' }

Write-Host "WINTUN_RELEASE_VERSION=$Version"
Write-Host "WINTUN_RELEASE_ARCH=$Arch"
Write-Host "WINTUN_RELEASE_VERIFIED=true"
Write-Host "WINTUN_ADAPTER_CREATED=false"
