import type { BrandConfig } from './brand'
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
import type { GeodataSettings } from './geodata'
import type { UsageWindow, UsageRanking, UsageHistorySnapshot, UsageRankingEntry, UsageCapacity } from './usage'
import type { NetworkMetadataProvider, NetworkMetadataSnapshot, NetworkMetadataState } from './network-metadata'
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
} from './mihomo-api'
import type {
  ConfigEdit,
  ImportRequest,
  Profile,
  ProfileMeta,
  ValidationResult
} from './profiles'
import type { KernelStatus, RuntimeSummary, TrafficSample } from './runtime'
import type { SystemProxyStatus } from './system-proxy'
import type { ProxyBypassPolicy } from './proxy-bypass'
import type { StartupStatus } from './startup'
import type { AppSettings } from './app-settings'
import type { TunGateway } from './tun'
import type { TunConfigModel, TunConfigSnapshot } from './tun-config'
import type { CoreSettings } from './core-settings'
import type { AppInfo } from './app-info'
import type { UpdateState } from './updates'

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
  /**
   * Single-kernel mode-switch hooks. Optional: the plain main-kernel gateway does
   * not implement them. When present, the IPC `tun:enable`/`tun:disable` handlers
   * use them instead of a plain stop/start so the unified controller/mixed ports
   * keep serving the data plane and the owned system proxy across the switch
   * (the ports are never left pointing at a dead host).
   */
  prepareTunEnable?(): Promise<void>
  resumeAfterTun?(): Promise<void>
}

/**
 * Kernel management boundary: the master enable switch plus the version manager
 * (fetch published versions, install a specific one). Durable choices are
 * mirrored into the settings document; the rest is runtime state.
 */
export interface KernelManagerGateway {
  getState(): KernelManagerState | Promise<KernelManagerState>
  setEnabled(enabled: boolean): Promise<KernelManagerState>
  setChannel(channel: 'stable' | 'specific'): Promise<KernelManagerState>
  /** Fetch the published mihomo version list. */
  listVersions(): Promise<KernelManagerState>
  /** Download + verify + install a specific version, then select it. */
  install(version: string): Promise<KernelManagerState>
  /** Subscribe to state transitions; returns an unsubscribe function. */
  onState(listener: (state: KernelManagerState) => void): () => void
}

/** Shape the activity card's latency sampler must expose to the IPC layer. */
export interface InternetLatencySampler {
  sample(): Promise<{
    gatewayMs: number | null
    dnsMs: number | null
    proxyMs: number | null
    proxyNode: string | null
  }>
}

export interface MihomoGateway {
  getVersion(): Promise<MihomoVersion>
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
  /** Test one member using its owning group's probe URL and provider route. */
  groupMemberDelayTest(group: string, name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult>
  groupDelayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayMap>
  dnsQuery(name: string, type: MihomoDnsQueryType): Promise<MihomoDnsQueryResult>
  flushDnsCache(): Promise<void>
  flushFakeIpCache(): Promise<void>
  getConnections(): Promise<MihomoConnectionsSnapshot>
  closeConnection(id: string): Promise<void>
  /** Push subscriptions over the shared WebSocket transports. */
  onTraffic(listener: (sample: TrafficSample) => void): () => void
  onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void
  onLogs(listener: (message: MihomoLogMessage) => void): () => void
  onStreamError(listener: (error: MihomoStreamError) => void): () => void
  /** Retained log history (log capture is independent of the logs view). */
  logsSnapshot(afterSeq?: number): Promise<MihomoLogsSnapshot>
  /** Drop retained log history; live streaming and sequence numbering continue. */
  clearLogs(): Promise<void>
}

export interface RuntimeGateway {
  getSummary(): RuntimeSummary | Promise<RuntimeSummary>
  /** Best-effort egress IP of the running proxy node; null when unavailable. */
  getExternalIp(): Promise<string | null>
}

/**
 * System-proxy ownership boundary. Implementations read/apply/restore the
 * *platform* system proxy (on Windows the HKCU Internet Settings values) while
 * keeping the decision logic (ownership, backup, kernel ordering) in the
 * injectable `SystemProxyService`.
 */
export interface SystemProxyGateway {
  getStatus(): SystemProxyStatus | Promise<SystemProxyStatus>
  enable(): Promise<SystemProxyStatus>
  disable(): Promise<SystemProxyStatus>
  /** Subscribe to status transitions; returns an unsubscribe function. */
  onStatus(listener: (status: SystemProxyStatus) => void): () => void
  /**
   * The controlled proxy-bypass policy. `get` returns the persisted model;
   * `set` validates + persists it and, when the system proxy is currently
   * enabled, re-applies the new `ProxyOverride` live (conflict-checked and
   * read-back verified); `preview` returns the `ProxyOverride` value that would
   * be written given the policy and the current registry.
   */
  getProxyBypass(): ProxyBypassPolicy | Promise<ProxyBypassPolicy>
  setProxyBypass(input: ProxyBypassPolicy): Promise<ProxyBypassPolicy>
  previewProxyBypass(input: ProxyBypassPolicy): Promise<string>
}

export interface StartupGateway {
  getStatus(): Promise<StartupStatus>
  setEnabled(enabled: boolean): Promise<StartupStatus>
}

export interface AppSettingsGateway {
  get(): Promise<AppSettings>
  set(patch: Partial<AppSettings>): Promise<AppSettings>
}

/**
 * Override/增强 chain management boundary. Implements the durable override
 * list (global + profile-scoped, applied during runtime config generation).
 * Every mutation returns the authoritative {@link OverridesSnapshot}.
 */
export interface OverridesGateway {
  list(): OverridesSnapshot | Promise<OverridesSnapshot>
  create(input: OverrideInput): OverridesSnapshot | Promise<OverridesSnapshot>
  update(id: string, input: OverrideInput): OverridesSnapshot | Promise<OverridesSnapshot>
  remove(id: string): OverridesSnapshot | Promise<OverridesSnapshot>
  setEnabled(id: string, enabled: boolean): OverridesSnapshot | Promise<OverridesSnapshot>
  move(id: string, direction: 'up' | 'down'): OverridesSnapshot | Promise<OverridesSnapshot>
  /** Redacted preview of the effective override set against the active profile document. */
  preview(): OverridePreview | Promise<OverridePreview>
  /** Structural + semantic validation of the effective override set against the active profile document. */
  validate(): OverrideValidation | Promise<OverrideValidation>
  /** The last-known-good override snapshot, or null if none has been captured. */
  lastKnownGood(): OverrideLastKnownGood | null | Promise<OverrideLastKnownGood | null>
  /** Restore the override list to its last-known-good state. */
  resetToLastGood(): OverridesSnapshot | Promise<OverridesSnapshot>
}

/**
 * Application-update boundary. The implementation owns the auto-updater and
 * reduces its events into a {@link UpdateState} snapshot; the renderer issues a
 * narrow command (check, download, install) and observes the pushed state.
 */
export interface UpdatesGateway {
  /** Current in-memory snapshot (never performs I/O). */
  getState(): UpdateState
  /** Check the feed for a newer version; resolves with the resulting state. */
  check(): Promise<UpdateState>
  /** Start (or resume) downloading the available update in the background. */
  download(): Promise<void>
  /** Install a fully-downloaded update and restart the app. */
  install(): void
  /** Subscribe to state transitions; returns an unsubscribe function. */
  onState(listener: (state: UpdateState) => void): () => void
}

/**
 * Profile/subscription management boundary. Implementations manage an isolated
 * profile directory with atomic writes and never touch the live mihomo config.
 */
export interface ProfileGateway {
  listProfiles(): ProfileMeta[] | Promise<ProfileMeta[]>
  getProfile(id: string): Profile | Promise<Profile>
  importProfile(request: ImportRequest): ProfileMeta | Promise<ProfileMeta>
  importFromUrl(name: string, url: string, activate?: boolean): ProfileMeta | Promise<ProfileMeta>
  /** Re-fetch a URL-backed profile's subscription and replace its document. */
  updateFromSource(id: string): ProfileMeta | Promise<ProfileMeta>
  activateProfile(id: string): ProfileMeta | Promise<ProfileMeta>
  /** Internal recovery primitive; not exposed through renderer IPC. */
  deactivateProfile(): Promise<void>
  /** Internal recovery primitive; restores a pre-mutation document snapshot. */
  restoreProfileDocument(id: string, document: string): Promise<void>
  deleteProfile(id: string): Promise<void>
  renameProfile(id: string, name: string): ProfileMeta | Promise<ProfileMeta>
  editDocument(id: string, edits: ConfigEdit[]): ProfileMeta | Promise<ProfileMeta>
  replaceDocument(id: string, document: string): ProfileMeta | Promise<ProfileMeta>
  getSourceUrl(id: string): string | null | Promise<string | null>
  setSourceUrl(id: string, url: string): ProfileMeta | Promise<ProfileMeta>
  validateDocument(document: string): ValidationResult | Promise<ValidationResult>
}

/**
 * Typed DNS enhancement boundary. A single global, schema-validated model that
 * is re-applied through the kernel config pipeline at start time.
 */
export interface DnsEnhancementGateway {
  get(): DnsSnapshot | Promise<DnsSnapshot>
  set(input: DnsEnhancement): DnsSnapshot | Promise<DnsSnapshot>
  /** Render the redacted `dns:` block a model would produce (no writes). */
  preview(input: DnsEnhancement): string | Promise<string>
}

/**
 * Typed sniffer enhancement boundary. A single global, schema-validated model
 * that is re-applied through the kernel config pipeline at start time.
 */
export interface SnifferEnhancementGateway {
  get(): SnifferSnapshot | Promise<SnifferSnapshot>
  set(input: SnifferEnhancement): SnifferSnapshot | Promise<SnifferSnapshot>
  /** Render the `sniffer:` block a model would produce (no writes). */
  preview(input: SnifferEnhancement): string | Promise<string>
}

/**
 * Typed TUN configuration boundary. A single global, schema-validated model that
 * the mihomo-owned adapter reads at enable-time and folds into its bootstrap
 * profile. Unlike DNS/sniffer this model does not enter the main-kernel config
 * pipeline — `tun` is dropped by the safety transform.
 */
export interface TunConfigGateway {
  get(): TunConfigSnapshot | Promise<TunConfigSnapshot>
  set(input: TunConfigModel): TunConfigSnapshot | Promise<TunConfigSnapshot>
  /** Render the `tun:` block a model would produce (no writes). */
  preview(input: TunConfigModel): string | Promise<string>
}

/**
 * Controlled core-settings boundary. A single global, schema-validated model of
 * the allowlisted mihomo *core* runtime keys the user may control. When enabled
 * the model is authoritative in the runtime config (read-back); when disabled the
 * active profile's own values are preserved (conflict handling).
 */
export interface CoreSettingsGateway {
  get(): CoreSettings | Promise<CoreSettings>
  set(input: CoreSettings): CoreSettings | Promise<CoreSettings>
  /** Render the mihomo core keys a model would produce (no writes). */
  preview(input: CoreSettings): string | Promise<string>
}

/**
 * Controlled geodata-settings boundary. A single global, schema-validated model of
 * the allowlisted mihomo *geodata* runtime keys the user may control. When enabled
 * the model is authoritative in the runtime config (read-back); when disabled the
 * active profile's own values are preserved (conflict handling).
 */
export interface GeodataSettingsGateway {
  get(): GeodataSettings | Promise<GeodataSettings>
  set(input: GeodataSettings): GeodataSettings | Promise<GeodataSettings>
  /** Render the mihomo geodata keys a model would produce (no writes). */
  preview(input: GeodataSettings): string | Promise<string>
}

/**
 * Bounded usage-history boundary. The main process records the `/traffic`
 * stream into an hourly bucket database (capped, persisted) and serves windowed
 * aggregates plus ranked views. It deliberately stores only aggregate byte
 * counts — never credentials, hosts, or raw profiles.
 */
export interface UsageHistoryGateway {
  /** Aggregate the bounded database into a window slice (read-back). */
  getWindow(window: UsageWindow): UsageHistorySnapshot | Promise<UsageHistorySnapshot>
  /** Rank a window's buckets by the chosen metric into a 1-based ordered list. */
  rank(window: UsageWindow, ranking: UsageRanking, limit?: number): UsageRankingEntry[] | Promise<UsageRankingEntry[]>
  /** Drop the whole bounded database; write-back via the underlying store. */
  clear(): Promise<void>
  /** Static capacity facts (bucket granularity, cap, retention). */
  getCapacity(): UsageCapacity | Promise<UsageCapacity>
}

/**
 * Read-only network (egress) metadata boundary. The main process resolves the
 * proxy node's public exit address through the kernel's mixed-port proxy and
 * derives geographic metadata from a user-selected privacy-explicit provider.
 * Only a bounded in-memory cache of aggregate metadata is kept; no credentials,
 * hosts or raw profiles are persisted or transmitted.
 */
export interface NetworkMetadataGateway {
  /** List the available (function-free) privacy-explicit providers. */
  getProviders(): NetworkMetadataProvider[]
  /** The current state snapshot, without triggering a fetch. */
  getState(): NetworkMetadataState
  /** Select a provider by id and return the resulting state (no fetch). */
  selectProvider(id: string): NetworkMetadataState
  /**
   * Resolve metadata for the current provider. Uses a fresh cache entry when one
   * is available unless `force` is true; returns the resulting state.
   */
  resolve(force?: boolean): Promise<NetworkMetadataState>
  /**
   * Resolve every shipped provider once (concurrently, single-flight) and
   * return the per-provider outcomes in display order. A per-provider failure
   * degrades only its own row, never the whole sweep.
   */
  resolveAll(force?: boolean): Promise<NetworkMetadataSnapshot>
}

/** Everything the IPC handler factory needs from the trusted main process. */
export interface IpcDeps {
  brand: BrandConfig
  appInfo: AppInfo
  /** INTERNET-latency sampler for the activity card (nulls per failed slot). */
  internetLatency: InternetLatencySampler
  kernel: KernelGateway
  kernelManager: KernelManagerGateway
  mihomo: MihomoGateway
  runtime: RuntimeGateway
  profiles: ProfileGateway
  systemProxy: SystemProxyGateway
  startup: StartupGateway
  appSettings: AppSettingsGateway
  overrides: OverridesGateway
  dns: DnsEnhancementGateway
  sniffer: SnifferEnhancementGateway
  tunConfig: TunConfigGateway
  core: CoreSettingsGateway
  geodata: GeodataSettingsGateway
  usageHistory: UsageHistoryGateway
  networkMetadata: NetworkMetadataGateway
  updates: UpdatesGateway
  tun: TunGateway
}
