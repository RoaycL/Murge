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

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DesktopApi = {
  app: {
    getBrand: () => invoke(IPC.appGetBrand)
  },
  kernel: {
    getStatus: () => invoke(IPC.kernelGetStatus),
    start: () => invoke(IPC.kernelStart),
    stop: () => invoke(IPC.kernelStop),
    onStatus: (listener) => listen(IPC.kernelStatusEvent, listener)
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
    getProxyProviders: () => invoke(IPC.mihomoGetProxyProviders),
    refreshProxyProvider: (name) => invoke(IPC.mihomoRefreshProxyProvider, name),
    healthCheckProxyProvider: (name) => invoke(IPC.mihomoHealthCheckProxyProvider, name),
    getRuleProviders: () => invoke(IPC.mihomoGetRuleProviders),
    refreshRuleProvider: (name) => invoke(IPC.mihomoRefreshRuleProvider, name),
    delayTest: (name, opts) => invoke(IPC.mihomoDelayTest, name, opts),
    groupDelayTest: (name, opts) => invoke(IPC.mihomoGroupDelayTest, name, opts),
    getConnections: () => invoke(IPC.mihomoGetConnections),
    closeConnection: (id) => invoke(IPC.mihomoCloseConnection, id),
    onTraffic: (listener) => listen(IPC.mihomoTrafficEvent, listener),
    onConnections: (listener) => listen(IPC.mihomoConnectionsEvent, listener),
    onLogs: (listener) => listen(IPC.mihomoLogEvent, listener),
    onStreamError: (listener) => listen(IPC.mihomoStreamErrorEvent, listener)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
