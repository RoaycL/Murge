// GENERATED FILE — do not edit by hand.
// Regenerate with `npm run tauri:bridge`.
//
// Source of truth: src/preload/index.ts (method surface) + src/shared/ipc.ts
// (wire channel names). The Tauri shell renders window.desktop over
// commands/events with the identical contract, so renderer code cannot
// tell the shells apart (docs/tauri/phase2/README.md).
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { decodeProtocolError } from '@shared/protocol-errors'
import type { DesktopApi } from '@shared/ipc'

/**
 * Thin invoke wrapper with the exact error semantics of the Electron
 * preload: Tauri command rejections arrive as the raw ProtocolError wire
 * string (`PROTOCOL_ERROR:<CODE>::<message>`), decode them so the renderer
 * can branch on a stable error code.
 */
async function bridgeInvoke<T>(channel: string, args: unknown[]): Promise<T> {
  try {
    return (await tauriInvoke<T>('desktop_ipc', { channel, payload: args })) as T
  } catch (error) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
    const decoded = decodeProtocolError(message)
    throw decoded ?? error
  }
}

/**
 * Event subscription with the preload's synchronous-unsubscribe contract.
 * Tauri listen resolves asynchronously; a listener disposed before
 * resolution unregisters immediately once it lands.
 */
function bridgeListen<T>(channel: string, listener: (value: T) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null
  void tauriListen<T>(channel, (event) => { listener(event.payload) }).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Install the Tauri-backed `window.desktop` implementation. */
export function createDesktopApi(): DesktopApi {
  const api: DesktopApi = {
    app: {
      getBrand: () => bridgeInvoke("app:get-brand", []),
      getInfo: () => bridgeInvoke("app:get-info", []),
      getProcessIcon: (path) => bridgeInvoke("app:get-process-icon", ["path"]),
      getCachedIcon: (cacheKey, url, refresh) => bridgeInvoke("app:get-cached-icon", ["cacheKey","url","refresh"]),
      listNetworkInterfaces: () => bridgeInvoke("app:list-network-interfaces", []),
      onNavigate: (listener) => bridgeListen("app:navigate-event", listener),
    },
    kernel: {
      getStatus: () => bridgeInvoke("kernel:get-status", []),
      start: () => bridgeInvoke("kernel:start", []),
      stop: () => bridgeInvoke("kernel:stop", []),
      onStatus: (listener) => bridgeListen("kernel:status-event", listener),
    },
    kernelManager: {
      getState: () => bridgeInvoke("kernel-manager:get-state", []),
      setEnabled: (enabled) => bridgeInvoke("kernel-manager:set-enabled", ["enabled"]),
      setChannel: (channel) => bridgeInvoke("kernel-manager:set-channel", ["channel"]),
      listVersions: () => bridgeInvoke("kernel-manager:list-versions", []),
      install: (version) => bridgeInvoke("kernel-manager:install", ["version"]),
      onState: (listener) => bridgeListen("kernel-manager:state-event", listener),
    },
    runtime: {
      getSummary: () => bridgeInvoke("runtime:get-summary", []),
      getExternalIp: () => bridgeInvoke("runtime:get-external-ip", []),
    },
    mihomo: {
      getConfig: () => bridgeInvoke("mihomo:get-config", []),
      patchConfig: (patch) => bridgeInvoke("mihomo:patch-config", ["patch"]),
      getProxies: () => bridgeInvoke("mihomo:get-proxies", []),
      internetLatency: () => bridgeInvoke("mihomo:internet-latency", []),
      selectProxy: (group, name) => bridgeInvoke("mihomo:select-proxy", ["group","name"]),
      getRules: () => bridgeInvoke("mihomo:get-rules", []),
      getProxyProviders: () => bridgeInvoke("mihomo:get-proxy-providers", []),
      refreshProxyProvider: (name) => bridgeInvoke("mihomo:refresh-proxy-provider", ["name"]),
      healthCheckProxyProvider: (name) => bridgeInvoke("mihomo:health-check-proxy-provider", ["name"]),
      getRuleProviders: () => bridgeInvoke("mihomo:get-rule-providers", []),
      refreshRuleProvider: (name) => bridgeInvoke("mihomo:refresh-rule-provider", ["name"]),
      delayTest: (name, opts) => bridgeInvoke("mihomo:delay-test", ["name","opts"]),
      groupMemberDelayTest: (group, name, opts) => bridgeInvoke("mihomo:group-member-delay-test", ["group","name","opts"]),
      groupDelayTest: (name, opts) => bridgeInvoke("mihomo:group-delay-test", ["name","opts"]),
      getConnections: () => bridgeInvoke("mihomo:get-connections", []),
      closeConnection: (id) => bridgeInvoke("mihomo:close-connection", ["id"]),
      dnsQuery: (name, type) => bridgeInvoke("mihomo:dns-query", ["name","type"]),
      flushDnsCache: () => bridgeInvoke("mihomo:flush-dns-cache", []),
      flushFakeIpCache: () => bridgeInvoke("mihomo:flush-fakeip-cache", []),
      logsSnapshot: (afterSeq) => bridgeInvoke("mihomo:logs-snapshot", ["afterSeq"]),
      clearLogs: () => bridgeInvoke("mihomo:clear-logs", []),
      onTraffic: (listener) => bridgeListen("mihomo:traffic-event", listener),
      onConnections: (listener) => bridgeListen("mihomo:connections-event", listener),
      onLogs: (listener) => bridgeListen("mihomo:log-event", listener),
      onStreamError: (listener) => bridgeListen("mihomo:stream-error-event", listener),
    },
    profiles: {
      getActiveGroupOrder: () => bridgeInvoke("profiles:get-active-group-order", []),
      getActiveProviderCatalog: () => bridgeInvoke("profiles:get-active-provider-catalog", []),
      getProviderContent: (kind, name) => bridgeInvoke("profiles:get-provider-content", ["kind","name"]),
      inspectActiveConfig: () => bridgeInvoke("profiles:inspect-active-config", []),
      list: () => bridgeInvoke("profiles:list", []),
      get: (id) => bridgeInvoke("profiles:get", ["id"]),
      import: (request) => bridgeInvoke("profiles:import", ["request"]),
      importFromUrl: (name, url, activate) => bridgeInvoke("profiles:import-from-url", ["name","url","activate"]),
      updateFromSource: (id) => bridgeInvoke("profiles:update-from-source", ["id"]),
      activate: (id) => bridgeInvoke("profiles:activate", ["id"]),
      delete: (id) => bridgeInvoke("profiles:delete", ["id"]),
      rename: (id, name) => bridgeInvoke("profiles:rename", ["id","name"]),
      editDocument: (id, edits) => bridgeInvoke("profiles:edit-document", ["id","edits"]),
      replaceDocument: (id, document) => bridgeInvoke("profiles:replace-document", ["id","document"]),
      getSourceUrl: (id) => bridgeInvoke("profiles:get-source-url", ["id"]),
      setSourceUrl: (id, url) => bridgeInvoke("profiles:set-source-url", ["id","url"]),
      validate: (document) => bridgeInvoke("profiles:validate", ["document"]),
    },
    systemProxy: {
      getStatus: () => bridgeInvoke("system-proxy:get-status", []),
      enable: () => bridgeInvoke("system-proxy:enable", []),
      disable: () => bridgeInvoke("system-proxy:disable", []),
      onStatus: (listener) => bridgeListen("system-proxy:status-event", listener),
      getProxyBypass: () => bridgeInvoke("system-proxy:get-proxy-bypass", []),
      setProxyBypass: (input) => bridgeInvoke("system-proxy:set-proxy-bypass", ["input"]),
      previewProxyBypass: (input) => bridgeInvoke("system-proxy:preview-proxy-bypass", ["input"]),
    },
    startup: {
      getStatus: () => bridgeInvoke("startup:get-status", []),
      setEnabled: (enabled) => bridgeInvoke("startup:set-enabled", ["enabled"]),
    },
    unlock: {
      testAll: () => bridgeInvoke("network:unlock-test-all", []),
      testOne: (name) => bridgeInvoke("network:unlock-test-one", ["name"]),
    },
    appSettings: {
      get: () => bridgeInvoke("app-settings:get", []),
      set: (patch) => bridgeInvoke("app-settings:set", ["patch"]),
    },
    subStore: {
      getState: () => bridgeInvoke("substore:get-state", []),
      ensureRunning: () => bridgeInvoke("substore:ensure-running", []),
      stop: () => bridgeInvoke("substore:stop", []),
      checkUpdate: () => bridgeInvoke("substore:check-update", []),
      openExternal: (url) => bridgeInvoke("substore:open-external", ["url"]),
    },
    overrides: {
      list: () => bridgeInvoke("overrides:list", []),
      create: (input) => bridgeInvoke("overrides:create", ["input"]),
      update: (id, input) => bridgeInvoke("overrides:update", ["id","input"]),
      remove: (id) => bridgeInvoke("overrides:remove", ["id"]),
      setEnabled: (id, enabled) => bridgeInvoke("overrides:set-enabled", ["id","enabled"]),
      move: (id, direction) => bridgeInvoke("overrides:move", ["id","direction"]),
      preview: () => bridgeInvoke("overrides:preview", []),
      validate: () => bridgeInvoke("overrides:validate", []),
      lastKnownGood: () => bridgeInvoke("overrides:last-known-good", []),
      resetToLastGood: () => bridgeInvoke("overrides:reset-to-last-good", []),
    },
    dns: {
      get: () => bridgeInvoke("dns:get", []),
      set: (input) => bridgeInvoke("dns:set", ["input"]),
      preview: (input) => bridgeInvoke("dns:preview", ["input"]),
    },
    sniffer: {
      get: () => bridgeInvoke("sniffer:get", []),
      set: (input) => bridgeInvoke("sniffer:set", ["input"]),
      preview: (input) => bridgeInvoke("sniffer:preview", ["input"]),
    },
    updates: {
      getState: () => bridgeInvoke("updates:get-state", []),
      check: () => bridgeInvoke("updates:check", []),
      download: () => bridgeInvoke("updates:download", []),
      install: () => bridgeInvoke("updates:install", []),
      onState: (listener) => bridgeListen("updates:state-event", listener),
    },
    tun: {
      getStatus: () => bridgeInvoke("tun:get-status", []),
      enable: () => bridgeInvoke("tun:enable", []),
      disable: () => bridgeInvoke("tun:disable", []),
      onStatus: (listener) => bridgeListen("tun:status-event", listener),
    },
    tunConfig: {
      get: () => bridgeInvoke("tun-config:get", []),
      set: (input) => bridgeInvoke("tun-config:set", ["input"]),
      preview: (input) => bridgeInvoke("tun-config:preview", ["input"]),
    },
    core: {
      get: () => bridgeInvoke("core-settings:get", []),
      set: (input) => bridgeInvoke("core-settings:set", ["input"]),
      preview: (input) => bridgeInvoke("core-settings:preview", ["input"]),
    },
    geodata: {
      get: () => bridgeInvoke("geodata-settings:get", []),
      set: (input) => bridgeInvoke("geodata-settings:set", ["input"]),
      preview: (input) => bridgeInvoke("geodata-settings:preview", ["input"]),
    },
    usageHistory: {
      getWindow: (window) => bridgeInvoke("usage-history:get-window", ["window"]),
      rank: (window, ranking, limit) => bridgeInvoke("usage-history:rank", ["window","ranking","limit"]),
      clear: () => bridgeInvoke("usage-history:clear", []),
      getCapacity: () => bridgeInvoke("usage-history:get-capacity", []),
    },
    networkMetadata: {
      getProviders: () => bridgeInvoke("network-metadata:get-providers", []),
      getState: () => bridgeInvoke("network-metadata:get-state", []),
      selectProvider: (id) => bridgeInvoke("network-metadata:select-provider", ["id"]),
      resolve: (force) => bridgeInvoke("network-metadata:resolve", ["force"]),
      resolveAll: (force) => bridgeInvoke("network-metadata:resolve-all", ["force"]),
    },
  }
  return api
}
