import { randomUUID } from 'node:crypto'
import { StaticSystemProxyProbe, LiveSystemProxyKernelProbe } from './probe'
import { FileSystemProxyBackupStore, InMemorySystemProxyBackupStore } from './backup-store'
import { FileSystemProxyBypassStore, InMemoryProxyBypassStore } from './proxy-bypass-store'
import type { ProxyBypassStore } from './proxy-bypass-store'
import { SystemProxyService } from './service'
import { FakeSystemProxyAdapter } from './adapters/fake-adapter'
import { DisabledSystemProxyAdapter } from './adapters/disabled-adapter'
import { WindowsSystemProxyAdapter } from './adapters/windows-adapter'
import type { KernelGateway } from '../../shared/gateways'
import type {
  SystemProxyAdapter,
  SystemProxyBackupStore,
  SystemProxyKernelProbe
} from './types'
import type { MihomoConfigSnapshot } from '../../shared/mihomo-api'

/** The mihomo surface the live probe needs (subset of the gateway). */
export interface SystemProxyMihomoSurface {
  getVersion(): Promise<unknown>
  getConfig(): Promise<MihomoConfigSnapshot>
}

export interface CreateSystemProxyOptions {
  appDataBase: string
  isDev: boolean
  instanceId?: string
  kernel: KernelGateway
  mihomo: SystemProxyMihomoSurface
  /** Override the platform adapter (used by tests to inject a fake without touching real state). */
  adapter?: SystemProxyAdapter
  probe?: SystemProxyKernelProbe
  backup?: SystemProxyBackupStore
  proxyBypassStore?: ProxyBypassStore
}

/**
 * Compose the system-proxy controller for the current runtime.
 *
 * Production on Windows uses the real registry adapter plus a live kernel probe
 * and the durable file-backed backup store. Anything else must never mutate the
 * real network, so the dev build gets a fake adapter, a static probe and an
 * in-memory backup store. The controlled proxy-bypass policy is persisted to
 * disk in production (so an edited custom bypass list survives a restart) and
 * kept in-memory in dev.
 */
export function createSystemProxy(options: CreateSystemProxyOptions): SystemProxyService {
  const instanceId = options.instanceId ?? randomUUID()
  const adapter =
    options.adapter ??
    (options.isDev
      ? new FakeSystemProxyAdapter()
      : process.platform === 'win32'
        ? new WindowsSystemProxyAdapter()
        : new DisabledSystemProxyAdapter(process.platform))
  const probe =
    options.probe ??
    (options.isDev ? new StaticSystemProxyProbe() : new LiveSystemProxyKernelProbe(options.kernel, options.mihomo))
  const backup = options.backup ?? (options.isDev ? new InMemorySystemProxyBackupStore() : FileSystemProxyBackupStore.forAppDataBase(options.appDataBase))
  const proxyBypassStore =
    options.proxyBypassStore ??
    (options.isDev ? new InMemoryProxyBypassStore() : FileSystemProxyBypassStore.forAppDataBase(options.appDataBase))
  return new SystemProxyService({ adapter, probe, backup, proxyBypassStore, instanceId })
}
