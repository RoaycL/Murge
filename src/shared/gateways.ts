import type { BrandConfig } from './brand'
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
} from './mihomo-api'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'

/**
 * Narrow, testable service boundaries. Main-process services implement these
 * interfaces and the IPC handlers depend on them, so unit tests can inject a
 * fake container without Electron or a real kernel.
 */

export interface KernelGateway {
  getStatus(): KernelStatus | Promise<KernelStatus>
  start(): Promise<KernelStatus>
  stop(): Promise<KernelStatus>
  /** Subscribe to status transitions; returns an unsubscribe function. */
  onStatus(listener: (status: KernelStatus) => void): () => void
}

export interface MihomoGateway {
  getConfig(): Promise<MihomoConfigSnapshot>
  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void>
  getProxies(): Promise<MihomoProxiesResponse>
  selectProxy(group: string, name: string): Promise<void>
  getRules(): Promise<MihomoRulesResponse>
  getProxyProviders(): Promise<MihomoProxyProvidersResponse>
  refreshProxyProvider(name: string): Promise<void>
  healthCheckProxyProvider(name: string): Promise<void>
  getRuleProviders(): Promise<MihomoRuleProvidersResponse>
  refreshRuleProvider(name: string): Promise<void>
  delayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult>
  groupDelayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayMap>
  getConnections(): Promise<MihomoConnectionsSnapshot>
  closeConnection(id: string): Promise<void>
  /** Push subscriptions over the shared WebSocket transports. */
  onTraffic(listener: (sample: TrafficSample) => void): () => void
  onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void
  onLogs(listener: (message: MihomoLogMessage) => void): () => void
  onStreamError(listener: (error: MihomoStreamError) => void): () => void
}

export interface RuntimeGateway {
  getSummary(): RuntimeSummary
}

/** Everything the IPC handler factory needs from the trusted main process. */
export interface IpcDeps {
  brand: BrandConfig
  kernel: KernelGateway
  mihomo: MihomoGateway
  runtime: RuntimeGateway
}
