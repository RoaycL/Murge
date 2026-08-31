import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoConnectionsSnapshot, MihomoStreamError } from '@shared/mihomo-api'
import type { MihomoConnection } from '@shared/mihomo-api'
import { toProtocolError } from '@shared/protocol-errors'

export type ConnectionsStreamStatus = 'loading' | 'live' | 'disconnected' | 'error'

export interface ProcessRank {
  name: string
  download: number
  width: number
}

/** Whether the activity breakdown counts every connection or only proxied ones. */
export type RankScope = 'all' | 'proxy'

export interface ConnectionsSummary {
  totalConnections: number
  distinctProcesses: number
  distinctDevices: number
  downloadTotal: number
  uploadTotal: number
  memory: number
  directDownload: number
  proxyDownload: number
  topProcesses: ProcessRank[]
}

export const useConnectionsStore = defineStore('connections', () => {
  const status = ref<ConnectionsStreamStatus>('loading')
  const lastError = ref<string | null>(null)
  const snapshot = ref<MihomoConnectionsSnapshot | null>(null)
  const selectedId = ref<string | null>(null)
  const search = ref('')
  const closingIds = ref<string[]>([])
  const actionError = ref<string | null>(null)
  const rankScope = ref<RankScope>('all')
  let connectionsUnsub: (() => void) | null = null
  let errorUnsub: (() => void) | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      watchdog = null
      // No snapshot for this long means the stream is effectively dead even if
      // no close/error event surfaced. Only override loading/live so a genuine
      // parse error is not masked by silence.
      if (status.value === 'loading' || status.value === 'live') {
        lastError.value = '未收到连接数据'
        status.value = 'disconnected'
      }
    }, 5000)
  }

  function isProxyConnection(connection: MihomoConnection): boolean {
    return !connection.chains.includes('DIRECT')
  }

  const connections = computed<MihomoConnection[]>(() => snapshot.value?.connections ?? [])
  const scopeFilter = computed<(connection: MihomoConnection) => boolean>(() =>
    rankScope.value === 'proxy' ? isProxyConnection : () => true
  )

  function buildRank(rows: MihomoConnection[], filter: (connection: MihomoConnection) => boolean, keyFn: (connection: MihomoConnection) => string): ProcessRank[] {
    const map = new Map<string, number>()
    for (const connection of rows) {
      if (!filter(connection)) continue
      const key = keyFn(connection)
      if (!key) continue
      map.set(key, (map.get(key) ?? 0) + connection.download)
    }
    const ranked = Array.from(map.entries())
      .map(([name, download]) => ({ name, download }))
      .sort((a, b) => b.download - a.download)
    const max = ranked[0]?.download ?? 1
    return ranked.map(({ name, download }) => ({ name, download, width: Math.round((download / max) * 100) }))
  }

  // Activity breakdown slots; each reacts to the 全部/仅代理 scope so toggling it
  // consistently filters whichever dimension the user is viewing.
  const topProcesses = computed(() => buildRank(connections.value, scopeFilter.value, (c) => c.metadata.process ?? 'unknown'))
  const topHosts = computed(() => buildRank(connections.value, scopeFilter.value, (c) => c.metadata.host || c.metadata.destinationIP || '未知目标'))
  const topPolicies = computed(() => buildRank(connections.value, scopeFilter.value, (c) => c.rule || c.chains[0] || 'DIRECT'))

  const summary = computed<ConnectionsSummary | null>(() => {
    const snap = snapshot.value
    if (!snap) return null
    const processes = new Set<string>()
    const devices = new Set<string>()
    let directDownload = 0
    let proxyDownload = 0
    for (const connection of snap.connections) {
      processes.add(connection.metadata.process ?? 'unknown')
      const ip = connection.metadata.sourceIP ?? connection.metadata.destinationIP
      if (ip) devices.add(ip)
      if (connection.chains.includes('DIRECT')) directDownload += connection.download
      else proxyDownload += connection.download
    }
    return {
      totalConnections: snap.connections.length,
      distinctProcesses: processes.size,
      distinctDevices: devices.size,
      downloadTotal: snap.downloadTotal,
      uploadTotal: snap.uploadTotal,
      memory: snap.memory,
      directDownload,
      proxyDownload,
      topProcesses: topProcesses.value
    }
  })

  const visibleConnections = computed<MihomoConnection[]>(() => {
    const term = search.value.trim().toLocaleLowerCase()
    const rows = snapshot.value?.connections ?? []
    if (!term) return rows
    return rows.filter((connection) => {
      const haystack = [
        connection.metadata.process,
        connection.metadata.host,
        connection.metadata.destinationIP,
        connection.rule,
        connection.rulePayload,
        ...connection.chains
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return haystack.includes(term)
    })
  })

  const selectedConnection = computed<MihomoConnection | null>(() => {
    if (!selectedId.value) return null
    return snapshot.value?.connections.find((connection) => connection.id === selectedId.value) ?? null
  })

  function accept(snap: MihomoConnectionsSnapshot): void {
    snapshot.value = snap
    if (selectedId.value && !snap.connections.some((connection) => connection.id === selectedId.value)) selectedId.value = null
    // Any valid snapshot proves the stream is alive; recover from loading or
    // disconnected and clear the stale error.
    lastError.value = null
    status.value = 'live'
    // Keep a fresh silence watchdog armed after every snapshot.
    armWatchdog()
  }

  function select(id: string | null): void {
    selectedId.value = id
    actionError.value = null
  }

  function setRankScope(scope: RankScope): void {
    rankScope.value = scope
  }

  async function close(id: string): Promise<boolean> {
    if (closingIds.value.includes(id)) return false
    closingIds.value = [...closingIds.value, id]
    actionError.value = null
    try {
      await window.desktop.mihomo.closeConnection(id)
      const confirmed = await window.desktop.mihomo.getConnections()
      accept(confirmed)
      if (confirmed.connections.some((connection) => connection.id === id)) {
        actionError.value = '控制器未确认连接已关闭'
        return false
      }
      return true
    } catch (error) {
      actionError.value = toProtocolError(error).message
      return false
    } finally {
      closingIds.value = closingIds.value.filter((value) => value !== id)
    }
  }

  function onError(error: MihomoStreamError): void {
    if (error.source !== 'connections') return
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    lastError.value = error.message
    status.value = error.kind === 'connection' ? 'disconnected' : 'error'
  }

  function connect(): void {
    if (connectionsUnsub) return
    connectionsUnsub = window.desktop.mihomo.onConnections(accept)
    errorUnsub = window.desktop.mihomo.onStreamError(onError)
    void window.desktop.mihomo.getConnections().then(accept).catch(() => undefined)
    armWatchdog()
  }

  function disconnect(): void {
    connectionsUnsub?.()
    errorUnsub?.()
    connectionsUnsub = null
    errorUnsub = null
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    // A clean slate on explicit disconnect: no lingering timer or listeners.
    lastError.value = null
    status.value = 'loading'
  }

  return {
    status, lastError, snapshot, summary,
    selectedId, selectedConnection, search, visibleConnections, closingIds, actionError,
    rankScope, setRankScope, topProcesses, topHosts, topPolicies,
    connect, disconnect, select, close
  }
})
