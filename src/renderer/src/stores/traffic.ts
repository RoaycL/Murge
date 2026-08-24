import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { TrafficSample } from '@shared/runtime'
import type { MihomoStreamError } from '@shared/mihomo-api'

export type TrafficStreamStatus = 'loading' | 'live' | 'disconnected' | 'error'

/** Maximum samples retained (60 at 1 Hz = one minute of history). */
const HISTORY = 60

/**
 * Bounded traffic history fed by the shared `/traffic` WebSocket transport.
 * The store keeps only the last minute so memory is flat while the value and
 * sparkline still reflect live throughput.
 */
export const useTrafficStore = defineStore('traffic', () => {
  const status = ref<TrafficStreamStatus>('loading')
  const lastError = ref<string | null>(null)
  const samples = ref<TrafficSample[]>([])
  let trafficUnsub: (() => void) | null = null
  let errorUnsub: (() => void) | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      if (status.value !== 'live') {
        lastError.value = '未收到流量数据'
        status.value = 'disconnected'
      }
    }, 5000)
  }

  const current = computed<TrafficSample | null>(() => samples.value[samples.value.length - 1] ?? null)
  const downloadSeries = computed<number[]>(() => samples.value.map((s) => s.down))
  const uploadSeries = computed<number[]>(() => samples.value.map((s) => s.up))
  const totalDownload = computed<number>(() => current.value?.downTotal ?? 0)
  const totalUpload = computed<number>(() => current.value?.upTotal ?? 0)

  function push(sample: TrafficSample): void {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    samples.value = samples.value.length < HISTORY ? [...samples.value, sample] : [...samples.value.slice(1), sample]
    if (status.value !== 'live') {
      lastError.value = null
      status.value = 'live'
    }
  }

  function onError(error: MihomoStreamError): void {
    if (error.source !== 'traffic') return
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    lastError.value = error.message
    status.value = error.kind === 'connection' ? 'disconnected' : 'error'
  }

  function connect(): void {
    if (trafficUnsub) return
    trafficUnsub = window.desktop.mihomo.onTraffic(push)
    errorUnsub = window.desktop.mihomo.onStreamError(onError)
    armWatchdog()
  }

  function disconnect(): void {
    trafficUnsub?.()
    errorUnsub?.()
    trafficUnsub = null
    errorUnsub = null
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
  }

  return {
    status,
    lastError,
    samples,
    current,
    downloadSeries,
    uploadSeries,
    totalDownload,
    totalUpload,
    connect,
    disconnect
  }
})
