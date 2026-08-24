import { ipcMain } from 'electron'
import { brand } from '@shared/brand'
import { IPC } from '@shared/ipc'
import type { MihomoConfigSnapshot } from '@shared/mihomo-api'
import type { RuntimeSummary } from '@shared/runtime'
import type { KernelSupervisor } from '../services/kernel-supervisor'
import type { MihomoClient } from '../services/mihomo-client'

export interface IpcDependencies {
  kernel: KernelSupervisor
  mihomo: MihomoClient
}

export function registerIpc({ kernel, mihomo }: IpcDependencies): void {
  ipcMain.handle(IPC.appGetBrand, () => brand)
  ipcMain.handle(IPC.kernelGetStatus, () => kernel.getStatus())
  ipcMain.handle(IPC.kernelStart, () => kernel.start())
  ipcMain.handle(IPC.kernelStop, () => kernel.stop())

  ipcMain.handle(IPC.runtimeGetSummary, (): RuntimeSummary => ({
    networkName: 'Ethernet',
    profileName: 'Default',
    mode: 'rule',
    externalIp: null,
    systemProxyEnabled: false,
    tunEnabled: false
  }))

  ipcMain.handle(IPC.mihomoGetConfig, () => mihomo.getConfig())
  ipcMain.handle(IPC.mihomoPatchConfig, (_event, patch: Partial<MihomoConfigSnapshot>) => mihomo.patchConfig(patch))
  ipcMain.handle(IPC.mihomoGetProxies, () => mihomo.getProxies())
  ipcMain.handle(IPC.mihomoSelectProxy, (_event, group: string, name: string) => mihomo.selectProxy(group, name))
  ipcMain.handle(IPC.mihomoGetRules, () => mihomo.getRules())
  ipcMain.handle(IPC.mihomoGetConnections, () => mihomo.getConnections())
  ipcMain.handle(IPC.mihomoCloseConnection, (_event, id: string) => mihomo.closeConnection(id))
}
