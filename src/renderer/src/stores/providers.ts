import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
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

/**
 * A single node's measured health. `status === 'ok'` carries the measured
 * delay; `status === 'unavailable'` means no usable measurement exists
 * (mihomo reports `delay === 0` — and omits the key entirely — when a probe
 * failed or a node was not measured, which is NOT a successful 0ms latency).
 */
export type ProviderNodeHealth =
  | { status: 'ok'; delay: number }
  | { status: 'unavailable'; delay: null }

export type ProviderHealthResult = Record<string, ProviderNodeHealth>

function emptyOp(): ProviderOp {
  return { refreshing: false, healthchecking: false, error: null }
}

/**
 * Latest measured delay for a proxy, or `null` when it has no usable history.
 * A delay of `0` (probe failed / not measured), a negative value, NaN, or an
 * absent history entry are all treated as unavailable rather than as a real
 * latency — mihomo only reports a `> 0` delay for a successful measurement.
 */
function latestDelay(proxy: MihomoProxy): number | null {
  const history = proxy.history
  if (!history || history.length === 0) return null
  const last = history[history.length - 1]
  const delay = last?.delay
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : null
}

export const useProvidersStore = defineStore('providers', () => {
  const proxyStatus = ref<ProvidersStatus>('idle')
  const ruleStatus = ref<ProvidersStatus>('idle')
  const lastError = ref<string | null>(null)
  const proxyProviders = ref<Record<string, MihomoProxyProvider>>({})
  const ruleProviders = ref<Record<string, MihomoRuleProvider>>({})
  const ops = ref<Record<string, ProviderOp>>({})
  const healthResults = ref<Record<string, ProviderHealthResult>>({})

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

  function healthOf(name: string): ProviderHealthResult | null {
    return healthResults.value[name] ?? null
  }

  /**
   * Re-pull provider metadata WITHOUT discarding the currently loaded providers.
   * Throws on failure so a refresh/health-check that runs it can surface a
   * per-provider error while the last good data stays visible. The current data
   * is only replaced after a successful fetch, so a failed reload never clears
   * what the user already sees.
   */
  async function reloadProxyProviders(): Promise<void> {
    const result = await window.desktop.mihomo.getProxyProviders()
    proxyProviders.value = result.providers
    proxyStatus.value = 'ready'
  }

  async function reloadRuleProviders(): Promise<void> {
    const result = await window.desktop.mihomo.getRuleProviders()
    ruleProviders.value = result.providers
    ruleStatus.value = 'ready'
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
      await reloadProxyProviders()
      setOp(name, { refreshing: false })
    } catch (error) {
      setOp(name, { refreshing: false, error: toProtocolError(error).message })
    }
  }

  async function refreshRuleProvider(name: string): Promise<void> {
    setOp(name, { refreshing: true, error: null })
    try {
      await window.desktop.mihomo.refreshRuleProvider(name)
      await reloadRuleProviders()
      setOp(name, { refreshing: false })
    } catch (error) {
      setOp(name, { refreshing: false, error: toProtocolError(error).message })
    }
  }

  /**
   * Refresh every external resource (proxy + rule providers) currently loaded
   * from the running controller, in one click. Individual provider refreshes are
   * still reflected in `ops` so a row can show its own in-flight/error state,
   * while this batch returns a summary the caller can surface without restarting
   * the kernel. Provider maps are re-pulled only at the end, so a single failing
   * resource never discards the data the user already sees.
   */
  async function refreshAllProviders(): Promise<{ updated: number; failed: number }> {
    const proxyNames = Object.keys(proxyProviders.value)
    const ruleNames = Object.keys(ruleProviders.value)
    let updated = 0
    let failed = 0
    await Promise.all(
      proxyNames.map(async (name) => {
        try {
          await window.desktop.mihomo.refreshProxyProvider(name)
          updated++
        } catch (error) {
          setOp(name, { refreshing: false, error: toProtocolError(error).message })
          failed++
        }
      })
    )
    await Promise.all(
      ruleNames.map(async (name) => {
        try {
          await window.desktop.mihomo.refreshRuleProvider(name)
          updated++
        } catch (error) {
          setOp(name, { refreshing: false, error: toProtocolError(error).message })
          failed++
        }
      })
    )
    // Re-pull both maps after the batch so rows reflect fresh metadata.
    try {
      await reloadProxyProviders()
    } catch {
      /* keep last good data */
    }
    try {
      await reloadRuleProviders()
    } catch {
      /* keep last good data */
    }
    return { updated, failed }
  }

  async function healthCheckProxyProvider(name: string): Promise<void> {
    setOp(name, { healthchecking: true, error: null })
    try {
      // A provider health check is a fire-and-forget action: mihomo re-probes the
      // members of the provider and records fresh history entries on each proxy.
      // We therefore await a 204, then re-pull the provider and derive each node's
      // latest delay from its history, rather than trusting a returned map.
      await window.desktop.mihomo.healthCheckProxyProvider(name)
      await reloadProxyProviders()
      const provider = proxyProviders.value[name]
      const map: ProviderHealthResult = {}
      if (provider?.proxies) {
        for (const proxy of provider.proxies) {
          const delay = latestDelay(proxy)
          map[proxy.name] = delay === null
            ? { status: 'unavailable', delay: null }
            : { status: 'ok', delay }
        }
      }
      healthResults.value = { ...healthResults.value, [name]: map }
      setOp(name, { healthchecking: false })
    } catch (error) {
      // A reload failure must NOT wipe the last measured health results; the
      // old map is the only information the user still has, so keep it intact.
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
    refreshAllProviders,
    healthCheckProxyProvider,
    reset
  }
})
