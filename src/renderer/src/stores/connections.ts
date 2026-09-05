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
export type ConnectionSort = 'traffic' | 'started' | 'process' | 'host'
export type ConnectionView = 'active' | 'closed'
export type TrackedConnection = MihomoConnection & { closedAt?: string }

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
  const closedConnections = ref<TrackedConnection[]>([])
  const view = ref<ConnectionView>('active')
  const selectedId = ref<string | null>(null)
  const search = ref('')
  const closingIds = ref<string[]>([])
  const actionError = ref<string | null>(null)
  const rankScope = ref<RankScope>('all')
  const sort = ref<ConnectionSort>('traffic')
  const closingMany = ref(false)
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
  const topPolicies = computed(() => buildRank(connections.value, scopeFilter.value, (c) => c.rule || c.chains.at(-1) || 'DIRECT'))

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

  const visibleConnections = computed<TrackedConnection[]>(() => {
    const term = search.value.trim().toLocaleLowerCase()
    const rows: TrackedConnection[] = view.value === 'active' ? (snapshot.value?.connections ?? []) : closedConnections.value
    const filtered = term ? rows.filter((connection) => {
      const haystack = [
        connection.metadata.process,
        connection.metadata.host,
        connection.metadata.destinationIP,
        connection.rule,
        connection.rulePayload,
        ...connection.chains
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return haystack.includes(term)
    }) : rows
    return [...filtered].sort((left, right) => {
      if (sort.value === 'started') return Date.parse(right.start) - Date.parse(left.start)
      if (sort.value === 'process') return (left.metadata.process ?? '').localeCompare(right.metadata.process ?? '')
      if (sort.value === 'host') {
        const leftHost = left.metadata.host || left.metadata.destinationIP || ''
        const rightHost = right.metadata.host || right.metadata.destinationIP || ''
        return leftHost.localeCompare(rightHost)
      }
      return (right.upload + right.download) - (left.upload + left.download)
    })
  })

  const selectedConnection = computed<TrackedConnection | null>(() => {
    if (!selectedId.value) return null
    return snapshot.value?.connections.find((connection) => connection.id === selectedId.value) ??
      closedConnections.value.find((connection) => connection.id === selectedId.value) ?? null
  })

  function accept(snap: MihomoConnectionsSnapshot): void {
    const previous = snapshot.value?.connections ?? []
    const activeIds = new Set(snap.connections.map((connection) => connection.id))
    const closedAt = new Date().toISOString()
    const merged = new Map(closedConnections.value.map((connection) => [connection.id, connection]))
    for (const connection of previous) {
      if (!activeIds.has(connection.id)) merged.set(connection.id, { ...connection, closedAt })
    }
    for (const id of activeIds) merged.delete(id)
    closedConnections.value = [...merged.values()]
      .sort((left, right) => Date.parse(right.closedAt ?? '') - Date.parse(left.closedAt ?? ''))
      .slice(0, 500)
    snapshot.value = snap
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

  function setView(next: ConnectionView): void {
    view.value = next
    selectedId.value = null
  }

  function clearClosed(): void {
    closedConnections.value = []
    if (view.value === 'closed') selectedId.value = null
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

  /**
   * Close the supplied snapshot of connection ids sequentially. A sequential
   * loop intentionally reuses the single-close read-back contract instead of
   * racing several controller confirmations against one another.
   */
  async function closeMany(ids: string[]): Promise<{ closed: number; failed: number }> {
    if (closingMany.value) return { closed: 0, failed: ids.length }
    closingMany.value = true
    let closed = 0
    let failed = 0
    try {
      for (const id of [...new Set(ids)]) {
        if (await close(id)) closed += 1
        else failed += 1
      }
      if (failed > 0) actionError.value = `${failed} 条连接未能关闭`
      return { closed, failed }
    } finally {
      closingMany.value = false
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
    status, lastError, snapshot, summary, closedConnections, view,
    selectedId, selectedConnection, search, visibleConnections, closingIds, closingMany, actionError, sort,
    rankScope, setRankScope, topProcesses, topHosts, topPolicies,
    connect, disconnect, select, close, closeMany, setView, clearClosed
  }
})
