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
})
