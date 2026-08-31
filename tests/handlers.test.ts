import { describe, it, expect, beforeEach } from 'vitest'
import { IPC } from '@shared/ipc'
import { brand } from '@shared/brand'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

describe('buildIpcHandlers', () => {
  let container: ReturnType<typeof createFakeContainer>
  let handlers: ReturnType<typeof buildIpcHandlers>

  beforeEach(() => {
    container = createFakeContainer(brand)
    handlers = buildIpcHandlers(container.deps)
  })

  it('exposes the brand via app:get-brand', async () => {
    const result = await handlers[IPC.appGetBrand](null)
    expect(result).toBe(brand)
  })

  it('returns the runtime summary via runtime:get-summary', async () => {
    const result = await handlers[IPC.runtimeGetSummary](null)
    expect(result).toEqual(container.runtime.summary)
  })

  describe('mihomo:patch-config', () => {
    it('forwards a valid patch to the gateway', async () => {
      await handlers[IPC.mihomoPatchConfig](null, { mode: 'rule', 'allow-lan': true })
      expect(container.mihomo.patchConfigCalls).toHaveLength(1)
      expect(container.mihomo.patchConfigCalls[0]).toEqual({ mode: 'rule', 'allow-lan': true })
    })

    it('rejects an invalid patch BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.mihomoPatchConfig](null, { noSuchKey: true })).rejects.toThrow(ProtocolError)
      expect(container.mihomo.patchConfigCalls).toHaveLength(0)
    })

    it('exposes the typed code', async () => {
      try {
        await handlers[IPC.mihomoPatchConfig](null, { mode: 'bogus' })
      } catch (error) {
        expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_ARGUMENT)
      }
    })
  })

  describe('mihomo:select-proxy', () => {
    it('forwards a valid selection to the gateway', async () => {
      await handlers[IPC.mihomoSelectProxy](null, 'Proxy', 'HK-01')
      expect(container.mihomo.selectProxyCalls[0]).toEqual({ group: 'Proxy', name: 'HK-01' })
    })

    it('rejects an empty selection BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.mihomoSelectProxy](null, '', 'x')).rejects.toThrow(ProtocolError)
      expect(container.mihomo.selectProxyCalls).toHaveLength(0)
    })
  })

  describe('mihomo:close-connection', () => {
    it('forwards a valid id to the gateway', async () => {
      await handlers[IPC.mihomoCloseConnection](null, 'conn-7')
      expect(container.mihomo.closeConnectionCalls).toEqual(['conn-7'])
    })

    it('rejects an invalid id BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.mihomoCloseConnection](null, 7)).rejects.toThrow(ProtocolError)
      expect(container.mihomo.closeConnectionCalls).toHaveLength(0)
    })
  })

  describe('mihomo DNS diagnostics', () => {
    it('validates and forwards a DNS query', async () => {
      await handlers[IPC.mihomoDnsQuery](null, 'example.com', 'AAAA')
      expect(container.mihomo.dnsQueryCalls).toEqual([{ name: 'example.com', type: 'AAAA' }])
    })

    it('rejects malformed names and unsupported types before the gateway', async () => {
      await expect(handlers[IPC.mihomoDnsQuery](null, 'https://example.com', 'A')).rejects.toThrow(ProtocolError)
      await expect(handlers[IPC.mihomoDnsQuery](null, 'example.com', 'ANY')).rejects.toThrow(ProtocolError)
      expect(container.mihomo.dnsQueryCalls).toEqual([])
    })

    it('forwards both cache flush operations', async () => {
      await handlers[IPC.mihomoFlushDnsCache](null)
      await handlers[IPC.mihomoFlushFakeIpCache](null)
      expect(container.mihomo.flushDnsCacheCalls).toBe(1)
      expect(container.mihomo.flushFakeIpCacheCalls).toBe(1)
    })
  })

  describe('kernel control', () => {
    it('delegates start to the kernel gateway', async () => {
      await handlers[IPC.kernelStart](null)
      expect(container.kernel.startCalls).toBe(1)
    })

    it('exposes mihomo proxies through the gateway', async () => {
      container.mihomo.proxies = { proxies: { A: { name: 'HK', type: 'Shadowsocks' } as never } }
      const result = await handlers[IPC.mihomoGetProxies](null)
      expect(result).toEqual(container.mihomo.proxies)
    })
  })

  describe('startup control', () => {
    it('forwards an explicit boolean and returns confirmed state', async () => {
      const result = await handlers[IPC.startupSetEnabled](null, true)
      expect(container.startup.setCalls).toEqual([true])
      expect(result).toMatchObject({ enabled: true })
    })

    it('rejects non-booleans before reaching the gateway', async () => {
      await expect(handlers[IPC.startupSetEnabled](null, 'true')).rejects.toThrow(ProtocolError)
      expect(container.startup.setCalls).toEqual([])
    })
  })

  describe('profile argument validation', () => {
    it('rejects a non-string validation document before reaching the gateway', async () => {
      await expect(handlers[IPC.profilesValidate](null, { yaml: true })).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
    })

    it('rejects an invalid subscription URL before reaching the gateway', async () => {
      await expect(
        handlers[IPC.profilesImportFromUrl](null, 'Profile', 'file:///etc/passwd', false)
      ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
    })

    it('rejects a non-boolean activate flag instead of coercing it', async () => {
      await expect(
        handlers[IPC.profilesImportFromUrl](null, 'Profile', 'https://example.com/sub', 'false')
      ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
    })

    it('uses a typed error for a malformed edits collection', async () => {
      await expect(handlers[IPC.profilesEditDocument](null, 'profile-id', {})).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
    })
  })

  describe('mihomo Phase 4 provider and delay channels', () => {
    it('forwards a delay test to the gateway', async () => {
      container.mihomo.delayResults['香港 01'] = { delay: 42 }
      const result = await handlers[IPC.mihomoDelayTest](null, '香港 01')
      expect(result).toEqual({ delay: 42 })
    })

    it('passes options through without failing validation', async () => {
      const result = await handlers[IPC.mihomoDelayTest](null, 'node', { timeout: 2000 })
      expect(result).toEqual({ delay: 0 })
    })

    it('rejects an options object carrying a probe URL', async () => {
      await expect(handlers[IPC.mihomoDelayTest](null, 'node', { timeout: 2000, url: 'https://example.com' })).rejects.toThrow(ProtocolError)
    })

    it('rejects an invalid delay options BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.mihomoDelayTest](null, 'node', { timeout: -1 })).rejects.toThrow(ProtocolError)
    })

    it('forwards a group delay test to the gateway', async () => {
      container.mihomo.groupDelayResults['节点选择'] = { '香港 01': 42 }
      const result = await handlers[IPC.mihomoGroupDelayTest](null, '节点选择')
      expect(result).toEqual({ '香港 01': 42 })
    })

    it('refreshes a proxy provider by name', async () => {
      await handlers[IPC.mihomoRefreshProxyProvider](null, '机场 A')
      expect(container.mihomo.refreshProxyProviderCalls).toEqual(['机场 A'])
    })

    it('health-checks a proxy provider by name (fire-and-forget 204)', async () => {
      const result = await handlers[IPC.mihomoHealthCheckProxyProvider](null, '机场 A')
      expect(result).toBeUndefined()
      expect(container.mihomo.healthCheckProxyProviderCalls).toEqual(['机场 A'])
    })

    it('rejects an empty provider name BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.mihomoRefreshProxyProvider](null, '  ')).rejects.toThrow(ProtocolError)
      expect(container.mihomo.refreshProxyProviderCalls).toHaveLength(0)
    })

    it('refreshes a rule provider by name', async () => {
      await handlers[IPC.mihomoRefreshRuleProvider](null, '规则集 A')
      expect(container.mihomo.refreshRuleProviderCalls).toEqual(['规则集 A'])
    })

    it('exposes proxy and rule providers through the gateway', async () => {
      container.mihomo.proxyProviders = {
        providers: { A: { name: 'A', type: 'Proxy', proxies: [{ name: 'n1', type: 'Shadowsocks' }] } as never }
      }
      const result = await handlers[IPC.mihomoGetProxyProviders](null)
      expect(result).toEqual(container.mihomo.proxyProviders)
    })
  })

  describe('update control', () => {
    it('exposes the current update state', async () => {
      const result = await handlers[IPC.updatesGetState](null)
      expect(result).toEqual(container.updates.state)
    })

    it('forwards a manual check to the gateway', async () => {
      const result = await handlers[IPC.updatesCheck](null)
      expect(container.updates.checkCalls).toBe(1)
      expect(result).toEqual(container.updates.state)
    })

    it('forwards a download request', async () => {
      await handlers[IPC.updatesDownload](null)
      expect(container.updates.downloadCalls).toBe(1)
    })

    it('forwards an install request', async () => {
      handlers[IPC.updatesInstall](null)
      expect(container.updates.installCalls).toBe(1)
    })
  })

  describe('kernel-manager control', () => {
    it('exposes the current kernel-manager state', async () => {
      const result = await handlers[IPC.kernelManagerGetState](null)
      expect(result).toEqual(await container.kernelManager.getState())
    })

    it('forwards a valid enable toggle to the gateway', async () => {
      const result = await handlers[IPC.kernelManagerSetEnabled](null, false)
      expect(container.kernelManager.setEnabledCalls).toEqual([false])
      expect(result).toEqual(await container.kernelManager.getState())
    })

    it('rejects a non-boolean enable toggle BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.kernelManagerSetEnabled](null, 'yes')).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
      expect(container.kernelManager.setEnabledCalls).toHaveLength(0)
    })

    it('forwards a valid channel change to the gateway', async () => {
      const result = await handlers[IPC.kernelManagerSetChannel](null, 'specific')
      expect(container.kernelManager.setChannelCalls).toEqual(['specific'])
      expect(result).toEqual(await container.kernelManager.getState())
    })

    it('rejects an invalid channel BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.kernelManagerSetChannel](null, 'beta')).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
      expect(container.kernelManager.setChannelCalls).toHaveLength(0)
    })

    it('forwards a version refresh to the gateway', async () => {
      const result = await handlers[IPC.kernelManagerListVersions](null)
      expect(container.kernelManager.listVersionsCalls).toBe(1)
      expect(result).toEqual(await container.kernelManager.getState())
    })

    it('forwards a valid version install to the gateway', async () => {
      const result = await handlers[IPC.kernelManagerInstall](null, 'v1.19.30')
      expect(container.kernelManager.installCalls).toEqual(['v1.19.30'])
      expect(result).toEqual(await container.kernelManager.getState())
    })

    it('rejects a malformed version BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.kernelManagerInstall](null, '1.19.30')).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
      await expect(handlers[IPC.kernelManagerInstall](null, 'not-a-version')).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
      expect(container.kernelManager.installCalls).toHaveLength(0)
    })
  })

  describe('override chain', () => {
    it('lists the current overrides snapshot', async () => {
      container.overrides.snapshot = { items: [{ id: 'ov-1', name: '规则', kind: 'yaml', enabled: true, scope: 'global', profileId: null, order: 0, content: 'mode: rule', updatedAt: 1 }] }
      const result = await handlers[IPC.overridesList](null)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].name).toBe('规则')
    })

    it('forwards a valid create payload to the gateway', async () => {
      const result = await handlers[IPC.overridesCreate](null, { name: '规则', kind: 'yaml', scope: 'global', content: 'mode: rule' })
      expect(container.overrides.createCalls).toHaveLength(1)
      expect(container.overrides.createCalls[0].input).toEqual({ name: '规则', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: rule' })
      expect(result).toEqual(await container.overrides.list())
    })

    it('rejects a blank name BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.overridesCreate](null, { name: '  ', kind: 'yaml', scope: 'global', content: '' })).rejects.toMatchObject({
        code: ProtocolErrorCode.INVALID_ARGUMENT
      })
      expect(container.overrides.createCalls).toHaveLength(0)
    })

    it('rejects an unknown kind BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.overridesCreate](null, { name: 'x', kind: 'toml', scope: 'global', content: '' })).rejects.toThrow(ProtocolError)
      expect(container.overrides.createCalls).toHaveLength(0)
    })

    it('requires a profileId for profile-scoped overrides', async () => {
      await expect(handlers[IPC.overridesCreate](null, { name: 'x', kind: 'yaml', scope: 'profile', content: 'a: 1' })).rejects.toThrow(ProtocolError)
      expect(container.overrides.createCalls).toHaveLength(0)
    })

    it('forwards an update with a validated id', async () => {
      const result = await handlers[IPC.overridesUpdate](null, 'ov-1', { name: '新', kind: 'js', scope: 'global', content: 'main=function(c){return c}' })
      expect(container.overrides.updateCalls).toEqual([{ id: 'ov-1', input: { name: '新', kind: 'js', scope: 'global', profileId: null, content: 'main=function(c){return c}' } }])
      expect(result).toEqual(await container.overrides.list())
    })

    it('forwards removal and toggle through the gateway', async () => {
      await handlers[IPC.overridesRemove](null, 'ov-1')
      expect(container.overrides.removeCalls).toEqual(['ov-1'])
      await handlers[IPC.overridesSetEnabled](null, 'ov-1', false)
      expect(container.overrides.setEnabledCalls).toEqual([{ id: 'ov-1', enabled: false }])
    })

    it('rejects a non-boolean enabled value BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.overridesSetEnabled](null, 'ov-1', 'yes')).rejects.toThrow(ProtocolError)
      expect(container.overrides.setEnabledCalls).toHaveLength(0)
    })

    it('forwards a valid reorder direction', async () => {
      await handlers[IPC.overridesMove](null, 'ov-1', 'up')
      expect(container.overrides.moveCalls).toEqual([{ id: 'ov-1', direction: 'up' }])
    })

    it('rejects an invalid direction BEFORE reaching the gateway', async () => {
      await expect(handlers[IPC.overridesMove](null, 'ov-1', 'sideways')).rejects.toThrow(ProtocolError)
      expect(container.overrides.moveCalls).toHaveLength(0)
    })
  })
})
