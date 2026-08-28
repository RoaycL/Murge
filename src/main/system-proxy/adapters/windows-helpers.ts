import type { RegistryValue } from '../types'

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

/** `reg delete` argv for a named value (removes it entirely). */
export function regDeleteValueArgs(valueName: string): string[] {
  return ['delete', WIN_INTERNET_SETTINGS_KEY, '/v', valueName, '/f']
}

const TYPE_PATTERN = /^\s*(\S+)\s+((?:REG|QWORD)[A-Z_]*)\s+(.*)$/

function normalizeType(typeLabel: string): RegistryValue['type'] {
  switch (typeLabel) {
    case 'REG_DWORD':
      return 'dword'
    case 'REG_SZ':
    case 'REG_EXPAND_SZ':
      return 'string'
    case 'REG_BINARY':
      return 'binary'
    default:
      return 'none'
  }
}

/**
 * Parse a single-value `reg query` result into a {@link RegistryValue}.
 * Returns `{ exists: false }` when no value line was found (the value is absent),
 * which is how `reg query` signals a missing value on a non-zero exit.
 */
export function parseRegQueryValue(raw: string): RegistryValue {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(TYPE_PATTERN)
    if (!match) continue
    const typeLabel = match[2]
    const rawValue = match[3].trim()
    const type = normalizeType(typeLabel)
    if (type === 'dword') {
      // `reg` prints REG_DWORD as hex (0x1 or 0x00000001).
      const parsed = parseInt(rawValue, 16)
      return { exists: true, type, value: Number.isNaN(parsed) ? 0 : parsed }
    }
    return { exists: true, type, value: rawValue }
  }
  return { exists: false, type: 'none', value: null }
}

/** PowerShell script that tells WinINet to re-read the HKCU proxy settings. */
export function buildWinInetRefreshScript(): string {
  return [
    '$sig = \'[DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);\'',
    '$t = Add-Type -MemberDefinition $sig -Name "SystemProxyWinINet" -Namespace "SystemProxy" -PassThru',
    'if ($null -eq $t) { exit 1 }',
    '$null = $t::InternetSetOption(0, 39, 0, 0)',
    '$null = $t::InternetSetOption(0, 37, 0, 0)',
    'exit 0'
  ].join('; ')
}
