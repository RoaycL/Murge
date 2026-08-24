import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { startMockMihomoServer, type MockMihomoServerHandle } from '../src/main/testing/mock-mihomo-server'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { usePoliciesStore } from '../src/renderer/src/stores/policies'
import type { DesktopApi } from '../src/shared/ipc'

const handles: MockMihomoServerHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  ;(globalThis as unknown as { window?: unknown }).window = undefined
  vi.restoreAllMocks()
})

/**
 * Wire a real preload-shaped bridge onto a real controller-backed client. This
 * is the contract the renderer trusts, so these tests prove the store's
 * optimistic selection is CONFIRMED by an actual subsequent read of the mock
 * controller — not just by the UI's own optimistic bookkeeping.
 */
function installBridge(client: MihomoClient): void {
  const mihomo = {
    getConfig: () => client.getConfig(),
    patchConfig: (patch: object) => client.patchConfig(patch as never),
    getProxies: () => client.getProxies(),
    selectProxy: (group: string, name: string) => client.selectProxy(group, name),
    getProxyProviders: () => client.getProxyProviders(),
    refreshProxyProvider: (name: string) => client.refreshProxyProvider(name),
    healthCheckProxyProvider: (name: string) => client.healthCheckProxyProvider(name),
    getRuleProviders: () => client.getRuleProviders(),
    refreshRuleProvider: (name: string) => client.refreshRuleProvider(name),
    delayTest: (name: string) => client.delayTest(name),
    groupDelayTest: (name: string) => client.groupDelayTest(name)
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: { mihomo } as DesktopApi['mihomo']
  }
}

describe('policies store + real mock controller', () => {
  it('confirms a rapid B→C selection with a subsequent mock read', async () => {
    setActivePinia(createPinia())
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000 })
    handles.push(server)
    installBridge(new MihomoClient(server.baseUrl, ''))

    const store = usePoliciesStore()
    await store.load()
    expect(store.selectedGroup).toBe('节点选择')
    expect(store.selectedMember).toBe('香港 01')

    // Rapid B→C clicks: the controller is written once at a time, and only the
    // latest intent survives. Both calls hand back the same serialized drain.
    const drain = store.selectNode('香港 02')
    store.selectNode('DIRECT')
    await drain

    // The store must agree with the controller's ACTUAL state, read back fresh
    // from the mock rather than trusted from optimistic UI bookkeeping.
    const reloaded = await new MihomoClient(server.baseUrl, '').getProxies()
    const controllerNow = reloaded.proxies['节点选择'].now
    expect(controllerNow).toBe('DIRECT')
    expect(store.selectedMember).toBe(controllerNow)
    expect(store.panelError).toBeNull()
  })
})
