/**
 * Aggregated re-export of the payload types behind the `window.desktop`
 * contract. Stores and views import payload types from here (or from
 * `@shared/ipc`) without knowing the owning domain module; the Tauri bridge
 * will satisfy the same types.
 *
 * This module is types-only — it must never emit runtime imports.
 */
export type {
  BrandConfig
} from './brand'
export type { AppInfo } from './app-info'
export type {
  KernelStatus,
  RuntimeSummary,
  TrafficSample
} from './runtime'
export type { KernelManagerState } from './kernel-manager'
export type {
  MihomoDelayResult,
  MihomoDelayMap,
  MihomoDnsQueryResult,
  MihomoDnsQueryType,
  MihomoLogMessage,
  MihomoLogsSnapshot,
  MihomoStreamError,
  MihomoProxiesResponse,
  MihomoConnectionsSnapshot
} from './mihomo-api'
export type {
  ProfileMeta,
  Profile,
  ImportRequest,
  ConfigEdit,
  ProfileProviderCatalog,
  ProfileProviderContent,
  ActiveProfileConfigInspection,
  ValidationResult
} from './profiles'
export type { SystemProxyStatus } from './system-proxy'
export type { ProxyBypassPolicy } from './proxy-bypass'
export type { StartupStatus } from './startup'
export type { ServiceUnlockResult } from './unlock'
export type { AppSettings } from './app-settings'
export type { SubStoreState } from './substore'
export type {
  OverridesSnapshot,
  OverrideInput,
  OverridePreview,
  OverrideValidation,
  OverrideLastKnownGood
} from './overrides'
export type { DnsSnapshot, DnsEnhancement } from './dns'
export type { SnifferSnapshot, SnifferEnhancement } from './sniffer'
export type { UpdateState } from './updates'
export type { TunStatus } from './tun'
export type { TunConfigModel, TunConfigSnapshot } from './tun-config'
export type { CoreSettings } from './core-settings'
export type { GeodataSettings } from './geodata'
export type {
  UsageWindow,
  UsageRanking,
  UsageHistorySnapshot,
  UsageRankingEntry,
  UsageCapacity
} from './usage'
export type {
  NetworkMetadataProvider,
  NetworkMetadataSnapshot,
  NetworkMetadataState
} from './network-metadata'
