import { describe, expect, it, vi } from 'vitest'
import { NetworkMetadataService } from '../src/main/services/network-metadata-service'

const NOW = 1_700_000_000_000

/** A tiny mutable clock so tests can advance time deterministically. */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = NOW
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

type FetchRecord = { endpoint: string; port: number; timeoutMs?: number }

/** A fetch stub returning queued bodies and recording every call. */
function stubFetch(values: unknown[]): { fn: (endpoint: string, port: number, timeoutMs?: number) => Promise<unknown>; calls: FetchRecord[] } {
  const calls: FetchRecord[] = []
  let index = 0
  return {
    calls,
    fn: async (endpoint, port, timeoutMs) => {
      calls.push({ endpoint, port, timeoutMs })
      const value = values[index]
      index += 1
      return value
    }
  }
}

function makeService(overrides: {
  now?: () => number
  fetch?: (endpoint: string, port: number, timeoutMs?: number) => Promise<unknown>
  resolveProxyPort?: () => Promise<number | null>
  cacheMaxEntries?: number
  cacheTtlMs?: number
  initialProviderId?: string
} = {}): NetworkMetadataService {
  return new NetworkMetadataService({
    now: overrides.now ?? (() => NOW),
    resolveProxyPort: overrides.resolveProxyPort ?? (async () => 7890),
    fetchJsonViaProxy: overrides.fetch ?? stubFetch([]).fn,
    cacheMaxEntries: overrides.cacheMaxEntries,
    cacheTtlMs: overrides.cacheTtlMs,
    initialProviderId: overrides.initialProviderId
  })
}

/** A valid ipwhois JSON body for the happy path. */
function ipwhoisBody(): unknown {
  return { ip: '203.0.113.5', success: true, country: 'United States', city: 'New York', connection: { asn: 7922 } }
}

/** A valid ip-api.com JSON body (used for the second provider). */
function ipapiBody(): unknown {
  return { status: 'success', query: '198.51.100.9', country: 'Japan', city: 'Tokyo', as: 'AS4134 Test Backbone' }
}

describe('NetworkMetadataService', () => {
  describe('resolve', () => {
    it('resolves metadata into a ready state when the kernel is running', async () => {
      const fetch = stubFetch([ipwhoisBody()])
      const service = makeService({ fetch: fetch.fn })
      const state = await service.resolve()
      expect(state.phase).toBe('ready')
      expect(state.provider).toBe('ipwhois')
      expect(state.metadata).toMatchObject({ ip: '203.0.113.5', country: 'United States', asn: 'AS7922' })
      expect(fetch.calls).toHaveLength(1)
      expect(fetch.calls[0]).toMatchObject({ endpoint: 'http://ipwho.is/', port: 7890 })
    })

    it('serves a fresh cache entry without a second fetch', async () => {
      const fetch = stubFetch([ipwhoisBody()])
      const service = makeService({ fetch: fetch.fn })
      await service.resolve()
      const again = await service.resolve()
      expect(again.phase).toBe('ready')
      expect(fetch.calls).toHaveLength(1)
    })

    it('refetches when the cache is stale (TTL elapsed)', async () => {
      const timer = makeClock()
      const fetch = stubFetch([ipwhoisBody(), ipwhoisBody()])
      const service = makeService({ now: timer.now, fetch: fetch.fn, cacheTtlMs: 1000 })
      await service.resolve()
      timer.advance(1500)
      await service.resolve()
      expect(fetch.calls).toHaveLength(2)
    })

    it('refetches when force is true', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipwhoisBody()])
      const service = makeService({ fetch: fetch.fn })
      await service.resolve()
      await service.resolve(true)
      expect(fetch.calls).toHaveLength(2)
    })

    it('reports a kernel-not-running error when the proxy port is null', async () => {
      const service = makeService({ resolveProxyPort: async () => null })
      const state = await service.resolve()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('内核未运行')
    })

    it('surfaces a parse failure when the fetch returns an unusable body', async () => {
      const service = makeService({ fetch: async () => ({ success: false, message: 'rate limited' }) })
      const state = await service.resolve()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('解析')
    })

    it('surfaces a parse failure when the fetch result is not JSON-like', async () => {
      const service = makeService({ fetch: async () => 'hello' })
      const state = await service.resolve()
      expect(state.phase).toBe('error')
    })

    it('surfaces a parse failure when the fetch rejects', async () => {
      const service = makeService({ fetch: async () => Promise.reject(new Error('boom')) })
      const state = await service.resolve()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('解析')
    })
  })

  describe('provider selection and cache bounds', () => {
    it('selectProvider switches the provider and resets to idle when uncached', () => {
      const service = makeService({ initialProviderId: 'ipwhois' })
      const state = service.selectProvider('ipapi')
      expect(state.provider).toBe('ipapi')
      expect(state.phase).toBe('idle')
    })

    it('selectProvider restores a cached provider to ready without fetching', async () => {
      const fetch = stubFetch([ipwhoisBody()])
      const service = makeService({ fetch: fetch.fn })
      await service.resolve()
      service.selectProvider('ipapi')
      const back = service.selectProvider('ipwhois')
      expect(back.phase).toBe('ready')
      expect(fetch.calls).toHaveLength(1)
    })

    it('does not show a stale cached provider as ready (TTL elapsed)', async () => {
      const clock = makeClock()
      const fetch = stubFetch([ipwhoisBody()])
      const service = makeService({ fetch: fetch.fn, now: clock.now, cacheTtlMs: 1000 })
      await service.resolve()
      clock.advance(2000)
      service.selectProvider('ipapi')
      // Switching back to a provider whose cache is now beyond TTL must NOT
      // present the expired data as "ready" (the old code showed stale data as
      // fresh whenever the phase was 'ready').
      const back = service.selectProvider('ipwhois')
      expect(back.phase).toBe('idle')
      expect(back.metadata).toBeNull()
    })

    it('evicts the oldest entry when the bounded cache overflows', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipapiBody()])
      const service = makeService({ fetch: fetch.fn, cacheMaxEntries: 1 })
      await service.resolve() // caches ipwhois
      service.selectProvider('ipapi')
      await service.resolve() // caches ipapi, evicts ipwhois
      const back = service.selectProvider('ipwhois')
      expect(back.phase).toBe('idle')
      await service.resolve() // must refetch ipwhois
      expect(fetch.calls).toHaveLength(3)
    })

    it('rejects an unknown provider id on selectProvider', () => {
      const service = makeService()
      expect(() => service.selectProvider('nope')).toThrowError(/unknown network metadata provider/)
    })
  })

  describe('state and providers', () => {
    it('starts idle with the default provider', () => {
      const service = makeService()
      expect(service.getState()).toEqual({ phase: 'idle', provider: 'ipwhois', metadata: null, error: null })
    })

    it('lists three privacy-explicit providers', () => {
      const service = makeService()
      expect(service.getProviders().map((provider) => provider.id)).toEqual(['ipwhois', 'ipapi', 'ipinfo'])
    })
  })

  describe('resolveAll (whole-set sweep)', () => {
    it('resolves every provider once and returns them in display order', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipapiBody(), { ip: '203.0.113.7', country: 'Germany', city: 'Berlin', org: 'AS3320' }])
      const service = makeService({ fetch: fetch.fn })
      const snapshot = await service.resolveAll()
      expect(snapshot.results.map((row) => row.providerId)).toEqual(['ipwhois', 'ipapi', 'ipinfo'])
      expect(snapshot.results.map((row) => row.label)).toEqual(['ipwho.is', 'ip-api.com', 'ipinfo.io'])
      expect(snapshot.results.map((row) => row.state.phase)).toEqual(['ready', 'ready', 'ready'])
      expect(snapshot.results[0].state.metadata).toMatchObject({ ip: '203.0.113.5', provider: 'ipwhois' })
      expect(snapshot.results[1].state.metadata).toMatchObject({ ip: '198.51.100.9', provider: 'ipapi' })
      expect(snapshot.results[2].state.metadata).toMatchObject({ ip: '203.0.113.7', provider: 'ipinfo' })
      expect(fetch.calls.map((call) => call.endpoint)).toEqual(['http://ipwho.is/', 'http://ip-api.com/json/', 'http://ipinfo.io/json'])
    })

    it('isolates a per-provider failure without failing the sweep', async () => {
      // ipwhois succeeds; ipapi returns an unusable body; ipinfo throws.
      const fetch = stubFetch([ipwhoisBody(), { success: false }, Promise.reject(new Error('boom'))])
      const service = makeService({ fetch: fetch.fn })
      const snapshot = await service.resolveAll()
      expect(snapshot.results[0].state.phase).toBe('ready')
      expect(snapshot.results[1].state.phase).toBe('error')
      expect(snapshot.results[2].state.phase).toBe('error')
      expect(snapshot.results[1].state.error).toContain('解析')
      // The ready row still carries its data.
      expect(snapshot.results[0].state.metadata).not.toBeNull()
    })

    it('reports a kernel-not-running error on every row without fetching', async () => {
      const fetch = stubFetch([])
      const service = makeService({ fetch: fetch.fn, resolveProxyPort: async () => null })
      const snapshot = await service.resolveAll()
      expect(snapshot.results).toHaveLength(3)
      for (const row of snapshot.results) {
        expect(row.state.phase).toBe('error')
        expect(row.state.error).toContain('内核未运行')
      }
      expect(fetch.calls).toHaveLength(0)
    })

    it('serves every row from cache on a second non-forced sweep', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipapiBody(), { ip: '203.0.113.7' }])
      const service = makeService({ fetch: fetch.fn })
      await service.resolveAll()
      const again = await service.resolveAll()
      expect(again.results.map((row) => row.state.phase)).toEqual(['ready', 'ready', 'ready'])
      expect(fetch.calls).toHaveLength(3)
    })

    it('single-flights concurrent sweeps into one set of fetches', async () => {
      // A deferred fetch lets the test overlap two sweeps deterministically.
      let release: (() => void) | null = null
      const gate = new Promise<void>((resolve) => { release = resolve })
      const fetch = vi.fn(async () => {
        await gate
        return ipwhoisBody()
      })
      const service = makeService({ fetch: fetch as unknown as (endpoint: string, port: number, timeoutMs?: number) => Promise<unknown> })
      const first = service.resolveAll()
      const second = service.resolveAll()
      release?.()
      const [a, b] = await Promise.all([first, second])
      // One sweep fetches once per provider (3); the joined second sweep must
      // not stack a second set of round-trips. ipapi's parser requires a
      // `status` field (absent here) so only rows 1 and 3 parse.
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(a.results.map((row) => row.state.phase)).toEqual(['ready', 'error', 'ready'])
      expect(b.results[0].state.metadata).toMatchObject({ provider: 'ipwhois' })
    })

    it('refetches the whole set when force is true', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipapiBody(), { ip: '203.0.113.7' }, ipwhoisBody(), ipapiBody(), { ip: '203.0.113.7' }])
      const service = makeService({ fetch: fetch.fn })
      await service.resolveAll()
      await service.resolveAll(true)
      expect(fetch.calls).toHaveLength(6)
    })

    it('keeps the legacy single-provider resolve working alongside the sweep', async () => {
      const fetch = stubFetch([ipwhoisBody(), ipapiBody()])
      const service = makeService({ fetch: fetch.fn })
      const state = await service.resolve()
      expect(state.phase).toBe('ready')
      expect(state.provider).toBe('ipwhois')
      service.selectProvider('ipapi')
      const switched = await service.resolve()
      expect(switched.provider).toBe('ipapi')
      expect(switched.phase).toBe('ready')
    })
  })
})
