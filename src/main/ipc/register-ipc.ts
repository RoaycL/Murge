import { ipcMain, BrowserWindow, app } from 'electron'
import { brand } from '@shared/brand'
import type { IpcDeps, KernelGateway, KernelManagerGateway, MihomoGateway, ProfileGateway, SystemProxyGateway, StartupGateway, AppSettingsGateway, UpdatesGateway, OverridesGateway, DnsEnhancementGateway, SnifferEnhancementGateway, TunConfigGateway, CoreSettingsGateway, GeodataSettingsGateway, UsageHistoryGateway } from '@shared/gateways'
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

async function buildRuntimeSummary({ mihomo }: Pick<IpcDependencies, 'mihomo'>): Promise<RuntimeSummary> {
  let mode: OutboundMode = 'rule'
  try {
    const config = await mihomo.getConfig()
    if (config.mode) mode = config.mode
  } catch {
    // Controller unreachable (kernel stopped): fall back to the safe default.
  }
  return {
    networkName: 'Ethernet',
    profileName: brand.defaultProfileName,
    mode,
    externalIp: null,
    systemProxyEnabled: false,
    tunEnabled: false
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

export function registerIpc({ kernel, kernelManager, mihomo, profiles, systemProxy, startup, appSettings, overrides, dns, sniffer, tunConfig, updates, tun, core, geodata, usageHistory }: IpcDependencies): () => void {
  const deps: IpcDeps = {
    brand,
    appInfo: { version: app.getVersion(), platform: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'other', arch: process.arch },
    kernel,
    kernelManager,
    mihomo,
    runtime: {
      getSummary: () => buildRuntimeSummary({ mihomo }),
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
    usageHistory
  }
  const entries = Object.entries(buildIpcHandlers(deps))
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
