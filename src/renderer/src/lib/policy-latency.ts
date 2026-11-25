import type { MihomoProxy } from '@shared/mihomo-api'

/**
 * 策略延迟 card (Surge 6 style): the latest measured delay of every concrete
 * node, best first. Groups and built-in outbounds are left out; a node that
 * was never tested (or timed out, delay 0) has no bar.
 */
export interface NodeLatency {
  name: string
  delay: number
}

const BUILT_IN = new Set(['direct', 'reject', 'rejectdrop', 'pass', 'compatible', 'dns'])

export function latestDelay(proxy: MihomoProxy): number | null {
  const history = proxy.history
  const last = history && history.length ? history[history.length - 1] : null
  return last && Number.isFinite(last.delay) && last.delay > 0 ? last.delay : null
}

export function collectNodeLatencies(...sources: ReadonlyArray<Record<string, MihomoProxy> | undefined>): NodeLatency[] {
  const out = new Map<string, number>()
  for (const source of sources) {
    for (const proxy of Object.values(source ?? {})) {
      if (!proxy || typeof proxy.name !== 'string' || out.has(proxy.name)) continue
      if (Array.isArray(proxy.all) || BUILT_IN.has(String(proxy.type).toLowerCase())) continue
      const delay = latestDelay(proxy)
      if (delay != null) out.set(proxy.name, delay)
    }
  }
  return [...out].map(([name, delay]) => ({ name, delay }))
}

export function sortNodeLatencies(nodes: readonly NodeLatency[], order: 'asc' | 'desc'): NodeLatency[] {
  const sign = order === 'asc' ? 1 : -1
  return [...nodes].sort((a, b) => sign * (a.delay - b.delay) || a.name.localeCompare(b.name))
}

/** A round axis maximum (100 ms steps) covering every shown delay. */
export function latencyAxisMax(nodes: readonly NodeLatency[]): number {
  const max = Math.max(0, ...nodes.map((node) => node.delay))
  return Math.max(100, Math.ceil(max / 100) * 100)
}

/** Surge's colour bands: green fast, orange so-so, red slow. */
export function latencyTone(delay: number): 'good' | 'fair' | 'poor' {
  if (delay < 200) return 'good'
  if (delay < 500) return 'fair'
  return 'poor'
}
