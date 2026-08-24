import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRulesStore } from '../src/renderer/src/stores/rules'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type { MihomoRulesResponse } from '../src/shared/mihomo-api'

const RULES: MihomoRulesResponse = {
  rules: [
    { index: 0, type: 'DOMAIN-SUFFIX', payload: 'google.com', proxy: '香港 01', size: -1, extra: { hitCount: 3 } },
    { index: 1, type: 'GEOIP', payload: 'CN', proxy: 'DIRECT', size: 80, extra: { hitCount: 12 } },
    { index: 2, type: 'MATCH', payload: '', proxy: '节点选择', size: -1, extra: { hitCount: 7 } },
    { index: 3, type: 'DOMAIN-SUFFIX', payload: 'youtube.com', proxy: '香港 01', size: 12, extra: { hitCount: 1 } }
  ]
}

// No rule reports a hit count: the summary must expose `totalHits === null`.
const RULES_NO_HITS: MihomoRulesResponse = {
  rules: [
    { index: 0, type: 'MATCH', payload: '', proxy: '节点选择', size: 5 }
  ]
}

describe('rules store', () => {
  let getRules: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    getRules = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = { desktop: { mihomo: { getRules } } }
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { window?: unknown }).window = undefined
  })

  it('loads rules and computes hits from extra.hitCount (independent of size)', async () => {
    getRules.mockResolvedValue(RULES)
    const store = useRulesStore()
    await store.load()
    expect(store.status).toBe('ready')
    expect(store.summary.total).toBe(4)
    expect(store.summary.totalHits).toBe(3 + 12 + 7 + 1)
    // Rule-set rules (size -1) contribute 0 to the size total.
    expect(store.summary.totalSize).toBe(80 + 12)
    expect(store.summary.totalSize).not.toBe(store.summary.totalHits)
  })

  it('reports totalHits as null when no rule carries a hit count', async () => {
    getRules.mockResolvedValue(RULES_NO_HITS)
    const store = useRulesStore()
    await store.load()
    expect(store.summary.totalHits).toBeNull()
    expect(store.summary.totalSize).toBe(5)
  })

  it('filters rows by a case-insensitive search', async () => {
    getRules.mockResolvedValue(RULES)
    const store = useRulesStore()
    await store.load()
    store.setSearch('GEoIP')
    expect(store.visibleRows).toHaveLength(1)
    expect(store.visibleRows[0].type).toBe('GEOIP')
    store.setSearch('香港 01')
    expect(store.visibleRows).toHaveLength(2)
  })

  it('sorts by the hits column and toggles direction', async () => {
    getRules.mockResolvedValue(RULES)
    const store = useRulesStore()
    await store.load()
    store.sortBy('hits')
    expect(store.sortKey).toBe('hits')
    expect(store.visibleRows[0].extra?.hitCount).toBe(1)
    store.sortBy('hits')
    expect(store.sortDirection).toBe('desc')
    expect(store.visibleRows[0].extra?.hitCount).toBe(12)
  })

  it('sorts alphabetically by payload', async () => {
    getRules.mockResolvedValue(RULES)
    const store = useRulesStore()
    await store.load()
    store.sortBy('payload')
    const payloads = store.visibleRows.map((row) => row.payload)
    expect(payloads).toEqual(['', 'CN', 'google.com', 'youtube.com'])
  })

  it('marks the store as error and clears rows when loading fails', async () => {
    getRules.mockRejectedValue(new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'down'))
    const store = useRulesStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.lastError).toBe('down')
    expect(store.rows).toHaveLength(0)
  })
})
