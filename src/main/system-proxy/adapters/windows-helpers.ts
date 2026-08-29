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

const TYPE_PATTERN = /^\s*(\S+)\s+((?:REG|QWORD)[A-Z0-9_]*)\s+(.*)$/

/** Raised when `reg query` output cannot be interpreted as a valid registry value. */
export class RegistryReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryReadError'
  }
}

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

/** A line signalling the requested value is not present (never "value 0"). */
const VALUE_NOT_FOUND_PATTERN = /(?:not\s+found|unable\s+to\s+find|cannot\s+find|找不到|无法找到)/i

/** Strictly decode a hex number (`0x1`, `1`) — returns null on ANY non-hex input. */
function parseExactHex(raw: string): number | null {
  const trimmed = raw.trim()
  const hex = trimmed.replace(/^0[xX]/, '')
  if (hex === '' || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const parsed = Number.parseInt(hex, 16)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Parse a single-value `reg query` result into a {@link RegistryValue}.
 *
 * This is the *legacy* text-mode parser and is intentionally fail-closed for
 * numeric values (P1-1): an unparseable REG_DWORD / REG_QWORD hex line is a read
 * failure and throws a {@link RegistryReadError} rather than being silently
 * coerced to `0`. When `valueName` is supplied, a non-matching line is skipped
 * and a "value not found" outcome maps to absent; anything else that produces no
 * matching value line is a read failure, never a phantom absence.
 *
 * NOTE: this text parser cannot reconstruct exact leading/trailing spaces in a
 * REG_SZ / REG_EXPAND_SZ value (reg.exe prints the data without a reliable column
 * delimiter). The canonical read path is the PowerShell/.NET reader
 * ({@link buildRegistryReadScript}) which captures exact strings; this parser is
 * kept for DWORD/QWORD correctness and as a defensive fallback.
 */
export function parseRegQueryValue(raw: string, valueName = ''): RegistryValue {
  let absent = false
  let anyValueLineForName = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (VALUE_NOT_FOUND_PATTERN.test(trimmed)) {
      absent = true
      continue
    }
    const match = line.match(TYPE_PATTERN)
    if (!match) continue
    // `reg query KEY /v NAME` prints a per-value name line; only the requested
    // name (when supplied) is meaningful. Other value lines are data, not the
    // answer.
    if (valueName !== '' && match[1] !== valueName) continue
    anyValueLineForName = true
    const label = match[2]
    const rawValue = match[3]
    const type = typeLabelToRegistryValueType(label)
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      const parsed = parseExactHex(rawValue)
      if (parsed === null) {
        throw new RegistryReadError(`无法解析 ${label} 十六进制值：${JSON.stringify(rawValue)}`)
      }
      return { exists: true, type, value: parsed }
    }
    return { exists: true, type, value: rawValue }
  }
  if (absent) return { exists: false, type: 'none', value: null }
  if (valueName !== '') {
    // The caller saw exit code 0 (a real value should be present), but the output
    // contained no line for this value name — a read inconsistency, not "absent".
    throw new RegistryReadError(`未能在 reg query 输出中解析注册表值 ${valueName}`)
  }
  if (!anyValueLineForName) {
    throw new RegistryReadError('未能在 reg query 输出中解析任何注册表值行')
  }
  throw new RegistryReadError('未能在 reg query 输出中解析注册表值')
}

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

/**
 * The canonical .NET registry-read script, shared byte-for-byte with the
 * standalone recovery helper (`scripts/recover-system-proxy.mjs`) and the CI
 * snapshot helper (`scripts/system-proxy-snapshot.ps1`). It reads the three HKCU
 * Internet Settings values a single time via `[Microsoft.Win32.Registry]`, which
 * — unlike `reg.exe` text parsing — returns the EXACT stored string, the exact
 * `RegistryValueKind` (REG_SZ vs REG_EXPAND_SZ vs REG_MULTI_SZ vs REG_BINARY),
 * and never expands environment names (REG_EXPAND_SZ keeps its `%VAR%`). It emits
 * a single JSON object on stdout:
 *
 *   { "ProxyEnable":{exists,type,value}, "ProxyServer":{...}, "ProxyOverride":{...} }
 *
 * REG_DWORD / REG_QWORD are emitted as numbers; REG_BINARY as an UPPERCASE hex
 * string; REG_MULTI_SZ joined with ';'; REG_SZ / REG_EXPAND_SZ as the exact
 * string. A missing value is `{exists:false,type:'none',value:null}`.
 */
export const REGISTRY_READ_SCRIPT = `$ErrorActionPreference = 'Stop'
$keyPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$names = @('ProxyEnable', 'ProxyServer', 'ProxyOverride')
$subKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
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
`

export function buildRegistryReadScript(): string {
  return REGISTRY_READ_SCRIPT
}

/** Canonical snapshot shape emitted by {@link REGISTRY_READ_SCRIPT}. */
export interface RegistrySnapshot {
  ProxyEnable: RegistryValue
  ProxyServer: RegistryValue
  ProxyOverride: RegistryValue
}

/**
 * Strictly coerce one value object from the registry snapshot JSON.
 *
 * Fail-closed (P1-1): a malformed or structurally inconsistent entry is a read
 * failure, never silently coerced to a phantom `0` / absent.
 */
function coerceRegistryValue(raw: unknown, name: string): RegistryValue {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryReadError(`注册表快照缺少 ${name}`)
  }
  const { exists, type, value } = raw as { exists?: unknown; type?: unknown; value?: unknown }
  if (typeof exists !== 'boolean') {
    throw new RegistryReadError(`注册表快照 ${name}.exists 无效`)
  }
  if (!exists) {
    if (type !== 'none' || value !== null) {
      throw new RegistryReadError(`注册表快照 ${name} 缺失但内容不一致`)
    }
    return { exists: false, type: 'none', value: null }
  }
  if (typeof type !== 'string' || !typeLabelToRegistryValueType(type) || type === 'none') {
    throw new RegistryReadError(`注册表快照 ${name}.type 无效`)
  }
  const registryType = typeLabelToRegistryValueType(type) as RegistryValueType
  if (registryType === 'REG_DWORD' || registryType === 'REG_QWORD') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RegistryReadError(`注册表快照 ${name} 不是有效的 ${type} 数值`)
    }
    return { exists: true, type: registryType, value }
  }
  if (typeof value !== 'string') {
    throw new RegistryReadError(`注册表快照 ${name} 不是有效的 ${type} 字符串`)
  }
  return { exists: true, type: registryType, value }
}

/** Parse the `REGISTRY_READ_SCRIPT` JSON stdout into the canonical snapshot. */
export function coerceRegistrySnapshot(stdout: string): RegistrySnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new RegistryReadError(`注册表快照不是有效 JSON：${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RegistryReadError('注册表快照不是 JSON 对象')
  }
  const obj = parsed as Record<string, unknown>
  return {
    ProxyEnable: coerceRegistryValue(obj['ProxyEnable'], 'ProxyEnable'),
    ProxyServer: coerceRegistryValue(obj['ProxyServer'], 'ProxyServer'),
    ProxyOverride: coerceRegistryValue(obj['ProxyOverride'], 'ProxyOverride')
  }
}
