/**
 * Bounded usage-history model and pure aggregation/ranking helpers.
 *
 * The main process records per-sample traffic rates from the `/traffic` stream,
 * integrates them into hourly byte buckets, and persists only the aggregate
 * buckets (never credentials, hosts or raw profiles). Every read is derived
 * from a single bounded array so memory and the on-disk file stay flat for the
 * whole app lifetime (at most `USAGE_MAX_BUCKETS` hourly buckets = 30 days).
 */

/** Time granularities the UI can bucketed usage by. */
export type UsageWindow = '1h' | '24h' | '7d' | '30d'

/** How a window's buckets are ranked (the four ranking views). */
export type UsageRanking = 'down' | 'up' | 'total' | 'count'

/**
 * One aggregated bucket of transferred bytes.
 *
 * - `bucketStart` is epoch milliseconds aligned to the bucket grid (hour for
 *   `1h`/`24h`, day for `7d`/`30d`).
 * - `up`/`down` are the integrated byte totals in that bucket.
 * - `count` is the number of traffic samples coalesced into the bucket.
 */
export interface UsageBucket {
  bucketStart: number
  up: number
  down: number
  count: number
}

export interface UsageTotals {
  up: number
  down: number
  total: number
  count: number
}

/** A read of a usage window, oldest bucket first. */
export interface UsageHistorySnapshot {
  window: UsageWindow
  /** Granularity of the returned buckets (ms). */
  bucketMs: number
  /** Number of buckets returned for the window (bounded, includes empty slots). */
  bucketCount: number
  /** The cap on stored hourly buckets and the corresponding retention in hours. */
  maxBuckets: number
  retentionHours: number
  totals: UsageTotals
  buckets: UsageBucket[]
}

/** One ranked window bucket. `value` is the ranking metric; `rank` is 1-based. */
export interface UsageRankingEntry {
  bucketStart: number
  up: number
  down: number
  count: number
  value: number
  rank: number
}

/** Static capacity facts surfaced to the renderer. */
export interface UsageCapacity {
  /** Hourly storage granularity in ms. */
  bucketMs: number
  maxBuckets: number
  /** Hours covered by the worst-case bounded database. */
  retentionHours: number
}

/** Hourly bucket granularity used for the persisted database. */
export const USAGE_BUCKET_MS = 3_600_000

/** Default cap: 720 hourly buckets = 30 days of retained usage. */
export const USAGE_MAX_BUCKETS = 24 * 30

/**
 * Per-window bucketing config. `bucketMs` is the grid granularity and
 * `spanBuckets` the number of buckets returned for that window.
 */
export const USAGE_WINDOW_CONFIG: Record<UsageWindow, { bucketMs: number; spanBuckets: number }> = {
  '1h': { bucketMs: USAGE_BUCKET_MS, spanBuckets: 1 },
  '24h': { bucketMs: USAGE_BUCKET_MS, spanBuckets: 24 },
  '7d': { bucketMs: 24 * USAGE_BUCKET_MS, spanBuckets: 7 },
  '30d': { bucketMs: 24 * USAGE_BUCKET_MS, spanBuckets: 30 }
}

/** Align a timestamp down to the start of its bucket for the given grid. */
export function usageBucketStart(time: number, bucketMs: number): number {
  return time - (time % bucketMs)
}

/** Align a timestamp down to the start of its hourly storage bucket. */
export function usageHourStart(time: number): number {
  return usageBucketStart(time, USAGE_BUCKET_MS)
}

/** True when the value is a finite non-negative number. */
function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Coerce one unknown value into a valid {@link UsageBucket}, or null when it
 * cannot be made valid. The persisted on-disk form is coalesced through this so
 * a stale or hand-edited file never crashes the renderer.
 */
export function coerceUsageBucket(input: unknown): UsageBucket | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  if (!isNonNegative(record.bucketStart)) return null
  if (!isNonNegative(record.up)) return null
  if (!isNonNegative(record.down)) return null
  return {
    bucketStart: Math.floor(record.bucketStart),
    up: Math.round(record.up),
    down: Math.round(record.down),
    count: isNonNegative(record.count) ? Math.floor(record.count) : 0
  }
}

/**
 * Coerce an unknown persisted array into a valid bounded, sorted bucket list.
 * Non-coercible entries are dropped and the result is trimmed to the newest
 * `maxBuckets` entries so a runaway file can never grow memory.
 */
export function coerceUsageBuckets(input: unknown, maxBuckets = USAGE_MAX_BUCKETS): UsageBucket[] {
  if (!Array.isArray(input)) return []
  const buckets: UsageBucket[] = []
  for (const entry of input) {
    const bucket = coerceUsageBucket(entry)
    if (bucket) buckets.push(bucket)
  }
  buckets.sort((a, b) => a.bucketStart - b.bucketStart)
  return buckets.length > maxBuckets ? buckets.slice(buckets.length - maxBuckets) : buckets
}

/**
 * Aggregate the stored hourly buckets into a window slice. Returns exactly
 * `spanBuckets` slots ending at the current slot for the window grid, filling
 * gaps with zero buckets so a window always renders a fixed-length series.
 *
 * `maxBuckets` is the storage cap and is used to compute retention; it does not
 * change the window geometry (which is bounded by the window config).
 */
export function aggregateUsageWindow(
  buckets: UsageBucket[],
  window: UsageWindow,
  now: number,
  maxBuckets = USAGE_MAX_BUCKETS
): UsageHistorySnapshot {
  const config = USAGE_WINDOW_CONFIG[window]
  const gridMs = config.bucketMs
  const span = config.spanBuckets
  const alignedNow = usageBucketStart(now, gridMs)
  const windowStart = alignedNow - (span - 1) * gridMs

  const grouped = new Map<number, { up: number; down: number; count: number }>()
  for (const bucket of buckets) {
    const slot = usageBucketStart(bucket.bucketStart, gridMs)
    if (slot < windowStart || slot > alignedNow) continue
    const existing = grouped.get(slot) ?? { up: 0, down: 0, count: 0 }
    existing.up += bucket.up
    existing.down += bucket.down
    existing.count += bucket.count
    grouped.set(slot, existing)
  }

  const out: UsageBucket[] = []
  const totals: UsageTotals = { up: 0, down: 0, total: 0, count: 0 }
  for (let slot = windowStart; slot <= alignedNow; slot += gridMs) {
    const acc = grouped.get(slot) ?? { up: 0, down: 0, count: 0 }
    const bucket: UsageBucket = { bucketStart: slot, up: acc.up, down: acc.down, count: acc.count }
    out.push(bucket)
    totals.up += bucket.up
    totals.down += bucket.down
    totals.count += bucket.count
  }
  totals.total = totals.up + totals.down

  return {
    window,
    bucketMs: gridMs,
    bucketCount: out.length,
    maxBuckets,
    retentionHours: Math.round((maxBuckets * USAGE_BUCKET_MS) / 3_600_000),
    totals,
    buckets: out
  }
}

/** The metric value used to rank one bucket. */
export function usageRankingValue(bucket: UsageBucket, ranking: UsageRanking): number {
  switch (ranking) {
    case 'down':
      return bucket.down
    case 'up':
      return bucket.up
    case 'total':
      return bucket.up + bucket.down
    case 'count':
      return bucket.count
  }
}

/**
 * Rank a window's buckets by the chosen metric into a 1-based ordered list.
 * Zero-value buckets (empty slots) are omitted and the result is capped at
 * `limit` (defaults to all qualifying buckets) so the UI never renders a
 * misleading exhaustive list.
 */
export function rankUsageBuckets(
  buckets: UsageBucket[],
  ranking: UsageRanking,
  limit?: number
): UsageRankingEntry[] {
  const qualifying = buckets
    .map((bucket) => ({ bucket, value: usageRankingValue(bucket, ranking) }))
    .filter((entry) => entry.value > 0)

  qualifying.sort((a, b) => {
    const delta = b.value - a.value
    if (delta !== 0) return delta
    return a.bucket.bucketStart - b.bucket.bucketStart
  })

  const capped = typeof limit === 'number' && limit > 0 ? qualifying.slice(0, limit) : qualifying
  return capped.map((entry, index) => ({
    bucketStart: entry.bucket.bucketStart,
    up: entry.bucket.up,
    down: entry.bucket.down,
    count: entry.bucket.count,
    value: entry.value,
    rank: index + 1
  }))
}

/** Build the capacity facts for a given hourly storage cap. */
export function usageCapacity(maxBuckets = USAGE_MAX_BUCKETS): UsageCapacity {
  return {
    bucketMs: USAGE_BUCKET_MS,
    maxBuckets,
    retentionHours: Math.round((maxBuckets * USAGE_BUCKET_MS) / 3_600_000)
  }
}
