import type { RegistryValue, RegistryValueType } from '../types'

/**
 * Pure helpers for the Windows system-proxy adapter.
 *
 * These build `reg.exe` argument arrays and parse `reg query` output. They touch
 * no I/O so they are unit-tested on the Mac/Linux dev boxes; only the adapter
 * that executes them is Windows-only. Arguments are passed as an argv array
 * (never a shell string), so no value can inject another command.
 */

/** HKCU Internet Settings key that owns the per-user system proxy. */
export const WIN_INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

export const PROXY_ENABLE_VALUE = 'ProxyEnable'
export const PROXY_SERVER_VALUE = 'ProxyServer'
export const PROXY_OVERRIDE_VALUE = 'ProxyOverride'

/** `reg query` argv for a single value. */
export function regQueryValueArgs(valueName: string): string[] {
  return ['query', WIN_INTERNET_SETTINGS_KEY, '/v', valueName]
}

/** `reg add` argv for a REG_DWORD value. */
export function regAddDwordArgs(valueName: string, value: number): string[] {
  return ['add', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/t', 'REG_DWORD', '/d', String(value), '/f']
}

/** `reg add` argv for a REG_SZ value. */
export function regAddStringArgs(valueName: string, value: string): string[] {
  return ['add', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f']
}

/** `reg add` argv for a REG_EXPAND_SZ value (restoring the exact original type). */
export function regAddExpandStringArgs(valueName: string, value: string): string[] {
  return ['add', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/t', 'REG_EXPAND_SZ', '/d', value, '/f']
}

/** `reg add` argv for a REG_BINARY value (restoring the exact original type). */
export function regAddBinaryArgs(valueName: string, value: string): string[] {
  return ['add', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/t', 'REG_BINARY', '/d', value, '/f']
}

/** `reg delete` argv for a named value (removes it entirely). */
export function regDeleteValueArgs(valueName: string): string[] {
  return ['delete', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/f']
}

/** Value name → restore-type helper selection used by `restoreValue`. */
export function regAddArgsFor(valueName: string, value: RegistryValue): string[] {
  if (!value.exists) return regDeleteValueArgs(valueName)
  switch (value.type) {
    case 'REG_DWORD':
      return regAddDwordArgs(valueName, value.value as number)
    case 'REG_SZ':
      return regAddStringArgs(valueName, value.value as string)
    case 'REG_EXPAND_SZ':
      return regAddExpandStringArgs(valueName, value.value as string)
    case 'REG_BINARY':
      return regAddBinaryArgs(valueName, value.value as string)
    default:
      // A type we cannot faithfully restore should never reach this point: the
      // controller validates restorability before it writes anything. Guard so a
      // future caller cannot silently corrupt a value.
      throw new Error(`unsupported registry type for restore: ${value.type}`)
  }
}

const TYPE_PATTERN = /^\s*(\S+)\s+((?:REG|QWORD)[A-Z_]*)\s+(.*)$/

function typeLabelToRegistryValueType(label: string): RegistryValueType {
  switch (label) {
    case 'REG_DWORD':
    case 'REG_SZ':
    case 'REG_EXPAND_SZ':
    case 'REG_MULTI_SZ':
    case 'REG_BINARY':
    case 'REG_QWORD':
      return label
    default:
      // Unknown / unsupported registry types are surfaced as present-but-typed
      // `none` so the controller refuses to enable on them (fail closed).
      return 'none'
  }
}

/**
 * Parse a single-value `reg query` result into a {@link RegistryValue}.
 *
 * The caller determines absence: the adapter only maps the explicit "value not
 * found" outcome to `{ exists: false }` after checking the exit code — this
 * function merely governs what an actual value-line parses to. The original
 * registry type (`REG_DWORD` / `REG_SZ` / `REG_EXPAND_SZ` / `REG_BINARY` / ...)
 * is preserved verbatim so restore can write the exact same `/t`.
 */
export function parseRegQueryValue(raw: string, valueName = ''): RegistryValue {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(TYPE_PATTERN)
    if (!match) continue
    const label = match[2]
    const rawValue = match[3].trim()
    const type = typeLabelToRegistryValueType(label)
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      // `reg` prints REG_DWORD/REG_QWORD as hex (0x1 or 0x00000001).
      const parsed = parseInt(rawValue, 16)
      return { exists: true, type, value: Number.isNaN(parsed) ? 0 : parsed }
    }
    return { exists: true, type, value: rawValue }
  }
  return { exists: false, type: 'none', value: null }
}

/**
 * PowerShell script that tells WinINet to re-read the HKCU proxy settings and
 * *reports failure*. Both `InternetSetOption` calls must return `true` and the
 * Win32 last-error must be zero; otherwise the script exits non-zero so the
 * adapter treats the refresh as failed (and can trigger a rollback).
 */
/**
 * The canonical WinINet refresh script, shared byte-for-byte with the standalone
 * recovery helper (`scripts/recover-system-proxy.mjs`). It intentionally does NOT
 * cache the Win32 last-error after a *successful* call — a stale non-zero
 * last-error from an unrelated prior call would otherwise be misread as a
 * failure. Each call reads `GetLastWin32Error()` only in the branch where that
 * call returned false, and a failure exits non-zero so the adapter treats the
 * refresh as failed (and can trigger a rollback).
 */
export const WIN_INET_REFRESH_SCRIPT = `$ErrorActionPreference = 'Stop'
if (-not ('SystemProxy.WinInet' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace SystemProxy {
  public static class WinInet {
    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
  }
}
'@
}
$b1 = [SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
if (-not $b1) {
  $e1 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error ('InternetSetOption(INTERNET_OPTION_SETTINGS_CHANGED) failed; last-error={0}' -f $e1)
  exit 2
}
$b2 = [SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
if (-not $b2) {
  $e2 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error ('InternetSetOption(INTERNET_OPTION_REFRESH) failed; last-error={0}' -f $e2)
  exit 2
}
exit 0
`

export function buildWinInetRefreshScript(): string {
  return WIN_INET_REFRESH_SCRIPT
}
