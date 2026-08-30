import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoLogMessage, MihomoStreamError } from '@shared/mihomo-api'
import { normalizeLogMessage, type DisplayLogEntry, type LogLevel } from '../lib/logs'

export type LogsStatus = 'loading' | 'live' | 'disconnected' | 'error'
export type LogLevelFilter = 'all' | LogLevel
const MAX_ENTRIES = 2000

export const useLogsStore = defineStore('logs', () => {
  const status = ref<LogsStatus>('loading')
  const lastError = ref<string | null>(null)
  const entries = ref<DisplayLogEntry[]>([])
  const search = ref('')
  const level = ref<LogLevelFilter>('all')
  let nextId = 1
  let logsUnsub: (() => void) | null = null
  let errorUnsub: (() => void) | null = null

  const visibleEntries = computed(() => {
    const term = search.value.trim().toLocaleLowerCase()
    return entries.value.filter((entry) => {
      if (level.value !== 'all' && entry.level !== level.value) return false
      return !term || entry.message.toLocaleLowerCase().includes(term)
    })
  })

  function push(message: MihomoLogMessage): void {
    const entry = normalizeLogMessage(message, nextId++)
    entries.value = entries.value.length < MAX_ENTRIES
      ? [...entries.value, entry]
      : [...entries.value.slice(1), entry]
    lastError.value = null
    status.value = 'live'
  }

  function onError(error: MihomoStreamError): void {
    if (error.source !== 'logs') return
    lastError.value = error.message
    status.value = error.kind === 'connection' ? 'disconnected' : 'error'
  }

  function connect(): void {
    if (logsUnsub) return
    logsUnsub = window.desktop.mihomo.onLogs(push)
    errorUnsub = window.desktop.mihomo.onStreamError(onError)
  }

  function disconnect(): void {
    logsUnsub?.()
    errorUnsub?.()
    logsUnsub = null
    errorUnsub = null
    status.value = 'loading'
    lastError.value = null
  }

  function clear(): void {
    entries.value = []
  }

  return { status, lastError, entries, search, level, visibleEntries, connect, disconnect, clear }
})

