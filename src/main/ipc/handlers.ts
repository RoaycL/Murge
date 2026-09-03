import { IPC } from '@shared/ipc'
import type { IpcDeps } from '@shared/gateways'
import { parseConfigPatch, parseProxySelection, parseConnectionId, parseMihomoName, parseDelayOptions, parseStartupEnabled, parseDnsQuery, parseAppSettingsPatch, parseKernelEnabled, parseKernelChannel, parseKernelVersion, parseOverrideInput, parseOverrideId, parseOverrideEnabled, parseOverrideMove, parseDnsEnhancement, parseSnifferEnhancement, parseTunConfig, parseCoreSettings, parseGeodataSettings, parseProxyBypassPolicy, parseUsageWindow, parseUsageRanking, parseUsageRankLimit, parseNetworkMetadataProviderId } from '@shared/schemas/ipc'
import {
  parseConfigEdit,
  parseImportRequest,
  parseOptionalBoolean,
  parseProfileDocument,
  parseProfileName,
  parseSubscriptionUrl
} from '@shared/schemas/profiles'
import type { ConfigEdit } from '@shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

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
  const { brand, appInfo, kernel, kernelManager, mihomo, runtime, profiles, systemProxy, startup, appSettings, overrides, dns, sniffer, tunConfig, updates, tun, core, geodata, usageHistory, networkMetadata } = deps

  return {
    [IPC.appGetBrand]: async () => brand,
    [IPC.appGetInfo]: async () => appInfo,

    [IPC.kernelGetStatus]: async () => kernel.getStatus(),
    [IPC.kernelStart]: async () => {
      assertTunInactive(await tun.getStatus())
      return kernel.start()
    },
    [IPC.kernelStop]: async () => kernel.stop(),

    [IPC.kernelManagerGetState]: async () => kernelManager.getState(),
    [IPC.kernelManagerSetEnabled]: async (_event, enabled) =>
      kernelManager.setEnabled(parseKernelEnabled(enabled)),
    [IPC.kernelManagerSetChannel]: async (_event, channel) =>
      kernelManager.setChannel(parseKernelChannel(channel)),
    [IPC.kernelManagerListVersions]: async () => kernelManager.listVersions(),
    [IPC.kernelManagerInstall]: async (_event, version) =>
      kernelManager.install(parseKernelVersion(version)),

    [IPC.runtimeGetSummary]: async () => runtime.getSummary(),
    [IPC.runtimeGetExternalIp]: async () => runtime.getExternalIp(),

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
    [IPC.mihomoDnsQuery]: async (_event, name, type) => {
      const query = parseDnsQuery(name, type)
      return mihomo.dnsQuery(query.name, query.type)
    },
    [IPC.mihomoFlushDnsCache]: async () => mihomo.flushDnsCache(),
    [IPC.mihomoFlushFakeIpCache]: async () => mihomo.flushFakeIpCache(),

    [IPC.profilesList]: async () => profiles.listProfiles(),
    [IPC.profilesGet]: async (_event, id) => profiles.getProfile(parseProfileName(id)),
    [IPC.profilesImport]: async (_event, request) => profiles.importProfile(parseImportRequest(request)),
    [IPC.profilesImportFromUrl]: async (_event, name, url, activate) =>
      profiles.importFromUrl(
        parseProfileName(name),
        parseSubscriptionUrl(url),
        parseOptionalBoolean(activate, 'activate')
      ),
    [IPC.profilesActivate]: async (_event, id) => profiles.activateProfile(parseProfileName(id)),
    [IPC.profilesDelete]: async (_event, id) => profiles.deleteProfile(parseProfileName(id)),
    [IPC.profilesRename]: async (_event, id, name) => profiles.renameProfile(parseProfileName(id), parseProfileName(name)),
    [IPC.profilesEditDocument]: async (_event, id, edits) =>
      profiles.editDocument(parseProfileName(id), parseEditsArray(edits)),
    [IPC.profilesValidate]: async (_event, document) => profiles.validateDocument(parseProfileDocument(document)),

    [IPC.systemProxyGetStatus]: async () => systemProxy.getStatus(),
    [IPC.systemProxyEnable]: async () => systemProxy.enable(),
    [IPC.systemProxyDisable]: async () => systemProxy.disable(),
    [IPC.systemProxyGetProxyBypass]: async () => systemProxy.getProxyBypass(),
    [IPC.systemProxySetProxyBypass]: async (_event, input) =>
      systemProxy.setProxyBypass(parseProxyBypassPolicy(input)),
    [IPC.systemProxyPreviewProxyBypass]: async (_event, input) =>
      systemProxy.previewProxyBypass(parseProxyBypassPolicy(input)),
    [IPC.startupGetStatus]: async () => startup.getStatus(),
    [IPC.startupSetEnabled]: async (_event, enabled) => startup.setEnabled(parseStartupEnabled(enabled)),
    [IPC.appSettingsGet]: async () => appSettings.get(),
    [IPC.appSettingsSet]: async (_event, patch) => appSettings.set(parseAppSettingsPatch(patch)),
    [IPC.overridesList]: async () => overrides.list(),
    [IPC.overridesCreate]: async (_event, input) => overrides.create(parseOverrideInput(input)),
    [IPC.overridesUpdate]: async (_event, id, input) =>
      overrides.update(parseOverrideId(id), parseOverrideInput(input)),
    [IPC.overridesRemove]: async (_event, id) => overrides.remove(parseOverrideId(id)),
    [IPC.overridesSetEnabled]: async (_event, id, enabled) =>
      overrides.setEnabled(parseOverrideId(id), parseOverrideEnabled(enabled)),
    [IPC.overridesMove]: async (_event, id, direction) =>
      overrides.move(parseOverrideId(id), parseOverrideMove(direction)),
    [IPC.overridesPreview]: async () => overrides.preview(),
    [IPC.overridesValidate]: async () => overrides.validate(),
    [IPC.overridesLastKnownGood]: async () => overrides.lastKnownGood(),
    [IPC.overridesResetToLastGood]: async () => overrides.resetToLastGood(),
    [IPC.dnsGet]: async () => dns.get(),
    [IPC.dnsSet]: async (_event, input) => dns.set(parseDnsEnhancement(input)),
    [IPC.dnsPreview]: async (_event, input) => dns.preview(parseDnsEnhancement(input)),
    [IPC.snifferGet]: async () => sniffer.get(),
    [IPC.snifferSet]: async (_event, input) => sniffer.set(parseSnifferEnhancement(input)),
    [IPC.snifferPreview]: async (_event, input) => sniffer.preview(parseSnifferEnhancement(input)),
    [IPC.updatesGetState]: async () => updates.getState(),
    [IPC.updatesCheck]: async () => updates.check(),
    [IPC.updatesDownload]: async () => updates.download(),
    [IPC.updatesInstall]: () => updates.install(),
    [IPC.tunGetStatus]: async () => tun.getStatus(),
    [IPC.tunEnable]: async () => {
      // TUN and the safe kernel stay mutually exclusive: both run a mihomo and
      // both bind a mixed-port. Rather than rejecting when the kernel is live,
      // auto-stop it first so enabling TUN is a single action. The kernel gateway
      // restores any owned system proxy before stopping (see
      // SystemProxyOrderedKernelGateway), so the proxy is never left pointing at a
      // port that is about to close; a proxy conflict is treated as safe. On a true
      // restore/stop failure the gateway throws and the TUN enable aborts, leaving
      // the kernel running rather than a TUN session against a dead controller.
      // The system proxy is NOT excluded — it may point at whichever mihomo is
      // live (see TunAwareSystemProxyProbe), so TUN and the system proxy can be
      // enabled together.
      const kernelStatus = await kernel.getStatus()
      if (kernelStatus.phase !== 'stopped') {
        await kernel.stop()
      }
      return tun.enable()
    },
    [IPC.tunDisable]: async () => tun.disable(),
    [IPC.tunConfigGet]: async () => tunConfig.get(),
    [IPC.tunConfigSet]: async (_event, input) => tunConfig.set(parseTunConfig(input)),
    [IPC.tunConfigPreview]: async (_event, input) => tunConfig.preview(parseTunConfig(input)),
    [IPC.coreSettingsGet]: async () => core.get(),
    [IPC.coreSettingsSet]: async (_event, input) => core.set(parseCoreSettings(input)),
    [IPC.coreSettingsPreview]: async (_event, input) => core.preview(parseCoreSettings(input)),
    [IPC.geodataSettingsGet]: async () => geodata.get(),
    [IPC.geodataSettingsSet]: async (_event, input) => geodata.set(parseGeodataSettings(input)),
    [IPC.geodataSettingsPreview]: async (_event, input) => geodata.preview(parseGeodataSettings(input)),

    [IPC.usageHistoryGetWindow]: async (_event, window) => usageHistory.getWindow(parseUsageWindow(window)),
    [IPC.usageHistoryRank]: async (_event, window, ranking, limit) =>
      usageHistory.rank(parseUsageWindow(window), parseUsageRanking(ranking), parseUsageRankLimit(limit)),
    [IPC.usageHistoryClear]: async () => usageHistory.clear(),
    [IPC.usageHistoryGetCapacity]: async () => usageHistory.getCapacity(),

    [IPC.networkMetadataGetProviders]: async () => networkMetadata.getProviders(),
    [IPC.networkMetadataGetState]: async () => networkMetadata.getState(),
    [IPC.networkMetadataSelectProvider]: async (_event, id) =>
      networkMetadata.selectProvider(parseNetworkMetadataProviderId(id)),
    [IPC.networkMetadataResolve]: async (_event, force) =>
      networkMetadata.resolve(parseOptionalBoolean(force, 'force'))
  }
}

function assertTunInactive(status: Awaited<ReturnType<IpcDeps['tun']['getStatus']>>): void {
  if (status.phase !== 'configured' && status.phase !== 'unsupported' && status.phase !== 'failed') {
    throw new ProtocolError(ProtocolErrorCode.TUN_INVALID_TRANSITION, 'Disable TUN before starting another network mode')
  }
}

function parseEditsArray(input: unknown): ConfigEdit[] {
  if (!Array.isArray(input)) {
    throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'config edits must be an array')
  }
  return input.map(parseConfigEdit)
}
