import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, unlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { WindowsSystemProxyAdapter } from '../src/main/system-proxy/adapters/windows-adapter'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FileSystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import { captureNetworkSnapshot, type NetworkSnapshot } from './real-network-snapshot'
import type { SystemProxyTarget, SystemProxyRegistryState } from '../src/main/system-proxy/types'
import type { RegistryValue } from '../src/main/system-proxy/types'

/**
 * Real system-proxy lifecycle + crash-recovery against a live Windows HKCU
 * Internet Settings key. Gated behind MURGE_RUN_REAL_SYSTEM_PROXY=1 AND the
 * win32 platform so it never runs in the default `npm test`; it is only meant
 * for the disposable CI Windows runner (or an explicitly opted-in local Windows
 * box). Every test restores the exact original values in a `finally` so a failing
 * assertion can never leave the host's proxy changed.
 *
 * The system proxy here is *registered* (ProxyServer/ProxyEnable/ProxyOverride)
 * but NOT served — no socket is bound, so no real traffic is proxied. The only
 * observable effect is the per-user registry, which the finally block resets.
 *
 * Two scenarios:
 *   - lifecycle: pre-save 3 values -> enable -> normal disable -> precise restore,
 *     proving WinHTTP/routes/DNS/adapters/firewall are untouched and only
 *     `internetSettingsProxy` changed while enabled.
 *   - crash-recovery: a detached owner process enables the proxy then SIGKILLs
 *     itself without any restore; we then run the STANDALONE
 *     `scripts/recover-system-proxy.mjs` helper and prove it undoes the exact
 *     pre-enable values from the owned backup.
 */
const enabled = process.env.MURGE_RUN_REAL_SYSTEM_PROXY === '1' && process.platform === 'win32'
const run = enabled ? describe : describe.skip

const TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

const RECOVERY_HELPER = fileURLToPath(new URL('../scripts/recover-system-proxy.mjs', import.meta.url))
const OWNER_WORKER = fileURLToPath(new URL('../scripts/system-proxy-owner-crash.mjs', import.meta.url))

const dword = (value: number): RegistryValue => ({ exists: true, type: 'REG_DWORD', value })

// The owner-crash worker and the recovery helper are plain-node `.mjs` modules
// run as CHILD processes, never statically imported here: vitest's Windows
// transform chokes on a top-level `.mjs` import in a `.test.ts` module (see
// kernel-watchdog-cleanup.test.ts for the same rationale). Assertions read the
// worker's durable evidence file instead, so the values under test (the enabled
// "written" state, the crash marker) come from the worker itself and can never
// drift from a private in-test copy. This constant is the documented marker the
// worker emits before SIGKILL (must stay in sync with
// scripts/system-proxy-owner-crash.mjs).
const OWNER_CRASH_MARKER = 'SYSTEM-PROXY-OWNER-CRASHED'

async function waitForFile(path: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (true) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`waitForFile timed out: ${label}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** Capture the timing of a phase and fail if it exceeds the budget. */
async function timePhase<T>(label: string, budgetMs: number, fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  const result = await fn()
  const elapsed = Date.now() - start
  if (elapsed > budgetMs) {
    throw new Error(`phase '${label}' took ${elapsed}ms; budget ${budgetMs}ms`)
  }
  return result
}

/** Assert only `internetSettingsProxy` changed among the safety-relevant fields. */
function assertOnlyProxyChanged(before: NetworkSnapshot, during: NetworkSnapshot): void {
  const changed = Object.keys(during).filter((key) => during[key] !== before[key])
  expect(changed).toEqual(['internetSettingsProxy'])
}

/** Spawn CLI `node <script>` and resolve {code, stdout, stderr} on close. */
function runCli(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += String(d)))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

run('real Windows system-proxy lifecycle + crash recovery (gated)', () => {
  let tempDir = ''
  let service: SystemProxyService | null = null
  let adapter: WindowsSystemProxyAdapter | null = null
  let before: SystemProxyRegistryState | null = null

  afterEach(async () => {
    // Hard fallback: put back the exact pre-enable values regardless of ownership
    // so a failed test can never leave the host proxy pointing at a dead port.
    if (adapter && before) {
      await adapter.restore(before).catch(() => undefined)
    }
    if (service) {
      await service.restoreBeforeKernelUnavailable().catch(() => undefined)
      service = null
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('enable -> normal disable -> precise restore, only proxy fields touched', async () => {
    adapter = new WindowsSystemProxyAdapter()
    tempDir = await mkdtemp(join(tmpdir(), 'murge-sysproxy-life-'))
    const backup = FileSystemProxyBackupStore.forAppDataBase(tempDir)
    service = new SystemProxyService({
      adapter,
      probe: new StaticSystemProxyProbe(TARGET),
      backup,
      instanceId: 'real-windows-lifecycle'
    })

    // Pre-save the exact pre-enable registry values (the thing restore must match).
    before = await adapter.read()
    const beforeSnap = await captureNetworkSnapshot()

    // --- enable: only internetSettingsProxy may change --------------------
    const status = await timePhase('enable', 60000, () => service!.enable())
    expect(status.phase).toBe('enabled')
    expect(status.address).toBe('127.0.0.1:7890')
    expect(status.port).toBe(7890)

    const now = await adapter.read()
    expect(now.proxyEnable).toEqual(dword(1))
    expect(now.proxyServer.value).toBe('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890')

    const duringSnap = await captureNetworkSnapshot()
    assertOnlyProxyChanged(beforeSnap, duringSnap)

    // --- normal disable: exact restore ------------------------------------
    const disabled = await timePhase('disable', 60000, () => service!.disable())
    expect(disabled.phase).toBe('disabled')

    const after = await adapter.read()
    expect(after).toEqual(before)
    const afterSnap = await captureNetworkSnapshot()
    expect(afterSnap).toEqual(beforeSnap)
  }, 180000)

  it('force-kills the owner, then the STANDALONE recovery helper restores exactly', async () => {
    adapter = new WindowsSystemProxyAdapter()
    tempDir = await mkdtemp(join(tmpdir(), 'murge-sysproxy-crash-'))
    const backupFile = join(tempDir, 'system-proxy', 'owned-backup.json')
    const evidenceFile = join(tempDir, 'owner-evidence.json')

    before = await adapter.read()
    const beforeSnap = await captureNetworkSnapshot()

    // Spawn a detached owner that enables the proxy then hard-crashes (no restore).
    const owner: ChildProcess = spawn(process.execPath, [OWNER_WORKER, '--backup', backupFile, '--evidence', evidenceFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    owner.unref()

    await timePhase('owner-crash-worker', 60000, async () => {
      await waitForFile(evidenceFile, 60000, 'owner evidence')
      await waitForFile(backupFile, 60000, 'owned backup')
    })

    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
    expect(evidence.marker).toBe(OWNER_CRASH_MARKER)

    // The proxy is now enabled (the owner died with no restore) and a valid
    // owned backup is on disk — exactly the condition to fail-closed on. The
    // "written" state is read from the worker's own evidence, not a private copy.
    const enabledNow = await adapter.read()
    expect(enabledNow.proxyEnable).toEqual(dword(1))
    expect(enabledNow.proxyServer.value).toBe(evidence.written.proxyServer.value)

    // The owner persists the owned backup BEFORE applying and never deletes it on
    // a crash, so it MUST still be on disk and structurally valid for the
    // standalone helper to consume. (Deleting it here would leave the helper
    // nothing to restore from — the assertion is the positive presence, not the
    // absence, of the file.)
    const ownedBackup = JSON.parse(await readFile(backupFile, 'utf8'))
    expect(ownedBackup.schemaVersion).toBe(1)
    expect(ownedBackup.target).toEqual(TARGET)
    expect(ownedBackup.written).toEqual(evidence.written)

    // --- standalone recovery helper --------------------------------------
    const recovery = await timePhase('standalone-recovery', 60000, () => runCli(RECOVERY_HELPER, ['--backup', backupFile]))
    expect(recovery.stderr).toBe('')
    expect(recovery.code).toBe(0)

    const after = await adapter.read()
    expect(after).toEqual(before)
    // The recovered helper deletes the backup only after a confirmed restore.
    await expect(unlink(backupFile)).rejects.toMatchObject({ code: 'ENOENT' })
    const afterSnap = await captureNetworkSnapshot()
    expect(afterSnap).toEqual(beforeSnap)
  }, 180000)
})
