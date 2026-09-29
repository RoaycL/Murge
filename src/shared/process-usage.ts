import type { UsageWindow } from './usage'
import { USAGE_BUCKET_MS, USAGE_MAX_BUCKETS, USAGE_WINDOW_CONFIG, usageHourStart } from './usage'

export interface ProcessUsageRow { name: string; up: number; down: number }
export interface ProcessUsageBucket { bucketStart: number; rows: ProcessUsageRow[] }
export interface ProcessUsageSnapshot { window: UsageWindow; observedBytes: number; entries: Array<ProcessUsageRow & { total: number }> }

/** Names are local-only; never persist executable paths, hosts or connection IDs. */
export const PROCESS_USAGE_MAX_NAMES = 64
export const PROCESS_USAGE_OTHER = '其他进程'
export const PROCESS_USAGE_UNKNOWN = '未知进程'

export function processUsageName(value: string | undefined): string {
  const name = (value?.trim() ?? '').split(/[\\/]/).pop() ?? ''
  return name && name.length <= 128 && !/[\x00-\x1f]/.test(name) ? name : PROCESS_USAGE_UNKNOWN
}

export function coerceProcessUsageBuckets(input: unknown, maxBuckets = USAGE_MAX_BUCKETS): ProcessUsageBucket[] {
  if (!Array.isArray(input)) return []
  const unique = new Map<number, ProcessUsageBucket>()
  for (const item of input.slice(-maxBuckets)) {
    if (!item || typeof item !== 'object') continue
    const bucket = item as Partial<ProcessUsageBucket>
    if (!Number.isSafeInteger(bucket.bucketStart) || (bucket.bucketStart ?? -1) < 0 || !Array.isArray(bucket.rows)) continue
    const rows: ProcessUsageRow[] = []
    for (const row of bucket.rows.slice(0, PROCESS_USAGE_MAX_NAMES)) {
      if (!row || typeof row.name !== 'string' || processUsageName(row.name) !== row.name ||
        typeof row.up !== 'number' || typeof row.down !== 'number' || !Number.isFinite(row.up) || !Number.isFinite(row.down) || row.up < 0 || row.down < 0) continue
      rows.push({ name: row.name, up: Math.round(row.up), down: Math.round(row.down) })
    }
    unique.set(bucket.bucketStart!, { bucketStart: bucket.bucketStart!, rows })
  }
  return [...unique.values()].sort((a, b) => a.bucketStart - b.bucketStart).slice(-maxBuckets)
}

export function processUsageWindow(buckets: readonly ProcessUsageBucket[], window: UsageWindow, now: number): ProcessUsageSnapshot {
  const config = USAGE_WINDOW_CONFIG[window]
  const hours = config.bucketMs * config.spanBuckets / USAGE_BUCKET_MS
  const start = usageHourStart(now) - (hours - 1) * USAGE_BUCKET_MS
  const totals = new Map<string, ProcessUsageRow>()
  for (const bucket of buckets) {
    if (bucket.bucketStart < start || bucket.bucketStart > now) continue
    for (const row of bucket.rows) {
      const total = totals.get(row.name) ?? { name: row.name, up: 0, down: 0 }
      total.up += row.up; total.down += row.down
      totals.set(row.name, total)
    }
  }
  const entries = [...totals.values()].map((row) => ({ ...row, total: row.up + row.down }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { window, observedBytes: entries.reduce((sum, row) => sum + row.total, 0), entries }
}
