import type { MihomoGateway } from '@shared/gateways'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoDelayMap,
  MihomoDelayResult,
  MihomoLogMessage,
  MihomoProxiesResponse,
  MihomoProxyProvidersResponse,
  MihomoRuleProvidersResponse,
  MihomoRulesResponse,
  MihomoStreamError
} from '@shared/mihomo-api'
import type { TrafficSample } from '@shared/runtime'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { parseMihomoConnections, parseMihomoLog, parseMihomoTraffic } from '@shared/schemas/mihomo'
import type { MihomoClient } from './mihomo-client'
import { createMihomoStream, type MihomoStream } from './mihomo-stream'

export interface MihomoServiceStreams {
  wsBaseUrl: string
  secret?: string
  /** When false the push streams stay closed (e.g. no controller in production). */
  enabled?: boolean
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

  constructor(private readonly client: MihomoClient, streams: MihomoServiceStreams) {
    const enabled = streams.enabled ?? true
    const parseHandler = (source: MihomoStreamError['source']) => (error: unknown) => this.emitError(source, 'parse', error)
    const connectionHandler = (source: MihomoStreamError['source']) => (error: unknown) => this.emitError(source, 'connection', error)
    if (enabled) {
      this.trafficStream = createMihomoStream<TrafficSample>({
        url: `${streams.wsBaseUrl}/traffic`,
        secret: streams.secret,
        parse: (raw) => ({ timestamp: Date.now(), ...parseMihomoTraffic(raw) }),
        onParseError: parseHandler('traffic'),
        onConnectionError: connectionHandler('traffic')
      })
      this.connectionsStream = createMihomoStream<MihomoConnectionsSnapshot>({
        url: `${streams.wsBaseUrl}/connections`,
        secret: streams.secret,
        parse: parseMihomoConnections,
        onParseError: parseHandler('connections'),
        onConnectionError: connectionHandler('connections')
      })
      this.logsStream = createMihomoStream<MihomoLogMessage>({
        url: `${streams.wsBaseUrl}/logs`,
        secret: streams.secret,
        parse: parseMihomoLog,
        onParseError: parseHandler('logs'),
        onConnectionError: connectionHandler('logs')
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
