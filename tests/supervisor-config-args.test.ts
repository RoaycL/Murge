import { describe, it, expect } from 'vitest'
import { KernelSupervisor } from '../src/main/kernel/supervisor'
import type {
  KernelBinary,
  KernelBinaryResolver,
  KernelConfig,
  KernelConfigStore,
  KernelExitInfo,
  KernelProcessAdapter,
  KernelProcessHandle
} from '../src/main/kernel/types'

class Resolver implements KernelBinaryResolver {
  async resolve(): Promise<KernelBinary> {
    return { command: '/bin/mihomo', args: ['--base'], version: '1.19.30' }
  }
}

class Store implements KernelConfigStore {
  async materialize(): Promise<KernelConfig> {
    return {
      configPath: '/ws/config.yaml',
      rootDir: '/ws',
      args: ['-f', '/ws/config.yaml', '-d', '/ws'],
      env: { MIHOMO_PLATFORM: 'linux' }
    }
  }
  async cleanup(): Promise<void> {}
}

class Handle implements KernelProcessHandle {
  readonly pid = 123
  private stdout: Array<(t: string) => void> = []
  private exits: Array<(info: KernelExitInfo) => void> = []
  private exited = false
  onStdout(l: (t: string) => void): void {
    this.stdout.push(l)
  }
  onStderr(): void {}
  onExit(l: (info: KernelExitInfo) => void): void {
    this.exits.push(l)
  }
  onError(): void {}
  sendSignal(signal: NodeJS.Signals): boolean {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') this.emitExit({ code: 0, signal: null })
    return true
  }
  emit(text: string): void {
    for (const l of this.stdout) l(text)
  }
  private emitExit(info: KernelExitInfo): void {
    if (this.exited) return
    this.exited = true
    for (const l of this.exits) l(info)
  }
}

class Adapter implements KernelProcessAdapter {
  spawned: KernelBinary[] = []
  private last: Handle | null = null
  spawn(binary: KernelBinary): KernelProcessHandle {
    this.spawned.push(binary)
    this.last = new Handle()
    return this.last
  }
  isProcessAlive(): boolean {
    return true
  }
  emitReady(text: string): void {
    this.last?.emit(text)
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 2))
  }
}

describe('KernelSupervisor config args merge', () => {
  it('appends config args after the binary args so mihomo reads the isolated config', async () => {
    const adapter = new Adapter()
    const supervisor = new KernelSupervisor(
      { resolver: new Resolver(), configStore: new Store(), adapter, secret: 's3cret' },
      { readinessPattern: /base-ready/, startTimeoutMs: 2000, stopTimeoutMs: 2000 }
    )
    const running = supervisor.start()
    await waitFor(() => (supervisor as unknown as { readiness: unknown }).readiness != null)
    adapter.emitReady('base-ready\n')
    const status = await running
    expect(status.phase).toBe('running')
    expect(adapter.spawned).toHaveLength(1)
    expect(adapter.spawned[0].args).toEqual(['--base', '-f', '/ws/config.yaml', '-d', '/ws'])
    expect(adapter.spawned[0].env).toMatchObject({ MIHOMO_PLATFORM: 'linux' })
    await supervisor.stop()
  })
})
