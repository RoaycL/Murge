import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi } from '@shared/ipc'

const api: DesktopApi = {
  app: {
    getBrand: () => ipcRenderer.invoke(IPC.appGetBrand)
  },
  kernel: {
    getStatus: () => ipcRenderer.invoke(IPC.kernelGetStatus),
    start: () => ipcRenderer.invoke(IPC.kernelStart),
    stop: () => ipcRenderer.invoke(IPC.kernelStop),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on(IPC.kernelStatusEvent, handler)
      return () => ipcRenderer.removeListener(IPC.kernelStatusEvent, handler)
    }
  },
  runtime: {
    getSummary: () => ipcRenderer.invoke(IPC.runtimeGetSummary)
  },
  mihomo: {
    getConfig: () => ipcRenderer.invoke(IPC.mihomoGetConfig),
    patchConfig: (patch) => ipcRenderer.invoke(IPC.mihomoPatchConfig, patch),
    getProxies: () => ipcRenderer.invoke(IPC.mihomoGetProxies),
    selectProxy: (group, name) => ipcRenderer.invoke(IPC.mihomoSelectProxy, group, name),
    getRules: () => ipcRenderer.invoke(IPC.mihomoGetRules),
    getConnections: () => ipcRenderer.invoke(IPC.mihomoGetConnections),
    closeConnection: (id) => ipcRenderer.invoke(IPC.mihomoCloseConnection, id),
    onTraffic: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on(IPC.mihomoTrafficEvent, handler)
      return () => ipcRenderer.removeListener(IPC.mihomoTrafficEvent, handler)
    }
  }
}

contextBridge.exposeInMainWorld('desktop', api)
