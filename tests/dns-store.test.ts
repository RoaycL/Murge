import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDnsStore } from '../src/renderer/src/stores/dns'

const dnsQuery = vi.fn()
const flushDnsCache = vi.fn()
const flushFakeIpCache = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { desktop: { mihomo: { dnsQuery, flushDnsCache, flushFakeIpCache } } }
})
afterEach(() => { ;(globalThis as unknown as { window?: unknown }).window = undefined })

describe('DNS store', () => {
  it('publishes only a validated controller result after the request resolves', async () => {
    dnsQuery.mockResolvedValue({ Status: 0, Question: [], TC: false, RD: true, RA: true, AD: false, CD: false, Answer: [] })
    const store = useDnsStore(); store.name = 'example.com'; store.type = 'AAAA'
    await store.query()
    expect(dnsQuery).toHaveBeenCalledWith('example.com', 'AAAA')
    expect(store.result?.Status).toBe(0); expect(store.error).toBeNull(); expect(store.busy).toBe(false)
  })

  it('does not report a cache flush as successful when the controller rejects it', async () => {
    flushDnsCache.mockRejectedValue(new Error('controller unavailable'))
    const store = useDnsStore(); await store.flush('dns')
    expect(store.message).toBeNull(); expect(store.error).toBe('controller unavailable')
  })

  it('routes Fake-IP flush to its dedicated endpoint', async () => {
    flushFakeIpCache.mockResolvedValue(undefined)
    const store = useDnsStore(); await store.flush('fakeip')
    expect(flushFakeIpCache).toHaveBeenCalledOnce(); expect(store.message).toBe('Fake-IP 缓存已清除')
  })
})
