import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  MihomoProxy,
  MihomoProxyProvider,
  MihomoRuleProvider
} from '@shared/mihomo-api'
import type { ProfileProviderCatalog } from '@shared/profiles'
import { toProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

export type ProvidersStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Per-provider in-flight and error state shared by proxy and rule providers. */
export interface ProviderOp {
  refreshing: boolean
  healthchecking: boolean
  error: string | null
}

export type ProviderKind = 'proxy' | 'rule'

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
 * A provider is a "remote" (远端) external resource only when it is backed by a
 * URL (mihomo reports this as vehicleType 'HTTP'). Inline ('Compatible') and
 * local-file ('File') providers have no remote address to refresh, and the
 * controller refuses to re-pull them (HTTP 503), so they must not be offered as
 * updatable external resources. Case-insensitive because mihomo emits the
 * capitalized form but some older/embedded builds use lowercase.
 */
export function isRemoteResource(provider: { vehicleType?: string; type?: string; url?: string }): boolean {
  if (provider.url) return true
  return String(provider.vehicleType ?? '').toLowerCase() === 'http'
}

/**
 * A refresh failure on a provider never means "our delay test failed": mihomo
 * returns 503 (mapped to UPSTREAM_TEST_FAILED) when it cannot re-pull the
 * source URL. Surface that as an actionable fetch error rather than the
 * misleading "delay test failed" wording the generic 503 mapping produces.
 */
function refreshFailureMessage(error: unknown): string {
  const err = toProtocolError(error)
  if (err.code === ProtocolErrorCode.UPSTREAM_TEST_FAILED) {
    return '更新失败：无法连接源地址（HTTP 503）'
  }
  return err.message
}

const BATCH_REFRESH_CONCURRENCY = 2
const TRANSIENT_RETRY_DELAYS_MS = [800, 2_000] as const

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retry only failures that can plausibly recover without user intervention. */
function transientRefreshRetryCount(error: unknown): number {
  const err = toProtocolError(error)
  if (err.code === ProtocolErrorCode.UPSTREAM_TEST_FAILED) return TRANSIENT_RETRY_DELAYS_MS.length
  if (err.code === ProtocolErrorCode.UPSTREAM_TIMEOUT) return 1
  if (err.code === ProtocolErrorCode.UPSTREAM_HTTP_ERROR && /HTTP\s+(429|502|503|504)\b/i.test(err.message)) {
    return TRANSIENT_RETRY_DELAYS_MS.length
  }
  return 0
}

async function refreshWithBackoff(action: () => Promise<void>): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await action()
      return
    } catch (error) {
      failure = error
      const retries = transientRefreshRetryCount(error)
      if (attempt >= retries) throw error
      await wait(TRANSIENT_RETRY_DELAYS_MS[attempt])
    }
  }
  throw failure
}

/** Run provider pulls with bounded concurrency so one slow source cannot block every later row. */
async function runProviderBatch(names: string[], task: (name: string) => Promise<void>): Promise<void> {
  const queue = [...new Set(names)]
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const name = queue[cursor++]
      await task(name)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BATCH_REFRESH_CONCURRENCY, queue.length) }, () => worker())
  )
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
  /** Profile-declared 集合配置 (url/interval/path…), merged at the 外部资源 drawer. */
  const providerCatalog = ref<ProfileProviderCatalog>({ proxy: [], rule: [] })
  const healthResults = ref<Record<string, ProviderHealthResult>>({})
  const batchRefreshing = ref(false)

  const orderedProxyProviders = computed<MihomoProxyProvider[]>(() =>
    Object.values(proxyProviders.value).sort((a, b) => a.name.localeCompare(b.name))
  )
  const orderedRuleProviders = computed<MihomoRuleProvider[]>(() =>
    Object.values(ruleProviders.value).sort((a, b) => a.name.localeCompare(b.name))
  )

  /** Only URL-backed providers belong on the external-resources page. */
  const remoteProxyProviders = computed<MihomoProxyProvider[]>(() =>
    orderedProxyProviders.value.filter((p) => isRemoteResource(p))
  )
  /** Only URL-backed rule providers belong on the external-resources page. */
  const remoteRuleProviders = computed<MihomoRuleProvider[]>(() =>
    orderedRuleProviders.value.filter((p) => isRemoteResource(p))
  )

  function opOf(name: string, kind: ProviderKind = 'proxy'): ProviderOp {
    return ops.value[`${kind}\0${name}`] ?? emptyOp()
  }

  function setOp(name: string, patch: Partial<ProviderOp>, kind: ProviderKind = 'proxy'): void {
    const key = `${kind}\0${name}`
    ops.value = { ...ops.value, [key]: { ...opOf(name, kind), ...patch } }
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

  /**
   * Pull the ACTIVE profile's 集合声明 (url/interval/behavior…) for the 外部资源
   * viewer. Tolerant: an unreadable/absent catalog keeps the previous value —
   * the viewer already degrades per field to controller-only metadata.
   */
  async function loadProviderCatalog(): Promise<void> {
    try {
      providerCatalog.value = await window.desktop.profiles.getActiveProviderCatalog()
    } catch {
      /* keep the previous catalog */
    }
  }

  async function refreshProxyProvider(name: string): Promise<void> {
    setOp(name, { refreshing: true, error: null })
    try {
      await window.desktop.mihomo.refreshProxyProvider(name)
      await reloadProxyProviders()
      setOp(name, { refreshing: false })
    } catch (error) {
      setOp(name, { refreshing: false, error: refreshFailureMessage(error) })
    }
  }

  async function refreshRuleProvider(name: string): Promise<void> {
    setOp(name, { refreshing: true, error: null }, 'rule')
    try {
      await window.desktop.mihomo.refreshRuleProvider(name)
      await reloadRuleProviders()
      setOp(name, { refreshing: false }, 'rule')
    } catch (error) {
      setOp(name, { refreshing: false, error: refreshFailureMessage(error) }, 'rule')
    }
  }

  /**
   * Bounded-concurrency batch core shared by every 更新全部 entry point. Two
   * provider pulls may run together, avoiding a slow source blocking the whole
   * queue without flooding mihomo's DNS/TLS stack, with
   * per-provider failure isolation, then a single map re-pull so rows reflect
   * fresh metadata while a failing fetch never discards what the user sees.
   */
  async function refreshProxyProvidersBatch(names: string[]): Promise<{ updated: number; failed: number }> {
    let updated = 0
    let failed = 0
    await runProviderBatch(names, async (name) => {
      setOp(name, { refreshing: true, error: null })
      try {
        await refreshWithBackoff(() => window.desktop.mihomo.refreshProxyProvider(name))
        updated++
      } catch (error) {
        setOp(name, { error: refreshFailureMessage(error) })
        failed++
      } finally {
        setOp(name, { refreshing: false })
      }
    })
    try {
      await reloadProxyProviders()
    } catch {
      /* keep last good data */
    }
    return { updated, failed }
  }

  /** Rule-provider twin of `refreshProxyProvidersBatch` (see it for rationale). */
  async function refreshRuleProvidersBatch(names: string[]): Promise<{ updated: number; failed: number }> {
    let updated = 0
    let failed = 0
    await runProviderBatch(names, async (name) => {
      setOp(name, { refreshing: true, error: null }, 'rule')
      try {
        await refreshWithBackoff(() => window.desktop.mihomo.refreshRuleProvider(name))
        updated++
      } catch (error) {
        setOp(name, { error: refreshFailureMessage(error) }, 'rule')
        failed++
      } finally {
        setOp(name, { refreshing: false }, 'rule')
      }
    })
    try {
      await reloadRuleProviders()
    } catch {
      /* keep last good data */
    }
    return { updated, failed }
  }

  /**
   * Refresh every remote (URL-backed) external resource — proxy + rule
   * providers — currently loaded from the running controller, in one click.
   * Inline/local providers are excluded because the controller cannot re-pull
   * them (503).
   */
  async function refreshAllProviders(): Promise<{ updated: number; failed: number }> {
    if (batchRefreshing.value) return { updated: 0, failed: 0 }
    batchRefreshing.value = true
    try {
      const providers = remoteProxyProviders.value.map((p) => p.name)
      const ruleSets = remoteRuleProviders.value.map((p) => p.name)
      const proxyOutcome = await refreshProxyProvidersBatch(providers)
      const ruleOutcome = await refreshRuleProvidersBatch(ruleSets)
      return { updated: proxyOutcome.updated + ruleOutcome.updated, failed: proxyOutcome.failed + ruleOutcome.failed }
    } finally {
      batchRefreshing.value = false
    }
  }

  /**
   * Refresh only the remote RULE providers (规则页的一键更新). Serialized for
   * the same reason as the combined batch — parallel re-pulls turn kernel /
   * CDN contention into mihomo 503s — with per-provider failure isolation: one
   * failing rule set shows its own row error and never discards the others'
   * data.
   */
  async function refreshAllRuleProviders(): Promise<{ updated: number; failed: number }> {
    if (batchRefreshing.value) return { updated: 0, failed: 0 }
    batchRefreshing.value = true
    try {
      return await refreshRuleProvidersBatch(remoteRuleProviders.value.map((p) => p.name))
    } finally {
      batchRefreshing.value = false
    }
  }

  /** 更新全部 for the 外部资源 page's 代理集合 section only. */
  async function refreshAllProxyProviders(): Promise<{ updated: number; failed: number }> {
    if (batchRefreshing.value) return { updated: 0, failed: 0 }
    batchRefreshing.value = true
    try {
      return await refreshProxyProvidersBatch(remoteProxyProviders.value.map((p) => p.name))
    } finally {
      batchRefreshing.value = false
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
    batchRefreshing,
    orderedProxyProviders,
    orderedRuleProviders,
    remoteProxyProviders,
    remoteRuleProviders,
    providerCatalog,
    opOf,
    healthOf,
    loadProxyProviders,
    loadRuleProviders,
    loadProviderCatalog,
    refreshProxyProvider,
    refreshRuleProvider,
    refreshAllProviders,
    refreshAllProxyProviders,
    refreshAllRuleProviders,
    healthCheckProxyProvider,
    reset
  }
})
