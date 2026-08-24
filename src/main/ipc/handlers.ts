import { IPC } from '@shared/ipc'
import type { IpcDeps } from '@shared/gateways'
import { parseConfigPatch, parseProxySelection, parseConnectionId } from '@shared/schemas/ipc'

/** A single IPC handler. The event is opaque to keep the factory Electron-free. */
export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

/**
 * Build the channel map of renderer-to-main handlers.
 *
 * This is intentionally free of any Electron import so it can be unit tested
 * with a fake service container. Every renderer-supplied argument is validated
 * here, before the corresponding gateway method is reached. Handlers are async
 * so a synchronous validation failure surfaces as a rejected promise, matching
 * the semantics Electron uses for `ipcMain.handle`.
 */
export function buildIpcHandlers(deps: IpcDeps): Record<string, IpcHandler> {
  const { brand, kernel, mihomo, runtime } = deps

  return {
    [IPC.appGetBrand]: async () => brand,

    [IPC.kernelGetStatus]: async () => kernel.getStatus(),
    [IPC.kernelStart]: async () => kernel.start(),
    [IPC.kernelStop]: async () => kernel.stop(),

    [IPC.runtimeGetSummary]: async () => runtime.getSummary(),

    [IPC.mihomoGetConfig]: async () => mihomo.getConfig(),
    [IPC.mihomoPatchConfig]: async (_event, patch) => mihomo.patchConfig(parseConfigPatch(patch)),
    [IPC.mihomoGetProxies]: async () => mihomo.getProxies(),
    [IPC.mihomoSelectProxy]: async (_event, group, name) => {
      const selection = parseProxySelection(group, name)
      return mihomo.selectProxy(selection.group, selection.name)
    },
    [IPC.mihomoGetRules]: async () => mihomo.getRules(),
    [IPC.mihomoGetConnections]: async () => mihomo.getConnections(),
    [IPC.mihomoCloseConnection]: async (_event, id) => mihomo.closeConnection(parseConnectionId(id))
  }
}
