import type { BrandConfig } from './brand'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoLogMessage,
  MihomoProxiesResponse,
  MihomoRulesResponse,
  MihomoStreamError
} from './mihomo-api'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'

export const IPC = {
  appGetBrand: 'app:get-brand',
  kernelGetStatus: 'kernel:get-status',
  kernelStart: 'kernel:start',
  kernelStop: 'kernel:stop',
  runtimeGetSummary: 'runtime:get-summary',
  mihomoGetConfig: 'mihomo:get-config',
  mihomoPatchConfig: 'mihomo:patch-config',
  mihomoGetProxies: 'mihomo:get-proxies',
  mihomoSelectProxy: 'mihomo:select-proxy',
  mihomoGetRules: 'mihomo:get-rules',
  mihomoGetConnections: 'mihomo:get-connections',
  mihomoCloseConnection: 'mihomo:close-connection',
  mihomoTrafficEvent: 'mihomo:traffic-event',
  mihomoConnectionsEvent: 'mihomo:connections-event',
  mihomoLogEvent: 'mihomo:log-event',
  mihomoStreamErrorEvent: 'mihomo:stream-error-event',
  kernelStatusEvent: 'kernel:status-event'
} as const

export interface DesktopApi {
  app: {
    getBrand(): Promise<BrandConfig>
  }
  kernel: {
    getStatus(): Promise<KernelStatus>
    start(): Promise<KernelStatus>
    stop(): Promise<KernelStatus>
    onStatus(listener: (status: KernelStatus) => void): () => void
  }
  runtime: {
    getSummary(): Promise<RuntimeSummary>
  }
  mihomo: {
    getConfig(): Promise<MihomoConfigSnapshot>
    patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void>
    getProxies(): Promise<MihomoProxiesResponse>
    selectProxy(group: string, name: string): Promise<void>
    getRules(): Promise<MihomoRulesResponse>
    getConnections(): Promise<MihomoConnectionsSnapshot>
    closeConnection(id: string): Promise<void>
    onTraffic(listener: (sample: TrafficSample) => void): () => void
    onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void
    onLogs(listener: (message: MihomoLogMessage) => void): () => void
    onStreamError(listener: (error: MihomoStreamError) => void): () => void
  }
}
