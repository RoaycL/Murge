import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Load the shared recovery script at runtime (see kernel-watchdog-cleanup.test.ts
// for why we avoid a static `.mjs` import in a `.test.ts`).
type RecoveryScript = typeof import('../scripts/recover-system-proxy.mjs')
let runRecovery: RecoveryScript['runRecovery']
let validateBackupShape: RecoveryScript['validateBackupShape']
let validateRestorableState: RecoveryScript['validateRestorableState']
let sameRegistryValue: RecoveryScript['sameRegistryValue']
let isOwned: RecoveryScript['isOwned']
let restoreArgs: RecoveryScript['restoreArgs']

beforeAll(async () => {
  if (process.platform === 'win32') return
  const mod = await import('../scripts/recover-system-proxy.mjs')
  runRecovery = mod.runRecovery
  validateBackupShape = mod.validateBackupShape
  validateRestorableState = mod.validateRestorableState
  sameRegistryValue = mod.sameRegistryValue
  isOwned = mod.isOwned
  restoreArgs = mod.restoreArgs
})

const describePortable = process.platform === 'win32' ? describe.skip : describe

const ABSENT = { exists: false, type: 'none', value: null }
const dword = (value: number) => ({ exists: true, type: 'REG_DWORD', value })
const str = (value: string) => ({ exists: true, type: 'REG_SZ', value })

const previous = { proxyEnable: dword(0), proxyServer: str('http=127.0.0.1:1'), proxyOverride: str('<local>') }
const written = { proxyEnable: dword(1), proxyServer: str('http=127.0.0.1:7890'), proxyOverride: str('<local>;localhost') }
const TARGET = { host: '127.0.0.1', port: 7890 }

function backupJson(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'test-instance',
    createdAt: new Date().toISOString(),
    target: TARGET,
    previous,
    written,
    ...overrides
  }
}

type V = { exists: boolean; type: string; value: string | number | null }

/** A stateful in-memory registry that round-trips the exact types over reg.exe. */
function makeRegistry(initial: Record<string, V> = {}) {
  const values: Record<string, V> = { ProxyEnable: { ...ABSENT }, ProxyServer: { ...ABSENT }, ProxyOverride: { ...ABSENT }, ...initial }
  const calls: Array<{ command: string; args: string[] }> = []

  const queryOut = (name: string, v: V) => {
    if (!v.exists) return { stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.', code: 1 }
    let raw: string
    if (v.type === 'REG_DWORD') raw = `0x${(v.value as number).toString(16)}`
    else raw = String(v.value)
    // Real reg.exe prints a key-path header line ahead of the value line; the
    // parser must ignore it (this reproduces that exact multi-line stdout).
    return { stdout: `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ${name}    ${v.type}    ${raw}`, stderr: '', code: 0 }
  }

  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args })
    if (command === 'powershell') {
      // Real script exits 0 when both InternetSetOption calls "succeed" (bools
      // both true and last-error 0). We model that as exit 0 by default.
      return { stdout: '', stderr: '', code: refreshCode }
    }
    // command === 'reg.exe'
    const op = args[0]
    if (op === 'query') {
      const name = args[3]
      return queryOut(name, values[name])
    }
    if (op === 'add') {
      const name = args[3]
      const type = args[5]
      const data = args[7]
      if (type === 'REG_DWORD') values[name] = { exists: true, type, value: Number(data) }
      else values[name] = { exists: true, type, value: data }
      return { stdout: '', stderr: '', code: 0 }
    }
    if (op === 'delete') {
      const name = args[3]
      values[name] = { ...ABSENT }
      return { stdout: '', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }

  return { exec, values, calls, setRefreshCode: (c: number) => { refreshCode = c } }
}

let refreshCode = 0
let dir: string
let runner: ReturnType<typeof makeRegistry>
let backupFile: string
const fs = { readFile: (p: string, e: string) => readFile(p, e as BufferEncoding), unlink: (p: string) => unlink(p) }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'murge-recover-'))
  backupFile = join(dir, 'owned-backup.json')
  refreshCode = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeBackup(data: unknown) {
  await writeFile(backupFile, JSON.stringify(data), 'utf8')
}

const opts = (extra: Record<string, unknown> = {}) => ({
  runner: {
    isWin: true,
    exec: (c: string, a: string[]) => runner.exec(c, a),
    fs
  },
  ...extra
})

describePortable('recover-system-proxy', () => {
  describe('pure helpers', () => {
    it('reports a missing value as absent and parses types preserving the label', () => {
      expect(sameRegistryValue({ exists: false, type: 'none', value: null }, { exists: false, type: 'none', value: null })).toBe(true)
      expect(sameRegistryValue({ exists: true, type: 'REG_EXPAND_SZ', value: 'x' }, { exists: true, type: 'REG_SZ', value: 'x' })).toBe(false)
    })

    it('isOwned requires exists/type/value to all match', () => {
      expect(isOwned({ proxyEnable: dword(1), proxyServer: str('x'), proxyOverride: str('y') }, written)).toBe(false)
      expect(isOwned({ proxyEnable: dword(1), proxyServer: str('http=127.0.0.1:7890'), proxyOverride: str('<local>;localhost') }, written)).toBe(true)
    })

    it('builds a delete argv for absent and an exact-type add for present values', () => {
      expect(restoreArgs('ProxyOverride', ABSENT)).toEqual(['delete', expect.any(String), '/v', 'ProxyOverride', '/f'])
      const add = restoreArgs('ProxyServer', { exists: true, type: 'REG_EXPAND_SZ', value: '%PATH%' })
      expect(add).toEqual(['add', expect.any(String), '/v', 'ProxyServer', '/t', 'REG_EXPAND_SZ', '/d', '%PATH%', '/f'])
    })
  })

  describe('validateBackupShape', () => {
    it('accepts a valid backup', () => {
      expect(validateBackupShape(backupJson())).toEqual([])
    })

    it('rejects a non-literal schemaVersion and a bad target/port', () => {
      expect(validateBackupShape(backupJson({ schemaVersion: '1' })).length).toBeGreaterThan(0)
      expect(validateBackupShape(backupJson({ target: { host: '0.0.0.0', port: 7890 } })).length).toBeGreaterThan(0)
      expect(validateBackupShape(backupJson({ target: { host: '127.0.0.1', port: 0 } })).length).toBeGreaterThan(0)
    })

    it('rejects a non-ISO createdAt and an unknown top-level key', () => {
      expect(validateBackupShape(backupJson({ createdAt: '2024-01-01' })).length).toBeGreaterThan(0)
      expect(validateBackupShape(backupJson({ extra: true })).length).toBeGreaterThan(0)
    })

    it('rejects a non-safe-integer port (float)', () => {
      expect(validateBackupShape(backupJson({ target: { host: '127.0.0.1', port: 7890.5 } })).length).toBeGreaterThan(0)
    })

    it('treats a present REG_MULTI_SZ as structurally valid but NOT restorable', () => {
      const bad = backupJson({ previous: { ...previous, proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } } })
      // Structural validity now mirrors the shared Zod schema (REG_MULTI_SZ is a
      // legal registry type), so the shape check passes...
      expect(validateBackupShape(bad)).toEqual([])
      // ...but restorability refuses it (reg.exe cannot faithfully restore it),
      // mirroring the app's validateRestorable.
      const restorable = validateRestorableState(bad.previous as never)
      expect(restorable.some((p) => p.includes('REG_MULTI_SZ'))).toBe(true)
    })
  })

  describe('runRecovery', () => {
    it('is a safe no-op (disabled) when there is no backup at all', async () => {
      runner = makeRegistry()
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'disabled', ok: true })
      expect(runner.calls.length).toBe(0)
    })

    it('fails closed on a corrupt backup without ever restoring', async () => {
      await writeBackup('not json')
      runner = makeRegistry()
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'conflict', ok: false })
      expect(runner.calls.length).toBe(0)
    })

    it('fails closed on a schema mismatch without ever restoring', async () => {
      await writeBackup(backupJson({ schemaVersion: '1' }))
      runner = makeRegistry()
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'conflict', ok: false })
      expect(runner.calls.length).toBe(0)
    })

    it('reports a conflict and does NOT overwrite when the registry no longer matches', async () => {
      await writeBackup(backupJson())
      // Registry has been externally mutated away from `written`.
      runner = makeRegistry({ ProxyEnable: dword(0) })
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'conflict', ok: true })
      // No delete / add write happened.
      expect(runner.calls.filter((c) => c.args[0] === 'delete' || c.args[0] === 'add').length).toBe(0)
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })

    it('restores the exact pre-enable values and deletes the backup on a confirmed restore', async () => {
      await writeBackup(backupJson())
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'disabled', ok: true })
      expect(runner.values.ProxyEnable).toEqual(dword(0))
      expect(runner.values.ProxyServer).toEqual(str('http=127.0.0.1:1'))
      expect(runner.values.ProxyOverride).toEqual(str('<local>'))
      await expect(unlink(backupFile)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('preserves REG_EXPAND_SZ / REG_BINARY during restore', async () => {
      const prev: Record<string, V> = {
        ProxyEnable: dword(0),
        ProxyServer: { exists: true, type: 'REG_EXPAND_SZ', value: '%PATH%\\p' },
        ProxyOverride: { exists: true, type: 'REG_BINARY', value: 'DEADBEEF' }
      }
      // Written values must still match the registry so ownership passes.
      const writ = {
        ProxyEnable: dword(1),
        ProxyServer: { exists: true, type: 'REG_SZ', value: 'http://127.0.0.1:7890' },
        ProxyOverride: { exists: true, type: 'REG_SZ', value: 'x' }
      }
      await writeBackup({ ...backupJson(), previous: { proxyEnable: prev.ProxyEnable, proxyServer: prev.ProxyServer, proxyOverride: prev.ProxyOverride }, written: { proxyEnable: writ.ProxyEnable, proxyServer: writ.ProxyServer, proxyOverride: writ.ProxyOverride } })
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http://127.0.0.1:7890'), ProxyOverride: str('x') })
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'disabled', ok: true })
      expect(runner.values.ProxyServer).toEqual({ exists: true, type: 'REG_EXPAND_SZ', value: '%PATH%\\p' })
      expect(runner.values.ProxyOverride).toEqual({ exists: true, type: 'REG_BINARY', value: 'DEADBEEF' })
    })

    it('keeps the backup when the refresh (WinINet) step fails', async () => {
      await writeBackup(backupJson())
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      runner.setRefreshCode(2)
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'restore-failed', ok: false })
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })

    it('keeps the backup when the read-back verify fails', async () => {
      await writeBackup(backupJson())
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      // After restore the registry is externally clobbered back to `written`, so
      // the read-back will not match `previous`. Force that by re-writing a wrong
      // value on ProxyEnable during the restore write.
      const original = runner.exec
      runner.exec = async (c: string, a: string[]) => {
        if (c === 'reg.exe' && a[0] === 'add' && a[3] === 'ProxyEnable') {
          runner.values.ProxyEnable = dword(1)
          return { stdout: '', stderr: '', code: 0 }
        }
        return original(c, a)
      }
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'restore-failed', ok: false })
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })

    it('keeps the backup when a restore write itself fails', async () => {
      await writeBackup(backupJson())
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      // Every restore write (add) returns an access-denied exit so the restore
      // step throws. readRegistry only issues `query`, which is left intact.
      const original = runner.exec
      runner.exec = async (c: string, a: string[]) => {
        if (c === 'reg.exe' && a[0] === 'add') return { stdout: '', stderr: 'access denied', code: 5 }
        return original(c, a)
      }
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'restore-failed', ok: false })
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })

    it('detects an already-restored state and retries cleanup (no false conflict)', async () => {
      await writeBackup(backupJson())
      // The registry already matches `previous` (the pre-enable snapshot) — the
      // signature of a restored-but-not-cleaned backup. runRecovery must retry the
      // delete and report 'disabled', never 'conflict'.
      runner = makeRegistry({ ProxyEnable: dword(0), ProxyServer: str('http=127.0.0.1:1'), ProxyOverride: str('<local>') })
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'disabled', ok: true })
      await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('surfaces restore-failed when a confirmed restore cannot delete the backup', async () => {
      await writeBackup(backupJson())
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      const verdict = await runRecovery(backupFile, opts({
        runner: {
          isWin: true,
          exec: (c: string, a: string[]) => runner.exec(c, a),
          fs: { readFile: (p: string, e: string) => readFile(p, e as BufferEncoding), unlink: () => Promise.reject(new Error('EBUSY: file is locked')) }
        }
      }))
      expect(verdict).toMatchObject({ phase: 'restore-failed', ok: false })
      // The backup is deliberately kept so the caller can retry cleanup.
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })

    it('refuses (conflict) a backup whose previous state carries an unrestorable type', async () => {
      await writeBackup(backupJson({ previous: { ...previous, proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } } }))
      runner = makeRegistry({ ProxyEnable: dword(1), ProxyServer: str('http=127.0.0.1:7890'), ProxyOverride: str('<local>;localhost') })
      const verdict = await runRecovery(backupFile, opts())
      expect(verdict).toMatchObject({ phase: 'conflict', ok: false })
      // Nothing was restored or deleted.
      expect(runner.calls.filter((c) => c.args[0] === 'delete' || c.args[0] === 'add').length).toBe(0)
      await expect(readFile(backupFile, 'utf8')).resolves.toBeTruthy()
    })
  })
})
