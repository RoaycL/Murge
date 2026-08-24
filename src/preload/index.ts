import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi } from '@shared/ipc'
import { decodeProtocolError } from '@shared/protocol-errors'

/**
 * Thin invoke wrapper. `ipcRenderer.invoke` rejects with a generic Error whose
 * message may carry an encoded ProtocolError; decode it so the renderer can
 * branch on a stable error code.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const decoded = decodeProtocolError(message)
    throw decoded ?? error
  }
}

const api: DesktopApi = {
  app: {
    getBrand: () => invoke(IPC.appGetBrand)
  },
  kernel: {
    getStatus: () => invoke(IPC.kernelGetStatus),
    start: () => invoke(IPC.kernelStart),
    stop: () => invoke(IPC.kernelStop),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on(IPC.kernelStatusEvent, handler)
      return () => ipcRenderer.removeListener(IPC.kernelStatusEvent, handler)
    }
  },
  runtime: {
    getSummary: () => invoke(IPC.runtimeGetSummary)
  },
  mihomo: {
    getConfig: () => invoke(IPC.mihomoGetConfig),
    patchConfig: (patch) => invoke(IPC.mihomoPatchConfig, patch),
    getProxies: () => invoke(IPC.mihomoGetProxies),
    selectProxy: (group, name) => invoke(IPC.mihomoSelectProxy, group, name),
    getRules: () => invoke(IPC.mihomoGetRules),
    getConnections: () => invoke(IPC.mihomoGetConnections),
    closeConnection: (id) => invoke(IPC.mihomoCloseConnection, id),
    onTraffic: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on(IPC.mihomoTrafficEvent, handler)
      return () => ipcRenderer.removeListener(IPC.mihomoTrafficEvent, handler)
    }
  }
}

contextBridge.exposeInMainWorld('desktop', api)
