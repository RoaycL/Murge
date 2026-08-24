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
    profileName: 'Default',
    mode: 'rule',
    externalIp: null,
    systemProxyEnabled: false,
    tunEnabled: false
  }
}

export function registerIpc({ kernel, mihomo }: IpcDependencies): void {
  const deps: IpcDeps = {
    brand,
    kernel,
    mihomo,
    runtime: { getSummary: buildRuntimeSummary }
  }
  const handlers = buildIpcHandlers(deps)
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, wrapHandler(handler))
  }

  // Forward kernel status transitions to every open renderer window.
  kernel.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.kernelStatusEvent, status)
    }
  })
}
