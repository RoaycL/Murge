import type { BrandConfig } from './brand'
import type { KernelManagerState } from './kernel-manager'
import type { OverrideInput, OverridesSnapshot } from './overrides'
import type { DnsEnhancement, DnsSnapshot } from './dns'
import type { SnifferEnhancement, SnifferSnapshot } from './sniffer'
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
import type { StartupStatus } from './startup'
import type { AppSettings } from './app-settings'
import type { TunGateway } from './tun'
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
  activateProfile(id: string): ProfileMeta | Promise<ProfileMeta>
  /** Internal recovery primitive; not exposed through renderer IPC. */
  deactivateProfile(): Promise<void>
  /** Internal recovery primitive; restores a pre-mutation document snapshot. */
  restoreProfileDocument(id: string, document: string): Promise<void>
  deleteProfile(id: string): Promise<void>
  renameProfile(id: string, name: string): ProfileMeta | Promise<ProfileMeta>
  editDocument(id: string, edits: ConfigEdit[]): ProfileMeta | Promise<ProfileMeta>
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

/** Everything the IPC handler factory needs from the trusted main process. */
export interface IpcDeps {
  brand: BrandConfig
  appInfo: AppInfo
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
  updates: UpdatesGateway
  tun: TunGateway
}
