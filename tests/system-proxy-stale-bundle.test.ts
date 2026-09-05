import { describe, it, expect, vi } from 'vitest'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FakeSystemProxyAdapter } from '../src/main/system-proxy/adapters/fake-adapter'
import { InMemorySystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import type { SystemProxyBackup, SystemProxyBackupStore } from '../src/main/system-proxy/types'

const TARGET = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

/**
 * A store that keeps a WRITTEN bundle alive after delete() — modelling the
 * crash window "restore verified, delete never ran" (power loss between the
 * two steps of restoreBackupStrict).
 */
class ResurrectingBackupStore implements SystemProxyBackupStore {
  private deleted: SystemProxyBackup | null = null
  private value: SystemProxyBackup | null = null
  write(backup: SystemProxyBackup): Promise<void> {
    this.value = backup
    this.deleted = null
    return Promise.resolve()
  }
  read(): Promise<SystemProxyBackup | null> {
    return Promise.resolve(this.value ?? this.deleted)
  }
  delete(): Promise<void> {
    this.deleted = this.value
    this.value = null
    return Promise.resolve()
  }
}

function makeService(initial?: ConstructorParameters<typeof FakeSystemProxyAdapter>[0]['initial']) {
  const adapter = new FakeSystemProxyAdapter({ initial })
  const backup = new InMemorySystemProxyBackupStore()
  const service = new SystemProxyService({
    adapter,
    probe: new StaticSystemProxyProbe(TARGET),
    backup,
    instanceId: 'same-instance'
  })
  return { service, adapter, backup }
}

describe('enable() recovers from a stale OWNED bundle (BUG-REVIEW #2 follow-up)', () => {
  it('same target + registry already back at previous: discards the stale bundle and enables fresh', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const first = await backup.read()
    expect(first).not.toBeNull()

    // Crash window: restore verified (registry back at the pre-enable snapshot)
    // but backup.delete() never ran. Simulate by hand-writing the first bundle
    // back after an explicit disable.
    await service.disable()
    await backup.write(first!)
    // Registry must still match `previous` (disable already restored it).
    const deleteBackup = vi.spyOn(backup, 'delete')
    const writeBackup = vi.spyOn(backup, 'write')

    const result = await service.enable()
    expect(result.phase).toBe('enabled')
    // The stale bundle was replaced by a fresh one, not left in place.
    const current = await backup.read()
    expect(deleteBackup).toHaveBeenCalledOnce()
    expect(writeBackup).toHaveBeenCalledOnce()
    expect(deleteBackup.mock.invocationCallOrder[0]).toBeLessThan(writeBackup.mock.invocationCallOrder[0])
    expect(current!.previous).toEqual(first!.previous)
    // The proxy really points at the live target.
    const observed = await adapter.read()
    expect(observed.proxyEnable.value).toBe(1)
    expect(observed.proxyServer.value).toContain(`${TARGET.host}:${TARGET.port}`)
  })

  it('same target + our server flipped off externally: recovers instead of conflicting', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    // Someone flipped ProxyEnable off while keeping the server aimed at us.
    adapter.mutate({ proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 } })
    // And the session restarted with the SAME port (same target).
    await backup.write(bundle!)

    const result = await service.enable()
    expect(result.phase).toBe('enabled')
    const observed = await adapter.read()
    expect(observed.proxyEnable.value).toBe(1)
  })

  it('same target + external override edit inside our envelope: recovers to a fresh enable', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    adapter.mutate({ proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>;*.elsewhere' } })
    await backup.write(bundle!)

    const result = await service.enable()
    expect(result.phase).toBe('enabled')
    const observed = await adapter.read()
    expect(observed.proxyOverride.value).not.toBe('<local>;*.elsewhere')
  })

  it('port moved + registry still aiming at the dead port: restores previous, then enables', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    await service.disable()
    // Session restart with a DIFFERENT port, registry still aiming at the dead
    // port from the old bundle (route-owned): classic moved-unified-port case.
    const moved = { ...bundle!, target: { host: TARGET.host, port: 7891 } }
    adapter.mutate({
      proxyEnable: { exists: true, type: 'REG_DWORD', value: 1 },
      proxyServer: { exists: true, type: 'REG_SZ', value: `http=${TARGET.host}:7891;https=${TARGET.host}:7891;socks=${TARGET.host}:7891` }
    })
    await backup.write(moved)
    const result = await service.enable()
    expect(result.phase).toBe('enabled')
    const observed = await adapter.read()
    expect(observed.proxyServer.value).toContain(`http=${TARGET.host}:${TARGET.port}`)
  })

  it('disable() restores a same-target bundle whose ProxyEnable was flipped off', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    adapter.mutate({ proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 } })
    await backup.write(bundle!)

    const result = await service.disable()
    expect(result.phase).toBe('disabled')
    const observed = await adapter.read()
    expect(observed.proxyEnable).toEqual(bundle!.previous.proxyEnable) // pre-enable snapshot
    expect(await backup.read()).toBeNull() // bundle consumed
  })

  it('disable() restores an override degraded inside our envelope', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    adapter.mutate({ proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>;*.drifted' } })
    await backup.write(bundle!)

    const result = await service.disable()
    expect(result.phase).toBe('disabled')
    const observed = await adapter.read()
    expect(observed.proxyOverride.value).toBe(bundle!.previous.proxyOverride.value)
  })

  it('a genuinely external server edit still fails closed (conflict)', async () => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    const bundle = await backup.read()
    await service.disable()
    adapter.mutate({
      proxyServer: { exists: true, type: 'REG_SZ', value: 'http://10.9.9.9:8888' }
    })
    await backup.write(bundle!)
    await expect(service.enable()).rejects.toMatchObject({ code: 'SYSTEM_PROXY_STATE_CONFLICT' })
    // The external values were not touched.
    const observed = await adapter.read()
    expect(observed.proxyServer.value).toBe('http://10.9.9.9:8888')
  })

  it.each(['shutdown', 'startup'] as const)('%s restores bypass drift and consumes the backup', async (path) => {
    const { service, adapter, backup } = makeService()
    const previous = await adapter.read()
    await service.enable()
    adapter.mutate({ proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>;*.changed' } })
    const recovering = path === 'startup'
      ? new SystemProxyService({ adapter, backup, probe: new StaticSystemProxyProbe(TARGET), instanceId: 'restarted' })
      : service
    if (path === 'startup') await recovering.init()
    else await recovering.restoreBeforeKernelUnavailable()
    expect(recovering.getStatus().phase).toBe('disabled')
    expect(await adapter.read()).toEqual(previous)
    expect(await backup.read()).toBeNull()
  })

  it.each(['shutdown', 'startup'] as const)('%s preserves another proxy server', async (path) => {
    const { service, adapter, backup } = makeService()
    await service.enable()
    adapter.mutate({ proxyServer: { exists: true, type: 'REG_SZ', value: 'http=10.9.9.9:8888' } })
    const external = await adapter.read()
    if (path === 'startup') await service.init()
    else await service.restoreBeforeKernelUnavailable()
    expect(service.getStatus().phase).toBe('conflict')
    expect(await adapter.read()).toEqual(external)
    expect(await backup.read()).not.toBeNull()
  })

  it.each(['reject', 'restore-mismatch'] as const)('shutdown rejects %s after bypass drift and retains recovery evidence', async (restoreBehavior) => {
    const adapter = new FakeSystemProxyAdapter({ restoreBehavior })
    const backup = new InMemorySystemProxyBackupStore()
    const service = new SystemProxyService({ adapter, backup, probe: new StaticSystemProxyProbe(TARGET), instanceId: 'failure' })
    await service.enable()
    const bundle = await backup.read()
    adapter.mutate({ proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>;*.changed' } })
    await expect(service.restoreBeforeKernelUnavailable()).rejects.toMatchObject({ code: 'SYSTEM_PROXY_RESTORE_FAILED' })
    expect(service.getStatus().phase).toBe('restore-failed')
    expect(await backup.read()).toEqual(bundle)
  })
})
