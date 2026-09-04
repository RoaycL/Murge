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
    getInfo: () => invoke(IPC.appGetInfo),
    getProcessIcon: (path) => invoke(IPC.appGetProcessIcon, path)
  },
  kernel: {
    getStatus: () => invoke(IPC.kernelGetStatus),
    start: () => invoke(IPC.kernelStart),
    stop: () => invoke(IPC.kernelStop),
    onStatus: (listener) => listen(IPC.kernelStatusEvent, listener)
  },
  kernelManager: {
    getState: () => invoke(IPC.kernelManagerGetState),
    setEnabled: (enabled) => invoke(IPC.kernelManagerSetEnabled, enabled),
    setChannel: (channel) => invoke(IPC.kernelManagerSetChannel, channel),
    listVersions: () => invoke(IPC.kernelManagerListVersions),
    install: (version) => invoke(IPC.kernelManagerInstall, version),
    onState: (listener) => listen(IPC.kernelManagerStateEvent, listener)
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
    updateFromSource: (id) => invoke(IPC.profilesUpdateFromSource, id),
    activate: (id) => invoke(IPC.profilesActivate, id),
    delete: (id) => invoke(IPC.profilesDelete, id),
    rename: (id, name) => invoke(IPC.profilesRename, id, name),
    editDocument: (id, edits) => invoke(IPC.profilesEditDocument, id, edits),
    replaceDocument: (id, document) => invoke(IPC.profilesReplaceDocument, id, document),
    getSourceUrl: (id) => invoke(IPC.profilesGetSourceUrl, id),
    setSourceUrl: (id, url) => invoke(IPC.profilesSetSourceUrl, id, url),
    validate: (document) => invoke(IPC.profilesValidate, document)
  },
  systemProxy: {
    getStatus: () => invoke(IPC.systemProxyGetStatus),
    enable: () => invoke(IPC.systemProxyEnable),
    disable: () => invoke(IPC.systemProxyDisable),
    onStatus: (listener) => listen(IPC.systemProxyStatusEvent, listener),
    getProxyBypass: () => invoke(IPC.systemProxyGetProxyBypass),
    setProxyBypass: (input) => invoke(IPC.systemProxySetProxyBypass, input),
    previewProxyBypass: (input) => invoke(IPC.systemProxyPreviewProxyBypass, input)
  },
  startup: {
    getStatus: () => invoke(IPC.startupGetStatus),
    setEnabled: (enabled) => invoke(IPC.startupSetEnabled, enabled)
  },
  appSettings: {
    get: () => invoke(IPC.appSettingsGet),
    set: (patch) => invoke(IPC.appSettingsSet, patch)
  },
  overrides: {
    list: () => invoke(IPC.overridesList),
    create: (input) => invoke(IPC.overridesCreate, input),
    update: (id, input) => invoke(IPC.overridesUpdate, id, input),
    remove: (id) => invoke(IPC.overridesRemove, id),
    setEnabled: (id, enabled) => invoke(IPC.overridesSetEnabled, id, enabled),
    move: (id, direction) => invoke(IPC.overridesMove, id, direction),
    preview: () => invoke(IPC.overridesPreview),
    validate: () => invoke(IPC.overridesValidate),
    lastKnownGood: () => invoke(IPC.overridesLastKnownGood),
    resetToLastGood: () => invoke(IPC.overridesResetToLastGood)
  },
  dns: {
    get: () => invoke(IPC.dnsGet),
    set: (input) => invoke(IPC.dnsSet, input),
    preview: (input) => invoke(IPC.dnsPreview, input)
  },
  sniffer: {
    get: () => invoke(IPC.snifferGet),
    set: (input) => invoke(IPC.snifferSet, input),
    preview: (input) => invoke(IPC.snifferPreview, input)
  },
  updates: {
    getState: () => invoke(IPC.updatesGetState),
    check: () => invoke(IPC.updatesCheck),
    download: () => invoke(IPC.updatesDownload),
    install: () => invoke(IPC.updatesInstall),
    onState: (listener) => listen(IPC.updatesStateEvent, listener)
  },
  tun: {
    getStatus: () => invoke(IPC.tunGetStatus),
    enable: () => invoke(IPC.tunEnable),
    disable: () => invoke(IPC.tunDisable),
    onStatus: (listener) => listen(IPC.tunStatusEvent, listener)
  },
  tunConfig: {
    get: () => invoke(IPC.tunConfigGet),
    set: (input) => invoke(IPC.tunConfigSet, input),
    preview: (input) => invoke(IPC.tunConfigPreview, input)
  },
  core: {
    get: () => invoke(IPC.coreSettingsGet),
    set: (input) => invoke(IPC.coreSettingsSet, input),
    preview: (input) => invoke(IPC.coreSettingsPreview, input)
  },
  geodata: {
    get: () => invoke(IPC.geodataSettingsGet),
    set: (input) => invoke(IPC.geodataSettingsSet, input),
    preview: (input) => invoke(IPC.geodataSettingsPreview, input)
  },
  usageHistory: {
    getWindow: (window) => invoke(IPC.usageHistoryGetWindow, window),
    rank: (window, ranking, limit) => invoke(IPC.usageHistoryRank, window, ranking, limit),
    clear: () => invoke(IPC.usageHistoryClear),
    getCapacity: () => invoke(IPC.usageHistoryGetCapacity)
  },
  networkMetadata: {
    getProviders: () => invoke(IPC.networkMetadataGetProviders),
    getState: () => invoke(IPC.networkMetadataGetState),
    selectProvider: (id) => invoke(IPC.networkMetadataSelectProvider, id),
    resolve: (force) => invoke(IPC.networkMetadataResolve, force)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
