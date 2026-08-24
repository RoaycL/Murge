import { ipcMain, BrowserWindow } from 'electron'
import { brand } from '@shared/brand'
import type { IpcDeps, KernelGateway, MihomoGateway } from '@shared/gateways'
import type { RuntimeSummary } from '@shared/runtime'
import { IPC } from '@shared/ipc'
import { ProtocolError, encodeProtocolError } from '@shared/protocol-errors'
import { buildIpcHandlers, type IpcHandler } from './handlers'

export interface IpcDependencies {
  kernel: KernelGateway
  mihomo: MihomoGateway
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

export function registerIpc({ kernel, mihomo }: IpcDependencies): () => void {
  const deps: IpcDeps = {
    brand,
    kernel,
    mihomo,
    runtime: { getSummary: buildRuntimeSummary }
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

  const trafficUnsub = forward(IPC.mihomoTrafficEvent, mihomo.onTraffic)
  const connectionsUnsub = forward(IPC.mihomoConnectionsEvent, mihomo.onConnections)
  const logsUnsub = forward(IPC.mihomoLogEvent, mihomo.onLogs)
  const streamErrorUnsub = forward(IPC.mihomoStreamErrorEvent, mihomo.onStreamError)

  // Forward kernel status transitions to every open renderer window.
  const statusUnsub = kernel.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.kernelStatusEvent, status)
    }
  })

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
  }
}
