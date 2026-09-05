import type { BrandConfig } from './brand'
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
  MihomoStreamError
} from './mihomo-api'
import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from './profiles'
import type { KernelManagerState } from './kernel-manager'
import type {
  OverrideInput,
  OverridesSnapshot,
  OverridePreview,
  OverrideValidation,
  OverrideLastKnownGood
} from './overrides'
import type { DnsEnhancement, DnsSnapshot } from './dns'
import type { SnifferEnhancement, SnifferSnapshot } from './sniffer'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'
import type { SystemProxyStatus } from './system-proxy'
import type { ProxyBypassPolicy } from './proxy-bypass'
import type { StartupStatus } from './startup'
import type { TunStatus } from './tun'
import type { TunConfigModel, TunConfigSnapshot } from './tun-config'
import type { CoreSettings } from './core-settings'
import type { GeodataSettings } from './geodata'
import type { UsageWindow, UsageRanking, UsageHistorySnapshot, UsageRankingEntry, UsageCapacity } from './usage'
import type { NetworkMetadataProvider, NetworkMetadataSnapshot, NetworkMetadataState } from './network-metadata'
import type { AppInfo } from './app-info'
import type { AppSettings } from './app-settings'
import type { UpdateState } from './updates'

export const IPC = {
  appGetBrand: 'app:get-brand',
  appGetInfo: 'app:get-info',
  appGetProcessIcon: 'app:get-process-icon',
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
  mihomoInternetLatency: 'mihomo:internet-latency',
  mihomoSelectProxy: 'mihomo:select-proxy',
  mihomoGetRules: 'mihomo:get-rules',
  mihomoGetProxyProviders: 'mihomo:get-proxy-providers',
  mihomoRefreshProxyProvider: 'mihomo:refresh-proxy-provider',
  mihomoHealthCheckProxyProvider: 'mihomo:health-check-proxy-provider',
  mihomoGetRuleProviders: 'mihomo:get-rule-providers',
  mihomoRefreshRuleProvider: 'mihomo:refresh-rule-provider',
  mihomoDelayTest: 'mihomo:delay-test',
  mihomoGroupMemberDelayTest: 'mihomo:group-member-delay-test',
  mihomoGroupDelayTest: 'mihomo:group-delay-test',
  mihomoGetConnections: 'mihomo:get-connections',
  mihomoCloseConnection: 'mihomo:close-connection',
  mihomoDnsQuery: 'mihomo:dns-query',
  mihomoFlushDnsCache: 'mihomo:flush-dns-cache',
  mihomoFlushFakeIpCache: 'mihomo:flush-fakeip-cache',
  mihomoLogsSnapshot: 'mihomo:logs-snapshot',
  mihomoClearLogs: 'mihomo:clear-logs',
  mihomoTrafficEvent: 'mihomo:traffic-event',
  mihomoConnectionsEvent: 'mihomo:connections-event',
  mihomoLogEvent: 'mihomo:log-event',
  mihomoStreamErrorEvent: 'mihomo:stream-error-event',
  profilesList: 'profiles:list',
  profilesGetActiveGroupOrder: 'profiles:get-active-group-order',
  profilesGet: 'profiles:get',
  profilesImport: 'profiles:import',
  profilesImportFromUrl: 'profiles:import-from-url',
  profilesUpdateFromSource: 'profiles:update-from-source',
  profilesActivate: 'profiles:activate',
  profilesDelete: 'profiles:delete',
  profilesRename: 'profiles:rename',
  profilesEditDocument: 'profiles:edit-document',
  profilesReplaceDocument: 'profiles:replace-document',
  profilesGetSourceUrl: 'profiles:get-source-url',
  profilesSetSourceUrl: 'profiles:set-source-url',
  profilesValidate: 'profiles:validate',
  kernelStatusEvent: 'kernel:status-event',
  systemProxyGetStatus: 'system-proxy:get-status',
  systemProxyEnable: 'system-proxy:enable',
  systemProxyDisable: 'system-proxy:disable',
  systemProxyStatusEvent: 'system-proxy:status-event',
  systemProxyGetProxyBypass: 'system-proxy:get-proxy-bypass',
  systemProxySetProxyBypass: 'system-proxy:set-proxy-bypass',
  systemProxyPreviewProxyBypass: 'system-proxy:preview-proxy-bypass',
  startupGetStatus: 'startup:get-status',
  startupSetEnabled: 'startup:set-enabled',
  appSettingsGet: 'app-settings:get',
  appSettingsSet: 'app-settings:set',
  overridesList: 'overrides:list',
  overridesCreate: 'overrides:create',
  overridesUpdate: 'overrides:update',
  overridesRemove: 'overrides:remove',
  overridesSetEnabled: 'overrides:set-enabled',
  overridesMove: 'overrides:move',
  overridesPreview: 'overrides:preview',
  overridesValidate: 'overrides:validate',
  overridesLastKnownGood: 'overrides:last-known-good',
  overridesResetToLastGood: 'overrides:reset-to-last-good',
  dnsGet: 'dns:get',
  dnsSet: 'dns:set',
  dnsPreview: 'dns:preview',
  snifferGet: 'sniffer:get',
  snifferSet: 'sniffer:set',
  snifferPreview: 'sniffer:preview',
  updatesGetState: 'updates:get-state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesStateEvent: 'updates:state-event',
  tunGetStatus: 'tun:get-status',
  tunEnable: 'tun:enable',
  tunDisable: 'tun:disable',
  tunStatusEvent: 'tun:status-event',
  tunConfigGet: 'tun-config:get',
  tunConfigSet: 'tun-config:set',
  tunConfigPreview: 'tun-config:preview',
  coreSettingsGet: 'core-settings:get',
  coreSettingsSet: 'core-settings:set',
  coreSettingsPreview: 'core-settings:preview',
  geodataSettingsGet: 'geodata-settings:get',
  geodataSettingsSet: 'geodata-settings:set',
  geodataSettingsPreview: 'geodata-settings:preview',
  usageHistoryGetWindow: 'usage-history:get-window',
  usageHistoryRank: 'usage-history:rank',
  usageHistoryClear: 'usage-history:clear',
  usageHistoryGetCapacity: 'usage-history:get-capacity',
  networkMetadataGetProviders: 'network-metadata:get-providers',
  networkMetadataGetState: 'network-metadata:get-state',
  networkMetadataSelectProvider: 'network-metadata:select-provider',
  networkMetadataResolve: 'network-metadata:resolve',
  networkMetadataResolveAll: 'network-metadata:resolve-all'
} as const

export interface DesktopApi {
  app: {
    getBrand(): Promise<BrandConfig>
    getInfo(): Promise<AppInfo>
    getProcessIcon(path: string): Promise<string | null>
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
    /** One INTERNET-latency sample (gateway/dns/proxy RTTs; null per failed slot). */
    internetLatency(): Promise<{ gatewayMs: number | null; dnsMs: number | null; proxyMs: number | null; proxyNode: string | null }>
    selectProxy(group: string, name: string): Promise<void>
    getRules(): Promise<MihomoRulesResponse>
    getProxyProviders(): Promise<MihomoProxyProvidersResponse>
    refreshProxyProvider(name: string): Promise<void>
    healthCheckProxyProvider(name: string): Promise<void>
    getRuleProviders(): Promise<MihomoRuleProvidersResponse>
    refreshRuleProvider(name: string): Promise<void>
    delayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult>
    groupMemberDelayTest(group: string, name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult>
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
    /** Retained kernel-log history past `afterSeq` (0 = everything retained). */
    logsSnapshot(afterSeq?: number): Promise<MihomoLogsSnapshot>
    /** Drop retained history and return the last sequence included in the clear. */
    clearLogs(): Promise<number>
  }
  profiles: {
    /** Ordered proxy-group names from the ACTIVE profile document (config order). */
    getActiveGroupOrder(): Promise<string[]>
    list(): Promise<ProfileMeta[]>
    get(id: string): Promise<Profile>
    import(request: ImportRequest): Promise<ProfileMeta>
    importFromUrl(name: string, url: string, activate?: boolean): Promise<ProfileMeta>
    updateFromSource(id: string): Promise<ProfileMeta>
    activate(id: string): Promise<ProfileMeta>
    delete(id: string): Promise<void>
    rename(id: string, name: string): Promise<ProfileMeta>
    editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta>
    replaceDocument(id: string, document: string): Promise<ProfileMeta>
    getSourceUrl(id: string): Promise<string | null>
    setSourceUrl(id: string, url: string): Promise<ProfileMeta>
    validate(document: string): Promise<ValidationResult>
  }
  systemProxy: {
    getStatus(): Promise<SystemProxyStatus>
    enable(): Promise<SystemProxyStatus>
    disable(): Promise<SystemProxyStatus>
    onStatus(listener: (status: SystemProxyStatus) => void): () => void
    getProxyBypass(): Promise<ProxyBypassPolicy>
    setProxyBypass(input: ProxyBypassPolicy): Promise<ProxyBypassPolicy>
    previewProxyBypass(input: ProxyBypassPolicy): Promise<string>
  }
  startup: {
    getStatus(): Promise<StartupStatus>
    setEnabled(enabled: boolean): Promise<StartupStatus>
  }
  appSettings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  overrides: {
    list(): Promise<OverridesSnapshot>
    create(input: OverrideInput): Promise<OverridesSnapshot>
    update(id: string, input: OverrideInput): Promise<OverridesSnapshot>
    remove(id: string): Promise<OverridesSnapshot>
    setEnabled(id: string, enabled: boolean): Promise<OverridesSnapshot>
    move(id: string, direction: 'up' | 'down'): Promise<OverridesSnapshot>
    preview(): Promise<OverridePreview>
    validate(): Promise<OverrideValidation>
    lastKnownGood(): Promise<OverrideLastKnownGood | null>
    resetToLastGood(): Promise<OverridesSnapshot>
  }
  dns: {
    get(): Promise<DnsSnapshot>
    set(input: DnsEnhancement): Promise<DnsSnapshot>
    preview(input: DnsEnhancement): Promise<string>
  }
  sniffer: {
    get(): Promise<SnifferSnapshot>
    set(input: SnifferEnhancement): Promise<SnifferSnapshot>
    preview(input: SnifferEnhancement): Promise<string>
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
  tunConfig: {
    get(): Promise<TunConfigSnapshot>
    set(input: TunConfigModel): Promise<TunConfigSnapshot>
    preview(input: TunConfigModel): Promise<string>
  }
  core: {
    get(): Promise<CoreSettings>
    set(input: CoreSettings): Promise<CoreSettings>
    preview(input: CoreSettings): Promise<string>
  }
  geodata: {
    get(): Promise<GeodataSettings>
    set(input: GeodataSettings): Promise<GeodataSettings>
    preview(input: GeodataSettings): Promise<string>
  }
  usageHistory: {
    getWindow(window: UsageWindow): Promise<UsageHistorySnapshot>
    rank(window: UsageWindow, ranking: UsageRanking, limit?: number): Promise<UsageRankingEntry[]>
    clear(): Promise<void>
    getCapacity(): Promise<UsageCapacity>
  }
  networkMetadata: {
    getProviders(): Promise<NetworkMetadataProvider[]>
    getState(): Promise<NetworkMetadataState>
    selectProvider(id: string): Promise<NetworkMetadataState>
    resolve(force?: boolean): Promise<NetworkMetadataState>
    resolveAll(force?: boolean): Promise<NetworkMetadataSnapshot>
  }
}
