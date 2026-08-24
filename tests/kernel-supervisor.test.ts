import { describe, it, expect } from 'vitest'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type {
  KernelBinary,
  KernelBinaryResolver,
  KernelConfig,
  KernelConfigStore,
  KernelExitInfo,
  KernelProcessAdapter,
  KernelProcessHandle
} from '../src/main/kernel/types'
import { BoundedLogBuffer } from '../src/main/kernel/bounded-log'

class StubResolver implements KernelBinaryResolver {
  resolveCalls = 0
  error: Error | null = null
  binary: KernelBinary = { command: '/fake/kernel', args: ['--fixture'], version: '9.0.0' }

  async resolve(): Promise<KernelBinary> {
    this.resolveCalls += 1
    if (this.error) throw this.error
    return { ...this.binary }
  }
}

class StubStore implements KernelConfigStore {
  materializeCalls = 0
  cleanupCalls: KernelConfig[] = []
  lastSecret: string | null = null

  async materialize(_binary: KernelBinary, secret: string): Promise<KernelConfig> {
    this.materializeCalls += 1
    this.lastSecret = secret
    return { configPath: '/tmp/kernel/config.yaml', rootDir: '/tmp/kernel', env: { KERNEL_SECRET: secret } }
  }

  async cleanup(config: KernelConfig): Promise<void> {
    this.cleanupCalls.push(config)
  }
}

class FakeHandle implements KernelProcessHandle {
  readonly pid: number | undefined
  private stdout: Array<(text: string) => void> = []
  private stderr: Array<(text: string) => void> = []
  private exits: Array<(info: KernelExitInfo) => void> = []
  private errors: Array<(error: Error) => void> = []
  readonly signals: NodeJS.Signals[] = []
  private exited = false
  onSigterm: 'exits' | 'ignores' = 'exits'
  onSigkill: 'exits' | 'ignores' = 'exits'

  constructor(pid: number | undefined) {
    this.pid = pid
  }

  onStdout(l: (text: string) => void): void {
    this.stdout.push(l)
  }
  onStderr(l: (text: string) => void): void {
    this.stderr.push(l)
  }
  onExit(l: (info: KernelExitInfo) => void): void {
    this.exits.push(l)
  }
  onError(l: (error: Error) => void): void {
    this.errors.push(l)
  }
  sendSignal(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    if (signal === 'SIGTERM' && this.onSigterm === 'exits') this.emitExit({ code: 0, signal: null })
    if (signal === 'SIGKILL' && this.onSigkill === 'exits') this.emitExit({ code: null, signal: 'SIGKILL' })
    return true
  }
  emitStdout(text: string): void {
    for (const l of this.stdout) l(text)
  }
  emitStderr(text: string): void {
    for (const l of this.stderr) l(text)
  }
  emitError(error: Error): void {
    for (const l of this.errors) l(error)
  }
  emitExit(info: KernelExitInfo): void {
    if (this.exited) return
    this.exited = true
    for (const l of this.exits) l(info)
  }
}

class FakeAdapter implements KernelProcessAdapter {
  spawnCalls: KernelBinary[] = []
  alivePids = new Set<number>()
  private handles: FakeHandle[] = []
  private nextPid = 1
  /** Override returned pid (undefined simulates a spawn that produced no PID). */
  spawnPid: number | undefined | null = null

  spawn(binary: KernelBinary): FakeHandle {
    this.spawnCalls.push(binary)
    const pid = this.spawnPid === null ? this.nextPid++ : this.spawnPid
    const handle = new FakeHandle(pid)
    this.handles.push(handle)
    if (pid != null) this.alivePids.add(pid)
    return handle
  }
  isProcessAlive(pid: number): boolean {
    return this.alivePids.has(pid)
  }
  get lastHandle(): FakeHandle | null {
    return this.handles.length > 0 ? this.handles[this.handles.length - 1] : null
  }
}
interface Harness {
  supervisor: KernelSupervisor
  adapter: FakeAdapter
  resolver: StubResolver
  store: StubStore
}

function createHarness(options: {
  readinessPattern?: RegExp | null
  startTimeoutMs?: number
  stopTimeoutMs?: number
  forceKillTimeoutMs?: number
  maxRestarts?: number
  backoffMs?: number
  maxBackoffMs?: number
} = {}): Harness {
  const resolver = new StubResolver()
  const store = new StubStore()
  const adapter = new FakeAdapter()
  const supervisor = new KernelSupervisor(
    { resolver, configStore: store, adapter, secret: 's3cret' },
    {
      readinessPattern: options.readinessPattern === undefined ? /fixture-ready/ : options.readinessPattern,
      startTimeoutMs: options.startTimeoutMs ?? 2000,
      stopTimeoutMs: options.stopTimeoutMs ?? 2000,
      forceKillTimeoutMs: options.forceKillTimeoutMs ?? 2000,
      maxRestarts: options.maxRestarts ?? 3,
      backoffMs: options.backoffMs ?? 250,
      maxBackoffMs: options.maxBackoffMs ?? 10000
    }
  )
  return { supervisor, adapter, resolver, store }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Start and drive to readiness by emitting the fixture-ready marker. */
async function startToRunning(h: Harness): Promise<void> {
  const p = h.supervisor.start()
  await waitFor(() => (h.supervisor as unknown as { readiness: unknown }).readiness != null)
  h.adapter.lastHandle!.emitStdout('fixture-ready pid=1\n')
  const status = await p
  expect(status.phase).toBe('running')
}

describe('KernelSupervisor lifecycle', () => {
  it('starts a running process and surfaces pid + version', async () => {
    const h = createHarness()
    await startToRunning(h)
    const status = h.supervisor.getStatus()
    expect(status.phase).toBe('running')
    expect(status.pid).toBe(h.adapter.lastHandle!.pid)
    expect(status.version).toBe('9.0.0')
    expect(h.resolver.resolveCalls).toBe(1)
    expect(h.store.materializeCalls).toBe(1)
    // The fixture-ready line is captured into the rolling log.
    expect(h.supervisor.getRecentLogs().some((entry) => entry.text.includes('fixture-ready'))).toBe(true)
  })

  it('is idempotent under double start (no second spawn)', async () => {
    const h = createHarness()
    await startToRunning(h)
    const again = await h.supervisor.start()
    expect(again.phase).toBe('running')
    expect(h.adapter.spawnCalls.length).toBe(1)
    expect(h.supervisor.getStatus().phase).toBe('running')
  })

  it('serializes a stop submitted while a start is still in flight', async () => {
    const h = createHarness()
    const startP = h.supervisor.start()
    await waitFor(() => (h.supervisor as unknown as { readiness: unknown }).readiness != null)
    const handle = h.adapter.lastHandle!
    const stopP = h.supervisor.stop()
    // The stop must not touch the process while the start is still pending.
    expect(handle.signals).toEqual([])
    handle.emitStdout('fixture-ready pid=1\n')
    expect((await startP).phase).toBe('running')
    expect((await stopP).phase).toBe('stopped')
    expect(h.adapter.spawnCalls.length).toBe(1)
    expect(handle.signals).toContain('SIGTERM')
    expect(h.supervisor.getStatus().phase).toBe('stopped')
  })

  it('shuts down gracefully on SIGTERM', async () => {
    const h = createHarness()
    await startToRunning(h)
    const status = await h.supervisor.stop()
    expect(status.phase).toBe('stopped')
    expect(h.adapter.lastHandle!.signals).toEqual(['SIGTERM'])
    expect(h.supervisor.getStatus().phase).toBe('stopped')
  })

  it('forces SIGKILL when SIGTERM is ignored', async () => {
    const h = createHarness({ stopTimeoutMs: 15, forceKillTimeoutMs: 15 })
    await startToRunning(h)
    h.adapter.lastHandle!.onSigterm = 'ignores'
    await expect(h.supervisor.stop()).resolves.toMatchObject({ phase: 'stopped' })
    expect(h.adapter.lastHandle!.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('throws KERNEL_STOP_TIMEOUT when even SIGKILL is ignored', async () => {
    const h = createHarness({ stopTimeoutMs: 15, forceKillTimeoutMs: 15 })
    await startToRunning(h)
    h.adapter.lastHandle!.onSigterm = 'ignores'
    h.adapter.lastHandle!.onSigkill = 'ignores'
    await expect(h.supervisor.stop()).rejects.toThrow('Kernel did not exit after SIGKILL')
    expect(h.supervisor.getStatus().phase).toBe('stopped')
  })

  it('fails a start with no PID and cleans up the config', async () => {
    const h = createHarness()
    h.adapter.spawnPid = undefined
    let caught: unknown
    try {
      await h.supervisor.start()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ProtocolError)
    expect((caught as ProtocolError).code).toBe(ProtocolErrorCode.KERNEL_SPAWN_FAILED)
    expect(h.supervisor.getStatus().phase).toBe('failed')
    expect(h.store.cleanupCalls.length).toBe(1)
  })

  it('throws KERNEL_START_TIMEOUT when readiness never arrives', async () => {
    const h = createHarness({ startTimeoutMs: 20 })
    await expect(h.supervisor.start()).rejects.toMatchObject({ code: ProtocolErrorCode.KERNEL_START_TIMEOUT })
    expect(h.supervisor.getStatus().phase).toBe('failed')
    expect(h.supervisor.getStatus().lastError).toMatch(/ready within the start timeout/)
  })

  it('clears a stale recorded PID before spawning', async () => {
    const h = createHarness()
    // A live, unrelated pid and a recorded pid that is no longer alive.
    h.adapter.alivePids.add(50)
    ;(h.supervisor as unknown as { status: { pid: number | null } }).status.pid = 99999
    await startToRunning(h)
    const status = h.supervisor.getStatus()
    expect(status.pid).not.toBe(99999)
    expect(status.pid).toBe(h.adapter.lastHandle!.pid)
  })

  it('detects a crash and restarts up to the backoff cap', async () => {
    const h = createHarness({ readinessPattern: null, maxRestarts: 2, backoffMs: 10, maxBackoffMs: 40 })
    await h.supervisor.start()
    expect(h.adapter.spawnCalls.length).toBe(1)

    h.adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => h.adapter.spawnCalls.length === 2)
    h.adapter.lastHandle!.emitExit({ code: 1, signal: null })
    await waitFor(() => h.adapter.spawnCalls.length === 3)
    h.adapter.lastHandle!.emitExit({ code: 1, signal: null })

    // No further restart is scheduled once the cap is reached.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.adapter.spawnCalls.length).toBe(3)
    expect(h.supervisor.getStatus().phase).toBe('failed')
  })

  it('does not restart a start that never became ready (stays failed)', async () => {
    const h = createHarness({ readinessPattern: /fixture-ready/, startTimeoutMs: 20 })
    await expect(h.supervisor.start()).rejects.toMatchObject({ code: ProtocolErrorCode.KERNEL_START_TIMEOUT })
    expect(h.supervisor.getStatus().phase).toBe('failed')
    expect(h.adapter.spawnCalls.length).toBe(1)
  })
})

describe('BoundedLogBuffer', () => {
  it('keeps entries within the byte cap, dropping the oldest', () => {
    const buffer = new BoundedLogBuffer(8, 1000)
    buffer.append('stdout', 'aaa') // 3 bytes
    buffer.append('stdout', 'bbbb') // 4 bytes -> 7 bytes
    expect(buffer.size).toBe(7)
    buffer.append('stderr', 'cccc') // 4 bytes -> 11 bytes > 8 -> rotate out 'aaa'
    expect(buffer.size).toBe(8)
    expect(buffer.snapshot().map((e) => e.text)).toEqual(['bbbb', 'cccc'])
  })

  it('respects the entry cap', () => {
    const buffer = new BoundedLogBuffer(1000, 2)
    buffer.append('stdout', 'a')
    buffer.append('stdout', 'b')
    buffer.append('stdout', 'c')
    expect(buffer.length).toBe(2)
    expect(buffer.snapshot().map((e) => e.text)).toEqual(['b', 'c'])
  })
})
