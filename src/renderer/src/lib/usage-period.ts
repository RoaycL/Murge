import type { UsageBucket } from '@shared/usage'

/**
 * 流量用量 card (Surge 6 style): today / this month / last month, grouped in
 * the user's own time zone from the shell's raw hourly buckets.
 */
export type UsagePeriod = 'today' | 'month' | 'lastMonth'

export interface UsageSlot {
  /** Slot start (epoch ms, local hour or local day). */
  start: number
  bytes: number
  /** The slot has not started yet (drawn as a faint dot, like Surge). */
  future: boolean
}

export interface UsagePeriodSummary {
  period: UsagePeriod
  up: number
  down: number
  total: number
  proxy: number
  direct: number
  /** Some bucket in range carries the proxy/DIRECT split (older buckets do not). */
  splitKnown: boolean
  slotKind: 'hour' | 'day'
  slots: UsageSlot[]
}

const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate())

/** Slot starts plus the exclusive end of the period. */
export function usagePeriodSlots(period: UsagePeriod, now: Date): { kind: 'hour' | 'day'; starts: number[]; end: number } {
  if (period === 'today') {
    const day = startOfDay(now)
    const starts = Array.from({ length: 24 }, (_, hour) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime())
    return { kind: 'hour', starts, end: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() }
  }
  const monthOffset = period === 'month' ? 0 : -1
  const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const starts = Array.from({ length: days }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1).getTime())
  return { kind: 'day', starts, end: new Date(first.getFullYear(), first.getMonth() + 1, 1).getTime() }
}

const HOUR = 3_600_000

/**
 * The earliest bucket any period needs: the one covering the first day of last month.
 * Stored buckets are UTC hours, so in a fractional-offset zone (UTC+5:30) the bucket that
 * started up to an hour before local midnight still overlaps it.
 */
export function usageHistorySince(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() - HOUR + 1
}

export function summarizeUsagePeriod(buckets: readonly UsageBucket[], period: UsagePeriod, now: Date): UsagePeriodSummary {
  const { kind, starts, end } = usagePeriodSlots(period, now)
  const slots: UsageSlot[] = starts.map((start) => ({ start, bytes: 0, future: start > now.getTime() }))
  const summary: UsagePeriodSummary = { period, up: 0, down: 0, total: 0, proxy: 0, direct: 0, splitKnown: false, slotKind: kind, slots }
  const first = starts[0]
  const bounds = [...starts, end]
  for (const bucket of buckets) {
    const from = bucket.bucketStart
    const to = from + HOUR
    if (to <= first || from >= end) continue
    // A UTC-hour bucket can straddle a local slot boundary (UTC+5:30, UTC+9:45…):
    // share its bytes by overlap, as traffic inside one hour is not stored any finer.
    let inside = 0
    for (let index = 0; index < slots.length; index += 1) {
      const overlap = Math.min(to, bounds[index + 1]) - Math.max(from, bounds[index])
      if (overlap <= 0) continue
      const share = overlap / HOUR
      slots[index].bytes += (bucket.up + bucket.down) * share
      inside += share
    }
    summary.up += bucket.up * inside
    summary.down += bucket.down * inside
    if (bucket.proxy != null || bucket.direct != null) {
      summary.splitKnown = true
      summary.proxy += (bucket.proxy ?? 0) * inside
      summary.direct += (bucket.direct ?? 0) * inside
    }
  }
  summary.total = summary.up + summary.down
  return summary
}
