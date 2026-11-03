import { describe, expect, it } from 'vitest'
import { EntityTrafficTracker, ENTITY_TRAFFIC_MAX_ENTITIES } from '../src/renderer/src/lib/entity-traffic'
import { deviceKeyOf, processKeyOf } from '../src/renderer/src/lib/connection-groups'
import type { MihomoConnection } from '../src/shared/mihomo-api'

function conn(id: string, upload: number, download: number, meta: Partial<MihomoConnection['metadata']> = {}): MihomoConnection {
  return { id, metadata: { process: 'curl', processPath: 'C:\\curl.exe', sourceIP: '10.0.0.2', host: 'a.com', ...meta }, upload, download, start: '', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '' }
}

const MIN = 60_000
const t0 = new Date(2026, 10, 2, 12, 0, 0).getTime()

describe('EntityTrafficTracker', () => {
  it('integrates byte deltas per process and device without double counting', () => {
    const tracker = new EntityTrafficTracker(t0)
    tracker.observe([conn('a', 100, 1000)], t0)
    tracker.observe([conn('a', 150, 3000), conn('b', 10, 20, { host: 'b.com' })], t0 + 1000)
    const key = processKeyOf(conn('x', 0, 0))
    const stats = tracker.stats('process', key, t0 + 1000)!
    const start = stats.windows.find((row) => row.key === 'start')!
    expect(start).toMatchObject({ up: 160, down: 3020 })
    expect(stats.totalConnections).toBe(2)
    expect(stats.topHost).toBe('a.com')
    // 50 + 10 up and 2000 + 20 down moved during the 1 s interval.
    expect(stats.rate).toEqual({ up: 60, down: 2020 })
    expect(tracker.stats('device', deviceKeyOf(conn('x', 0, 0)), t0 + 1000)?.totalConnections).toBe(2)
  })

  it('splits traffic into rolling windows and drops closed connections without subtracting', () => {
    const tracker = new EntityTrafficTracker(t0)
    tracker.observe([conn('a', 0, 500)], t0)
    tracker.observe([conn('a', 0, 800)], t0 + 10 * MIN)
    tracker.observe([], t0 + 11 * MIN)
    const stats = tracker.stats('process', processKeyOf(conn('x', 0, 0)), t0 + 11 * MIN)!
    const byKey = Object.fromEntries(stats.windows.map((row) => [row.key, row.down]))
    // The 300 B growth is booked at the snapshot that observed it (t0 + 10 min).
    expect(byKey['5m']).toBe(300)
    expect(byKey['15m']).toBe(800)
    expect(byKey['start']).toBe(800)
    expect(byKey['today']).toBe(800)
    expect(stats.rate).toEqual({ up: 0, down: 0 })
  })

  it('forgets buckets older than 24 hours and bounds the entity count', () => {
    const tracker = new EntityTrafficTracker(t0)
    tracker.observe([conn('a', 0, 100)], t0)
    tracker.observe([conn('a', 0, 100)], t0 + 25 * 60 * MIN)
    const stats = tracker.stats('process', processKeyOf(conn('x', 0, 0)), t0 + 25 * 60 * MIN)!
    expect(stats.windows.find((row) => row.key === '24h')?.down).toBe(0)
    expect(stats.windows.find((row) => row.key === 'start')?.down).toBe(100)

    const many = Array.from({ length: ENTITY_TRAFFIC_MAX_ENTITIES + 10 }, (_, index) => conn(`c${index}`, 1, 1, { process: `p${index}`, processPath: '' }))
    tracker.observe(many, t0 + 26 * 60 * MIN)
    expect(tracker.totals('process').size).toBe(ENTITY_TRAFFIC_MAX_ENTITIES)
  })

  it('tracks the concrete node (first chain hop) with its peak rate', () => {
    const tracker = new EntityTrafficTracker(t0)
    const viaNode = (id: string, up: number, down: number): MihomoConnection => ({ ...conn(id, up, down), chains: ['Snell 家宽', 'Proxy'] })
    tracker.observe([viaNode('a', 0, 0)], t0)
    tracker.observe([viaNode('a', 500, 4000)], t0 + 1000)
    tracker.observe([viaNode('a', 600, 4100)], t0 + 2000)
    const stats = tracker.stats('node', 'Snell 家宽', t0 + 2000)!
    expect(stats.windows.find((row) => row.key === 'start')).toMatchObject({ up: 600, down: 4100 })
    expect(stats.rate).toEqual({ up: 100, down: 100 })
    expect(stats.peak).toEqual({ up: 500, down: 4000 })
    expect(tracker.stats('node', 'Proxy')).toBeNull()
  })
})
