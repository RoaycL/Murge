import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoLogMessage, MihomoStreamError } from '@shared/mihomo-api'
import { normalizeLogMessage, type DisplayLogEntry, type LogLevel } from '../lib/logs'

export type LogsStatus = 'loading' | 'live' | 'disconnected' | 'error'
export type LogLevelFilter = 'all' | LogLevel
const MAX_ENTRIES = 2000
/** Live lines are merged on this cadence; mihomo can burst hundreds per second. */
const FLUSH_INTERVAL_MS = 32

/**
 * Kernel log capture (design follows sparkle / clash-party / clash-verge-rev):
 * capture NEVER depends on the logs view being mounted. The main process
 * retains a bounded history and broadcasts every line to all windows; the
 * subscription here lives at MODULE scope and is started when the store is
 * first instantiated, so navigating away from the logs view stops nothing.
 * History that predates the store (early startup, before any view existed) is
 * recovered by merging the main-process snapshot, deduplicated on the
 * main-process sequence number.
 */
let logsUnsub: (() => void) | null = null
let errorUnsub: (() => void) | null = null
/** Last main-process sequence number already reflected in a store's entries. */
let lastSeq = 0
/** Live lines waiting for the flush timer or for the initial sync to settle. */
let pending: MihomoLogMessage[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let syncPromise: Promise<void> | null = null
/** Bound to the newest store instance; rebound when Pinia re-creates it. */
let appendSink: ((messages: readonly MihomoLogMessage[]) => void) | null = null
let errorSink: ((error: MihomoStreamError) => void) | null = null

function flushPending(): void {
  if (pending.length === 0 || !appendSink) return
  const batch = pending
  pending = []
  appendSink(batch)
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending()
  }, FLUSH_INTERVAL_MS)
}

async function initialSync(): Promise<void> {
  if (syncPromise) return syncPromise
  const attempt = (async () => {
    try {
      const snapshot = await window.desktop.mihomo.logsSnapshot(lastSeq)
      // Snapshot lines first, then the live lines held during the fetch, so the
      // merged order is ascending by seq; append deduplicates any overlap.
      const merged = [...snapshot.entries, ...pending.splice(0)]
      if (appendSink) appendSink(merged)
      if (snapshot.lastSeq > lastSeq) lastSeq = snapshot.lastSeq
    } catch {
      // Best-effort: the live stream is already connected and keeps the view
      // updating even when the history channel is unavailable.
    } finally {
      flushPending()
    }
  })()
  syncPromise = attempt.finally(() => {
    if (syncPromise === attempt) syncPromise = null
  })
  return attempt
}

function ensurePipelineStarted(): void {
  if (logsUnsub) return
  logsUnsub = window.desktop.mihomo.onLogs((message) => {
    if (syncPromise) {
      // Hold live lines while the snapshot fetch is in flight so they cannot
      // overtake older retained entries; they flush right after the merge.
      pending.push(message)
      return
    }
    if (typeof message.seq === 'number' && message.seq <= lastSeq) return
    pending.push(message)
    if (pending.length > MAX_ENTRIES) pending.splice(0, pending.length - MAX_ENTRIES)
    scheduleFlush()
  })
  errorUnsub = window.desktop.mihomo.onStreamError((error) => {
    errorSink?.(error)
  })
  void initialSync()
}

export const useLogsStore = defineStore('logs', () => {
  const status = ref<LogsStatus>('loading')
  const lastError = ref<string | null>(null)
  const entries = ref<DisplayLogEntry[]>([])
  const search = ref('')
  const level = ref<LogLevelFilter>('all')
  let nextId = 1

  function append(messages: readonly MihomoLogMessage[]): void {
    if (messages.length === 0) return
    const next: DisplayLogEntry[] = []
    for (const message of messages) {
      if (typeof message.seq === 'number') {
        if (message.seq <= lastSeq) continue
        lastSeq = message.seq
      }
      next.push(normalizeLogMessage(message, nextId++))
    }
    if (next.length === 0) return
    entries.value = entries.value.length + next.length <= MAX_ENTRIES
      ? [...entries.value, ...next]
      : [...entries.value, ...next].slice(-MAX_ENTRIES)
    lastError.value = null
    status.value = 'live'
  }

  function onError(error: MihomoStreamError): void {
    if (error.source !== 'logs') return
    lastError.value = error.message
    status.value = error.kind === 'connection' ? 'disconnected' : 'error'
  }

  // Bind this store instance to the shared pipeline and start it (idempotent).
  appendSink = append
  errorSink = onError
  ensurePipelineStarted()

  const visibleEntries = computed(() => {
    const term = search.value.trim().toLocaleLowerCase()
    return entries.value.filter((entry) => {
      if (level.value !== 'all' && entry.level !== level.value) return false
      return !term || entry.message.toLocaleLowerCase().includes(term)
    })
  })

  /** Idempotent; the view calls it on mount, but capture runs app-long anyway. */
  function connect(): void {
    ensurePipelineStarted()
    void initialSync()
  }

  function clear(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pending = []
    entries.value = []
    // Also drop the retained history in the main process, matching sparkle.
    void window.desktop.mihomo.clearLogs().catch(() => undefined)
  }

  return { status, lastError, entries, search, level, visibleEntries, connect, clear }
})
