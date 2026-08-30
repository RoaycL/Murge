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
import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from './profiles'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'
import type { SystemProxyStatus } from './system-proxy'
import type { StartupStatus } from './startup'

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
  mihomoGetProxyProviders: 'mihomo:get-proxy-providers',
  mihomoRefreshProxyProvider: 'mihomo:refresh-proxy-provider',
  mihomoHealthCheckProxyProvider: 'mihomo:health-check-proxy-provider',
  mihomoGetRuleProviders: 'mihomo:get-rule-providers',
  mihomoRefreshRuleProvider: 'mihomo:refresh-rule-provider',
  mihomoDelayTest: 'mihomo:delay-test',
  mihomoGroupDelayTest: 'mihomo:group-delay-test',
  mihomoGetConnections: 'mihomo:get-connections',
  mihomoCloseConnection: 'mihomo:close-connection',
  mihomoTrafficEvent: 'mihomo:traffic-event',
  mihomoConnectionsEvent: 'mihomo:connections-event',
  mihomoLogEvent: 'mihomo:log-event',
  mihomoStreamErrorEvent: 'mihomo:stream-error-event',
  profilesList: 'profiles:list',
  profilesGet: 'profiles:get',
  profilesImport: 'profiles:import',
  profilesImportFromUrl: 'profiles:import-from-url',
  profilesActivate: 'profiles:activate',
  profilesDelete: 'profiles:delete',
  profilesRename: 'profiles:rename',
  profilesEditDocument: 'profiles:edit-document',
  profilesValidate: 'profiles:validate',
  kernelStatusEvent: 'kernel:status-event',
  systemProxyGetStatus: 'system-proxy:get-status',
  systemProxyEnable: 'system-proxy:enable',
  systemProxyDisable: 'system-proxy:disable',
  systemProxyStatusEvent: 'system-proxy:status-event',
  startupGetStatus: 'startup:get-status',
  startupSetEnabled: 'startup:set-enabled'
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
    getProxyProviders(): Promise<MihomoProxyProvidersResponse>
    refreshProxyProvider(name: string): Promise<void>
    healthCheckProxyProvider(name: string): Promise<void>
    getRuleProviders(): Promise<MihomoRuleProvidersResponse>
    refreshRuleProvider(name: string): Promise<void>
    delayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult>
    groupDelayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayMap>
    getConnections(): Promise<MihomoConnectionsSnapshot>
    closeConnection(id: string): Promise<void>
    onTraffic(listener: (sample: TrafficSample) => void): () => void
    onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void
    onLogs(listener: (message: MihomoLogMessage) => void): () => void
    onStreamError(listener: (error: MihomoStreamError) => void): () => void
  }
  profiles: {
    list(): Promise<ProfileMeta[]>
    get(id: string): Promise<Profile>
    import(request: ImportRequest): Promise<ProfileMeta>
    importFromUrl(name: string, url: string, activate?: boolean): Promise<ProfileMeta>
    activate(id: string): Promise<ProfileMeta>
    delete(id: string): Promise<void>
    rename(id: string, name: string): Promise<ProfileMeta>
    editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta>
    validate(document: string): Promise<ValidationResult>
  }
  systemProxy: {
    getStatus(): Promise<SystemProxyStatus>
    enable(): Promise<SystemProxyStatus>
    disable(): Promise<SystemProxyStatus>
    onStatus(listener: (status: SystemProxyStatus) => void): () => void
  }
  startup: {
    getStatus(): Promise<StartupStatus>
    setEnabled(enabled: boolean): Promise<StartupStatus>
  }
}
