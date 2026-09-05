import { describe, it, expect } from 'vitest'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FakeSystemProxyAdapter } from '../src/main/system-proxy/adapters/fake-adapter'
import { InMemorySystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import type {
  SystemProxyAdapter,
  SystemProxyKernelProbe,
  SystemProxyRegistryState,
  SystemProxyTarget
} from '../src/main/system-proxy/types'

const TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

const kernelProbe = (): SystemProxyKernelProbe => new StaticSystemProxyProbe(TARGET)

/** Wraps the fake adapter to fail the NEXT apply() call exactly once. */
class FailingApplyAdapter implements SystemProxyAdapter {
  readonly platform = 'fake'
  readonly supported = true
  private armed = false
  readonly delegate: FakeSystemProxyAdapter
  constructor(delegate: FakeSystemProxyAdapter) {
    this.delegate = delegate
  }
  /** Inject a one-shot failure into the next apply (the guard's repair). */
  armOnce(): void {
    this.armed = true
  }
  read(): Promise<SystemProxyRegistryState> {
    return this.delegate.read()
  }
  async apply(written: Parameters<SystemProxyAdapter['apply']>[0]): Promise<void> {
    if (this.armed) {
      this.armed = false
      throw new Error('injected apply failure')
    }
    return this.delegate.apply(written)
  }
  restore(previous: Parameters<SystemProxyAdapter['restore']>[0]): Promise<void> {
    return this.delegate.restore(previous)
  }
  refresh(): Promise<void> {
    return this.delegate.refresh()
  }
}

/** Wraps the fake adapter to fail the NEXT restore() call exactly once. */
class FailingRestoreAdapter implements SystemProxyAdapter {
  readonly platform = 'fake'
  readonly supported = true
  private armed = false
  readonly delegate = new FakeSystemProxyAdapter()
  armOnce(): void {
    this.armed = true
  }
  read(): Promise<SystemProxyRegistryState> {
    return this.delegate.read()
  }
  apply(written: Parameters<SystemProxyAdapter['apply']>[0]): Promise<void> {
    return this.delegate.apply(written)
  }
  async restore(previous: Parameters<SystemProxyAdapter['restore']>[0]): Promise<void> {
    if (this.armed) {
      this.armed = false
      throw new Error('injected restore failure')
    }
    await this.delegate.restore(previous)
  }
  refresh(): Promise<void> {
    return this.delegate.refresh()
  }
}

function makeService(adapterOverride?: SystemProxyAdapter) {
  const adapter = adapterOverride ?? new FakeSystemProxyAdapter()
  const backup = new InMemorySystemProxyBackupStore()
  const service = new SystemProxyService({
    adapter,
    probe: kernelProbe(),
    backup,
    instanceId: 'guard-test'
  })
  return { service, adapter, backup }
}

describe('SystemProxyService.verifyIntegrity (proxy guard)', () => {
  it('is idle when the proxy is not enabled', async () => {
    const { service } = makeService()
    expect(await service.verifyIntegrity()).toBe('idle')
  })

  it('reports ok when the registry still matches our write', async () => {
    const { service, adapter } = makeService()
    await service.enable()
    expect((adapter as FakeSystemProxyAdapter).calls.some((c) => c.op === 'apply')).toBe(true)
    expect(await service.verifyIntegrity()).toBe('ok')
  })

  it('repairs an externally flipped-off owned proxy', async () => {
    const { service, adapter } = makeService()
    await service.enable()
    // A "cleaner" tool or another user session flips ProxyEnable off; the
    // ProxyServer still aims at OUR listener — degradation, not takeover.
    ;(adapter as FakeSystemProxyAdapter).mutate({
      proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 }
    })
    expect(await service.verifyIntegrity()).toBe('repaired')
    const observed = await (adapter as FakeSystemProxyAdapter).read()
    expect(observed.proxyEnable.value).toBe(1)
    expect(observed.proxyServer.value).toContain(`127.0.0.1:${TARGET.port}`)
    expect(service.getStatus().phase).toBe('enabled')
  })

  it('never fights an external takeover (conflict is left alone)', async () => {
    const { service, adapter } = makeService()
    await service.enable()
    // Another app took ownership: the values no longer match our written state.
    ;(adapter as FakeSystemProxyAdapter).mutate({
      proxyServer: { exists: true, type: 'REG_SZ', value: 'http://10.0.0.1:8888' }
    })
    expect(await service.verifyIntegrity()).toBe('conflict')
    const observed = await (adapter as FakeSystemProxyAdapter).read()
    expect(observed.proxyServer.value).toBe('http://10.0.0.1:8888')
    expect(service.getStatus().phase).toBe('conflict')
  })

  it('degrades to repair-failed without corrupting the owned state', async () => {
    const failing = new FailingApplyAdapter(new FakeSystemProxyAdapter())
    const service = new SystemProxyService({
      adapter: failing,
      probe: kernelProbe(),
      backup: new InMemorySystemProxyBackupStore(),
      instanceId: 'guard-test'
    })
    await service.enable()
    failing.armOnce()
    failing.delegate.mutate({
      proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 }
    })
    expect(await service.verifyIntegrity()).toBe('repair-failed')
    // The bundle is retained, so a later sweep can still repair.
    expect(await service.verifyIntegrity()).toBe('repaired')
  })
})

describe('SystemProxyService network self-healing', () => {
  it('offline disables the owned proxy; recovery re-enables it', async () => {
    const { service } = makeService()
    await service.enable()
    expect(await service.handleNetworkDown()).toBe('disabled')
    expect(service.getStatus().phase).toBe('disabled')

    expect(await service.handleNetworkUp()).toBe('reenabled')
    expect(service.getStatus().phase).toBe('enabled')
  })

  it('offline with nothing owned is idle', async () => {
    const { service } = makeService()
    expect(await service.handleNetworkDown()).toBe('idle')
    expect(await service.handleNetworkUp()).toBe('idle')
  })

  it('recovery with the kernel down keeps the resume pending for a retry', async () => {
    // Mutable probe: models the kernel dying and coming back across the outage.
    let kernelUp = true
    const probe: SystemProxyKernelProbe = {
      resolveTarget: () =>
        kernelUp
          ? Promise.resolve(TARGET)
          : Promise.reject(Object.assign(new Error('kernel down'), { code: 'SYSTEM_PROXY_KERNEL_REQUIRED' }))
    }
    const service = new SystemProxyService({
      adapter: new FakeSystemProxyAdapter(),
      probe,
      backup: new InMemorySystemProxyBackupStore(),
      instanceId: 'heal-test'
    })
    await service.enable()
    expect(await service.handleNetworkDown()).toBe('disabled')

    // Reconnect while the kernel is still down: the re-enable fails, but the
    // pending resume survives so the next detector tick retries.
    kernelUp = false
    expect(await service.handleNetworkUp()).toBe('failed')
    kernelUp = true
    expect(await service.handleNetworkUp()).toBe('reenabled')
    expect(service.getStatus().phase).toBe('enabled')
  })

  it('retries a transient offline restore failure before the host is stopped', async () => {
    const adapter = new FailingRestoreAdapter()
    const service = new SystemProxyService({
      adapter,
      probe: kernelProbe(),
      backup: new InMemorySystemProxyBackupStore(),
      instanceId: 'heal-test'
    })
    await service.enable()
    adapter.armOnce()

    expect(await service.handleNetworkDown()).toBe('failed')
    expect(service.getStatus().phase).toBe('restore-failed')
    expect(await service.handleNetworkDown()).toBe('disabled')
    expect(await service.handleNetworkUp()).toBe('reenabled')
  })

  it('a user disable cancels the pending network resume', async () => {
    const { service } = makeService()
    await service.enable()
    await service.handleNetworkDown()
    // User explicitly disables (idempotent here — nothing owned).
    await service.disable()
    expect(await service.handleNetworkUp()).toBe('idle')
  })
})
