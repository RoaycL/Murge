#!/usr/bin/env node
// Standalone system-proxy recovery helper.
//
// Reused by BOTH the Windows CI final `if: always()` external-restore step AND
// the force-crash recovery test, so the test is not exercising a private copy of
// the recovery logic. It must run under plain `node` (no Electron, no bundler,
// no TypeScript import aliases). It reads the brand-independent owned backup
// from app-data, restores the exact pre-enable HKCU Internet Settings values
// (preserving each value's precise registry type), verifies the registry really
// returned to the pre-enable snapshot, and only then deletes the backup.
//
// Fail-closed semantics:
//   - No backup       => nothing owned; safe "disabled" (exit 0), no registry write.
//   - Corrupt backup  => conflict; FAIL (exit 1) WITHOUT ever entering the
//                        restore-write path. We refuse to guess the original.
//   - Schema mismatch => conflict; FAIL (exit 1) without writing.
//   - Registry does NOT match the written (enabled) state => conflict; report
//                        and DO NOT overwrite (exit 0) — the values are no longer
//                        ours, so a blind restore would clobber an external edit.
//   - Restore write/refresh/read-back fails => FAIL (exit 1), keep the backup for
//                        a later retry. Never delete a backup on a failed restore.
//
// CLI:  node scripts/recover-system-proxy.mjs [--backup <path>] [--dry-run]
// Or import { runRecovery } from a test (tests inject a mock `runner`).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'

const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
// reg.exe value name -> SystemProxyRegistryState key. The app stores the backup
// with camelCase keys; the registry uses the HKCU PascalCase value names.
const REG_STATE_KEYS = {
  ProxyEnable: 'proxyEnable',
  ProxyServer: 'proxyServer',
  ProxyOverride: 'proxyOverride'
}
const REG_VALUE_NAMES = Object.keys(REG_STATE_KEYS)
const STATE_KEYS = Object.values(REG_STATE_KEYS)

const SCHEMA_VERSION = 1
const LOOPBACK_HOST = '127.0.0.1'
// Every registry type the shared backup schema may carry (structural validity).
const REGISTRY_TYPES = ['REG_DWORD', 'REG_SZ', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BINARY', 'REG_QWORD', 'none']
// Exact registry types the backup may *restore*. Anything else is un-restorable.
const RESTORABLE_TYPES = ['REG_DWORD', 'REG_SZ', 'REG_EXPAND_SZ', 'REG_BINARY']

const ABSENT = { exists: false, type: 'none', value: null }

/** Resolve the brand-independent backup path (null when not resolvable). */
export function backupPath(env = process.env, base = process.platform === 'win32' ? env.APPDATA : null) {
  if (!base) return null
  return join(base, 'system-proxy', 'owned-backup.json')
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isSafeInteger(n) {
  return Number.isSafeInteger(n)
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

// Matches the Zod `.datetime({ offset: true })` surface exactly: a full ISO-8601
// `YYYY-MM-DDTHH:mm:ss(.fraction)?(Z|±HH:MM)` with real calendar validity (no
// `2024-13-45`, no `24:00:00`, no leap second `:60`) and a mandatory offset. This
// is deliberately re-derived here rather than importing zod, and it is pinned by
// the schema-alignment test so it can never drift from the TypeScript schema.
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isIsoDatetime(s) {
  if (typeof s !== 'string') return false
  const m = ISO_DATETIME.exec(s)
  if (!m) return false
  const year = +m[1]
  const month = +m[2]
  const day = +m[3]
  const hour = +m[4]
  const minute = +m[5]
  const second = +m[6]
  if (month < 1 || month > 12) return false
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > daysInMonth[month - 1]) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  return true
}

function hasOnlyKeys(obj, keys) {
  const allowed = new Set(keys)
  return Object.keys(obj).every((k) => allowed.has(k))
}

/**
 * Structural validation that mirrors the TS/Zod `systemProxyBackupSchema`
 * exactly (the single source of truth). It does NOT pass judgment on whether a
 * type is restorable — that is a separate {@link validateRestorableState} check,
 * matching the two-stage validation the app performs (Zod schema, then
 * `validateRestorable`). Returns a list of problem strings (empty = valid).
 */
export function validateBackupShape(backup) {
  const problems = []
  if (!isPlainObject(backup)) return ['<backup-not-an-object>']
  if (!hasOnlyKeys(backup, ['schemaVersion', 'instanceId', 'createdAt', 'target', 'previous', 'written'])) {
    problems.push('unknown top-level key(s) in backup')
  }
  if (backup.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${SCHEMA_VERSION}; got ${JSON.stringify(backup.schemaVersion)}`)
  }
  if (typeof backup.instanceId !== 'string' || !backup.instanceId) problems.push('instanceId must be a non-empty string')
  if (!isIsoDatetime(backup.createdAt)) problems.push('createdAt must be an ISO-8601 datetime with an offset')
  if (!isPlainObject(backup.target)) {
    problems.push('target must be an object')
  } else {
    if (!hasOnlyKeys(backup.target, ['host', 'port'])) problems.push('unknown key(s) in target')
    if (backup.target.host !== LOOPBACK_HOST) {
      problems.push(`target.host must be loopback '${LOOPBACK_HOST}'; got ${JSON.stringify(backup.target.host)}`)
    }
    if (!isSafeInteger(backup.target.port) || backup.target.port < 1 || backup.target.port > 65535) {
      problems.push(`target.port must be a safe integer in 1-65535; got ${JSON.stringify(backup.target.port)}`)
    }
  }
  for (const key of ['previous', 'written']) {
    const state = backup[key]
    if (!isPlainObject(state)) {
      problems.push(`${key} must be a registry state object`)
      continue
    }
    if (!hasOnlyKeys(state, STATE_KEYS)) problems.push(`unknown key(s) in ${key}`)
    for (const name of STATE_KEYS) {
      const shapeProblem = validateRegistryValueShape(state[name])
      if (shapeProblem) problems.push(`${key}.${name}: ${shapeProblem}`)
    }
  }
  return problems
}

function validateRegistryValueShape(v) {
  if (!isPlainObject(v)) return 'must be a registry value object'
  if (typeof v.exists !== 'boolean') return 'exists must be a boolean'
  if (!REGISTRY_TYPES.includes(v.type)) return `unknown registry type '${v.type}'`
  if (!Object.prototype.hasOwnProperty.call(v, 'value')) return 'value must be present'
  if (v.exists === false) {
    if (v.type !== 'none' || v.value !== null) return 'absent value must be {type:"none", value:null}'
    return null
  }
  if (v.exists === true) {
    if (v.type === 'none') return 'present value cannot have type "none"'
    const numeric = v.type === 'REG_DWORD' || v.type === 'REG_QWORD'
    if (numeric) {
      if (typeof v.value !== 'number' || !isSafeInteger(v.value) || v.value < 0) {
        return `${v.type} value must be a non-negative safe integer`
      }
    } else if (typeof v.value !== 'string') {
      return `${v.type} value must be a string`
    }
    return null
  }
  return 'exists must be a boolean'
}

/**
 * Restorability check mirroring the app's `validateRestorable`: reg.exe can only
 * faithfully restore the types in {@link RESTORABLE_TYPES}, so a `previous` (or
 * `written`) state carrying anything else must refuse to restore rather than
 * guess. This is deliberately a *separate* concern from structural validity.
 */
export function validateRestorableState(state) {
  const problems = []
  if (!isPlainObject(state)) return ['<state-not-an-object>']
  for (const name of STATE_KEYS) {
    const v = state[name]
    if (!isPlainObject(v)) {
      problems.push(`${name}: must be a registry value object`)
      continue
    }
    if (v.exists === false) {
      if (v.type !== 'none' || v.value !== null) problems.push(`${name}: absent value must be {type:"none", value:null}`)
      continue
    }
    if (!RESTORABLE_TYPES.includes(v.type)) {
      problems.push(`${name}: type '${v.type}' cannot be faithfully restored`)
      continue
    }
    if (v.type === 'REG_DWORD') {
      if (!isSafeInteger(v.value) || v.value < 0) problems.push(`${name}: REG_DWORD value must be a non-negative safe integer`)
      continue
    }
    if (typeof v.value !== 'string') problems.push(`${name}: ${v.type} value must be a string`)
  }
  return problems
}

/** Two registry values are equal only when exists, type and value all match. */
export function sameRegistryValue(a, b) {
  if (!a || !b) return false
  if (a.exists !== b.exists) return false
  if (a.type !== b.type) return false
  if (a.value !== b.value) return false
  return true
}

/** True when `observed` matches the written/enabled snapshot on every value. */
export function isOwned(observed, written) {
  if (!observed || !written) return false
  return STATE_KEYS.every((name) => sameRegistryValue(observed[name], written[name]))
}

/** The reg.exe argv that restores `value` with its exact type (delete when absent). */
export function restoreArgs(valueName, value) {
  if (value.exists === false) {
    return ['delete', KEY, '/v', valueName, '/f']
  }
  return ['add', KEY, '/v', valueName, '/t', value.type, '/d', String(value.value), '/f']
}

/**
 * Parse `reg query` stdout into a typed value.
 *
 * `reg.exe query <key> /v <name>` prints a key-path header line followed by one
 * value line (e.g. `    ProxyEnable    REG_DWORD    0x1`). The whole stdout is
 * passed here, so we scan line-by-line for the value line and ignore the header
 * (the header never starts with a REG_* label). A value-not-found line is
 * treated as absent; anything with a non-zero exit never reaches here (the
 * caller maps it to absence or a failure first).
 *
 * This is the **legacy** text parser and is intentionally fail-closed for
 * numeric values (P1-1): an unparseable REG_DWORD / REG_QWORD hex line is a read
 * failure and throws rather than being silently coerced to `0`. When `valueName`
 * is supplied only that name's line is accepted; an exit-0 result with no
 * matching line is a read failure, never a phantom absence. (The canonical read
 * path is the PowerShell/.NET reader in `buildRegistryReadScript()`, which also
 * preserves exact strings that this text parser cannot.)
 */
export function parseRegQueryValue(raw, valueName = '') {
  const text = String(raw || '')
  let absent = false
  let sawValueLine = false
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+((?:REG|QWORD)[A-Z0-9_]*)\s+(.*)$/)
    if (!m) continue
    if (/error|unable to find|not\s+found|cannot/i.test(line)) {
      // A value-not-found line is absent (uncorrelated with the loop; the caller
      // maps a non-zero exit to failure before this is reachable on error).
      absent = true
      continue
    }
    if (valueName !== '' && m[1] !== valueName) continue
    sawValueLine = true
    const type = m[2]
    const rawValue = m[3]
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      const hex = rawValue.trim().replace(/^0[xX]/, '')
      if (hex === '' || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error(`cannot parse ${type} hex value: ${JSON.stringify(rawValue)}`)
      }
      const n = parseInt(hex, 16)
      if (!Number.isFinite(n)) throw new Error(`cannot parse ${type} hex value: ${JSON.stringify(rawValue)}`)
      return { exists: true, type, value: n }
    }
    return { exists: true, type, value: rawValue }
  }
  if (absent) return { ...ABSENT }
  if (valueName !== '') {
    throw new Error(`reg query output had no line for value '${valueName}'`)
  }
  if (!sawValueLine) throw new Error('reg query output had no registry value line')
  throw new Error('reg query output had no registry value line')
}

function looksLikeAccessDenied(text) {
  return /access\s+is\s+denied|access.*denied|denied|拒绝访问|无法打开|permission denied/i.test(text)
}

/**
 * Run the headless recovery against `backupFile`.
 *
 * @param {string} backupFile exact path of the owned-backup JSON.
 * @param {{
 *   log?: (msg: string) => void,
 *   dryRun?: boolean,
 *   onNonWindows?: 'noop' | 'throw',
 *   runner?: { isWin: boolean, exec: Function, fs?: object }
 * }} [opts]
 * @returns {Promise<{phase: string, ok: boolean, errorMessage?: string, conflictDetail?: string}>}
 */
export async function runRecovery(backupFile, opts = {}) {
  const log = opts.log ?? (() => {})
  const runner = opts.runner ?? defaultRunner()
  const dryRun = opts.dryRun === true

  // On a non-Windows host there is no reg.exe / HKCU key to touch; report the
  // safe "nothing to do" verdict unless the caller demands a throw.
  if (runner.isWin === false && opts.onNonWindows !== 'throw') {
    log('non-Windows host: nothing to restore')
    return { phase: 'disabled', ok: true }
  }
  if (!backupFile) {
    return { phase: 'disabled', ok: true }
  }

  // --- 1) Read + validate the backup -----------------------------------------
  let backup = null
  try {
    const raw = await runner.fs.readFile(backupFile, 'utf8')
    backup = JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('no owned backup: nothing to restore')
      return { phase: 'disabled', ok: true }
    }
    log(`backup unreadable: ${error.message}`)
    return { phase: 'conflict', ok: false, errorMessage: '系统代理备份文件损坏或无权限读取', conflictDetail: error.message }
  }
  const problems = validateBackupShape(backup)
  if (problems.length) {
    log(`backup schema invalid: ${problems.join('; ')}`)
    return {
      phase: 'conflict',
      ok: false,
      errorMessage: '系统代理备份无效，已停止以避免覆盖',
      conflictDetail: problems.join('; ')
    }
  }
  // Mirror the app's two-stage validation: a structurally valid backup may still
  // carry a registry type reg.exe cannot restore (e.g. REG_MULTI_SZ). Refuse
  // before any write rather than guessing.
  const restorableProblems = validateRestorableState(backup.previous)
  if (restorableProblems.length) {
    log(`backup not restorable: ${restorableProblems.join('; ')}`)
    return {
      phase: 'conflict',
      ok: false,
      errorMessage: '系统代理备份含无法安全还原的注册表项',
      conflictDetail: restorableProblems.join('; ')
    }
  }

  // --- 2) Only auto-restore when the registry still matches our written state ---
  let observed
  try {
    observed = await readRegistry(runner)
  } catch (error) {
    log(`cannot read registry: ${error.message}`)
    return {
      phase: 'restore-failed',
      ok: false,
      errorMessage: '无法读取注册表以确认系统代理状态',
      conflictDetail: error.message
    }
  }
  // A prior run may have restored the registry but failed to delete the backup
  // (e.g. a transient file lock). Detect that state and just retry cleanup so a
  // stale backup is never mistaken for a live ownership conflict on next launch.
  if (isOwned(observed, backup.previous)) {
    log('registry already matches the pre-enable state; retrying cleanup of the stale backup')
    if (!dryRun) {
      try {
        await runner.fs.unlink(backupFile)
      } catch (error) {
        log(`stale-backup cleanup failed: ${error.message}`)
        return {
          phase: 'restore-failed',
          ok: false,
          errorMessage: '系统代理先前已还原，但备份文件删除失败，请重试清理',
          conflictDetail: error.message
        }
      }
    }
    log('stale backup cleared')
    return { phase: 'disabled', ok: true }
  }
  if (!isOwned(observed, backup.written)) {
    log('registry no longer matches the written state; reporting conflict without overwrite')
    return {
      phase: 'conflict',
      ok: true,
      conflictDetail: '检测到外部修改，已跳过自动还原以保留当前值'
    }
  }

  try {
    // --- 3) Restore the exact pre-enable values (types preserved) ---------------
    await restoreRegistry(runner, backup.previous)

    // Refresh WinINet so the per-user proxy is reloaded. A refresh failure on the
    // restore path is a hard error: keep the backup and report restore-failed.
    const refreshOk = await refreshWinInet(runner)
    if (!refreshOk) {
      log('refresh failed after restore; keeping backup')
      return {
        phase: 'restore-failed',
        ok: false,
        errorMessage: '系统代理还原后刷新失败，已保留备份'
      }
    }

    // --- 4) Verify read-back, then (and only then) delete the backup ------------
    const readback = await readRegistry(runner)
    const restored = isOwned(readback, backup.previous)
    if (!restored) {
      log('read-back verify failed after restore; keeping backup')
      return {
        phase: 'restore-failed',
        ok: false,
        errorMessage: '系统代理还原后校验不一致，已保留备份'
      }
    }
    if (!dryRun) {
      try {
        await runner.fs.unlink(backupFile)
      } catch (error) {
        // The registry is already restored and verified; a failure to remove the
        // backup is surfaced (not swallowed) so the caller can react, and marks
        // the next launch to retry cleanup rather than report a false conflict.
        log(`restore verified but backup delete failed: ${error.message}`)
        return {
          phase: 'restore-failed',
          ok: false,
          errorMessage: '系统代理已还原成功，但备份文件删除失败，请重试清理',
          conflictDetail: error.message
        }
      }
    }
    log('restore verified and backup removed')
    return { phase: 'disabled', ok: true }
  } catch (error) {
    log(`restore failed: ${error.message}`)
    return {
      phase: 'restore-failed',
      ok: false,
      errorMessage: '系统代理还原失败，已保留备份',
      conflictDetail: error.message
    }
  }
}

/**
 * Read the three HKCU Internet Settings values into a camelCase state object via
 * the shared PowerShell/.NET reader (exact strings + exact registry types, P1-2).
 * The output is strictly coerced (P1-1): a malformed value is a read failure.
 */
export async function readRegistry(runner) {
  const res = await runner.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', buildRegistryReadScript()], 'registry read')
  if (res.code !== 0) {
    if (looksLikeAccessDenied(`${res.stderr}${res.stdout}`)) {
      throw new Error('registry read access denied')
    }
    throw new Error(`registry read failed (${res.code})`)
  }
  const snapshot = coerceRegistrySnapshot(res.stdout)
  return {
    proxyEnable: snapshot.ProxyEnable,
    proxyServer: snapshot.ProxyServer,
    proxyOverride: snapshot.ProxyOverride
  }
}

/** Apply `state` with each value's exact type (delete when absent). */
export async function applyRegistry(runner, state) {
  for (const regName of REG_VALUE_NAMES) {
    const value = state[REG_STATE_KEYS[regName]]
    const args = restoreArgs(regName, value)
    const res = await runner.exec('reg.exe', args, 'reg write')
    if (res.code !== 0) throw new Error(`write ${regName} failed (${res.code}): ${res.stderr}`)
  }
}

/** Apply the pre-enable values with their exact type (delete when absent). */
async function restoreRegistry(runner, previous) {
  await applyRegistry(runner, previous)
}

/** Signal WinINet to reload the per-user proxy; false when either call or last-error fails. */
async function refreshWinInet(runner) {
  const script = buildRefreshScript()
  const res = await runner.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 'powershell refresh')
  return res.code === 0
}

/**
 * The canonical WinINet refresh script, shared byte-for-byte with the TypeScript
 * `buildWinInetRefreshScript()` in the main app (see the static equality test in
 * `tests/system-proxy-windows-helpers.test.ts`). It intentionally does NOT cache
 * the last Win32 error after a *successful* call — a stale non-zero last-error
 * from an unrelated prior call would otherwise be misread as a failure. Each call
 * reads `GetLastWin32Error()` only in the branch where that call returned false,
 * and a failure exits non-zero so the caller (adapter / recovery) treats the
 * refresh as failed.
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

export function buildRefreshScript() {
  return WIN_INET_REFRESH_SCRIPT
}

/**
 * The canonical .NET registry-read script, shared byte-for-byte with the main app
 * (`buildRegistryReadScript()` in the TypeScript adapter) and the CI snapshot
 * helper (`scripts/system-proxy-snapshot.ps1`). It reads the three HKCU Internet
 * Settings values in ONE `[Microsoft.Win32.Registry]` call, which returns the
 * EXACT stored string, the exact `RegistryValueKind` (REG_SZ vs REG_EXPAND_SZ vs
 * REG_MULTI_SZ vs REG_BINARY), and never expands environment names (a
 * REG_EXPAND_SZ keeps its `%VAR%`). It emits a single JSON object on stdout:
 *
 *   { "ProxyEnable":{exists,type,value}, "ProxyServer":{...}, "ProxyOverride":{...} }
 *
 * REG_DWORD / REG_QWORD as numbers; REG_BINARY as an UPPERCASE hex string;
 * REG_MULTI_SZ joined with ';'; REG_SZ / REG_EXPAND_SZ as the exact string. A
 * missing value is `{exists:false,type:'none',value:null}`.
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

export function buildRegistryReadScript() {
  return REGISTRY_READ_SCRIPT
}

const SNAPSHOT_KEYS = ['ProxyEnable', 'ProxyServer', 'ProxyOverride']

/** Strictly coerce one value object from the registry snapshot JSON (fail-closed). */
function coerceRegistryValue(raw, name) {
  if (!isPlainObject(raw)) throw new Error(`registry snapshot is missing '${name}'`)
  const { exists, type, value } = raw
  if (typeof exists !== 'boolean') throw new Error(`registry snapshot ${name}.exists is not a boolean`)
  if (!exists) {
    if (type !== 'none' || value !== null) throw new Error(`registry snapshot ${name} is absent but inconsistent`)
    return { ...ABSENT }
  }
  if (typeof type !== 'string' || !REGISTRY_TYPES.includes(type) || type === 'none') {
    throw new Error(`registry snapshot ${name}.type is invalid`)
  }
  if (type === 'REG_DWORD' || type === 'REG_QWORD') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`registry snapshot ${name} is not a valid ${type} number`)
    }
    return { exists: true, type, value }
  }
  if (typeof value !== 'string') throw new Error(`registry snapshot ${name} is not a valid ${type} string`)
  return { exists: true, type, value }
}

/** Parse the `REGISTRY_READ_SCRIPT` JSON stdout into the canonical snapshot. */
export function coerceRegistrySnapshot(stdout) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout || ''))
  } catch (error) {
    throw new Error(`registry snapshot is not valid JSON: ${error.message}`)
  }
  if (!isPlainObject(parsed)) throw new Error('registry snapshot is not a JSON object')
  const snapshot = {}
  for (const name of SNAPSHOT_KEYS) {
    snapshot[name] = coerceRegistryValue(parsed[name], name)
  }
  return snapshot
}

/** Default runner over the real Windows tools. Tests inject a mock. */
export function defaultRunner() {
  const exec = async (command, args, what) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })
      const code = 0
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code }
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : -1
      if (typeof error.code === 'string') {
        throw new Error(`${what || command} transport failure: ${error.code}: ${error.message}`)
      }
      return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code }
    }
  }
  return {
    isWin,
    exec,
    fs: {
      readFile: (p, enc) => readFile(p, enc),
      unlink: (p) => unlink(p),
      writeFile,
      rename,
      mkdir,
      randomUUID: () => randomUUID()
    }
  }
}

function parseCli(argv) {
  const opts = { backupPath: null, dryRun: false, printRefreshScript: false, printReadScript: false, validate: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--backup') opts.backupPath = argv[++i]
    else if (argv[i] === '--dry-run') opts.dryRun = true
    else if (argv[i] === '--print-refresh-script') opts.printRefreshScript = true
    else if (argv[i] === '--print-read-script') opts.printReadScript = true
    else if (argv[i] === '--validate') opts.validate = argv[++i]
  }
  return opts
}

async function main() {
  const opts = parseCli(process.argv)

  if (opts.printRefreshScript) {
    process.stdout.write(buildRefreshScript())
    return
  }

  if (opts.printReadScript) {
    process.stdout.write(buildRegistryReadScript())
    return
  }

  // Cross-check mode used by the schema-alignment test: validate an arbitrary
  // backup payload (a JSON string or a path to a JSON file) and print the
  // structural + restorability problems. Exits 0 when structurally valid and
  // restorable, 1 otherwise.
  if (opts.validate !== null) {
    let input = opts.validate
    if (input !== '-' && (input.startsWith('{') || input.startsWith('['))) {
      // Already an inline JSON string.
    } else {
      try {
        input = await readFile(input, 'utf8')
      } catch (error) {
        process.stderr.write(`[recover] --validate cannot read ${opts.validate}: ${error.message}\n`)
        process.exitCode = 1
        return
      }
    }
    let payload
    try {
      payload = JSON.parse(input)
    } catch (error) {
      process.stdout.write(JSON.stringify({ parseError: `not valid JSON: ${error.message}` }))
      process.exitCode = 1
      return
    }
    const structural = validateBackupShape(payload)
    const restorable = validateRestorableState(payload?.previous)
    const verdict = { structural, restorable, valid: structural.length === 0 && restorable.length === 0 }
    process.stdout.write(JSON.stringify(verdict, null, 2))
    process.stdout.write('\n')
    process.exitCode = verdict.valid ? 0 : 1
    return
  }

  const path = opts.backupPath ?? backupPath()
  try {
    const verdict = await runRecovery(path, {
      log: (msg) => process.stdout.write(`[recover] ${msg}\n`),
      dryRun: opts.dryRun
    })
    process.stdout.write(`[recover] ${JSON.stringify(verdict)}\n`)
    process.exitCode = verdict.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`[recover] FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
