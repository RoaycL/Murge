import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { NodeKernelProcessAdapter } from '../src/main/kernel/node-adapter'
import { MihomoKernelResolver } from '../src/main/kernel/resolvers'
import { MihomoKernelConfigStore, findFreePort } from '../src/main/kernel/mihomo-config-store'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { randomSecret } from '../src/main/kernel/mihomo-config'
import { captureNetworkSnapshot, assertNetworkUnchanged } from './real-network-snapshot'
import { listenersMatchingText } from './listener-tools'
import type { KernelDependencies } from '../src/main/kernel/types'

const execFileAsync = promisify(execFile)

/**
 * Real mihomo kernel integration. It is intentionally gated behind
 * MURGE_RUN_REAL_KERNEL=1 because it downloads the pinned official mihomo build
 * and launches it. It only ever runs in the disposable CI/VM job (or an
 * explicitly opted-in local run); the default `npm test` skips it entirely.
 */
const enabled = process.env.MURGE_RUN_REAL_KERNEL === '1'
const run = enabled ? describe : describe.skip

/**
 * Persistent evidence for the CI watchdog (P2 #11). The PID (and the ports the
 * test opened) are written to a runner-temp file so an `if: always()` finally
 * step can kill exactly the recorded process and verify cleanup — even if the
 * test crashed. Never write the controller secret here.
 */
const evidencePath = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'mihomo-real-kernel-evidence.json')
  : join(tmpdir(), 'mihomo-real-kernel-evidence.json')

async function writeKernelEvidence(data: Record<string, unknown>): Promise<void> {
  await writeFile(evidencePath, JSON.stringify(data), 'utf8')
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

/** Poll the mihomo controller until `/version` answers or the supervisor fails. */
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

/**
 * Enumerate the hosts listening on `port`, failing CLOSED when the listening
 * tooling is unavailable or no listener matches. Non-loopback hosts are
 * returned too so the caller can reject them — this never silently passes.
 * The parsing is split into a pure helper so it is unit-tested by default.
 */
async function listenersOn(port: number): Promise<string[]> {
  let stdout: string
  try {
    const res =
      process.platform === 'win32'
        ? await execFileAsync('netstat', ['-ano', '-p', 'TCP'])
        : await execFileAsync('ss', ['-ltna'])
    stdout = res.stdout
  } catch (error) {
    throw new Error(`listener tooling unavailable: ${(error as Error).message}`)
  }
  return listenersMatchingText(stdout, port, process.platform === 'win32')
}

run('mihomo real kernel integration', () => {
  let workspace = ''
  let supervisor: KernelSupervisor | null = null

  afterEach(async () => {
    if (supervisor) {
      await supervisor.stop().catch(() => undefined)
      supervisor = null
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
      workspace = ''
    }
  })

  it('downloads, verifies, starts, serves, stops and restarts the pinned mihomo', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    const before = await captureNetworkSnapshot()
    const secret = randomSecret(32)
    const mixedPort = await findFreePort()
    let controllerPort = await findFreePort()
    while (controllerPort === mixedPort) {
      controllerPort = await findFreePort()
    }
    const configDir = join(workspace, 'config')

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
      // Real readiness is verified by polling the controller, not a stdout line
      // (mihomo logs to stderr via its own logger). A null pattern means the
      // process is announced running immediately and readiness is our poll.
      readinessPattern: null,
      startTimeoutMs: 30000,
      stopTimeoutMs: 20000,
      forceKillTimeoutMs: 5000,
      maxRestarts: 1,
      backoffMs: 500,
      maxBackoffMs: 2000
    })

    const status = await supervisor.start()
    expect(status.phase).toBe('running')
    expect(status.pid).toBeGreaterThan(0)
    expect(status.version).toBe('1.19.30')
    await writeKernelEvidence({ pid: status.pid, controllerPort, mixedPort, workspace, configDir })

    const base = `http://127.0.0.1:${controllerPort}`
    const client = new MihomoClient(base, secret, { timeoutMs: 10000 })
    await waitForController(client, supervisor)

    // REST /version + auth.
    const version = await client.getVersion()
    expect(version.version).toBeTruthy()

    // Wrong secret must be rejected with 401 -> UNAUTHORIZED.
    const badClient = new MihomoClient(base, 'wrong-secret-0000000000000000', { timeoutMs: 5000 })
    await expect(badClient.getVersion()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    // Mode + rules evidence. The config path comes from the live supervisor so
    // it tracks the store-created workspace child (the store nests config.yaml
    // under a randomly named child of workspaceDir).
    const activeConfig = supervisor.getActiveConfig()
    expect(activeConfig).not.toBeNull()
    const configPath = activeConfig!.configPath
    expect(configPath.startsWith(configDir)).toBe(true)
    expect(configPath).toContain('config.yaml')
    const configText = await readFile(configPath, 'utf8')
    expect(configText).toContain('mode: direct')
    expect(configText).toContain('  - MATCH,DIRECT')
    const configs = await client.getConfig()
    expect(configs.mode).toBe('direct')

    // Loopback-only listeners. The controller port and the mixed port must each
    // show at least one listener, and every listener host must be loopback. A
    // missing listener or a non-loopback bind fails the test (fail closed).
    const listenerGroups = [controllerPort, mixedPort]
    for (const port of listenerGroups) {
      const hosts = await listenersOn(port)
      expect(hosts.length).toBeGreaterThanOrEqual(1)
      for (const host of hosts) {
        expect(host).toMatch(/^(127\.0\.0\.1|::1)$/)
      }
    }

    // WebSocket transport to the controller authenticates + opens.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${controllerPort}/traffic?token=${secret}`)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('WebSocket open timed out'))
      }, 8000)
      ws.once('open', () => {
        clearTimeout(timer)
        ws.close()
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    // Graceful stop releases the pid + ports.
    const firstPid = supervisor.getStatus().pid
    const stopped = await supervisor.stop()
    expect(stopped.phase).toBe('stopped')
    await waitFor(() => !isAlive(firstPid!), 5000, 'process exit after stop')

    // Limited restart produces a fresh pid against the same config.
    supervisor = new KernelSupervisor(deps, {
      readinessPattern: null,
      startTimeoutMs: 30000,
      stopTimeoutMs: 20000,
      forceKillTimeoutMs: 5000,
      maxRestarts: 1,
      backoffMs: 500,
      maxBackoffMs: 2000
    })
    const restarted = await supervisor.start()
    expect(restarted.phase).toBe('running')
    await writeKernelEvidence({ pid: restarted.pid, controllerPort, mixedPort, workspace, configDir })
    await waitForController(client, supervisor)
    expect(restarted.pid).not.toBe(firstPid)
    const stoppedRestarted = await supervisor.stop()
    expect(stoppedRestarted.phase).toBe('stopped')

    // Watchdog: a hard crash (SIGKILL of the real process) must be detected and
    // auto-restarted with a fresh pid, then cleaned up.
    supervisor = new KernelSupervisor(deps, {
      readinessPattern: null,
      startTimeoutMs: 30000,
      stopTimeoutMs: 20000,
      forceKillTimeoutMs: 5000,
      maxRestarts: 1,
      backoffMs: 500,
      maxBackoffMs: 2000
    })
    const crashed = await supervisor.start()
    expect(crashed.phase).toBe('running')
    await writeKernelEvidence({ pid: crashed.pid, controllerPort, mixedPort, workspace, configDir })
    await waitForController(client, supervisor)
    const crashedPid = supervisor.getStatus().pid
    expect(crashedPid).toBeGreaterThan(0)
    // Kill the child out from under the supervisor; it must observe the exit and
    // reschedule with a bounded backoff.
    process.kill(crashedPid!, 'SIGKILL')
    await waitFor(
      () => {
        const s = supervisor!.getStatus()
        return s.phase === 'running' && s.pid !== crashedPid
      },
      30000,
      'watchdog auto-restart after crash'
    )
    // The supervisor never exceeds its restart budget (so it stays failed rather
    // than flapping forever) and the recovered process serves the controller.
    expect(supervisor.getStatus().phase).toBe('running')
    await waitForController(client, supervisor)
    const watchdogStatus = supervisor.getStatus()
    expect(watchdogStatus.pid).not.toBe(crashedPid)
    await supervisor.stop()

    // P1 #9 network integrity: the run must not have mutated the host's proxy
    // settings, default routes, DNS or firewall.
    const after = await captureNetworkSnapshot()
    assertNetworkUnchanged(before, after)
  }, 180000)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
