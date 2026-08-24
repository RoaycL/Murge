import type { KernelGateway, MihomoGateway, RuntimeGateway, IpcDeps } from '@shared/gateways'
import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoProxiesResponse,
  MihomoRulesResponse
} from '@shared/mihomo-api'
import type { KernelStatus, RuntimeSummary } from '@shared/runtime'
import type { BrandConfig } from '@shared/brand'

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
}

export class FakeMihomoGateway implements MihomoGateway {
  config: Partial<MihomoConfigSnapshot> = { port: 7890, mode: 'rule', 'allow-lan': false }
  proxies: MihomoProxiesResponse = { proxies: {} }
  rules: MihomoRulesResponse = { rules: [] }
  connections: MihomoConnectionsSnapshot = { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] }

  getConfigCalls = 0
  patchConfigCalls: Array<Partial<MihomoConfigSnapshot>> = []
  getProxiesCalls = 0
  selectProxyCalls: Array<{ group: string; name: string }> = []
  getRulesCalls = 0
  getConnectionsCalls = 0
  closeConnectionCalls: string[] = []

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

  getConnections(): Promise<MihomoConnectionsSnapshot> {
    this.getConnectionsCalls += 1
    return Promise.resolve(this.connections)
  }

  closeConnection(id: string): Promise<void> {
    this.closeConnectionCalls.push(id)
    return Promise.resolve()
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
}

export interface FakeContainer {
  deps: IpcDeps
  kernel: FakeKernelGateway
  mihomo: FakeMihomoGateway
  runtime: FakeRuntimeGateway
}

export function createFakeContainer(brand: BrandConfig): FakeContainer {
  const kernel = new FakeKernelGateway()
  const mihomo = new FakeMihomoGateway()
  const runtime = new FakeRuntimeGateway()
  return {
    kernel,
    mihomo,
    runtime,
    deps: { brand, kernel, mihomo, runtime }
  }
}
