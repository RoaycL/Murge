import type { MihomoConnection } from '@shared/mihomo-api'

/**
 * Since-start traffic totals for the Activity page.
 *
 * mihomo's /connections snapshot only lists connections that are still open,
 * so summing it loses every byte of a connection the moment it closes. This
 * tracker remembers the last upload/download seen per connection id and adds
 * only the growth on each snapshot, so closed connections keep counting.
 * Bytes a connection moves between its last snapshot and closing are not
 * observable here (at most one tick's worth).
 */

export type TrafficDimension = 'process' | 'host' | 'policy'

export interface CumulativeBucket {
  /** Upload + download across every connection. */
  all: number
  /** Upload + download across proxied (non-DIRECT) connections only. */
  proxy: number
  /** Whether any proxied connection has been seen for this row. */
  proxied: boolean
  iconPath?: string
}

export interface CumulativeKeys {
  process: (connection: MihomoConnection) => string
  host: (connection: MihomoConnection) => string
  policy: (connection: MihomoConnection) => string
  iconPath: (connection: MihomoConnection) => string | undefined
  isProxy: (connection: MihomoConnection) => boolean
}

/** Keeps long sessions bounded: the smallest rows are dropped first. */
const MAX_KEYS_PER_DIMENSION = 2000

function bytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export class CumulativeTraffic {
  private readonly seen = new Map<string, { up: number; down: number }>()
  private readonly buckets: Record<TrafficDimension, Map<string, CumulativeBucket>> = {
    process: new Map(),
    host: new Map(),
    policy: new Map()
  }
  direct = 0
  proxy = 0

  constructor(private readonly keys: CumulativeKeys) {}

  observe(connections: MihomoConnection[]): void {
    const active = new Set<string>()
    for (const connection of connections) {
      active.add(connection.id)
      const up = bytes(connection.upload)
      const down = bytes(connection.download)
      const previous = this.seen.get(connection.id)
      this.seen.set(connection.id, { up, down })
      // A counter that went backwards means a reused id; count it from zero.
      const delta = previous
        ? (up >= previous.up ? up - previous.up : up) + (down >= previous.down ? down - previous.down : down)
        : up + down
      // A brand-new idle connection still lists its process/host (at 0 B).
      if (delta <= 0 && previous) continue
      const proxied = this.keys.isProxy(connection)
      if (proxied) this.proxy += delta
      else this.direct += delta
      this.add('process', this.keys.process(connection), delta, proxied, this.keys.iconPath(connection))
      this.add('host', this.keys.host(connection), delta, proxied)
      this.add('policy', this.keys.policy(connection), delta, proxied)
    }
    for (const id of this.seen.keys()) if (!active.has(id)) this.seen.delete(id)
  }

  rows(dimension: TrafficDimension): ReadonlyMap<string, CumulativeBucket> {
    return this.buckets[dimension]
  }

  private add(dimension: TrafficDimension, key: string, delta: number, proxied: boolean, iconPath?: string): void {
    if (!key) return
    const map = this.buckets[dimension]
    const current = map.get(key)
    if (current) {
      current.all += delta
      if (proxied) {
        current.proxy += delta
        current.proxied = true
      }
      if (!current.iconPath && iconPath) current.iconPath = iconPath
      return
    }
    map.set(key, { all: delta, proxy: proxied ? delta : 0, proxied, ...(iconPath ? { iconPath } : {}) })
    if (map.size > MAX_KEYS_PER_DIMENSION) {
      const smallest = [...map.entries()].sort((a, b) => a[1].all - b[1].all).slice(0, map.size - MAX_KEYS_PER_DIMENSION * 0.9)
      for (const [name] of smallest) map.delete(name)
    }
  }
}
