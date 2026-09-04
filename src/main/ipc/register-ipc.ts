import { ipcMain, BrowserWindow, app } from 'electron'
import { brand } from '@shared/brand'
import type { IpcDeps, KernelGateway, KernelManagerGateway, MihomoGateway, ProfileGateway, SystemProxyGateway, StartupGateway, AppSettingsGateway, UpdatesGateway, OverridesGateway, DnsEnhancementGateway, SnifferEnhancementGateway, TunConfigGateway, CoreSettingsGateway, GeodataSettingsGateway, UsageHistoryGateway, NetworkMetadataGateway } from '@shared/gateways'
import type { TunGateway } from '@shared/tun'
import type { OutboundMode, RuntimeSummary } from '@shared/runtime'
import { IPC } from '@shared/ipc'
import { ProtocolError, encodeProtocolError } from '@shared/protocol-errors'
import { fetchExternalIpViaProxy } from '../services/external-ip'
import { buildIpcHandlers, type IpcHandler } from './handlers'

export interface IpcDependencies {
  kernel: KernelGateway
  kernelManager: KernelManagerGateway
  mihomo: MihomoGateway
  profiles: ProfileGateway
  systemProxy: SystemProxyGateway
  startup: StartupGateway
  appSettings: AppSettingsGateway
  overrides: OverridesGateway
  dns: DnsEnhancementGateway
  sniffer: SnifferEnhancementGateway
  tunConfig: TunConfigGateway
  updates: UpdatesGateway
  tun: TunGateway
  core: CoreSettingsGateway
  geodata: GeodataSettingsGateway
  usageHistory: UsageHistoryGateway
  networkMetadata: NetworkMetadataGateway
  /** Group order parsed from the exact enhanced document materialized for mihomo. */
  resolveActiveGroupOrder?: () => Promise<string[]>
}

/**
 * Wrap a handler so a typed ProtocolError crosses Electron IPC as an encoded
 * message. The renderer-side preload decodes it back into a ProtocolError.
 */
function wrapHandler(handler: IpcHandler): IpcHandler {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      if (error instanceof ProtocolError) throw new Error(encodeProtocolError(error))
      throw error
    }
  }
}

/**
 * Build the Activity page's runtime context summary. Exported for tests; the
 * production path is the `runtime` gateway wired below.
 */
export async function buildRuntimeSummary({
  mihomo,
  profiles,
  systemProxy,
  tun
}: Pick<IpcDependencies, 'mihomo' | 'profiles' | 'systemProxy' | 'tun'>): Promise<RuntimeSummary> {
  let mode: OutboundMode = 'rule'
  try {
    const config = await mihomo.getConfig()
    if (config.mode) mode = config.mode
  } catch {
    // Controller unreachable (kernel stopped): fall back to the safe default.
  }
  // Real context, not placeholders: the Activity page shows the profile name to
  // the user, so it must be the ACTIVE profile (falling back to the brand
  // default only when nothing is activated), and the proxy/TUN flags must
  // reflect the main-process lifecycle owners rather than hardcoded values.
  let profileName = brand.defaultProfileName
  try {
    const metas = await profiles.listProfiles()
    const active = metas.find((meta) => meta.active)
    if (active) profileName = active.name
  } catch {
    // Keep the brand default on a repository error; never fabricate a name.
  }
  let systemProxyEnabled = false
  try {
    // `getStatus` may be sync or async per the gateway contract; await both.
    const proxyStatus = await systemProxy.getStatus()
    systemProxyEnabled = proxyStatus.phase === 'enabled'
  } catch {
    // A status failure must not break the whole summary.
  }
  let tunEnabled = false
  try {
    const tunStatus = await tun.getStatus()
    tunEnabled = tunStatus.phase === 'active' || tunStatus.phase === 'starting'
  } catch {
    // A status failure must not break the whole summary.
  }
  return {
    networkName: 'Ethernet',
    profileName,
    mode,
    externalIp: null,
    systemProxyEnabled,
    tunEnabled
  }
}

function resolveExternalIp({ kernel, mihomo }: Pick<IpcDependencies, 'kernel' | 'mihomo'>): Promise<string | null> {
  return (async () => {
    try {
      if ((await kernel.getStatus()).phase !== 'running') return null
      const config = await mihomo.getConfig()
      const port = config['mixed-port'] ?? config.port
      if (!port) return null
      return await fetchExternalIpViaProxy({ host: '127.0.0.1', port })
    } catch {
      return null
    }
  })()
}

export function registerIpc({ kernel, kernelManager, mihomo, profiles, systemProxy, startup, appSettings, overrides, dns, sniffer, tunConfig, updates, tun, core, geodata, usageHistory, networkMetadata, resolveActiveGroupOrder }: IpcDependencies): () => void {
  const deps: IpcDeps = {
    brand,
    appInfo: { version: app.getVersion(), platform: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'other', arch: process.arch },
    kernel,
    kernelManager,
    mihomo,
    runtime: {
      getSummary: () => buildRuntimeSummary({ mihomo, profiles, systemProxy, tun }),
      getExternalIp: () => resolveExternalIp({ kernel, mihomo })
    },
    profiles,
    systemProxy,
    startup,
    appSettings,
    overrides,
    dns,
    sniffer,
    tunConfig,
    updates,
    tun,
    core,
    geodata,
    usageHistory,
    networkMetadata
  }
  const iconCache = new Map<string, string>()
  const entries = Object.entries(buildIpcHandlers(deps, { resolveActiveGroupOrder }))
  entries.push([IPC.appGetProcessIcon, async (_event, rawPath) => {
    if (process.platform !== 'win32') return null
    // Local drive paths only: never let renderer input make Explorer resolve a
    // UNC/SMB path (which could cause unintended network access).
    if (typeof rawPath !== 'string' || !/^[a-zA-Z]:\\/.test(rawPath) || !/\.exe$/i.test(rawPath) || rawPath.length > 1024) return null
    const cached = iconCache.get(rawPath)
    if (cached) return cached
    try {
      const value = (await app.getFileIcon(rawPath, { size: 'normal' })).toDataURL()
      if (value.length <= 512_000) iconCache.set(rawPath, value)
      return value
    } catch { return null }
  }])
  for (const [channel, handler] of entries) {
    ipcMain.handle(channel, wrapHandler(handler))
  }

  // Forward push streams to every open renderer window. The gateway's shared
  // transports fan out to these forwarders, so window recreation never opens a
  // duplicate socket and no listener survives its window.
  const forward = <T>(channel: string, subscribe: (listener: (value: T) => void) => () => void): (() => void) => {
    return subscribe((value) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, value)
      }
    })
  }

  // Preserve the gateway receiver. Passing class methods as bare callbacks
  // loses `this` at runtime and previously made packaged/dev startup fail before
  // createWindow(), leaving only an invisible background process.
  const trafficUnsub = forward(IPC.mihomoTrafficEvent, (listener) => mihomo.onTraffic(listener))
  const connectionsUnsub = forward(IPC.mihomoConnectionsEvent, (listener) => mihomo.onConnections(listener))
  const logsUnsub = forward(IPC.mihomoLogEvent, (listener) => mihomo.onLogs(listener))
  const streamErrorUnsub = forward(IPC.mihomoStreamErrorEvent, (listener) => mihomo.onStreamError(listener))

  // Forward kernel status transitions to every open renderer window.
  const statusUnsub = kernel.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.kernelStatusEvent, status)
    }
  })

  // Forward system-proxy status transitions to every open renderer window.
  const systemProxyUnsub = forward(IPC.systemProxyStatusEvent, (listener) => systemProxy.onStatus(listener))
  const tunUnsub = forward(IPC.tunStatusEvent, (listener) => tun.onStatus(listener))

  // Forward application-update state transitions to every open renderer window.
  const updatesUnsub = forward(IPC.updatesStateEvent, (listener) => updates.onState(listener))

  // Forward kernel-manager state transitions to every open renderer window.
  const kernelManagerUnsub = forward(IPC.kernelManagerStateEvent, (listener) => kernelManager.onState(listener))

  // Cleanup is owned by the caller (index.ts wires it into the `app` "before-quit"
  // lifecycle event, which is the correct Electron signal — `process` has no
  // `before-quit` event). Repeated calls are harmless no-ops.
  let disposed = false
  return function dispose(): void {
    if (disposed) return
    disposed = true
    for (const [channel] of entries) ipcMain.removeHandler(channel)
    trafficUnsub()
    connectionsUnsub()
    logsUnsub()
    streamErrorUnsub()
    statusUnsub()
    systemProxyUnsub()
    tunUnsub()
    updatesUnsub()
    kernelManagerUnsub()
  }
}
