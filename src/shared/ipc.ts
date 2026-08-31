import type { BrandConfig } from './brand'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoDelayMap,
  MihomoDelayResult,
  MihomoDnsQueryResult,
  MihomoDnsQueryType,
  MihomoLogMessage,
  MihomoProxiesResponse,
  MihomoProxyProvidersResponse,
  MihomoRuleProvidersResponse,
  MihomoRulesResponse,
  MihomoStreamError
} from './mihomo-api'
import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from './profiles'
import type { KernelManagerState } from './kernel-manager'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'
import type { SystemProxyStatus } from './system-proxy'
import type { StartupStatus } from './startup'
import type { TunStatus } from './tun'
import type { AppInfo } from './app-info'
import type { AppSettings } from './app-settings'
import type { UpdateState } from './updates'

export const IPC = {
  appGetBrand: 'app:get-brand',
  appGetInfo: 'app:get-info',
  kernelGetStatus: 'kernel:get-status',
  kernelStart: 'kernel:start',
  kernelStop: 'kernel:stop',
  kernelManagerGetState: 'kernel-manager:get-state',
  kernelManagerSetEnabled: 'kernel-manager:set-enabled',
  kernelManagerSetChannel: 'kernel-manager:set-channel',
  kernelManagerListVersions: 'kernel-manager:list-versions',
  kernelManagerInstall: 'kernel-manager:install',
  kernelManagerStateEvent: 'kernel-manager:state-event',
  runtimeGetSummary: 'runtime:get-summary',
  runtimeGetExternalIp: 'runtime:get-external-ip',
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
  mihomoDnsQuery: 'mihomo:dns-query',
  mihomoFlushDnsCache: 'mihomo:flush-dns-cache',
  mihomoFlushFakeIpCache: 'mihomo:flush-fakeip-cache',
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
  startupSetEnabled: 'startup:set-enabled',
  appSettingsGet: 'app-settings:get',
  appSettingsSet: 'app-settings:set',
  updatesGetState: 'updates:get-state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesStateEvent: 'updates:state-event',
  tunGetStatus: 'tun:get-status',
  tunEnable: 'tun:enable',
  tunDisable: 'tun:disable',
  tunStatusEvent: 'tun:status-event'
} as const

export interface DesktopApi {
  app: {
    getBrand(): Promise<BrandConfig>
    getInfo(): Promise<AppInfo>
  }
  kernel: {
    getStatus(): Promise<KernelStatus>
    start(): Promise<KernelStatus>
    stop(): Promise<KernelStatus>
    onStatus(listener: (status: KernelStatus) => void): () => void
  }
  kernelManager: {
    getState(): Promise<KernelManagerState>
    setEnabled(enabled: boolean): Promise<KernelManagerState>
    setChannel(channel: 'stable' | 'specific'): Promise<KernelManagerState>
    listVersions(): Promise<KernelManagerState>
    install(version: string): Promise<KernelManagerState>
    onState(listener: (state: KernelManagerState) => void): () => void
  }
  runtime: {
    getSummary(): Promise<RuntimeSummary>
    getExternalIp(): Promise<string | null>
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
    dnsQuery(name: string, type: MihomoDnsQueryType): Promise<MihomoDnsQueryResult>
    flushDnsCache(): Promise<void>
    flushFakeIpCache(): Promise<void>
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
  appSettings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  updates: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<void>
    install(): void
    onState(listener: (state: UpdateState) => void): () => void
  }
  tun: {
    getStatus(): Promise<TunStatus>
    enable(): Promise<TunStatus>
    disable(): Promise<TunStatus>
    onStatus(listener: (status: TunStatus) => void): () => void
  }
}
