import { ipcMain, BrowserWindow } from 'electron'
import { brand } from '@shared/brand'
import type { IpcDeps, KernelGateway, MihomoGateway, ProfileGateway, SystemProxyGateway, StartupGateway } from '@shared/gateways'
import type { TunGateway } from '@shared/tun'
import type { RuntimeSummary } from '@shared/runtime'
import { IPC } from '@shared/ipc'
import { ProtocolError, encodeProtocolError } from '@shared/protocol-errors'
import { buildIpcHandlers, type IpcHandler } from './handlers'

export interface IpcDependencies {
  kernel: KernelGateway
  mihomo: MihomoGateway
  profiles: ProfileGateway
  systemProxy: SystemProxyGateway
  startup: StartupGateway
  tun: TunGateway
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

function buildRuntimeSummary(): RuntimeSummary {
  return {
    networkName: 'Ethernet',
    profileName: brand.defaultProfileName,
    mode: 'rule',
    externalIp: null,
    systemProxyEnabled: false,
    tunEnabled: false
  }
}

export function registerIpc({ kernel, mihomo, profiles, systemProxy, startup, tun }: IpcDependencies): () => void {
  const deps: IpcDeps = {
    brand,
    kernel,
    mihomo,
    runtime: { getSummary: buildRuntimeSummary },
    profiles,
    systemProxy,
    startup,
    tun
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
  }
}
