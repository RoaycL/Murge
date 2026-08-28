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
// Exact registry types the backup may carry. Anything else is un-restorable.
const RESTORABLE_TYPES = ['REG_DWORD', 'REG_SZ', 'REG_EXPAND_SZ', 'REG_BINARY']

const ABSENT = { exists: false, type: 'none', value: null }

/** Resolve the brand-independent backup path (null when not resolvable). */
export function backupPath(env = process.env, base = process.platform === 'win32' ? env.APPDATA : null) {
  if (!base) return null
  return join(base, 'system-proxy', 'owned-backup.json')
}

/** Structurally validate the backup; returns a list of problem strings (empty = ok). */
export function validateBackupShape(backup) {
  const problems = []
  if (!backup || typeof backup !== 'object') return ['<backup-not-an-object>']
  if (backup.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${SCHEMA_VERSION}; got ${JSON.stringify(backup.schemaVersion)}`)
  }
  if (typeof backup.instanceId !== 'string' || !backup.instanceId) problems.push('instanceId must be a non-empty string')
  if (typeof backup.createdAt !== 'string' || !backup.createdAt) problems.push('createdAt must be a non-empty string')
  if (!backup.target || backup.target.host !== LOOPBACK_HOST) {
    problems.push(`target.host must be loopback '${LOOPBACK_HOST}'; got ${JSON.stringify(backup.target?.host)}`)
  }
  if (!Number.isInteger(backup.target?.port) || backup.target.port < 1 || backup.target.port > 65535) {
    problems.push(`target.port must be an integer in 1-65535; got ${JSON.stringify(backup.target?.port)}`)
  }
  for (const key of ['previous', 'written']) {
    const state = backup[key]
    if (!state || typeof state !== 'object') {
      problems.push(`${key} must be a registry state object`)
      continue
    }
    for (const name of STATE_KEYS) {
      const v = state[name]
      if (!v || typeof v !== 'object') {
        problems.push(`${key}.${name} must be a registry value object`)
        continue
      }
      const typeProblem = validateRegistryValueShape(v)
      if (typeProblem) problems.push(`${key}.${name}: ${typeProblem}`)
    }
  }
  return problems
}

function validateRegistryValueShape(v) {
  if (v.exists === false) {
    if (v.type !== 'none' || v.value !== null) return 'absent value must be {type:"none", value:null}'
    return null
  }
  if (v.exists !== true) return 'exists must be a boolean'
  if (v.type === 'none') return 'present value cannot have type "none"'
  if (!RESTORABLE_TYPES.includes(v.type)) return `unrestorable type '${v.type}'`
  if (v.type === 'REG_DWORD') {
    if (!Number.isInteger(v.value) || v.value < 0) return 'REG_DWORD value must be a non-negative integer'
    return null
  }
  if (typeof v.value !== 'string') return `${v.type} value must be a string`
  return null
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

/** Parse one `reg query` stdout line into a typed value. */
export function parseRegQueryValue(raw) {
  const line = String(raw || '').trim()
  const m = line.match(/^\s*(\S+)\s+((?:REG|QWORD)[A-Z_]*)\s+(.*)$/)
  if (!m) {
    return ABSENT
  }
  if (/error|unable|not\s+found|cannot/i.test(line)) {
    // A value-not-found line is absent; anything else with a non-zero exit is
    // surfaced as a failure by the caller (it never reaches here on error).
    return ABSENT
  }
  const type = m[2]
  let rawValue = m[3].trim()
  if (type === 'REG_DWORD' || type === 'REG_QWORD') {
    const n = parseInt(rawValue, 16)
    return { exists: true, type, value: Number.isFinite(n) ? n : 0 }
  }
  return { exists: true, type, value: rawValue }
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
      await runner.fs.unlink(backupFile).catch(() => undefined)
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

/** Read the three HKCU Internet Settings values into a camelCase state object. */
export async function readRegistry(runner) {
  const out = {}
  for (const regName of REG_VALUE_NAMES) {
    const res = await runner.exec('reg.exe', ['query', KEY, '/v', regName], 'reg query')
    if (res.code !== 0) {
      if (res.code === 1) {
        out[REG_STATE_KEYS[regName]] = { ...ABSENT }
        continue
      }
      if (looksLikeAccessDenied(`${res.stderr}${res.stdout}`)) {
        throw new Error(`reg query ${regName} access denied`)
      }
      throw new Error(`reg query ${regName} failed (${res.code})`)
    }
    out[REG_STATE_KEYS[regName]] = parseRegQueryValue(res.stdout)
  }
  return out
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

/** The PowerShell refresh script with the Win32 last-error check. */
export function buildRefreshScript() {
  return [
    '$ErrorActionPreference = "Stop";',
    '$t = [type]::GetType("Microsoft.Win32.NativeMethods")',
    'if (-not $t) { [System.Reflection.Assembly]::LoadWithPartialName("System") | Out-Null; $t = [type]::GetType("Microsoft.Win32.NativeMethods") }',
    'if (-not $t) { Write-Error "WinINet P/Invoke type unavailable"; exit 3 }',
    '$b1 = $t::InternetSetOption(0, 39, 0, 0)',
    '$b2 = $t::InternetSetOption(0, 37, 0, 0)',
    '$e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    'if (-not ($b1 -and $b2) -or $e -ne 0) { Write-Error "InternetSetOption failed ($b1/$b2, last-error=$e)"; exit 2 }',
    'exit 0'
  ].join(' ')
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
  const opts = { backupPath: null, dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--backup') opts.backupPath = argv[++i]
    else if (argv[i] === '--dry-run') opts.dryRun = true
  }
  return opts
}

async function main() {
  const opts = parseCli(process.argv)
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
