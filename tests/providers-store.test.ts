import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProvidersStore } from '../src/renderer/src/stores/providers'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type { MihomoProxyProvidersResponse, MihomoRuleProvidersResponse } from '../src/shared/mihomo-api'

const PROXY_PROVIDERS: MihomoProxyProvidersResponse = {
  providers: {
    '机场 A': {
      name: '机场 A',
      type: 'Proxy',
      vehicleType: 'HTTP',
      proxies: [
        { name: '香港 01', type: 'Shadowsocks', udp: true, alive: true, history: [{ time: '2024-06-01T00:00:00Z', delay: 42 }] },
        { name: '香港 02', type: 'Shadowsocks', udp: true, alive: false, history: [] }
      ],
      testUrl: 'https://www.gstatic.com/generate_204',
      expectedStatus: '204',
      subscriptionInfo: { Upload: 12_345_678, Download: 987_654_321, Total: 107_374_182_400, Expire: 1_767_225_600 }
    },
    '机场 B': {
      name: '机场 B',
      type: 'Proxy',
      vehicleType: 'File',
      proxies: [
        { name: '香港 03', type: 'Shadowsocks', udp: true, alive: true, history: [{ time: '2024-06-01T00:00:00Z', delay: 6 }] }
      ]
    }
  }
}

const RULE_PROVIDERS: MihomoRuleProvidersResponse = {
  providers: {
    '规则集 A': { name: '规则集 A', type: 'Rule', behavior: 'rule', format: 'yaml', vehicleType: 'HTTP', ruleCount: 8 }
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

  it('derives the node count from proxies.length, since upstream emits no count field', async () => {
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    const store = useProvidersStore()
    await store.loadProxyProviders()
    const [a, b] = store.orderedProxyProviders
    // This is exactly what PolicyView renders (`provider.proxies?.length ?? 0`).
    expect(a.proxies?.length ?? 0).toBe(2)
    expect(b.proxies?.length ?? 0).toBe(1)
  })

  it('preserves subscription traffic/expiry metadata and omits it when absent', async () => {
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    const store = useProvidersStore()
    await store.loadProxyProviders()
    const subscribed = store.proxyProviders['机场 A']
    expect(subscribed.subscriptionInfo).toEqual({
      Upload: 12_345_678,
      Download: 987_654_321,
      Total: 107_374_182_400,
      Expire: 1_767_225_600
    })
    expect(subscribed.testUrl).toBe('https://www.gstatic.com/generate_204')
    // A File vehicle has no subscription; the field must stay absent, not zeroed.
    expect(store.proxyProviders['机场 B'].subscriptionInfo).toBeUndefined()
  })

  it('keeps rule-provider format and vehicleType from upstream', async () => {
    getRuleProviders.mockResolvedValue(RULE_PROVIDERS)
    const store = useProvidersStore()
    await store.loadRuleProviders()
    const provider = store.ruleProviders['规则集 A']
    expect(provider.format).toBe('yaml')
    expect(provider.vehicleType).toBe('HTTP')
    expect(provider.ruleCount).toBe(8)
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

  it('awaits a 204 health check, re-pulls the provider and derives per-node delays from proxy history', async () => {
    healthCheckProxyProvider.mockResolvedValue(undefined)
    getProxyProviders.mockResolvedValue(PROXY_PROVIDERS)
    const store = useProvidersStore()
    await store.healthCheckProxyProvider('机场 A')
    expect(healthCheckProxyProvider).toHaveBeenCalledWith('机场 A')
    expect(getProxyProviders).toHaveBeenCalled()
    // 香港 01 has a usable history entry (42); 香港 02 has none, so it is
    // reported as unavailable rather than as a bogus 0ms success.
    expect(store.healthOf('机场 A')).toEqual({
      '香港 01': { status: 'ok', delay: 42 },
      '香港 02': { status: 'unavailable', delay: null }
    })
    expect(store.opOf('机场 A').healthchecking).toBe(false)
    expect(store.opOf('机场 A').error).toBeNull()
  })

  it('surfaces a health-check failure and leaves prior results untouched', async () => {
    healthCheckProxyProvider.mockRejectedValue(new ProtocolError(ProtocolErrorCode.UPSTREAM_HTTP_ERROR, 'hc failed'))
    const store = useProvidersStore()
    await store.healthCheckProxyProvider('机场 A')
    expect(store.opOf('机场 A').error).toBe('hc failed')
    expect(store.opOf('机场 A').healthchecking).toBe(false)
    expect(store.healthOf('机场 A')).toBeNull()
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

  it('keeps the last good providers when a refresh API call succeeds but its reload fetch fails', async () => {
    getProxyProviders
      .mockResolvedValueOnce(PROXY_PROVIDERS)
      .mockRejectedValueOnce(new ProtocolError(ProtocolErrorCode.UPSTREAM_HTTP_ERROR, 'reload failed'))
    refreshProxyProvider.mockResolvedValue(undefined)
    const store = useProvidersStore()
    await store.loadProxyProviders()
    expect(store.orderedProxyProviders).toHaveLength(2)

    await store.refreshProxyProvider('机场 A')
    // The old data survives a failed re-pull — it is never wiped.
    expect(store.orderedProxyProviders.map((p) => p.name)).toEqual(['机场 A', '机场 B'])
    expect(store.proxyProviders['机场 B'].vehicleType).toBe('File')
    // The refresh error is surfaced on the row so the user can retry.
    expect(store.opOf('机场 A').error).toBe('reload failed')
    expect(store.opOf('机场 A').refreshing).toBe(false)
  })

  it('keeps prior health results when a health check 204 succeeds but its reload fetch fails', async () => {
    healthCheckProxyProvider.mockResolvedValue(undefined)
    getProxyProviders
      .mockResolvedValueOnce(PROXY_PROVIDERS)
      .mockRejectedValueOnce(new ProtocolError(ProtocolErrorCode.UPSTREAM_HTTP_ERROR, 'reload after healthcheck failed'))
    const store = useProvidersStore()

    await store.healthCheckProxyProvider('机场 A')
    expect(store.healthOf('机场 A')).toEqual({
      '香港 01': { status: 'ok', delay: 42 },
      '香港 02': { status: 'unavailable', delay: null }
    })

    // A second health check that fails to reload must NOT wipe the measured map.
    await store.healthCheckProxyProvider('机场 A')
    expect(store.healthOf('机场 A')).toEqual({
      '香港 01': { status: 'ok', delay: 42 },
      '香港 02': { status: 'unavailable', delay: null }
    })
    expect(store.opOf('机场 A').error).toBe('reload after healthcheck failed')
    expect(store.opOf('机场 A').healthchecking).toBe(false)
  })

  it('surfaces a rule refresh reload failure and keeps the loaded rule providers', async () => {
    getRuleProviders
      .mockResolvedValueOnce(RULE_PROVIDERS)
      .mockRejectedValueOnce(new ProtocolError(ProtocolErrorCode.UPSTREAM_TIMEOUT, 'rule reload failed'))
    refreshRuleProvider.mockResolvedValue(undefined)
    const store = useProvidersStore()
    await store.loadRuleProviders()
    expect(store.orderedRuleProviders).toHaveLength(1)

    await store.refreshRuleProvider('规则集 A')
    expect(store.orderedRuleProviders.map((p) => p.name)).toEqual(['规则集 A'])
    expect(store.ruleProviders['规则集 A'].format).toBe('yaml')
    expect(store.opOf('规则集 A').error).toBe('rule reload failed')
    expect(store.opOf('规则集 A').refreshing).toBe(false)
  })

  it('treats a recorded delay of 0 as unavailable, never as a 0ms success', async () => {
    getProxyProviders.mockResolvedValue({
      providers: {
        '机场 A': {
          name: '机场 A',
          type: 'Proxy',
          vehicleType: 'HTTP',
          proxies: [
            { name: '香港 01', type: 'Shadowsocks', udp: true, alive: true, history: [{ time: '2024-06-01T00:00:00Z', delay: 0 }] },
            { name: '香港 02', type: 'Shadowsocks', udp: true, alive: false, history: [{ time: '2024-06-01T00:00:00Z', delay: 0 }] }
          ]
        }
      }
    })
    healthCheckProxyProvider.mockResolvedValue(undefined)
    const store = useProvidersStore()
    await store.healthCheckProxyProvider('机场 A')
    // Both nodes report delay 0 — mihomo's idiom for "no usable latency" — so
    // neither is rendered as a real 0ms result.
    expect(store.healthOf('机场 A')).toEqual({
      '香港 01': { status: 'unavailable', delay: null },
      '香港 02': { status: 'unavailable', delay: null }
    })
  })
})
