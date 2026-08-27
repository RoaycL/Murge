import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSync } from 'node:fs'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { NodeKernelProcessAdapter } from '../src/main/kernel/node-adapter'
import { MihomoKernelResolver } from '../src/main/kernel/resolvers'
import { MihomoKernelConfigStore, findFreePort } from '../src/main/kernel/mihomo-config-store'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { randomSecret } from '../src/main/kernel/mihomo-config'
import { EvidenceFile } from './kernel-evidence'
import type { KernelDependencies } from '../src/main/kernel/types'

/**
 * Real-kernel fault injection for the CI watchdog (P1 acceptance gap).
 *
 * This test deliberately leaves a watchdog-RESTARTED mihomo kernel alive and
 * un-stopped, then hard-kills its own worker process (SIGKILL self) so the
 * supervisor is gone and the recovered mihomo is truly orphaned. The standalone
 * `scripts/kernel-watchdog-cleanup.mjs` — the exact script the CI `if: always()`
 * finally step calls — is then the SOLE reaper. This proves the finally branch
 * that was never actually exercised by a green CI run (where the test process
 * exited before the finally could find & kill a live restarted kernel).
 *
 * Gated behind MURGE_RUN_REAL_KERNEL=1 exactly like the main integration test;
 * the default `npm test` skips it entirely.
 */
const enabled = process.env.MURGE_RUN_REAL_KERNEL === '1'
const run = enabled ? describe : describe.skip

export const CRASH_MARKER = 'CRASH-DRIVER-REACHED-CRASH-POINT'

const evidencePath = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'mihomo-cleanup-fault-evidence.json')
  : join(tmpdir(), 'mihomo-cleanup-fault-evidence.json')

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function waitForController(
  client: MihomoClient,
  supervisor: KernelSupervisor,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = supervisor.getStatus()
    if (status.phase === 'failed') {
      throw new Error(`mihomo failed to start: ${status.lastError ?? 'unknown'}`)
    }
    try {
      await client.getVersion()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('mihomo controller did not answer /version within timeout')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

run('mihomo real kernel crash-orphan fault injection', () => {
  let workspace = ''
  let supervisor: KernelSupervisor | null = null

  afterEach(async () => {
    // Safety net for a SETUP failure before the crash point (e.g. the watchdog
    // did not restart): stop + remove the workspace so an aborted setup does not
    // leak a process. When the crash point is reached the worker is SIGKILLed,
    // so this never runs and the recovered kernel is deliberately left orphaned
    // for the standalone cleanup script to reap.
    if (supervisor) {
      await supervisor.stop().catch(() => undefined)
      supervisor = null
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
      workspace = ''
    }
  })

  it('orphans a watchdog-restarted kernel and records evidence for external cleanup', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mihomo-cleanup-fault-'))
    const secret = randomSecret(32)
    const mixedPort = await findFreePort()
    let controllerPort = await findFreePort()
    while (controllerPort === mixedPort) {
      controllerPort = await findFreePort()
    }
    const configDir = join(workspace, 'config')

    const evidence = new EvidenceFile(evidencePath)
    const deps: KernelDependencies = {
      resolver: new MihomoKernelResolver({
        allowReal: true,
        workspaceDir: workspace,
        binaryPath: undefined,
        platform: process.platform,
        arch: process.arch
      }),
      configStore: new MihomoKernelConfigStore({ mixedPort, controllerPort, workspaceDir: configDir }),
      adapter: new NodeKernelProcessAdapter(),
      secret
    }
    supervisor = new KernelSupervisor(deps, {
      readinessPattern: null,
      startTimeoutMs: 30000,
      stopTimeoutMs: 20000,
      forceKillTimeoutMs: 5000,
      maxRestarts: 1,
      backoffMs: 500,
      maxBackoffMs: 2000
    })
    supervisor.onStatus((status) => {
      const pid = status.pid
      if (typeof pid === 'number' && pid > 0) {
        void evidence
          .update({ pid, controllerPort, mixedPort, workspace, configDir })
          .catch(() => undefined)
      }
    })

    const initial = await supervisor.start()
    expect(initial.phase).toBe('running')
    expect(initial.pid).toBeGreaterThan(0)
    expect(initial.version).toBe('1.19.30')
    const client = new MihomoClient(`http://127.0.0.1:${controllerPort}`, secret, { timeoutMs: 10000 })
    await waitForController(client, supervisor)
    const crashedPid = supervisor.getStatus().pid!
    expect(crashedPid).toBeGreaterThan(0)

    // Hard crash -> the supervisor watchdog restarts the kernel under a fresh PID.
    process.kill(crashedPid, 'SIGKILL')
    await waitFor(
      () => supervisor!.getStatus().phase === 'running' && supervisor!.getStatus().pid !== crashedPid,
      30000,
      'watchdog auto-restart after crash'
    )
    await waitForController(client, supervisor)
    const recoveredPid = supervisor.getStatus().pid!
    expect(recoveredPid).not.toBe(crashedPid)
    expect(supervisor.getStatus().phase).toBe('running')
    expect(isAlive(recoveredPid)).toBe(true)

    // The evidence file must carry the recovered (live) PID — the value the
    // cleanup script must reap — and it must be DURABLE before we crash the
    // worker, so the standalone reaper can rely on it.
    const recorded = await evidence.read()
    expect(recorded).not.toBeNull()
    expect(recorded!.pid).toBe(recoveredPid)
    await evidence.update({ pid: recoveredPid, controllerPort, mixedPort, workspace, configDir })

    // Simulate a hard crash of THIS test process/worker: emit the marker, then
    // SIGKILL ourselves WITHOUT calling supervisor.stop(). The recovered mihomo
    // is orphaned and stays alive; the shared cleanup script reaps it.
    writeSync(1, `${CRASH_MARKER}\n`)
    process.kill(process.pid, 'SIGKILL')
  }, 180000)
})
