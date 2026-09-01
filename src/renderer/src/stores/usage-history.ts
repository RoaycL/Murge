import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { UsageCapacity, UsageHistorySnapshot, UsageRankingEntry, UsageRanking, UsageWindow } from '@shared/usage'
import { USAGE_WINDOW_CONFIG, USAGE_MAX_BUCKETS } from '@shared/usage'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the bounded usage-history read model.
 *
 * The main process owns the aggregate database (hourly byte buckets, capped,
 * persisted) and serves windowed aggregates plus ranked views over IPC. This
 * store just pulls, caches, and re-renders those reads; it holds no credentials
 * or raw profiles, and it never writes back except for an explicit `clear()`.
 */
export const useUsageHistoryStore = defineStore('usage-history', () => {
  const capacity = ref<UsageCapacity>({
    bucketMs: 3_600_000,
    maxBuckets: USAGE_MAX_BUCKETS,
    retentionHours: 24 * 30
  })
  const usageWindow = ref<UsageWindow>('24h')
  const usageRanking = ref<UsageRanking>('total')
  const snapshot = ref<UsageHistorySnapshot | null>(null)
  const ranked = ref<UsageRankingEntry[]>([])
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      capacity.value = await window.desktop.usageHistory.getCapacity()
      // Load the window + ranking reads in parallel; a ranking is derived from
      // the same windowed slice the chart renders, so they agree.
      const [snap, list] = await Promise.all([
        window.desktop.usageHistory.getWindow(usageWindow.value),
        window.desktop.usageHistory.rank(usageWindow.value, usageRanking.value)
      ])
      snapshot.value = snap
      ranked.value = list
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function selectWindow(next: UsageWindow): Promise<void> {
    if (next === usageWindow.value) return
    usageWindow.value = next
    await refresh()
  }

  async function selectRanking(next: UsageRanking): Promise<void> {
    if (next === usageRanking.value) return
    usageRanking.value = next
    await refresh()
  }

  async function clear(): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      await window.desktop.usageHistory.clear()
      snapshot.value = null
      ranked.value = []
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  const windowConfig = (value: UsageWindow): { bucketMs: number; spanBuckets: number } => USAGE_WINDOW_CONFIG[value]

  return {
    capacity,
    window: usageWindow,
    ranking: usageRanking,
    snapshot,
    ranked,
    busy,
    lastError,
    refresh,
    selectWindow,
    selectRanking,
    clear,
    windowConfig
  }
})
