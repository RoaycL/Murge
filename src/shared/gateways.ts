import type { BrandConfig } from './brand'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoProxiesResponse,
  MihomoRulesResponse
} from './mihomo-api'
import type { KernelStatus, RuntimeSummary } from './runtime'

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
  getConnections(): Promise<MihomoConnectionsSnapshot>
  closeConnection(id: string): Promise<void>
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
