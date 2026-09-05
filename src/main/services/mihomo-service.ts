import type { MihomoGateway } from '@shared/gateways'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoDelayMap,
  MihomoDelayResult,
  MihomoDnsQueryResult,
  MihomoDnsQueryType,
  MihomoLogMessage,
  MihomoLogsSnapshot,
  MihomoProxiesResponse,
  MihomoProxyProvidersResponse,
  MihomoRuleProvidersResponse,
  MihomoRulesResponse,
  MihomoStreamError,
  MihomoVersion
} from '@shared/mihomo-api'
import type { TrafficSample } from '@shared/runtime'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { parseMihomoConnections, parseMihomoLog, parseMihomoTraffic } from '@shared/schemas/mihomo'
import type { MihomoClient } from './mihomo-client'
import { MihomoLogBuffer } from './log-buffer'
import { createMihomoStream, type MihomoStream } from './mihomo-stream'

export interface MihomoServiceStreams {
  wsBaseUrl: string
  secret?: string
  /** When false the push streams stay closed (e.g. no controller in production). */
  enabled?: boolean
  /** Explicit group URLs parsed from the active runtime profile document. */
  resolveGroupTestUrls?: () => Promise<Record<string, string | null>>
  resolveDelayTestSettings?: () => Promise<{ scope: 'group' | 'global'; url: string }>
  /**
   * Retention buffer for the log history snapshot channel. Created internally
   * when omitted; injectable for tests. The buffer is fed by tapping `parse`,
   * so it captures EVERY message that crosses the socket regardless of who is
   * subscribed — log capture must not depend on the logs page being open.
   */
  logBuffer?: MihomoLogBuffer
}

/**
 * The production-capable {@link MihomoGateway}: REST calls delegate to a
 * {@link MihomoClient}, and the push streams share one WebSocket per stream.
 * The `enabled` flag lets callers run the REST surface without opening any
 * long-lived socket when there is no reachable controller.
 */
export class MihomoService implements MihomoGateway {
  private readonly trafficStream: MihomoStream<TrafficSample> | null
  private readonly connectionsStream: MihomoStream<MihomoConnectionsSnapshot> | null
  private readonly logsStream: MihomoStream<MihomoLogMessage> | null
  private readonly errorListeners = new Set<(error: MihomoStreamError) => void>()
  private readonly resolveGroupTestUrls?: MihomoServiceStreams['resolveGroupTestUrls']
  private readonly resolveDelayTestSettings?: MihomoServiceStreams['resolveDelayTestSettings']
  private groupTestUrlsPromise: Promise<Record<string, string | null>> | null = null
  private groupTestUrlsExpiresAt = 0
  private providerOwnersPromise: Promise<Map<string, string | null>> | null = null
  private providerOwnersExpiresAt = 0
  private readonly logBuffer: MihomoLogBuffer

  constructor(private readonly client: MihomoClient, streams: MihomoServiceStreams) {
    this.resolveGroupTestUrls = streams.resolveGroupTestUrls
    this.resolveDelayTestSettings = streams.resolveDelayTestSettings
    const enabled = streams.enabled ?? true
    this.logBuffer = streams.logBuffer ?? new MihomoLogBuffer()
    const parseHandler = (source: MihomoStreamError['source']) => (error: unknown) => this.emitError(source, 'parse', error)
    const connectionHandler = (source: MihomoStreamError['source']) => (error: unknown) => this.emitError(source, 'connection', error)
    if (enabled) {
      // maxRetries: 0 — retry FOREVER while any listener remains. The
      // production subscribers are long-lived (the IPC forwarder subscribes at
      // startup until quit, usage history hangs off /traffic permanently), so
      // `listeners.size` never drops to zero and the listener-count reset in
      // the transport never runs. A finite retry budget therefore means a
      // kernel downtime longer than the backoff ladder (~23s at defaults —
      // easy to hit with TUN mode switches or a manual restart) KILLS the
      // streams until the app relaunches: the UI sticks at "未收到流量数据"
      // and usage history silently stops recording. Retrying indefinitely with
      // the existing exponential backoff + jitter (capped at 5s) is the correct
      // steady-state behavior for a loopback peer that comes and goes.
      this.trafficStream = createMihomoStream<TrafficSample>({
        url: `${streams.wsBaseUrl}/traffic`,
        secret: streams.secret,
        parse: (raw) => ({ timestamp: Date.now(), ...parseMihomoTraffic(raw) }),
        onParseError: parseHandler('traffic'),
        onConnectionError: connectionHandler('traffic'),
        options: { maxRetries: 0 }
      })
      this.connectionsStream = createMihomoStream<MihomoConnectionsSnapshot>({
        url: `${streams.wsBaseUrl}/connections`,
        secret: streams.secret,
        parse: parseMihomoConnections,
        onParseError: parseHandler('connections'),
        onConnectionError: connectionHandler('connections'),
        options: { maxRetries: 0 }
      })
      this.logsStream = createMihomoStream<MihomoLogMessage>({
        url: `${streams.wsBaseUrl}/logs`,
        secret: streams.secret,
        // Tap the parse boundary to retain history: mihomo's /logs endpoint is a
        // live tail with no replay, so without this tap every line emitted while
        // the logs view is unmounted would be lost. Buffering here (not in a
        // subscriber) keeps capture independent of who is listening.
        parse: (raw) => {
          const message = parseMihomoLog(raw)
          this.logBuffer.append(message)
          return message
        },
        onParseError: parseHandler('logs'),
        onConnectionError: connectionHandler('logs'),
        options: { maxRetries: 0 }
      })
    } else {
      this.trafficStream = null
      this.connectionsStream = null
      this.logsStream = null
    }
  }

  getConfig(): Promise<MihomoConfigSnapshot> {
    return this.client.getConfig()
  }

  getVersion(): Promise<MihomoVersion> {
    return this.client.getVersion()
  }

  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> {
    return this.client.patchConfig(patch)
  }

  getProxies(): Promise<MihomoProxiesResponse> {
    return this.client.getProxies()
  }

  selectProxy(group: string, name: string): Promise<void> {
    return this.client.selectProxy(group, name)
  }

  getRules(): Promise<MihomoRulesResponse> {
    return this.client.getRules()
  }

  getProxyProviders(): Promise<MihomoProxyProvidersResponse> {
    return this.client.getProxyProviders()
  }

  refreshProxyProvider(name: string): Promise<void> {
    return this.client.refreshProxyProvider(name)
  }

  healthCheckProxyProvider(name: string): Promise<void> {
    return this.client.healthCheckProxyProvider(name)
  }

  /**
   * Resolve a member from trusted controller state before probing it. This keeps
   * renderer-controlled URLs out of IPC, uses the group's own test URL, and
   * routes provider nodes through the provider health-check endpoint.
   */
  async groupMemberDelayTest(group: string, name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult> {
    const [snapshot, explicitUrls, settings] = await Promise.all([
      this.client.getProxies(),
      this.getGroupTestUrls(),
      this.resolveDelayTestSettings?.().catch(() => ({ scope: 'group' as const, url: '' })) ??
        Promise.resolve({ scope: 'group' as const, url: '' })
    ])
    const owner = snapshot.proxies[group]
    if (!owner || !Array.isArray(owner.all) || !owner.all.includes(name)) {
      throw new ProtocolError(ProtocolErrorCode.NOT_FOUND, `策略组 ${group} 中不存在成员 ${name}`)
    }

    // A null profile entry means this group intentionally omitted `url`.
    // Do not reuse the controller's blank Selector value or a provider URL that
    // mihomo inherited internally for an include-all-providers group: both make
    // interactive results surprising. Missing profile data keeps the controller
    // value as a compatibility fallback for temporary/mock groups.
    const globalUrl = settings.url.trim() || null
    const hasProfileEntry = Object.prototype.hasOwnProperty.call(explicitUrls, group)
    const groupUrl = hasProfileEntry ? explicitUrls[group] : owner.testUrl?.trim() || null
    const resolvedUrl = settings.scope === 'global' ? globalUrl : groupUrl || globalUrl
    const testOptions = resolvedUrl ? { ...opts, url: resolvedUrl } : { ...opts }
    const member = snapshot.proxies[name]
    // A nested policy group is tested through /proxies/:name/delay. Only leaf
    // nodes are candidates for provider-specific health checks.
    if (!Array.isArray(member?.all)) {
      try {
        const providerName = (await this.getProviderOwners()).get(name)
        // null means the same controller name appeared in multiple providers;
        // the ordinary proxy endpoint is authoritative and avoids testing the
        // wrong provider record merely because it was enumerated first.
        if (providerName) return this.client.providerDelayTest(providerName, name, testOptions)
      } catch (error) {
        // A controller/provider-list failure must not make a globally resolvable
        // node untestable; fall through to the standard proxy endpoint.
        if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UNAUTHORIZED) throw error
      }
    }
    return this.client.delayTest(name, testOptions)
  }

  /** Coalesce all concurrent members in a batch onto one bounded profile read. */
  private getGroupTestUrls(): Promise<Record<string, string | null>> {
    if (!this.resolveGroupTestUrls) return Promise.resolve({})
    const now = Date.now()
    if (this.groupTestUrlsPromise && now < this.groupTestUrlsExpiresAt) return this.groupTestUrlsPromise
    this.groupTestUrlsExpiresAt = now + 1_000
    this.groupTestUrlsPromise = this.resolveGroupTestUrls().catch(() => ({}))
    return this.groupTestUrlsPromise
  }

  /** Provider-name index shared by every member of the current test batch. */
  private getProviderOwners(): Promise<Map<string, string | null>> {
    const now = Date.now()
    if (this.providerOwnersPromise && now < this.providerOwnersExpiresAt) return this.providerOwnersPromise
    this.providerOwnersExpiresAt = now + 1_000
    this.providerOwnersPromise = this.client.getProxyProviders().then(({ providers }) => {
      const owners = new Map<string, string | null>()
      for (const [providerName, provider] of Object.entries(providers)) {
        for (const proxy of provider.proxies ?? []) {
          owners.set(proxy.name, owners.has(proxy.name) ? null : providerName)
        }
      }
      return owners
    })
    return this.providerOwnersPromise
  }

  getRuleProviders(): Promise<MihomoRuleProvidersResponse> {
    return this.client.getRuleProviders()
  }

  refreshRuleProvider(name: string): Promise<void> {
    return this.client.refreshRuleProvider(name)
  }

  delayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult> {
    return this.client.delayTest(name, opts)
  }

  groupDelayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayMap> {
    return this.client.groupDelayTest(name, opts)
  }

  dnsQuery(name: string, type: MihomoDnsQueryType): Promise<MihomoDnsQueryResult> {
    return this.client.dnsQuery(name, type)
  }

  flushDnsCache(): Promise<void> { return this.client.flushDnsCache() }

  flushFakeIpCache(): Promise<void> { return this.client.flushFakeIpCache() }

  getConnections(): Promise<MihomoConnectionsSnapshot> {
    return this.client.getConnections()
  }

  closeConnection(id: string): Promise<void> {
    return this.client.closeConnection(id)
  }

  onTraffic(listener: (sample: TrafficSample) => void): () => void {
    return this.trafficStream ? this.trafficStream.subscribe(listener) : () => undefined
  }

  onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void {
    return this.connectionsStream ? this.connectionsStream.subscribe(listener) : () => undefined
  }

  onLogs(listener: (message: MihomoLogMessage) => void): () => void {
    return this.logsStream ? this.logsStream.subscribe(listener) : () => undefined
  }

  /** Retained log history past `afterSeq` (see {@link MihomoLogBuffer}). */
  logsSnapshot(afterSeq?: number): Promise<MihomoLogsSnapshot> {
    const clamped = typeof afterSeq === 'number' && Number.isFinite(afterSeq) && afterSeq > 0
      ? Math.floor(afterSeq)
      : 0
    return Promise.resolve({ entries: this.logBuffer.snapshot(clamped), lastSeq: this.logBuffer.lastSeq })
  }

  /** Drop retained log history (renderer "清空" button). Sequence numbering continues. */
  clearLogs(): Promise<number> {
    return Promise.resolve(this.logBuffer.clear())
  }

  onStreamError(listener: (error: MihomoStreamError) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  dispose(): void {
    this.trafficStream?.close()
    this.connectionsStream?.close()
    this.logsStream?.close()
    this.errorListeners.clear()
  }

  private emitError(source: MihomoStreamError['source'], kind: MihomoStreamError['kind'], error: unknown): void {
    const code = error instanceof ProtocolError ? error.code : ProtocolErrorCode.UPSTREAM_UNREACHABLE
    const message = error instanceof Error ? error.message : String(error)
    const payload: MihomoStreamError = { code, message: `${source} stream: ${message}`, source, kind }
    for (const listener of this.errorListeners) listener(payload)
  }
}
