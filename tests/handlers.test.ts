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
})
