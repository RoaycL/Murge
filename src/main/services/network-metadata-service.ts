import http from 'node:http'
import type { NetworkMetadataGateway } from '@shared/gateways'
import {
  defaultNetworkMetadataProviderId,
  getNetworkMetadataProvider,
  networkMetadataProviderList,
  parseNetworkMetadataJson,
  type NetworkMetadata,
  type NetworkMetadataPhase,
  type NetworkMetadataProvider,
  type NetworkMetadataState
} from '@shared/network-metadata'

/**
 * Read-only network (egress) metadata service.
 *
 * Resolves the running proxy node's public exit address through the kernel's
 * mixed-port proxy (absolute-form GET), then derives geographic metadata from
 * the user-selected privacy-explicit provider. A small bounded in-memory cache
 * keyed by provider id prevents duplicate provider round-trips; nothing is ever
 * persisted to disk, so no credentials, hosts or raw profiles are stored. Every
 * outcome flows through an explicit {@link NetworkMetadataState} so a kernel or
 * provider failure is surfaced instead of silently blanked.
 */

export interface NetworkMetadataServiceOptions {
  /** Fetch a provider endpoint as parsed JSON via the kernel proxy. Resolves null on failure. */
  fetchJsonViaProxy: (endpoint: string, port: number, timeoutMs?: number) => Promise<unknown>
  /** Resolve the kernel's mixed-port, or null when the kernel is not running. */
  resolveProxyPort: () => Promise<number | null>
  /** Injectable clock (epoch ms). */
  now?: () => number
  /** Max cached entries (bounded cache). */
  cacheMaxEntries?: number
  /** Cache freshness window (ms). */
  cacheTtlMs?: number
  /** Initial provider id. Defaults to the shipped default. */
  initialProviderId?: string
  /** Provider fetch timeout. */
  timeoutMs?: number
}

const DEFAULT_CACHE_MAX_ENTRIES = 4
const DEFAULT_CACHE_TTL_MS = 30 * 60_000
const DEFAULT_TIMEOUT_MS = 5000

const FETCH_FAILURE = '查询失败，请重试'
const KERNEL_NOT_RUNNING = '内核未运行，无法查询出口信息'
const PARSE_FAILURE = '数据源返回了无法解析的响应'

export class NetworkMetadataService implements NetworkMetadataGateway {
  #providerId: string
  #fetchJsonViaProxy: (endpoint: string, port: number, timeoutMs?: number) => Promise<unknown>
  #resolveProxyPort: () => Promise<number | null>
  #now: () => number
  #cacheMaxEntries: number
  #cacheTtlMs: number
  #timeoutMs: number
  #cache = new Map<string, NetworkMetadata>()
  #phase: NetworkMetadataPhase = 'idle'
  #error: string | null = null
  #fetching: Promise<NetworkMetadataState> | null = null

  constructor(options: NetworkMetadataServiceOptions) {
    this.#fetchJsonViaProxy = options.fetchJsonViaProxy
    this.#resolveProxyPort = options.resolveProxyPort
    this.#now = options.now ?? Date.now
    this.#cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const initial = options.initialProviderId ?? defaultNetworkMetadataProviderId()
    this.#providerId = getNetworkMetadataProvider(initial) ? initial : defaultNetworkMetadataProviderId()
  }

  getProviders(): NetworkMetadataProvider[] {
    return networkMetadataProviderList()
  }

  getState(): NetworkMetadataState {
    return this.#state()
  }

  selectProvider(id: string): NetworkMetadataState {
    if (!getNetworkMetadataProvider(id)) {
      throw new Error(`unknown network metadata provider: ${id}`)
    }
    this.#providerId = id
    const cached = this.#freshCache(id)
    if (cached) {
      this.#phase = 'ready'
      this.#error = null
    } else {
      this.#phase = 'idle'
      this.#error = null
    }
    return this.#state()
  }

  resolve(force = false): Promise<NetworkMetadataState> {
    if (this.#fetching) return this.#fetching
    this.#fetching = this.#doResolve(force).finally(() => {
      this.#fetching = null
    })
    return this.#fetching
  }

  async #doResolve(force: boolean): Promise<NetworkMetadataState> {
    const provider = getNetworkMetadataProvider(this.#providerId)
    if (!provider) {
      this.#phase = 'error'
      this.#error = `未知的数据源：${this.#providerId}`
      return this.#state()
    }

    if (!force) {
      const cached = this.#freshCache(this.#providerId)
      if (cached) {
        this.#phase = 'ready'
        this.#error = null
        return this.#state()
      }
    }

    this.#phase = 'fetching'
    let port: number | null = null
    try {
      port = await this.#resolveProxyPort()
    } catch {
      port = null
    }
    if (port === null) {
      this.#phase = 'error'
      this.#error = KERNEL_NOT_RUNNING
      return this.#state()
    }

    let body: unknown = null
    try {
      body = await this.#fetchJsonViaProxy(provider.endpoint, port, this.#timeoutMs)
    } catch {
      body = null
    }

    const metadata = body === null ? null : parseNetworkMetadataJson(body, provider.id, this.#now())
    if (!metadata) {
      this.#phase = 'error'
      this.#error = PARSE_FAILURE
      return this.#state()
    }

    this.#storeCache(provider.id, metadata)
    this.#phase = 'ready'
    this.#error = null
    return this.#state()
  }

  /** Insert into the bounded cache, evicting the oldest entry when over capacity. */
  #storeCache(providerId: string, metadata: NetworkMetadata): void {
    this.#cache.set(providerId, metadata)
    if (this.#cache.size > this.#cacheMaxEntries) {
      let oldestId: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.#cache) {
        if (entry.fetchedAt < oldestAt) {
          oldestAt = entry.fetchedAt
          oldestId = id
        }
      }
      if (oldestId !== null) this.#cache.delete(oldestId)
    }
  }

  /** A cache entry that is still within its freshness window, or null. */
  #freshCache(providerId: string): NetworkMetadata | null {
    const cached = this.#cache.get(providerId)
    if (!cached) return null
    return this.#now() - cached.fetchedAt <= this.#cacheTtlMs ? cached : null
  }

  #state(): NetworkMetadataState {
    const cached = this.#freshCache(this.#providerId)
    if (this.#phase === 'fetching') {
      return { phase: 'fetching', provider: this.#providerId, metadata: cached, error: null }
    }
    if (this.#phase === 'ready') {
      return { phase: cached ? 'ready' : 'idle', provider: this.#providerId, metadata: cached, error: null }
    }
    return { phase: this.#phase, provider: this.#providerId, metadata: cached, error: this.#error }
  }
}

/**
 * Fetch a plain-http JSON endpoint via the kernel's mixed-port proxy using an
 * absolute-form request line, exactly like the egress-IP echo path. Returns the
 * parsed JSON on success (2xx + valid JSON) or null on any failure.
 */
export function fetchMetadataJsonViaProxy(endpoint: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(endpoint)
    } catch {
      resolve(null)
      return
    }
    // Only plain-http targets can be reached with an absolute-form GET through a
    // forward proxy; https requires a CONNECT tunnel that is out of scope here.
    if (target.protocol !== 'http:') {
      resolve(null)
      return
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: target.href,
        headers: { Host: target.host, Connection: 'close', Accept: 'application/json' },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
            resolve(null)
            return
          }
          const body = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(null)
          }
        })
        res.on('error', () => resolve(null))
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}
