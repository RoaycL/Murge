import type { KernelGateway, KernelManagerGateway, MihomoGateway, RuntimeGateway, ProfileGateway, IpcDeps, SystemProxyGateway, StartupGateway, AppSettingsGateway, UpdatesGateway, OverridesGateway } from '@shared/gateways'
import type { StartupStatus } from '@shared/startup'
import type { AppSettings } from '@shared/app-settings'
import type { OverrideInput, OverridesSnapshot } from '@shared/overrides'
import { coerceOverridesSnapshot, EMPTY_OVERRIDES } from '@shared/overrides'
import type { KernelManagerState } from '@shared/kernel-manager'
import { DEFAULT_KERNEL_MANAGER_STATE } from '@shared/kernel-manager'
import type { UpdateState } from '@shared/updates'
import { DEFAULT_UPDATE_STATE } from '@shared/updates'
import type { SystemProxyStatus } from '@shared/system-proxy'
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
} from '@shared/mihomo-api'
import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from '@shared/profiles'
import type { KernelStatus, RuntimeSummary, TrafficSample } from '@shared/runtime'
import type { BrandConfig } from '@shared/brand'
import type { TunGateway, TunStatus } from '@shared/tun'

/**
 * In-memory fake service container for main-process tests.
 *
 * The fakes record every call and allow test code to assert that validation
 * ran before a service method was reached, without Electron or a real kernel.
 */

export class FakeKernelGateway implements KernelGateway {
  status: KernelStatus = { phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }
  getStatusCalls = 0
  startCalls = 0
  stopCalls = 0
  private readonly listeners = new Set<(status: KernelStatus) => void>()

  getStatus(): Promise<KernelStatus> {
    this.getStatusCalls += 1
    return Promise.resolve({ ...this.status })
  }

  start(): Promise<KernelStatus> {
    this.startCalls += 1
    return Promise.resolve({ ...this.status })
  }

  stop(): Promise<KernelStatus> {
    this.stopCalls += 1
    return Promise.resolve({ ...this.status })
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Test helper: publish a status transition to subscribers. */
  emitStatus(status: KernelStatus): void {
    this.status = { ...status }
    for (const listener of this.listeners) listener({ ...status })
  }
}

export class FakeMihomoGateway implements MihomoGateway {
  config: Partial<MihomoConfigSnapshot> = { port: 7890, mode: 'rule', 'allow-lan': false }
  proxies: MihomoProxiesResponse = { proxies: {} }
  rules: MihomoRulesResponse = { rules: [] }
  connections: MihomoConnectionsSnapshot = { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] }
  proxyProviders: MihomoProxyProvidersResponse = { providers: {} }
  ruleProviders: MihomoRuleProvidersResponse = { providers: {} }

  getConfigCalls = 0
  patchConfigCalls: Array<Partial<MihomoConfigSnapshot>> = []
  getProxiesCalls = 0
  selectProxyCalls: Array<{ group: string; name: string }> = []
  getRulesCalls = 0
  getProxyProvidersCalls = 0
  refreshProxyProviderCalls: string[] = []
  healthCheckProxyProviderCalls: string[] = []
  getRuleProvidersCalls = 0
  refreshRuleProviderCalls: string[] = []
  getConnectionsCalls = 0
  closeConnectionCalls: string[] = []
  dnsQueryCalls: Array<{ name: string; type: MihomoDnsQueryType }> = []
  flushDnsCacheCalls = 0
  flushFakeIpCacheCalls = 0

  getVersion(): Promise<MihomoVersion> {
    return Promise.resolve({ version: '1.18.0', meta: false })
  }

  /** Configurable results for the delay APIs. */
  delayResults: Record<string, MihomoDelayResult> = {}
  groupDelayResults: Record<string, MihomoDelayMap> = {}
  /** If set, these methods reject with this error. */
  delayError: Error | null = null

  getConfig(): Promise<MihomoConfigSnapshot> {
    this.getConfigCalls += 1
    return Promise.resolve({ ...this.config })
  }

  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> {
    this.patchConfigCalls.push({ ...patch })
    return Promise.resolve()
  }

  getProxies(): Promise<MihomoProxiesResponse> {
    this.getProxiesCalls += 1
    return Promise.resolve(this.proxies)
  }

  selectProxy(group: string, name: string): Promise<void> {
    this.selectProxyCalls.push({ group, name })
    return Promise.resolve()
  }

  getRules(): Promise<MihomoRulesResponse> {
    this.getRulesCalls += 1
    return Promise.resolve(this.rules)
  }

  getProxyProviders(): Promise<MihomoProxyProvidersResponse> {
    this.getProxyProvidersCalls += 1
    return Promise.resolve(this.proxyProviders)
  }

  refreshProxyProvider(name: string): Promise<void> {
    this.refreshProxyProviderCalls.push(name)
    return Promise.resolve()
  }

  healthCheckProxyProvider(name: string): Promise<void> {
    this.healthCheckProxyProviderCalls.push(name)
    if (this.delayError) return Promise.reject(this.delayError)
    return Promise.resolve()
  }

  getRuleProviders(): Promise<MihomoRuleProvidersResponse> {
    this.getRuleProvidersCalls += 1
    return Promise.resolve(this.ruleProviders)
  }

  refreshRuleProvider(name: string): Promise<void> {
    this.refreshRuleProviderCalls.push(name)
    return Promise.resolve()
  }

  delayTest(name: string): Promise<MihomoDelayResult> {
    if (this.delayError) return Promise.reject(this.delayError)
    return Promise.resolve(this.delayResults[name] ?? { delay: 0 })
  }

  groupDelayTest(name: string): Promise<MihomoDelayMap> {
    if (this.delayError) return Promise.reject(this.delayError)
    return Promise.resolve(this.groupDelayResults[name] ?? {})
  }

  getConnections(): Promise<MihomoConnectionsSnapshot> {
    this.getConnectionsCalls += 1
    return Promise.resolve(this.connections)
  }

  closeConnection(id: string): Promise<void> {
    this.closeConnectionCalls.push(id)
    return Promise.resolve()
  }

  dnsQuery(name: string, type: MihomoDnsQueryType): Promise<MihomoDnsQueryResult> {
    this.dnsQueryCalls.push({ name, type })
    return Promise.resolve({ Status: 0, Question: [{ name, type: type === 'AAAA' ? 28 : 1 }], TC: false, RD: true, RA: true, AD: false, CD: false, Answer: [] })
  }

  flushDnsCache(): Promise<void> { this.flushDnsCacheCalls += 1; return Promise.resolve() }
  flushFakeIpCache(): Promise<void> { this.flushFakeIpCacheCalls += 1; return Promise.resolve() }

  private readonly trafficListeners = new Set<(sample: TrafficSample) => void>()
  private readonly connectionsListeners = new Set<(snapshot: MihomoConnectionsSnapshot) => void>()
  private readonly logsListeners = new Set<(message: MihomoLogMessage) => void>()
  private readonly streamErrorListeners = new Set<(error: MihomoStreamError) => void>()

  onTraffic(listener: (sample: TrafficSample) => void): () => void {
    this.trafficListeners.add(listener)
    return () => this.trafficListeners.delete(listener)
  }

  onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void {
    this.connectionsListeners.add(listener)
    return () => this.connectionsListeners.delete(listener)
  }

  onLogs(listener: (message: MihomoLogMessage) => void): () => void {
    this.logsListeners.add(listener)
    return () => this.logsListeners.delete(listener)
  }

  onStreamError(listener: (error: MihomoStreamError) => void): () => void {
    this.streamErrorListeners.add(listener)
    return () => this.streamErrorListeners.delete(listener)
  }

  /** Test helpers: publish push events to subscribers. */
  emitTraffic(sample: TrafficSample): void {
    for (const listener of this.trafficListeners) listener(sample)
  }
  emitConnections(snapshot: MihomoConnectionsSnapshot): void {
    for (const listener of this.connectionsListeners) listener(snapshot)
  }
  emitLogs(message: MihomoLogMessage): void {
    for (const listener of this.logsListeners) listener(message)
  }
  emitStreamError(error: MihomoStreamError): void {
    for (const listener of this.streamErrorListeners) listener(error)
  }
}

export class FakeRuntimeGateway implements RuntimeGateway {
  summary: RuntimeSummary = {
    networkName: 'Ethernet',
    profileName: 'Default',
    mode: 'rule',
    externalIp: null,
    systemProxyEnabled: false,
    tunEnabled: false
  }

  getSummary(): RuntimeSummary {
    return { ...this.summary }
  }

  getExternalIp(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

export class FakeProfileGateway implements ProfileGateway {
  profiles: Profile[] = []
  activeIndex = -1
  listCalls = 0
  importCalls: ImportRequest[] = []

  async listProfiles(): Promise<ProfileMeta[]> {
    this.listCalls += 1
    return this.profiles.map((profile, index) => ({ ...profile.meta, active: index === this.activeIndex }))
  }

  async getProfile(id: string): Promise<Profile> {
    const profile = this.profiles.find((entry) => entry.meta.id === id)
    if (!profile) throw new Error(`profile ${id} not found`)
    return profile
  }

  async importProfile(request: ImportRequest): Promise<ProfileMeta> {
    this.importCalls.push({ ...request })
    const meta: ProfileMeta = {
      id: `p${this.profiles.length + 1}`,
      name: request.name,
      source: request.source,
      size: request.document.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: false
    }
    this.profiles.push({ meta, document: request.document })
    if (request.activate) this.activeIndex = this.profiles.length - 1
    return { ...meta, active: request.activate === true }
  }

  async importFromUrl(name: string, url: string, activate = false): Promise<ProfileMeta> {
    return this.importProfile({ name, document: `proxies:\n  - name: node\n    server: 127.0.0.1\n`, source: { type: 'url', url }, activate })
  }

  async activateProfile(id: string): Promise<ProfileMeta> {
    const index = this.profiles.findIndex((entry) => entry.meta.id === id)
    if (index === -1) throw new Error(`profile ${id} not found`)
    this.activeIndex = index
    return { ...this.profiles[index].meta, active: true }
  }

  async deactivateProfile(): Promise<void> {
    this.activeIndex = -1
  }

  async restoreProfileDocument(id: string, document: string): Promise<void> {
    const profile = await this.getProfile(id)
    profile.document = document
    profile.meta.size = document.length
  }

  async deleteProfile(id: string): Promise<void> {
    const index = this.profiles.findIndex((entry) => entry.meta.id === id)
    if (index === -1) throw new Error(`profile ${id} not found`)
    this.profiles.splice(index, 1)
    if (this.activeIndex === index) this.activeIndex = -1
    else if (this.activeIndex > index) this.activeIndex -= 1
  }

  async renameProfile(id: string, name: string): Promise<ProfileMeta> {
    const index = this.profiles.findIndex((entry) => entry.meta.id === id)
    if (index === -1) throw new Error(`profile ${id} not found`)
    this.profiles[index].meta.name = name
    return this.profiles[index].meta
  }

  async editDocument(id: string, _edits: ConfigEdit[]): Promise<ProfileMeta> {
    return this.getProfile(id).then((profile) => profile.meta)
  }

  validateDocument(_document: string): ValidationResult {
    return { ok: true, issues: [] }
  }
}

export class FakeSystemProxyGateway implements SystemProxyGateway {
  status: SystemProxyStatus = {
    supported: true,
    phase: 'disabled',
    address: null,
    port: null,
    errorMessage: null,
    conflictDetail: null,
    updatedAt: ''
  }
  getStatusCalls = 0
  enableCalls = 0
  disableCalls = 0
  enableError: Error | null = null
  disableError: Error | null = null
  private readonly listeners = new Set<(status: SystemProxyStatus) => void>()

  getStatus(): Promise<SystemProxyStatus> {
    this.getStatusCalls += 1
    return Promise.resolve({ ...this.status })
  }

  enable(): Promise<SystemProxyStatus> {
    this.enableCalls += 1
    if (this.enableError) return Promise.reject(this.enableError)
    return Promise.resolve({ ...this.status })
  }

  disable(): Promise<SystemProxyStatus> {
    this.disableCalls += 1
    if (this.disableError) return Promise.reject(this.disableError)
    return Promise.resolve({ ...this.status })
  }

  onStatus(listener: (status: SystemProxyStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Test helper: publish a status transition to subscribers. */
  emitStatus(status: SystemProxyStatus): void {
    this.status = { ...status }
    for (const listener of this.listeners) listener({ ...status })
  }
}

export interface FakeContainer {
  deps: IpcDeps
  kernel: FakeKernelGateway
  kernelManager: FakeKernelManagerGateway
  mihomo: FakeMihomoGateway
  runtime: FakeRuntimeGateway
  profiles: FakeProfileGateway
  systemProxy: FakeSystemProxyGateway
  startup: FakeStartupGateway
  appSettings: FakeAppSettingsGateway
  overrides: FakeOverridesGateway
  updates: FakeUpdatesGateway
  tun: FakeTunGateway
}

export class FakeKernelManagerGateway implements KernelManagerGateway {
  state: KernelManagerState = {
    ...DEFAULT_KERNEL_MANAGER_STATE,
    stableVersion: 'v1.19.30',
    effectiveVersion: 'v1.19.30'
  }
  setEnabledCalls: boolean[] = []
  setChannelCalls: Array<'stable' | 'specific'> = []
  listVersionsCalls = 0
  installCalls: string[] = []
  private readonly listeners = new Set<(state: KernelManagerState) => void>()
  getState(): Promise<KernelManagerState> { return Promise.resolve({ ...this.state }) }
  async setEnabled(enabled: boolean): Promise<KernelManagerState> {
    this.setEnabledCalls.push(enabled)
    this.state = { ...this.state, enabled }
    return Promise.resolve({ ...this.state })
  }
  async setChannel(channel: 'stable' | 'specific'): Promise<KernelManagerState> {
    this.setChannelCalls.push(channel)
    this.state = { ...this.state, channel, effectiveVersion: channel === 'specific' ? this.state.specificVersion ?? this.state.stableVersion : this.state.stableVersion }
    return Promise.resolve({ ...this.state })
  }
  async listVersions(): Promise<KernelManagerState> {
    this.listVersionsCalls += 1
    return Promise.resolve({ ...this.state })
  }
  async install(version: string): Promise<KernelManagerState> {
    this.installCalls.push(version)
    this.state = { ...this.state, channel: 'specific', specificVersion: version, effectiveVersion: version }
    return Promise.resolve({ ...this.state })
  }
  onState(listener: (state: KernelManagerState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}

export class FakeTunGateway implements TunGateway {
  status: TunStatus = { supported: true, phase: 'configured', errorMessage: null, conflictDetail: null, updatedAt: null }
  enableCalls = 0
  disableCalls = 0
  private readonly listeners = new Set<(status: TunStatus) => void>()
  getStatus(): TunStatus { return { ...this.status } }
  async enable(): Promise<TunStatus> { this.enableCalls += 1; return { ...this.status } }
  async disable(): Promise<TunStatus> { this.disableCalls += 1; return { ...this.status } }
  onStatus(listener: (status: TunStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}

export class FakeStartupGateway implements StartupGateway {
  status: StartupStatus = { supported: true, enabled: false, phase: 'idle', errorMessage: null }
  setCalls: boolean[] = []
  getStatus(): Promise<StartupStatus> { return Promise.resolve({ ...this.status }) }
  setEnabled(enabled: boolean): Promise<StartupStatus> { this.setCalls.push(enabled); this.status = { ...this.status, enabled }; return Promise.resolve({ ...this.status }) }
}

export class FakeAppSettingsGateway implements AppSettingsGateway {
  settings: AppSettings = {
    autoStartKernel: true,
    autoCheckUpdate: true,
    kernelEnabled: true,
    kernelChannel: 'stable',
    kernelSpecificVersion: ''
  }
  setCalls: Array<Partial<AppSettings>> = []
  get(): Promise<AppSettings> { return Promise.resolve({ ...this.settings }) }
  set(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.setCalls.push({ ...patch })
    this.settings = { ...this.settings, ...patch }
    return Promise.resolve({ ...this.settings })
  }
}

export class FakeOverridesGateway implements OverridesGateway {
  snapshot: OverridesSnapshot = { ...EMPTY_OVERRIDES }
  createCalls: Array<{ id: string; input: OverrideInput }> = []
  updateCalls: Array<{ id: string; input: OverrideInput }> = []
  removeCalls: string[] = []
  setEnabledCalls: Array<{ id: string; enabled: boolean }> = []
  moveCalls: Array<{ id: string; direction: 'up' | 'down' }> = []
  private nextId = 1

  list(): Promise<OverridesSnapshot> { return Promise.resolve(coerceOverridesSnapshot(this.snapshot)) }
  async create(input: OverrideInput): Promise<OverridesSnapshot> {
    const id = `ov-${this.nextId++}`
    this.createCalls.push({ id, input })
    const items = [...this.snapshot.items, { id, name: input.name, kind: input.kind, enabled: true, scope: input.scope, profileId: input.scope === 'profile' ? input.profileId ?? null : null, order: this.snapshot.items.length, content: input.content, updatedAt: 0 }]
    this.snapshot = { items }
    return Promise.resolve(coerceOverridesSnapshot(this.snapshot))
  }
  async update(id: string, input: OverrideInput): Promise<OverridesSnapshot> {
    this.updateCalls.push({ id, input })
    this.snapshot = { items: this.snapshot.items.map((item) => item.id === id ? { ...item, name: input.name, kind: input.kind, scope: input.scope, profileId: input.scope === 'profile' ? input.profileId ?? null : null, content: input.content, updatedAt: 0 } : item) }
    return Promise.resolve(coerceOverridesSnapshot(this.snapshot))
  }
  async remove(id: string): Promise<OverridesSnapshot> {
    this.removeCalls.push(id)
    this.snapshot = { items: this.snapshot.items.filter((item) => item.id !== id).map((item, index) => ({ ...item, order: index })) }
    return Promise.resolve(coerceOverridesSnapshot(this.snapshot))
  }
  async setEnabled(id: string, enabled: boolean): Promise<OverridesSnapshot> {
    this.setEnabledCalls.push({ id, enabled })
    this.snapshot = { items: this.snapshot.items.map((item) => item.id === id ? { ...item, enabled } : item) }
    return Promise.resolve(coerceOverridesSnapshot(this.snapshot))
  }
  async move(id: string, direction: 'up' | 'down'): Promise<OverridesSnapshot> {
    this.moveCalls.push({ id, direction })
    return Promise.resolve(coerceOverridesSnapshot(this.snapshot))
  }
}

export class FakeUpdatesGateway implements UpdatesGateway {
  state: UpdateState = { ...DEFAULT_UPDATE_STATE, currentVersion: '0.0.0-test' }
  checkCalls = 0
  downloadCalls = 0
  installCalls = 0
  private readonly listeners = new Set<(state: UpdateState) => void>()
  getState(): UpdateState { return { ...this.state } }
  async check(): Promise<UpdateState> {
    this.checkCalls += 1
    return { ...this.state }
  }
  async download(): Promise<void> { this.downloadCalls += 1 }
  install(): void { this.installCalls += 1 }
  onState(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** Test helper: publish a state transition to subscribers. */
  emitState(state: UpdateState): void {
    this.state = { ...state }
    for (const listener of this.listeners) listener({ ...state })
  }
}

export function createFakeContainer(brand: BrandConfig): FakeContainer {
  const kernel = new FakeKernelGateway()
  const kernelManager = new FakeKernelManagerGateway()
  const mihomo = new FakeMihomoGateway()
  const runtime = new FakeRuntimeGateway()
  const profiles = new FakeProfileGateway()
  const systemProxy = new FakeSystemProxyGateway()
  const startup = new FakeStartupGateway()
  const appSettings = new FakeAppSettingsGateway()
  const overrides = new FakeOverridesGateway()
  const updates = new FakeUpdatesGateway()
  const tun = new FakeTunGateway()
  return {
    kernel,
    kernelManager,
    mihomo,
    runtime,
    profiles,
    systemProxy,
    startup,
    appSettings,
    overrides,
    updates,
    tun,
    deps: { brand, appInfo: { version: '0.0.0-test', platform: 'linux', arch: 'x64' }, kernel, kernelManager, mihomo, runtime, profiles, systemProxy, startup, appSettings, overrides, updates, tun }
  }
}
