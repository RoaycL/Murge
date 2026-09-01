import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FakeSystemProxyAdapter } from '../src/main/system-proxy/adapters/fake-adapter'
import { InMemorySystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import { FileSystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import { InMemoryProxyBypassStore } from '../src/main/system-proxy/proxy-bypass-store'
import { DEFAULT_LOCAL_BYPASS_ENTRIES } from '../src/shared/proxy-bypass'
import type { RegistryValue, SystemProxyTarget, SystemProxyBackupStore } from '../src/main/system-proxy/types'

const TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }
const str = (value: string): RegistryValue => ({ exists: true, type: 'REG_SZ', value })
const LOCAL = DEFAULT_LOCAL_BYPASS_ENTRIES.join(';')

function makeService(initialOverride: string, backup?: SystemProxyBackupStore) {
  const adapter = new FakeSystemProxyAdapter({ initial: { proxyOverride: str(initialOverride) } })
  const store = new InMemoryProxyBypassStore()
  const service = new SystemProxyService({
    adapter,
    probe: new StaticSystemProxyProbe(TARGET),
    backup: backup ?? new InMemorySystemProxyBackupStore(),
    proxyBypassStore: store,
    instanceId: 'test-instance'
  })
  return { service, adapter, store }
}

describe('SystemProxyService proxy-bypass policy', () => {
  it('writes the authoritative (local + custom) override when the policy is enabled', async () => {
    const { service } = makeService('*.example.com')
    await service.setProxyBypass({ enabled: true, customEntries: ['internal.corp'] })
    await service.enable()
    const status = service.getStatus()
    expect(status.phase).toBe('enabled')
    expect(status.proxyOverride).toBe(`${LOCAL};internal.corp`)
  })

  it('preserves the OS override when the policy is disabled', async () => {
    const { service } = makeService('keep.me')
    await service.enable()
    expect(service.getStatus().proxyOverride).toBe(`${LOCAL};keep.me`)
  })

  it('re-applies a new policy live while enabled, then still restores the original verbatim on disable', async () => {
    // Use an overwritable file-backed backup so the re-apply can record its new
    // `written` value (mirroring production); `InMemorySystemProxyBackupStore`
    // is intentionally write-once for the crash-recovery tests.
    let dir = await mkdtemp(join(tmpdir(), 'mihomo-backup-'))
    const { service, adapter } = makeService('*.example.com', FileSystemProxyBackupStore.forAppDataBase(dir))
    try {
      await service.enable()
      expect(service.getStatus().proxyOverride).toBe(`${LOCAL};*.example.com`)

      await service.setProxyBypass({ enabled: true, customEntries: ['b.com'] })
      const readback = await adapter.read()
      expect(readback.proxyOverride.value).toBe(`${LOCAL};b.com`)
      expect(service.getStatus().proxyOverride).toBe(`${LOCAL};b.com`)

      await service.disable()
      const after = await adapter.read()
      // Exact restore: the pre-enable original, not the merged value.
      expect(after.proxyOverride.value).toBe('*.example.com')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never overwrites a foreign ProxyOverride while enabled (conflict)', async () => {
    const { service, adapter } = makeService('*.example.com')
    await service.enable()
    adapter.mutate({ proxyOverride: str('other.proc') })

    await service.setProxyBypass({ enabled: true, customEntries: ['c.com'] })
    const readback = await adapter.read()
    expect(readback.proxyOverride.value).toBe('other.proc')
    expect(service.getStatus().phase).toBe('conflict')
  })

  it('only persists the policy when not currently enabled', async () => {
    const { service, adapter, store } = makeService('*.example.com')
    await service.setProxyBypass({ enabled: true, customEntries: ['x.com'] })
    expect(service.getStatus().phase).toBe('disabled')
    expect((await adapter.read()).proxyOverride.value).toBe('*.example.com')
    expect((await store.read()).customEntries).toEqual(['x.com'])
  })

  it('persists a normalized, de-duplicated policy', async () => {
    const { service } = makeService('*.example.com')
    await service.setProxyBypass({ enabled: true, customEntries: ['pad.com', 'pad.com', ' z.com '] })
    const policy = await service.getProxyBypass()
    expect(policy.enabled).toBe(true)
    expect(policy.customEntries).toEqual(['pad.com', 'z.com'])
  })

  it('previews the exact override an enabled policy would write', async () => {
    const { service } = makeService('*.example.com')
    const preview = await service.previewProxyBypass({ enabled: true, customEntries: ['v.com'] })
    expect(preview).toBe(`${LOCAL};v.com`)
  })

  it('previews the disabled-aware override (preserves the OS list)', async () => {
    const { service } = makeService('*.example.com')
    const preview = await service.previewProxyBypass({ enabled: false, customEntries: ['ignored.com'] })
    expect(preview).toBe(`${LOCAL};*.example.com`)
  })
})
