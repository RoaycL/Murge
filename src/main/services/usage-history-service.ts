import type { UsageBucket, UsageHistorySnapshot, UsageRankingEntry, UsageWindow, UsageRanking, UsageCapacity } from '../../shared/usage'
import {
  aggregateUsageWindow,
  coerceUsageBuckets,
  rankUsageBuckets,
  usageCapacity,
  usageHourStart,
  USAGE_MAX_BUCKETS
} from '../../shared/usage'
import type { UsageHistoryGateway } from '../../shared/gateways'
import { InMemoryUsageHistoryStore, type UsageHistoryStore } from './usage-history-store'

/** A minimal traffic sample the service can integrate (rate in bytes/second). */
export interface UsageSample {
  up: number
  down: number
}

export interface UsageHistoryServiceOptions {
  /** Cap on stored hourly buckets (default {@link USAGE_MAX_BUCKETS}). */
  maxBuckets?: number
  /** Backing store; defaults to an in-memory database. */
  store?: UsageHistoryStore
  /** Injectable clock for window alignment (defaults to `Date.now`). */
  now?: () => number
  /** Only persist at most this often unless a boundary or flush forces it. */
  persistIntervalMs?: number
  /** Optional live traffic source the service records from. */
  onTraffic?: (listener: (sample: UsageSample) => void) => () => void
}

/**
 * Main-process bounded usage-history controller.
 *
 * It subscribes to the mihomo `/traffic` stream, integrates the per-sample rate
 * over the interval since the previous sample, and accumulates into hourly byte
 * buckets. The bucket list is capped at `maxBuckets` (newest retained), so
 * memory and the on-disk database stay flat for the whole session. Only
 * aggregate byte totals and sample counts are ever stored — credentials, hosts
 * and raw profiles are never recorded.
 */
export class UsageHistoryService implements UsageHistoryGateway {
  private readonly maxBuckets: number
  private readonly store: UsageHistoryStore
  private readonly now: () => number
  private readonly persistIntervalMs: number

  private buckets: UsageBucket[] = []
  private currentBucketStart: number | null = null
  private lastAt: number | null = null
  private lastPersistAt = 0
  private trafficUnsub: (() => void) | null = null
  private loaded = false

  constructor(options: UsageHistoryServiceOptions = {}) {
    this.maxBuckets = options.maxBuckets ?? USAGE_MAX_BUCKETS
    this.store = options.store ?? new InMemoryUsageHistoryStore()
    this.now = options.now ?? (() => Date.now())
    this.persistIntervalMs = options.persistIntervalMs ?? 10_000
    if (options.onTraffic) this.attachTraffic(options.onTraffic)
  }

  /** Load any persisted buckets; safe to call more than once. */
  async init(): Promise<void> {
    this.buckets = coerceUsageBuckets(await this.store.read(), this.maxBuckets)
    this.currentBucketStart = this.buckets.length ? this.buckets[this.buckets.length - 1].bucketStart : null
    this.loaded = true
  }

  /** Subscribe to a live traffic source; returns the unsubscribe function. */
  attachTraffic(onTraffic: (listener: (sample: UsageSample) => void) => () => void): () => void {
    const unsub = onTraffic((sample) => {
      void this.record(sample)
    })
    this.trafficUnsub = unsub
    return () => {
      unsub()
      this.trafficUnsub = null
    }
  }

  /**
   * Record one traffic sample at the given time (defaults to `sample.timestamp`
   * or the injected clock). Bytes are integrated from the rate over the interval
   * since the previous sample, so the database reflects transferred bytes and
   * not instantaneous throughput.
   */
  async record(sample: UsageSample, at?: number): Promise<void> {
    if (!this.loaded) await this.init()
    const time = typeof at === 'number' ? at : (sample as { timestamp?: number }).timestamp ?? this.now()
    const intervalMs = this.lastAt === null ? 0 : Math.max(0, time - this.lastAt)
    const factor = intervalMs / 1000
    const upBytes = sample.up * factor
    const downBytes = sample.down * factor

    const bucketStart = usageHourStart(time)
    if (this.currentBucketStart === null || bucketStart !== this.currentBucketStart) {
      this.buckets.push({ bucketStart, up: 0, down: 0, count: 0 })
      this.currentBucketStart = bucketStart
      // A boundary advance is a low-volume natural flush point.
      this.lastPersistAt = 0
    }

    const current = this.buckets[this.buckets.length - 1]
    current.up += upBytes
    current.down += downBytes
    current.count += 1
    this.lastAt = time

    this.trimToBound()
    await this.maybePersist(time)
  }

  /** Aggregate the bounded database into a window slice (read-back). */
  getWindow(window: UsageWindow): UsageHistorySnapshot {
    return aggregateUsageWindow(this.buckets, window, this.now(), this.maxBuckets)
  }

  /** Rank a window's buckets by the chosen metric into a 1-based ordered list. */
  rank(window: UsageWindow, ranking: UsageRanking, limit?: number): UsageRankingEntry[] {
    const snapshot = this.getWindow(window)
    return rankUsageBuckets(snapshot.buckets, ranking, limit)
  }

  /** Drop the whole bounded database and persist the empty list. */
  async clear(): Promise<void> {
    this.buckets = []
    this.currentBucketStart = null
    this.lastAt = null
    await this.store.write([])
    this.lastPersistAt = this.now()
  }

  /** Static capacity facts surfaced to the renderer. */
  getCapacity(): UsageCapacity {
    return usageCapacity(this.maxBuckets)
  }

  /** Persist the current bounded database immediately (e.g. on quit). */
  async flush(): Promise<void> {
    if (!this.loaded) await this.init()
    await this.store.write(this.buckets.map((bucket) => ({ ...bucket })))
    this.lastPersistAt = this.now()
  }

  /** Detach from the traffic source and persist pending buckets. */
  async dispose(): Promise<void> {
    this.trafficUnsub?.()
    this.trafficUnsub = null
    await this.flush()
  }

  private trimToBound(): void {
    while (this.buckets.length > this.maxBuckets) this.buckets.shift()
  }

  private async maybePersist(time: number): Promise<void> {
    // `0` disables throttling: persist every record. Any positive value gates
    // writes so the bounded database is not rewritten on every traffic tick.
    if (this.persistIntervalMs <= 0) {
      await this.store.write(this.buckets.map((bucket) => ({ ...bucket })))
      this.lastPersistAt = time
      return
    }
    if (time - this.lastPersistAt < this.persistIntervalMs) return
    await this.store.write(this.buckets.map((bucket) => ({ ...bucket })))
    this.lastPersistAt = time
  }
}
