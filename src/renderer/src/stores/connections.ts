import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoConnectionsSnapshot, MihomoStreamError } from '@shared/mihomo-api'

export type ConnectionsStreamStatus = 'loading' | 'live' | 'disconnected' | 'error'

export interface ProcessRank {
  name: string
  download: number
  width: number
}

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
  let connectionsUnsub: (() => void) | null = null
  let errorUnsub: (() => void) | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      if (status.value !== 'live') {
        lastError.value = '未收到连接数据'
        status.value = 'disconnected'
      }
    }, 5000)
  }

  const summary = computed<ConnectionsSummary | null>(() => {
    const snap = snapshot.value
    if (!snap) return null
    const connectionMap = new Map<string, number>()
    const devices = new Set<string>()
    let directDownload = 0
    let proxyDownload = 0
    for (const connection of snap.connections) {
      const process = connection.metadata.process ?? 'unknown'
      connectionMap.set(process, (connectionMap.get(process) ?? 0) + connection.download)
      const ip = connection.metadata.sourceIP ?? connection.metadata.destinationIP
      if (ip) devices.add(ip)
      if (connection.chains.includes('DIRECT')) directDownload += connection.download
      else proxyDownload += connection.download
    }
    const ranked = Array.from(connectionMap.entries())
      .map(([name, download]) => ({ name, download }))
      .sort((a, b) => b.download - a.download)
    const max = ranked[0]?.download ?? 1
    return {
      totalConnections: snap.connections.length,
      distinctProcesses: connectionMap.size,
      distinctDevices: devices.size,
      downloadTotal: snap.downloadTotal,
      uploadTotal: snap.uploadTotal,
      memory: snap.memory,
      directDownload,
      proxyDownload,
      topProcesses: ranked.map(({ name, download }) => ({ name, download, width: Math.round((download / max) * 100) }))
    }
  })

  function accept(snap: MihomoConnectionsSnapshot): void {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    snapshot.value = snap
    if (status.value !== 'live') {
      lastError.value = null
      status.value = 'live'
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
  }

  return { status, lastError, snapshot, summary, connect, disconnect }
})
