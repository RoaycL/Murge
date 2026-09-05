import type { MihomoGateway } from '@shared/gateways'
import type { MihomoProxiesResponse, MihomoVersion, MihomoConfigSnapshot, MihomoRulesResponse, MihomoProxyProvidersResponse, MihomoRuleProvidersResponse, MihomoDelayResult, MihomoDelayMap, MihomoDnsQueryType, MihomoDnsQueryResult, MihomoConnectionsSnapshot, MihomoLogMessage, MihomoStreamError } from '@shared/mihomo-api'
import type { TrafficSample } from '@shared/runtime'
import type { ProxySelectionService } from './proxy-selection-service'

/**
 * Decorates the live {@link MihomoGateway} so that EVERY successful node pick
 * (from any IPC entry point) is also written to the per-profile selection cache.
 * Restoring those picks is the service's job and happens after a kernel
 * (re)start, not here — this wrapper only owns the write side.
 *
 * All non-mutating methods delegate untouched.
 */
export class ProxySelectionGateway implements MihomoGateway {
  constructor(
    private readonly inner: MihomoGateway,
    private readonly selections: ProxySelectionService,
    private readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation()
  ) {}

  getVersion(): Promise<MihomoVersion> { return this.inner.getVersion() }
  getConfig(): Promise<MihomoConfigSnapshot> { return this.inner.getConfig() }
  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> { return this.inner.patchConfig(patch) }
  getProxies(): Promise<MihomoProxiesResponse> { return this.inner.getProxies() }

  async selectProxy(group: string, name: string): Promise<void> {
    await this.runExclusive(async () => {
      // The profile id, controller PUT and durable record share the SAME queue
      // as profile activation/reload. The live config cannot change between
      // attribution and application, and quit cannot outrun the accepted write.
      const profileId = await this.selections.resolveActiveProfileId()
      await this.inner.selectProxy(group, name)
      if (profileId) await this.selections.recordSelection(profileId, group, name)
    })
  }

  getRules(): Promise<MihomoRulesResponse> { return this.inner.getRules() }
  getProxyProviders(): Promise<MihomoProxyProvidersResponse> { return this.inner.getProxyProviders() }
  refreshProxyProvider(name: string): Promise<void> { return this.inner.refreshProxyProvider(name) }
  healthCheckProxyProvider(name: string): Promise<void> { return this.inner.healthCheckProxyProvider(name) }
  getRuleProviders(): Promise<MihomoRuleProvidersResponse> { return this.inner.getRuleProviders() }
  refreshRuleProvider(name: string): Promise<void> { return this.inner.refreshRuleProvider(name) }
  delayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult> { return this.inner.delayTest(name, opts) }
  groupMemberDelayTest(group: string, name: string, opts?: { timeout?: number }): Promise<MihomoDelayResult> {
    return this.inner.groupMemberDelayTest(group, name, opts)
  }
  groupDelayTest(name: string, opts?: { timeout?: number }): Promise<MihomoDelayMap> { return this.inner.groupDelayTest(name, opts) }
  dnsQuery(name: string, type: MihomoDnsQueryType): Promise<MihomoDnsQueryResult> { return this.inner.dnsQuery(name, type) }
  flushDnsCache(): Promise<void> { return this.inner.flushDnsCache() }
  flushFakeIpCache(): Promise<void> { return this.inner.flushFakeIpCache() }
  getConnections(): Promise<MihomoConnectionsSnapshot> { return this.inner.getConnections() }
  closeConnection(id: string): Promise<void> { return this.inner.closeConnection(id) }
  onTraffic(listener: (sample: TrafficSample) => void): () => void { return this.inner.onTraffic(listener) }
  onConnections(listener: (snapshot: MihomoConnectionsSnapshot) => void): () => void { return this.inner.onConnections(listener) }
  onLogs(listener: (message: MihomoLogMessage) => void): () => void { return this.inner.onLogs(listener) }
  onStreamError(listener: (error: MihomoStreamError) => void): () => void { return this.inner.onStreamError(listener) }
}
