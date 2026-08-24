import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProvidersStore } from '../src/renderer/src/stores/providers'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type { MihomoProxyProvidersResponse, MihomoRuleProvidersResponse } from '../src/shared/mihomo-api'

const PROXY_PROVIDERS: MihomoProxyProvidersResponse = {
  providers: {
    '机场 A': { name: '机场 A', type: 'Proxy', vehicleType: 'HTTP', proxiesCount: 2 },
    '机场 B': { name: '机场 B', type: 'Proxy', vehicleType: 'HTTP', proxiesCount: 1 }
  }
}

const RULE_PROVIDERS: MihomoRuleProvidersResponse = {
  providers: {
    '规则集 A': { name: '规则集 A', type: 'Rule', behavior: 'rule', ruleCount: 8 }
  }
}

describe('providers store', () => {
  let getProxyProviders: ReturnType<typeof vi.fn>
  let getRuleProviders: ReturnType<typeof vi.fn>
  let refreshProxyProvider: ReturnType<typeof vi.fn>
  let refreshRuleProvider: ReturnType<typeof vi.fn>
  let healthCheckProxyProvider: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    getProxyProviders = vi.fn()
    getRuleProviders = vi.fn()
    refreshProxyProvider = vi.fn()
    refreshRuleProvider = vi.fn()
    healthCheckProxyProvider = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      desktop: {
        mihomo: { getProxyProviders, getRuleProviders, refreshProxyProvider, refreshRuleProvider, healthCheckProxyProvider }
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { window?: unknown }).window = undefined
  })

  it('loads proxy and rule providers into ordered lists', async () => {
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    getRuleProviders.mockResolvedValue(RULE_PROVIDERS)
    const store = useProvidersStore()
    await store.loadProxyProviders()
    await store.loadRuleProviders()
    expect(store.orderedProxyProviders.map((p) => p.name)).toEqual(['机场 A', '机场 B'])
    expect(store.orderedRuleProviders.map((p) => p.name)).toEqual(['规则集 A'])
  })

  it('refreshes a proxy provider and reloads the list on success', async () => {
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    refreshProxyProvider.mockResolvedValue(undefined)
    const store = useProvidersStore()
    await store.loadProxyProviders()
    await store.refreshProxyProvider('机场 A')
    expect(refreshProxyProvider).toHaveBeenCalledWith('机场 A')
    expect(store.opOf('机场 A').refreshing).toBe(false)
    expect(store.opOf('机场 A').error).toBeNull()
  })

  it('surfaces a provider refresh failure as a recoverable error', async () => {
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    refreshProxyProvider.mockRejectedValue(new ProtocolError(ProtocolErrorCode.UPSTREAM_HTTP_ERROR, 'refresh failed'))
    const store = useProvidersStore()
    await store.loadProxyProviders()
    await store.refreshProxyProvider('机场 A')
    expect(store.opOf('机场 A').error).toBe('refresh failed')
    expect(store.opOf('机场 A').refreshing).toBe(false)
  })

  it('records a health-check result map', async () => {
    healthCheckProxyProvider.mockResolvedValue({ '香港 01': 42, '香港 02': 6 })
    const store = useProvidersStore()
    await store.healthCheckProxyProvider('机场 A')
    expect(store.healthOf('机场 A')).toEqual({ '香港 01': 42, '香港 02': 6 })
    expect(store.opOf('机场 A').healthchecking).toBe(false)
  })

  it('refreshes a rule provider on success', async () => {
    getRuleProviders.mockResolvedValue(RULE_PROVIDERS)
    refreshRuleProvider.mockResolvedValue(undefined)
    const store = useProvidersStore()
    await store.loadRuleProviders()
    await store.refreshRuleProvider('规则集 A')
    expect(refreshRuleProvider).toHaveBeenCalledWith('规则集 A')
    expect(store.opOf('规则集 A').refreshing).toBe(false)
  })
})
