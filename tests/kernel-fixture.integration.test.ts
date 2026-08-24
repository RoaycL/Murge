import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { FixtureKernelResolver, DisabledKernelResolver } from '../src/main/kernel/resolvers'
import { TempKernelConfigStore } from '../src/main/kernel/config-store'
import { NodeKernelProcessAdapter } from '../src/main/kernel/node-adapter'
import { ProtocolErrorCode } from '@shared/protocol-errors'

const fixturePath = fileURLToPath(new URL('../src/main/testing/kernel-fixture.mjs', import.meta.url))

function createFixtureSupervisor(extraArgs?: string[], options?: { maxRestarts?: number; stopTimeoutMs?: number }) {
  return new KernelSupervisor(
    {
      resolver: new FixtureKernelResolver({ fixturePath, extraArgs }),
      configStore: new TempKernelConfigStore(),
      adapter: new NodeKernelProcessAdapter(),
      secret: 's3cret'
    },
    {
      readinessPattern: /fixture-ready/,
      startTimeoutMs: 8000,
      stopTimeoutMs: options?.stopTimeoutMs ?? 2000,
      forceKillTimeoutMs: 2000,
      maxRestarts: options?.maxRestarts ?? 3
    }
  )
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('kernel fixture integration', () => {
  it('starts the fixture, proves a real PID, then stops it', async () => {
    const supervisor = createFixtureSupervisor()
    const running = await supervisor.start()
    expect(running.phase).toBe('running')
    expect(running.pid).toBeTypeOf('number')
    expect(running.pid!).toBeGreaterThan(0)
    expect(running.version).toBeNull()

    const adapter = new NodeKernelProcessAdapter()
    expect(adapter.isProcessAlive(running.pid!)).toBe(true)
    expect(supervisor.getRecentLogs().some((entry) => entry.text.includes('fixture-ready'))).toBe(true)

    const stopped = await supervisor.stop()
    expect(stopped.phase).toBe('stopped')
    expect(stopped.pid).toBeNull()
    await waitFor(() => !adapter.isProcessAlive(running.pid!))
  })

  it('detects a crash from the fixture and records the exit code', async () => {
    const supervisor = createFixtureSupervisor(['--exit-after-ms', '30', '--exit-code', '7'], { maxRestarts: 0 })
    const running = await supervisor.start()
    expect(running.phase).toBe('running')
    await waitFor(() => supervisor.getStatus().phase === 'failed')
    expect(supervisor.getStatus().lastError).toContain('exited with code 7')
  })

  it('fails a spawn when the command cannot be resolved', async () => {
    const supervisor = new KernelSupervisor(
      {
        resolver: { resolve: async () => ({ command: '/nonexistent/kernel-binary', args: [] }) },
        configStore: new TempKernelConfigStore(),
        adapter: new NodeKernelProcessAdapter(),
        secret: 's3cret'
      },
      { readinessPattern: /fixture-ready/ }
    )
    await expect(supervisor.start()).rejects.toMatchObject({ code: ProtocolErrorCode.KERNEL_SPAWN_FAILED })
    expect(supervisor.getStatus().phase).toBe('failed')
  })

  it('disabled resolver never yields a runnable command', async () => {
    const resolver = new DisabledKernelResolver()
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })

  it('the fixture opens no network listener in its source', async () => {
    const source = await readFile(fixturePath, 'utf8')
    expect(source).not.toMatch(/from ['"]node:net['"]/)
    expect(source).not.toMatch(/require\(['"]net['"]\)/)
    expect(source).not.toMatch(/\.listen\(/)
    expect(source).not.toMatch(/createServer\(/)
    expect(source).not.toMatch(/\.connect\(/)
    expect(source).not.toMatch(/http(s)?:\/\//)
  })
})
