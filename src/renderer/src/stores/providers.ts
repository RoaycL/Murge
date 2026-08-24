import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  MihomoDelayMap,
  MihomoProxy,
  MihomoProxyProvider,
  MihomoRuleProvider
} from '@shared/mihomo-api'
import { toProtocolError } from '@shared/protocol-errors'

export type ProvidersStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Per-provider in-flight and error state shared by proxy and rule providers. */
export interface ProviderOp {
  refreshing: boolean
  healthchecking: boolean
  error: string | null
}

function emptyOp(): ProviderOp {
  return { refreshing: false, healthchecking: false, error: null }
}

/** Latest measured delay for a proxy, or `null` when it has no history yet. */
function latestDelay(proxy: MihomoProxy): number | null {
  const history = proxy.history
  if (!history || history.length === 0) return null
  const last = history[history.length - 1]
  return typeof last?.delay === 'number' ? last.delay : null
}

export const useProvidersStore = defineStore('providers', () => {
  const proxyStatus = ref<ProvidersStatus>('idle')
  const ruleStatus = ref<ProvidersStatus>('idle')
  const lastError = ref<string | null>(null)
  const proxyProviders = ref<Record<string, MihomoProxyProvider>>({})
  const ruleProviders = ref<Record<string, MihomoRuleProvider>>({})
  const ops = ref<Record<string, ProviderOp>>({})
  const healthResults = ref<Record<string, MihomoDelayMap>>({})

  const orderedProxyProviders = computed<MihomoProxyProvider[]>(() =>
    Object.values(proxyProviders.value).sort((a, b) => a.name.localeCompare(b.name))
  )
  const orderedRuleProviders = computed<MihomoRuleProvider[]>(() =>
    Object.values(ruleProviders.value).sort((a, b) => a.name.localeCompare(b.name))
  )

  function opOf(name: string): ProviderOp {
    return ops.value[name] ?? emptyOp()
  }

  function setOp(name: string, patch: Partial<ProviderOp>): void {
    ops.value = { ...ops.value, [name]: { ...opOf(name), ...patch } }
  }

  function healthOf(name: string): MihomoDelayMap | null {
    return healthResults.value[name] ?? null
  }

  async function loadProxyProviders(): Promise<void> {
    proxyStatus.value = 'loading'
    lastError.value = null
    try {
      const result = await window.desktop.mihomo.getProxyProviders()
      proxyProviders.value = result.providers
      proxyStatus.value = 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      proxyProviders.value = {}
      proxyStatus.value = 'error'
    }
  }

  async function loadRuleProviders(): Promise<void> {
    ruleStatus.value = 'loading'
    lastError.value = null
    try {
      const result = await window.desktop.mihomo.getRuleProviders()
      ruleProviders.value = result.providers
      ruleStatus.value = 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      ruleProviders.value = {}
      ruleStatus.value = 'error'
    }
  }

  async function refreshProxyProvider(name: string): Promise<void> {
    setOp(name, { refreshing: true, error: null })
    try {
      await window.desktop.mihomo.refreshProxyProvider(name)
      await loadProxyProviders()
      setOp(name, { refreshing: false })
    } catch (error) {
      setOp(name, { refreshing: false, error: toProtocolError(error).message })
    }
  }

  async function refreshRuleProvider(name: string): Promise<void> {
    setOp(name, { refreshing: true, error: null })
    try {
      await window.desktop.mihomo.refreshRuleProvider(name)
      await loadRuleProviders()
      setOp(name, { refreshing: false })
    } catch (error) {
      setOp(name, { refreshing: false, error: toProtocolError(error).message })
    }
  }

  async function healthCheckProxyProvider(name: string): Promise<void> {
    setOp(name, { healthchecking: true, error: null })
    try {
      // A provider health check is a fire-and-forget action: mihomo re-probes the
      // members of the provider and records fresh history entries on each proxy.
      // We therefore await a 204, then re-pull the provider and derive each node's
      // latest delay from its history, rather than trusting a returned map.
      await window.desktop.mihomo.healthCheckProxyProvider(name)
      await loadProxyProviders()
      const map: MihomoDelayMap = {}
      const provider = proxyProviders.value[name]
      if (provider?.proxies) {
        for (const proxy of provider.proxies) {
          const delay = latestDelay(proxy)
          if (delay !== null) map[proxy.name] = delay
        }
      }
      healthResults.value = { ...healthResults.value, [name]: map }
      setOp(name, { healthchecking: false })
    } catch (error) {
      setOp(name, { healthchecking: false, error: toProtocolError(error).message })
    }
  }

  function reset(): void {
    proxyStatus.value = 'idle'
    ruleStatus.value = 'idle'
    lastError.value = null
    proxyProviders.value = {}
    ruleProviders.value = {}
    ops.value = {}
    healthResults.value = {}
  }

  return {
    proxyStatus,
    ruleStatus,
    lastError,
    proxyProviders,
    ruleProviders,
    ops,
    healthResults,
    orderedProxyProviders,
    orderedRuleProviders,
    opOf,
    healthOf,
    loadProxyProviders,
    loadRuleProviders,
    refreshProxyProvider,
    refreshRuleProvider,
    healthCheckProxyProvider,
    reset
  }
})
