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
import type { TunGateway } from './tun'

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
  deleteProfile(id: string): Promise<void>
  renameProfile(id: string, name: string): ProfileMeta | Promise<ProfileMeta>
  editDocument(id: string, edits: ConfigEdit[]): ProfileMeta | Promise<ProfileMeta>
  validateDocument(document: string): ValidationResult | Promise<ValidationResult>
}

/** Everything the IPC handler factory needs from the trusted main process. */
export interface IpcDeps {
  brand: BrandConfig
  kernel: KernelGateway
  mihomo: MihomoGateway
  runtime: RuntimeGateway
  profiles: ProfileGateway
  systemProxy: SystemProxyGateway
  startup: StartupGateway
  tun: TunGateway
}
