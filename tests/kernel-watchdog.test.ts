import { describe, it, expect } from 'vitest'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { buildWatchdogScript, WATCHDOG_RELEASE_BYTE } from '../src/main/kernel/crash-watchdog'
import type {
  KernelBinary,
  KernelBinaryResolver,
  KernelConfig,
  KernelConfigStore,
  KernelExitInfo,
  KernelProcessAdapter,
  KernelProcessHandle,
  KernelWatchdog
} from '../src/main/kernel/types'

class StubResolver implements KernelBinaryResolver {
  binary: KernelBinary = { command: '/fake/kernel', args: ['--fixture'], version: '9.0.0' }
  async resolve(): Promise<KernelBinary> {
    return { ...this.binary }
  }
}

class StubStore implements KernelConfigStore {
  async materialize(_binary: KernelBinary, secret: string): Promise<KernelConfig> {
    return { configPath: '/tmp/kernel/config.yaml', rootDir: '/tmp/kernel', env: { KERNEL_SECRET: secret } }
  }
  async cleanup(): Promise<void> {}
}

class FakeHandle implements KernelProcessHandle {
  readonly pid: number | undefined
  private exits: Array<(info: KernelExitInfo) => void> = []
  private errors: Array<(error: Error) => void> = []
  constructor(pid: number | undefined) {
    this.pid = pid
  }
  onStdout(): void {}
  onStderr(): void {}
  onExit(l: (info: KernelExitInfo) => void): void {
    this.exits.push(l)
  }
  onError(l: (error: Error) => void): void {
    this.errors.push(l)
  }
  sendSignal(): boolean {
    this.emitExit({ code: 0, signal: null })
    return true
  }
  emitExit(info: KernelExitInfo): void {
    for (const l of [...this.exits]) l(info)
  }
  reject(error: Error): void {
    for (const l of [...this.errors]) l(error)
  }
}

class FakeAdapter implements KernelProcessAdapter {
  handles: FakeHandle[] = []
  private nextPid = 100
  spawn(binary: KernelBinary): KernelProcessHandle {
    void binary
    const handle = new FakeHandle(this.nextPid++)
    this.handles.push(handle)
    return handle
  }
  isProcessAlive(): boolean {
    return false
  }
  get lastHandle(): FakeHandle | null {
    return this.handles.length ? this.handles[this.handles.length - 1] : null
  }
}

interface WatchRecord {
  pid: number
  released: boolean
}

function createHarness(options: {
  maxRestarts?: number
  backoffMs?: number
  maxBackoffMs?: number
  restartBudgetResetMs?: number
} = {}) {
  const watches: WatchRecord[] = []
  const adapter = new FakeAdapter()
  const supervisor = new KernelSupervisor(
    {
      resolver: new StubResolver(),
      configStore: new StubStore(),
      adapter,
      secret: 's3cret',
      attachWatchdog: (pid: number): KernelWatchdog => {
        const record: WatchRecord = { pid, released: false }
        watches.push(record)
        return {
          release(): void {
            record.released = true
          }
        }
      }
    },
    {
      readinessPattern: null,
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
      forceKillTimeoutMs: 1000,
      maxRestarts: options.maxRestarts ?? 10,
      backoffMs: options.backoffMs ?? 5,
      maxBackoffMs: options.maxBackoffMs ?? 20,
      restartBudgetResetMs: options.restartBudgetResetMs ?? 60_000
    }
  )
  return { supervisor, adapter, watches }
}

const waitFor = async (cond: () => boolean): Promise<void> => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > 3000) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('KernelSupervisor crash watchdog', () => {
  it('distinguishes an explicit release byte from an unexpected parent EOF', () => {
    const script = buildWatchdogScript(4321)
    expect(WATCHDOG_RELEASE_BYTE).toBeGreaterThanOrEqual(0)
    expect(script).toContain('ReadByte()')
    expect(script).toContain('$releaseByte -eq -1')
    expect(script).toContain('taskkill.exe /PID 4321 /T /F')
  })

  it('attaches to every spawned kernel and releases on a clean stop', async () => {
    const { supervisor, adapter, watches } = createHarness()
    await supervisor.start()
    expect(watches).toHaveLength(1)
    expect(watches[0].pid).toBe(adapter.lastHandle!.pid)
    expect(watches[0].released).toBe(false)

    await supervisor.stop()
    expect(watches[0].released).toBe(true)
  })

  it('releases on a crash and re-attaches to the restarted kernel', async () => {
    const { supervisor, adapter, watches } = createHarness({ backoffMs: 5, maxBackoffMs: 10 })
    await supervisor.start()
    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    // Wait for the RESTARTED kernel (a bare phase check can race the exit
    // bookkeeping, which still reports the first run for a microtask).
    await waitFor(() => adapter.handles.length === 2 && supervisor.getStatus().phase === 'running')
    expect(watches).toHaveLength(2)
    expect(watches[0].released).toBe(true)
    expect(watches[1].pid).toBe(adapter.lastHandle!.pid)
    expect(watches[1].released).toBe(false)
    await supervisor.stop()
  })
})

describe('KernelSupervisor restart budget', () => {
  it('gives up after maxRestarts and stays failed', async () => {
    const { supervisor, adapter } = createHarness({ maxRestarts: 2, backoffMs: 5, maxBackoffMs: 10 })
    await supervisor.start()
    expect(adapter.handles).toHaveLength(1)

    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => adapter.handles.length === 2)
    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => adapter.handles.length === 3)
    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => supervisor.getStatus().phase === 'failed')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(adapter.handles).toHaveLength(3)
  })

  it('refills the budget after a sustained run, so a later crash restarts again', async () => {
    const { supervisor, adapter } = createHarness({
      maxRestarts: 1,
      backoffMs: 5,
      maxBackoffMs: 10,
      restartBudgetResetMs: 30
    })
    await supervisor.start()

    // First crash consumes the budget; the restarted kernel then runs long
    // enough to refill it, so the SECOND crash still gets a restart.
    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => adapter.handles.length === 2 && supervisor.getStatus().phase === 'running')
    await new Promise((resolve) => setTimeout(resolve, 60))

    adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => adapter.handles.length === 3)
    expect(supervisor.getStatus().phase).toBe('running')
  })
})
