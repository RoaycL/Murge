import { IPC } from '@shared/ipc'
import type { IpcDeps } from '@shared/gateways'
import { parseConfigPatch, parseProxySelection, parseConnectionId, parseMihomoName, parseDelayOptions, parseStartupEnabled, parseDnsQuery, parseAppSettingsPatch, parseKernelEnabled, parseKernelChannel, parseKernelVersion, parseOverrideInput, parseOverrideId, parseOverrideEnabled, parseOverrideMove, parseDnsEnhancement, parseSnifferEnhancement, parseTunConfig, parseCoreSettings, parseGeodataSettings, parseProxyBypassPolicy, parseUsageWindow, parseUsageRanking, parseUsageRankLimit, parseNetworkMetadataProviderId } from '@shared/schemas/ipc'
import {
  parseConfigEdit,
  parseImportRequest,
  parseOptionalBoolean,
  parseOptionalImportName,
  parseProfileDocument,
  parseProfileName,
  parseSubscriptionUrl
} from '@shared/schemas/profiles'
import type { ConfigEdit } from '@shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { parseProxyGroupOrder } from '../profiles/proxy-group-order'

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
export interface IpcHandlerOptions {
  /** Runtime-enhanced profile order; defaults to the raw document in tests/legacy callers. */
  resolveActiveGroupOrder?: () => Promise<string[]>
}

export function buildIpcHandlers(deps: IpcDeps, options: IpcHandlerOptions = {}): Record<string, IpcHandler> {
  const { brand, appInfo, kernel, kernelManager, mihomo, runtime, profiles, systemProxy, startup, appSettings, overrides, dns, sniffer, tunConfig, updates, tun, core, geodata, usageHistory, networkMetadata, internetLatency } = deps

  return {
    [IPC.appGetBrand]: async () => brand,
    [IPC.appGetInfo]: async () => appInfo,

    [IPC.kernelGetStatus]: async () => kernel.getStatus(),
    // The injected `kernel`/`tun` gateways are the QUEUED wrappers over the
    // single-kernel model (see kernel/mode-transition.ts): kernel start/stop and
    // TUN enable/disable are exclusive tasks on ONE FIFO queue, so no two host
    // transitions can interleave a prepare/stop/resume sequence. Enabling TUN is
    // a mode switch on the SAME kernel: the ordinary host is stopped first (no
    // proxy restore — the elevated child rebinds the unified ports), the child
    // comes up, and the owned system proxy is untouched on success. Restore
    // happens inside the controller ONLY when the unified controller cannot be
    // confirmed reachable again (never a fixed-delay guess).
    [IPC.kernelStart]: async () => kernel.start(),
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
    [IPC.mihomoInternetLatency]: async () => internetLatency.sample(),
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

    [IPC.profilesGetActiveGroupOrder]: async () => {
      if (options.resolveActiveGroupOrder) return options.resolveActiveGroupOrder()
      const metas = await profiles.listProfiles()
      const active = metas.find((meta) => meta.active)
      if (!active) return []
      const profile = await profiles.getProfile(active.id)
      return parseProxyGroupOrder(profile.document)
    },
    [IPC.profilesList]: async () => profiles.listProfiles(),
    [IPC.profilesGet]: async (_event, id) => profiles.getProfile(parseProfileName(id)),
    [IPC.profilesImport]: async (_event, request) => profiles.importProfile(parseImportRequest(request)),
    [IPC.profilesImportFromUrl]: async (_event, name, url, activate) =>
      profiles.importFromUrl(
        parseOptionalImportName(name),
        parseSubscriptionUrl(url),
        parseOptionalBoolean(activate, 'activate')
      ),
    [IPC.profilesActivate]: async (_event, id) => profiles.activateProfile(parseProfileName(id)),
    [IPC.profilesUpdateFromSource]: async (_event, id) => profiles.updateFromSource(parseProfileName(id)),
    [IPC.profilesDelete]: async (_event, id) => profiles.deleteProfile(parseProfileName(id)),
    [IPC.profilesRename]: async (_event, id, name) => profiles.renameProfile(parseProfileName(id), parseProfileName(name)),
    [IPC.profilesEditDocument]: async (_event, id, edits) =>
      profiles.editDocument(parseProfileName(id), parseEditsArray(edits)),
    [IPC.profilesReplaceDocument]: async (_event, id, document) =>
      profiles.replaceDocument(parseProfileName(id), parseProfileDocument(document)),
    [IPC.profilesGetSourceUrl]: async (_event, id) => profiles.getSourceUrl(parseProfileName(id)),
    [IPC.profilesSetSourceUrl]: async (_event, id, url) =>
      profiles.setSourceUrl(parseProfileName(id), parseSubscriptionUrl(url)),
    [IPC.profilesValidate]: async (_event, document) => profiles.validateDocument(parseProfileDocument(document)),

    [IPC.systemProxyGetStatus]: async () => systemProxy.getStatus(),
    [IPC.systemProxyEnable]: async () => {
      // Persist the user's requested end state before touching Windows. A
      // transient controller/service failure may leave the live state off, but
      // the next launch should still retry the choice the user made.
      await appSettings.set({ systemProxyDesired: true })
      return systemProxy.enable()
    },
    [IPC.systemProxyDisable]: async () => {
      // Turning off is also intent-first: if registry restoration reports an
      // error, startup must never re-enable the proxy against the user's wish.
      await appSettings.set({ systemProxyDesired: false })
      return systemProxy.disable()
    },
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
      await appSettings.set({ tunDesired: true })
      return tun.enable()
    },
    [IPC.tunDisable]: async () => {
      await appSettings.set({ tunDesired: false })
      return tun.disable()
    },
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
      networkMetadata.resolve(parseOptionalBoolean(force, 'force')),
    [IPC.networkMetadataResolveAll]: async (_event, force) =>
      networkMetadata.resolveAll(parseOptionalBoolean(force, 'force'))
  }
}

function parseEditsArray(input: unknown): ConfigEdit[] {
  if (!Array.isArray(input)) {
    throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'config edits must be an array')
  }
  return input.map(parseConfigEdit)
}
