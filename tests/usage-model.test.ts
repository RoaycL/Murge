import { describe, it, expect } from 'vitest'
import {
  usageBucketStart,
  usageHourStart,
  coerceUsageBucket,
  coerceUsageBuckets,
  aggregateUsageWindow,
  rankUsageBuckets,
  usageCapacity,
  USAGE_BUCKET_MS,
  USAGE_MAX_BUCKETS,
  USAGE_WINDOW_CONFIG
} from '../src/shared/usage'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('usage model', () => {
  describe('usageBucketStart / usageHourStart', () => {
    it('aligns a timestamp down to its bucket grid', () => {
      expect(usageBucketStart(HOUR * 5 + 1_000, HOUR)).toBe(HOUR * 5)
      expect(usageBucketStart(0, HOUR)).toBe(0)
    })

    it('hour start aligns to an exact hour boundary', () => {
      expect(usageHourStart(1_234_567)).toBe(Math.floor(1_234_567 / HOUR) * HOUR)
    })
  })

  describe('coerceUsageBucket', () => {
    it('accepts a valid record', () => {
      expect(coerceUsageBucket({ bucketStart: HOUR, up: 10, down: 20, count: 3 })).toEqual({
        bucketStart: HOUR,
        up: 10,
        down: 20,
        count: 3
      })
    })

    it('rejects non-objects and invalid numbers', () => {
      expect(coerceUsageBucket(null)).toBeNull()
      expect(coerceUsageBucket('x')).toBeNull()
      expect(coerceUsageBucket({ bucketStart: -1, up: 0, down: 0 })).toBeNull()
      expect(coerceUsageBucket({ bucketStart: HOUR, up: 'a', down: 0 })).toBeNull()
      expect(coerceUsageBucket({ bucketStart: HOUR, up: 1, down: NaN })).toBeNull()
    })

    it('normalises a missing count to 0', () => {
      expect(coerceUsageBucket({ bucketStart: HOUR, up: 5, down: 7 })?.count).toBe(0)
    })
  })

  describe('coerceUsageBuckets', () => {
    it('returns empty for non-array input', () => {
      expect(coerceUsageBuckets(undefined)).toEqual([])
      expect(coerceUsageBuckets({})).toEqual([])
    })

    it('drops invalid entries and sorts ascending', () => {
      const out = coerceUsageBuckets([
        { bucketStart: HOUR * 2, up: 1, down: 2 },
        null,
        { bucketStart: HOUR, up: 3, down: 4 },
        { bucketStart: 'bad', up: 1, down: 1 }
      ])
      expect(out.map((b) => b.bucketStart)).toEqual([HOUR, HOUR * 2])
    })

    it('trims to the newest maxBuckets entries', () => {
      const input = Array.from({ length: USAGE_MAX_BUCKETS + 5 }, (_, i) => ({
        bucketStart: i * HOUR,
        up: i,
        down: 0,
        count: 1
      }))
      const out = coerceUsageBuckets(input, USAGE_MAX_BUCKETS)
      expect(out).toHaveLength(USAGE_MAX_BUCKETS)
      expect(out[0].bucketStart).toBe((USAGE_MAX_BUCKETS + 5 - USAGE_MAX_BUCKETS) * HOUR)
    })
  })

  describe('aggregateUsageWindow', () => {
    const baseline = 1_000_000_000 // arbitrary epoch around which buckets exist

    it('returns a fixed-length series ending at the current slot', () => {
      const buckets = [{ bucketStart: baseline, up: 8, down: 2, count: 2 }]
      const snap = aggregateUsageWindow(buckets, '24h', baseline + HOUR * 2, USAGE_MAX_BUCKETS)
      expect(snap.bucketMs).toBe(HOUR)
      expect(snap.bucketCount).toBe(USAGE_WINDOW_CONFIG['24h'].spanBuckets)
      expect(snap.buckets).toHaveLength(24)
      expect(snap.buckets[23].bucketStart).toBe(usageBucketStart(baseline + HOUR * 2, HOUR))
      // The lone non-zero bucket lands inside the window (slot = its aligned grid).
      const lone = snap.buckets.find((b) => b.bucketStart === usageBucketStart(baseline, HOUR))
      expect(lone?.up).toBe(8)
      expect(lone?.down).toBe(2)
    })

    it('aggregates matching hourly buckets into a day bucket for 7d', () => {
      const day0 = usageBucketStart(baseline, DAY) + HOUR // mid-day
      const sameDay = usageBucketStart(baseline, DAY) + HOUR * 2
      const nextDay = usageBucketStart(baseline, DAY) + DAY + HOUR
      const snap = aggregateUsageWindow(
        [
          { bucketStart: day0, up: 1, down: 2, count: 1 },
          { bucketStart: sameDay, up: 4, down: 5, count: 2 },
          { bucketStart: nextDay, up: 7, down: 8, count: 1 }
        ],
        '7d',
        usageBucketStart(baseline, DAY) + DAY + HOUR,
        USAGE_MAX_BUCKETS
      )
      expect(snap.bucketMs).toBe(DAY)
      expect(snap.buckets).toHaveLength(7)
      const firstDay = snap.buckets.find((b) => b.bucketStart === usageBucketStart(baseline, DAY))
      expect(firstDay?.up).toBe(5)
      expect(firstDay?.down).toBe(7)
      expect(firstDay?.count).toBe(3)
    })

    it('fills gap slots with zero buckets and computes totals', () => {
      const buckets = [{ bucketStart: baseline, up: 100, down: 0, count: 1 }]
      const snap = aggregateUsageWindow(buckets, '24h', baseline + 10 * HOUR, USAGE_MAX_BUCKETS)
      expect(snap.totals).toEqual({ up: 100, down: 0, total: 100, count: 1 })
      expect(snap.buckets.filter((b) => b.up === 0 && b.down === 0).length).toBe(23)
    })
  })

  describe('rankUsageBuckets', () => {
    it('omits zero entries and ranks descending with 1-based ranks', () => {
      const buckets = [
        { bucketStart: HOUR, up: 5, down: 20, count: 1 },
        { bucketStart: HOUR * 2, up: 0, down: 0, count: 0 },
        { bucketStart: HOUR * 3, up: 50, down: 20, count: 2 }
      ]
      const ranked = rankUsageBuckets(buckets, 'total')
      expect(ranked).toHaveLength(2)
      expect(ranked[0].bucketStart).toBe(HOUR * 3)
      expect(ranked[0].value).toBe(70)
      expect(ranked[0].rank).toBe(1)
      expect(ranked[1].bucketStart).toBe(HOUR)
      expect(ranked[1].rank).toBe(2)
    })

    it('caps by limit and breaks ties by earliest bucket', () => {
      const buckets = [
        { bucketStart: HOUR, up: 10, down: 0, count: 0 },
        { bucketStart: HOUR * 2, up: 10, down: 0, count: 0 },
        { bucketStart: HOUR * 3, up: 5, down: 0, count: 0 }
      ]
      const ranked = rankUsageBuckets(buckets, 'up', 2)
      expect(ranked).toHaveLength(2)
      expect(ranked.map((r) => r.bucketStart)).toEqual([HOUR, HOUR * 2])
    })

    it('scores by count and by up independently', () => {
      const buckets = [
        { bucketStart: HOUR, up: 0, down: 0, count: 9 },
        { bucketStart: HOUR * 2, up: 5, down: 0, count: 1 }
      ]
      expect(rankUsageBuckets(buckets, 'count')[0].bucketStart).toBe(HOUR)
      expect(rankUsageBuckets(buckets, 'up')[0].bucketStart).toBe(HOUR * 2)
    })
  })

  describe('usageCapacity', () => {
    it('reports the hourly bucket size, cap, and retention hours', () => {
      const cap = usageCapacity()
      expect(cap.bucketMs).toBe(USAGE_BUCKET_MS)
      expect(cap.maxBuckets).toBe(USAGE_MAX_BUCKETS)
      expect(cap.retentionHours).toBe(24 * 30)
    })
  })
})
