import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { MihomoKernelResolver } from '../src/main/kernel/resolvers'
import { MihomoKernelConfigStore, findFreePort } from '../src/main/kernel/mihomo-config-store'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { randomSecret } from '../src/main/kernel/mihomo-config'
import { EvidenceFile } from './kernel-evidence'
import type {
  KernelBinary,
  KernelDependencies,
  KernelExitInfo,
  KernelProcessAdapter,
  KernelProcessHandle
} from '../src/main/kernel/types'

/**
 * Real-kernel fault injection for the CI watchdog (P1 acceptance gap).
 *
 * The goal is to prove the external `scripts/kernel-watchdog-cleanup.mjs` — the
 * exact script the CI `if: always()` finally step runs — reaps a LIVE
 * watchdog-restarted kernel after the process that spawned it died without
 * calling `supervisor.stop()`.
 *
 * On Windows a child spawned WITHOUT `detached: true` is torn down when its
 * parent exits, so the ordinary production adapter would leave NO live orphan to
 * reap (the just-observed CI behaviour: `recorded mihomo PID X is gone`). To make
 * the orphan genuinely survive the worker's death we use a TEST-ONLY
 * `DetachedKernelProcessAdapter` that spawns mihomo with `detached: true` and
 * `stdio: 'ignore'` — the documented Windows mechanism for a child to outlive
 * its parent. Everything else (supervisor, watchdog restart, config store,
 * evidence) is the real production path.
 */
const enabled = process.env.MURGE_RUN_REAL_KERNEL === '1'
const run = enabled ? describe : describe.skip

export const CRASH_MARKER = 'CRASH-DRIVER-REACHED-CRASH-POINT'

const evidencePath = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'mihomo-cleanup-fault-evidence.json')
  : join(tmpdir(), 'mihomo-cleanup-fault-evidence.json')

/** Detached spawn so the kernel survives the death of its parent (the worker). */
class DetachedKernelProcessHandle implements KernelProcessHandle {
  readonly pid: number | undefined
  private readonly child: ChildProcess

  constructor(child: ChildProcess) {
    this.child = child
    this.pid = child.pid
  }

  onStdout(listener: (text: string) => void): void {
    this.child.stdout?.on('data', (chunk) => listener(String(chunk)))
  }

  onStderr(listener: (text: string) => void): void {
    this.child.stderr?.on('data', (chunk) => listener(String(chunk)))
  }

  onExit(listener: (info: KernelExitInfo) => void): void {
    this.child.on('exit', (code, signal) => listener({ code, signal }))
  }

  onError(listener: (error: Error) => void): void {
    this.child.on('error', (error) => listener(error))
  }

  sendSignal(signal: NodeJS.Signals): boolean {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return false
    if (this.child.pid == null) return false
    try {
      process.kill(this.child.pid, signal)
      return true
    } catch {
      return false
    }
  }
}

class DetachedKernelProcessAdapter implements KernelProcessAdapter {
  spawn(binary: KernelBinary): KernelProcessHandle {
    const child = spawn(binary.command, binary.args, {
      cwd: binary.cwd,
      env: { ...process.env, ...(binary.env ?? {}) },
      // 'ignore' (not a pipe) so the orphan is not killed by an EPIPE when the
      // parent that owned the pipe is torn down. Readiness is polled via /version.
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      detached: true
    })
    child.unref()
    return new DetachedKernelProcessHandle(child)
  }

  isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

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
      adapter: new DetachedKernelProcessAdapter(),
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
    // is spawned detached, so it is orphaned and stays alive; the shared cleanup
    // script reaps it.
    writeSync(1, `${CRASH_MARKER}\n`)
    process.kill(process.pid, 'SIGKILL')
  }, 180000)
})
