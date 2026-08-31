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
    getBrand: () => invoke(IPC.appGetBrand),
    getInfo: () => invoke(IPC.appGetInfo)
  },
  kernel: {
    getStatus: () => invoke(IPC.kernelGetStatus),
    start: () => invoke(IPC.kernelStart),
    stop: () => invoke(IPC.kernelStop),
    onStatus: (listener) => listen(IPC.kernelStatusEvent, listener)
  },
  runtime: {
    getSummary: () => invoke(IPC.runtimeGetSummary),
    getExternalIp: () => invoke(IPC.runtimeGetExternalIp)
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
    dnsQuery: (name, type) => invoke(IPC.mihomoDnsQuery, name, type),
    flushDnsCache: () => invoke(IPC.mihomoFlushDnsCache),
    flushFakeIpCache: () => invoke(IPC.mihomoFlushFakeIpCache),
    onTraffic: (listener) => listen(IPC.mihomoTrafficEvent, listener),
    onConnections: (listener) => listen(IPC.mihomoConnectionsEvent, listener),
    onLogs: (listener) => listen(IPC.mihomoLogEvent, listener),
    onStreamError: (listener) => listen(IPC.mihomoStreamErrorEvent, listener)
  },
  profiles: {
    list: () => invoke(IPC.profilesList),
    get: (id) => invoke(IPC.profilesGet, id),
    import: (request) => invoke(IPC.profilesImport, request),
    importFromUrl: (name, url, activate) => invoke(IPC.profilesImportFromUrl, name, url, activate),
    activate: (id) => invoke(IPC.profilesActivate, id),
    delete: (id) => invoke(IPC.profilesDelete, id),
    rename: (id, name) => invoke(IPC.profilesRename, id, name),
    editDocument: (id, edits) => invoke(IPC.profilesEditDocument, id, edits),
    validate: (document) => invoke(IPC.profilesValidate, document)
  },
  systemProxy: {
    getStatus: () => invoke(IPC.systemProxyGetStatus),
    enable: () => invoke(IPC.systemProxyEnable),
    disable: () => invoke(IPC.systemProxyDisable),
    onStatus: (listener) => listen(IPC.systemProxyStatusEvent, listener)
  },
  startup: {
    getStatus: () => invoke(IPC.startupGetStatus),
    setEnabled: (enabled) => invoke(IPC.startupSetEnabled, enabled)
  },
  tun: {
    getStatus: () => invoke(IPC.tunGetStatus),
    enable: () => invoke(IPC.tunEnable),
    disable: () => invoke(IPC.tunDisable),
    onStatus: (listener) => listen(IPC.tunStatusEvent, listener)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
