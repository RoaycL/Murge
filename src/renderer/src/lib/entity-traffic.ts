import type { MihomoConnection } from '@shared/mihomo-api'
import { deviceKeyOf, processKeyOf } from './connection-groups'

/**
 * Per-process / per-device / per-node traffic history derived from the live
 * `/connections` stream.
 *
 * Mihomo only reports cumulative bytes for connections that are still open, so
 * every windowed number here (today, since start, last 5 minutes ... 24 hours)
 * is integrated by the app from snapshot-to-snapshot byte deltas. The history
 * lives in memory for this run only and is bounded: one-minute buckets for the
 * last 24 hours, at most {@link ENTITY_TRAFFIC_MAX_ENTITIES} entities per kind
 * and {@link ENTITY_TRAFFIC_MAX_HOSTS} hosts per entity.
 */

/** `node`: the concrete outbound (first entry of `chains`). */
export type EntityKind = 'process' | 'device' | 'node'

export const ENTITY_TRAFFIC_BUCKET_MS = 60_000
export const ENTITY_TRAFFIC_RETENTION_MS = 24 * 60 * 60_000
export const ENTITY_TRAFFIC_MAX_ENTITIES = 256
export const ENTITY_TRAFFIC_MAX_HOSTS = 64

export interface TrafficPair { up: number; down: number }

export interface EntityTrafficWindow { key: string; label: string; up: number; down: number }

export interface EntityTrafficStats {
  /** Current bandwidth in bytes per second, measured between the last two snapshots. */
  rate: TrafficPair
  /** Highest bandwidth seen since the app started, bytes per second. */
  peak: TrafficPair
  /** Distinct connections observed for this entity since the app started. */
  totalConnections: number
  /** Host with the most transferred bytes since start, or null before any traffic. */
  topHost: string | null
  firstSeen: number
  lastSeen: number
  windows: EntityTrafficWindow[]
}

interface Bucket { start: number; up: number; down: number }

interface EntityRecord {
  buckets: Bucket[]
  total: TrafficPair
  rate: TrafficPair
  peak: TrafficPair
  connections: number
  hosts: Map<string, number>
  firstSeen: number
  lastSeen: number
}

const WINDOW_SPECS: Array<{ key: string; label: string; ms: number | 'today' | 'start' }> = [
  { key: 'today', label: '今日', ms: 'today' },
  { key: 'start', label: '自启动以来', ms: 'start' },
  { key: '5m', label: '最近 5 分钟', ms: 5 * 60_000 },
  { key: '15m', label: '最近 15 分钟', ms: 15 * 60_000 },
  { key: '60m', label: '最近 60 分钟', ms: 60 * 60_000 },
  { key: '6h', label: '最近 6 小时', ms: 6 * 60 * 60_000 },
  { key: '12h', label: '最近 12 小时', ms: 12 * 60 * 60_000 },
  { key: '24h', label: '最近 24 小时', ms: 24 * 60 * 60_000 }
]

function localMidnight(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function hostOf(connection: MihomoConnection): string {
  const meta = connection.metadata
  const sniffed = typeof meta.sniffHost === 'string' ? meta.sniffHost : ''
  return meta.host || sniffed || meta.destinationIP || ''
}

export class EntityTrafficTracker {
  private readonly records: Record<EntityKind, Map<string, EntityRecord>> = { process: new Map(), device: new Map(), node: new Map() }
  private previousBytes = new Map<string, TrafficPair>()
  private seenIds = new Set<string>()
  private lastObservedAt: number | null = null
  readonly startedAt: number

  constructor(now = Date.now()) {
    this.startedAt = now
  }

  /**
   * Fold one snapshot into the history. A connection seen for the first time
   * contributes all of its bytes; afterwards only the growth since the last
   * snapshot counts, so closing a connection never subtracts anything.
   */
  observe(connections: readonly MihomoConnection[], now = Date.now()): void {
    const elapsed = this.lastObservedAt == null ? 0 : Math.max(0, now - this.lastObservedAt)
    const deltas: Record<EntityKind, Map<string, TrafficPair>> = { process: new Map(), device: new Map(), node: new Map() }
    const nextBytes = new Map<string, TrafficPair>()
    const nextSeen = new Set<string>()

    for (const connection of connections) {
      const upload = Number.isFinite(connection.upload) ? Math.max(0, connection.upload) : 0
      const download = Number.isFinite(connection.download) ? Math.max(0, connection.download) : 0
      nextBytes.set(connection.id, { up: upload, down: download })
      nextSeen.add(connection.id)
      const previous = this.previousBytes.get(connection.id)
      const up = previous ? Math.max(0, upload - previous.up) : upload
      const down = previous ? Math.max(0, download - previous.down) : download
      const isNew = !this.seenIds.has(connection.id)
      const host = hostOf(connection)
      const entities: Array<readonly [EntityKind, string]> = [['process', processKeyOf(connection)], ['device', deviceKeyOf(connection)]]
      if (connection.chains[0]) entities.push(['node', connection.chains[0]])
      for (const [kind, key] of entities) {
        const record = this.ensure(kind, key, now)
        record.lastSeen = now
        if (isNew) record.connections += 1
        if (up > 0 || down > 0) {
          this.addBytes(record, now, up, down)
          if (host) this.addHost(record, host, up + down)
          const delta = deltas[kind].get(key) ?? { up: 0, down: 0 }
          delta.up += up
          delta.down += down
          deltas[kind].set(key, delta)
        }
      }
    }

    // Rates: bytes moved since the last snapshot over the elapsed time. The very
    // first snapshot has no interval, so it reports zero instead of a spike.
    for (const kind of ['process', 'device', 'node'] as const) {
      for (const [key, record] of this.records[kind]) {
        const delta = deltas[kind].get(key)
        record.rate = delta && elapsed > 0
          ? { up: (delta.up * 1000) / elapsed, down: (delta.down * 1000) / elapsed }
          : { up: 0, down: 0 }
        record.peak = { up: Math.max(record.peak.up, record.rate.up), down: Math.max(record.peak.down, record.rate.down) }
      }
      this.prune(kind, now)
    }

    this.previousBytes = nextBytes
    // Remember closed IDs only as long as the controller might still report them.
    this.seenIds = nextSeen
    this.lastObservedAt = now
  }

  stats(kind: EntityKind, key: string, now = Date.now()): EntityTrafficStats | null {
    const record = this.records[kind].get(key)
    if (!record) return null
    let topHost: string | null = null
    let topBytes = -1
    for (const [host, bytes] of record.hosts) {
      if (bytes > topBytes) { topHost = host; topBytes = bytes }
    }
    const windows = WINDOW_SPECS.map((spec) => {
      if (spec.ms === 'start') return { key: spec.key, label: spec.label, ...record.total }
      const since = spec.ms === 'today' ? localMidnight(now) : now - spec.ms
      return { key: spec.key, label: spec.label, ...this.sumSince(record, since) }
    })
    return {
      rate: { ...record.rate },
      peak: { ...record.peak },
      totalConnections: record.connections,
      topHost,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      windows
    }
  }

  /** Bytes since start for every tracked entity of a kind (list totals). */
  totals(kind: EntityKind): Map<string, TrafficPair & { rate: TrafficPair }> {
    const out = new Map<string, TrafficPair & { rate: TrafficPair }>()
    for (const [key, record] of this.records[kind]) out.set(key, { ...record.total, rate: { ...record.rate } })
    return out
  }

  private ensure(kind: EntityKind, key: string, now: number): EntityRecord {
    let record = this.records[kind].get(key)
    if (!record) {
      record = { buckets: [], total: { up: 0, down: 0 }, rate: { up: 0, down: 0 }, peak: { up: 0, down: 0 }, connections: 0, hosts: new Map(), firstSeen: now, lastSeen: now }
      this.records[kind].set(key, record)
    }
    return record
  }

  private addBytes(record: EntityRecord, now: number, up: number, down: number): void {
    record.total.up += up
    record.total.down += down
    const start = now - (now % ENTITY_TRAFFIC_BUCKET_MS)
    const last = record.buckets[record.buckets.length - 1]
    if (last && last.start === start) {
      last.up += up
      last.down += down
    } else {
      record.buckets.push({ start, up, down })
    }
  }

  private addHost(record: EntityRecord, host: string, bytes: number): void {
    if (!record.hosts.has(host) && record.hosts.size >= ENTITY_TRAFFIC_MAX_HOSTS) {
      // Drop the smallest host so a long tail of one-off hosts cannot grow memory.
      let smallest: string | null = null
      let smallestBytes = Infinity
      for (const [name, value] of record.hosts) {
        if (value < smallestBytes) { smallest = name; smallestBytes = value }
      }
      if (smallest == null || smallestBytes > bytes) return
      record.hosts.delete(smallest)
    }
    record.hosts.set(host, (record.hosts.get(host) ?? 0) + bytes)
  }

  private sumSince(record: EntityRecord, since: number): TrafficPair {
    const sum = { up: 0, down: 0 }
    const firstBucket = since - (since % ENTITY_TRAFFIC_BUCKET_MS)
    for (let index = record.buckets.length - 1; index >= 0; index -= 1) {
      const bucket = record.buckets[index]!
      if (bucket.start < firstBucket) break
      sum.up += bucket.up
      sum.down += bucket.down
    }
    return sum
  }

  private prune(kind: EntityKind, now: number): void {
    const cutoff = now - ENTITY_TRAFFIC_RETENTION_MS
    const records = this.records[kind]
    for (const record of records.values()) {
      let drop = 0
      while (drop < record.buckets.length && record.buckets[drop]!.start < cutoff) drop += 1
      if (drop) record.buckets.splice(0, drop)
    }
    if (records.size <= ENTITY_TRAFFIC_MAX_ENTITIES) return
    const oldest = [...records.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [key] of oldest.slice(0, records.size - ENTITY_TRAFFIC_MAX_ENTITIES)) records.delete(key)
  }
}
