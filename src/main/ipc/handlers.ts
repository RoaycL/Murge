import { IPC } from '@shared/ipc'
import type { IpcDeps } from '@shared/gateways'
import { parseConfigPatch, parseProxySelection, parseConnectionId, parseMihomoName, parseDelayOptions } from '@shared/schemas/ipc'
import { parseConfigEdit, parseImportRequest, parseProfileName } from '@shared/schemas/profiles'
import type { ConfigEdit } from '@shared/profiles'

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
  const { brand, kernel, mihomo, runtime, profiles } = deps

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
    [IPC.mihomoGetProxyProviders]: async () => mihomo.getProxyProviders(),
    [IPC.mihomoRefreshProxyProvider]: async (_event, name) => mihomo.refreshProxyProvider(parseMihomoName(name)),
    [IPC.mihomoHealthCheckProxyProvider]: async (_event, name) => mihomo.healthCheckProxyProvider(parseMihomoName(name)),
    [IPC.mihomoGetRuleProviders]: async () => mihomo.getRuleProviders(),
    [IPC.mihomoRefreshRuleProvider]: async (_event, name) => mihomo.refreshRuleProvider(parseMihomoName(name)),
    [IPC.mihomoDelayTest]: async (_event, name, opts) => mihomo.delayTest(parseMihomoName(name), parseDelayOptions(opts)),
    [IPC.mihomoGroupDelayTest]: async (_event, name, opts) => mihomo.groupDelayTest(parseMihomoName(name), parseDelayOptions(opts)),
    [IPC.mihomoGetConnections]: async () => mihomo.getConnections(),
    [IPC.mihomoCloseConnection]: async (_event, id) => mihomo.closeConnection(parseConnectionId(id)),

    [IPC.profilesList]: async () => profiles.listProfiles(),
    [IPC.profilesGet]: async (_event, id) => profiles.getProfile(parseProfileName(id)),
    [IPC.profilesImport]: async (_event, request) => profiles.importProfile(parseImportRequest(request)),
    [IPC.profilesImportFromUrl]: async (_event, name, url, activate) =>
      profiles.importFromUrl(parseProfileName(name), parseProfileName(url), activate === true),
    [IPC.profilesActivate]: async (_event, id) => profiles.activateProfile(parseProfileName(id)),
    [IPC.profilesDelete]: async (_event, id) => profiles.deleteProfile(parseProfileName(id)),
    [IPC.profilesRename]: async (_event, id, name) => profiles.renameProfile(parseProfileName(id), parseProfileName(name)),
    [IPC.profilesEditDocument]: async (_event, id, edits) =>
      profiles.editDocument(parseProfileName(id), parseEditsArray(edits)),
    [IPC.profilesValidate]: async (_event, document) => profiles.validateDocument(String(document))
  }
}

function parseEditsArray(input: unknown): ConfigEdit[] {
  if (!Array.isArray(input)) throw new Error('config edits must be an array')
  return input.map(parseConfigEdit)
}
