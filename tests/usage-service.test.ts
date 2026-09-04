import { describe, it, expect } from 'vitest'
import { UsageHistoryService } from '../src/main/services/usage-history-service'
import { InMemoryUsageHistoryStore } from '../src/main/services/usage-history-store'

const HOUR = 3_600_000
// An arbitrary baseline that is NOT hour-aligned, so the alignment is exercised.
const FIXED = 1_000_000_000

// A timer that never triggers so persistence only happens on an explicit flush.
const NO_PERSIST = Number.MAX_SAFE_INTEGER

describe('UsageHistoryService', () => {
  describe('record / getWindow', () => {
    it('integrates the rate over the interval since the previous sample', async () => {
      const service = new UsageHistoryService({ now: () => FIXED + 5_000, persistIntervalMs: NO_PERSIST })
      await service.record({ up: 100, down: 50 }, FIXED)
      await service.record({ up: 200, down: 100 }, FIXED + 5_000)
      const snap = service.getWindow('24h')
      expect(snap.totals).toEqual({ up: 1000, down: 500, total: 1500, count: 2 })
    })

    it('rolls over into a new hourly bucket at the hour boundary', async () => {
      const hourStart = FIXED - (FIXED % HOUR)
      const service = new UsageHistoryService({ now: () => hourStart + HOUR + 1_000, persistIntervalMs: NO_PERSIST })
      await service.record({ up: 100, down: 0 }, hourStart)
      await service.record({ up: 100, down: 0 }, hourStart + HOUR + 1_000)
      const snap = service.getWindow('24h')
      // First sample is a boundary (0 bytes), second integrates 3601s at 100B/s.
      expect(snap.totals.up).toBe(100 * 3_601)
      expect(snap.totals.count).toBe(2)
    })

    it('gives the expected empty totals for a window with no data', async () => {
      const service = new UsageHistoryService({ now: () => FIXED, persistIntervalMs: NO_PERSIST })
      const snap = service.getWindow('7d')
      expect(snap.buckets).toHaveLength(7)
      expect(snap.totals).toEqual({ up: 0, down: 0, total: 0, count: 0 })
    })

    it('does not mint bytes after a wall-clock rollback', async () => {
      // A non-monotonic clock: the second sample arrives BEFORE the first. The
      // regression mints a huge fake interval on the following (forward) sample
      // because lastAt was set backward. The back-dated sample must contribute
      // zero bytes and leave the cursor so the next sample integrates correctly.
      const service = new UsageHistoryService({ now: () => FIXED, persistIntervalMs: NO_PERSIST })
      await service.record({ up: 100, down: 50 }, FIXED + 10_000)
      await service.record({ up: 100, down: 50 }, FIXED)          // clock jumped back
      await service.record({ up: 100, down: 50 }, FIXED + 20_000) // forward again
      const snap = service.getWindow('24h')
      // Only the real 10s gap (first -> third) may integrate; the rollback is 0.
      expect(snap.totals.up).toBe(100 * 10)
      expect(snap.totals.down).toBe(50 * 10)
    })
  })

  describe('bounds', () => {
    it('retains only the newest maxBuckets entries (trimmed on overflow)', async () => {
      const store = new InMemoryUsageHistoryStore()
      const maxBuckets = 10
      const service = new UsageHistoryService({
        now: () => FIXED,
        store,
        maxBuckets,
        persistIntervalMs: NO_PERSIST
      })
      const hourStart = FIXED - (FIXED % HOUR)
      for (let i = 0; i < maxBuckets + 2; i += 1) {
        await service.record({ up: 1, down: 0 }, hourStart + i * HOUR)
      }
      await service.flush()
      const stored = await store.read()
      expect(stored).toHaveLength(maxBuckets)
      // The two oldest hourly buckets were dropped.
      expect(stored[0].bucketStart).toBe(hourStart + 2 * HOUR)
    })
  })

  describe('persistence round-trip', () => {
    it('reads back the same bounded aggregate from a fresh service', async () => {
      const store = new InMemoryUsageHistoryStore()
      const serviceA = new UsageHistoryService({ now: () => FIXED + 10_000, store, persistIntervalMs: NO_PERSIST })
      await serviceA.record({ up: 300, down: 100 }, FIXED)
      await serviceA.record({ up: 300, down: 100 }, FIXED + 10_000)
      await serviceA.flush()

      const serviceB = new UsageHistoryService({ now: () => FIXED + 10_000, store, persistIntervalMs: NO_PERSIST })
      await serviceB.init()
      const snap = serviceB.getWindow('24h')
      expect(snap.totals.up).toBe(300 * 10)
      expect(snap.totals.down).toBe(100 * 10)
      expect(snap.totals.count).toBe(2)
    })
  })

  describe('rank and clear', () => {
    it('ranks windows buckets for the chosen metric', async () => {
      const hourStart = FIXED - (FIXED % HOUR)
      const service = new UsageHistoryService({ now: () => hourStart + HOUR + 1, persistIntervalMs: NO_PERSIST })
      await service.record({ up: 10, down: 20 }, hourStart)
      await service.record({ up: 10, down: 20 }, hourStart + HOUR + 1)
      const total = service.rank('24h', 'total')
      const down = service.rank('24h', 'down')
      expect(total[0].value).toBeGreaterThan(0)
      expect(total[0].rank).toBe(1)
      expect(down[0].value).toBeGreaterThan(0)
    })

    it('clears the database', async () => {
      const store = new InMemoryUsageHistoryStore()
      const service = new UsageHistoryService({ now: () => FIXED, store, persistIntervalMs: NO_PERSIST })
      await service.record({ up: 5, down: 5 }, FIXED)
      await service.clear()
      expect(await store.read()).toEqual([])
      expect(service.getWindow('24h').totals.total).toBe(0)
    })

    it('reports capacity facts from the injected cap', async () => {
      const service = new UsageHistoryService({ now: () => FIXED, maxBuckets: 24, persistIntervalMs: NO_PERSIST })
      expect(service.getCapacity()).toMatchObject({ bucketMs: HOUR, maxBuckets: 24, retentionHours: 24 })
    })
  })
})
