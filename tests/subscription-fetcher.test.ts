import { describe, it, expect } from 'vitest'
import { SubscriptionFetcher, redactCredentials } from '../src/main/subscriptions/subscription-fetcher'

const SECRET_URL = 'https://user:supersecret@example.com/sub/v1'
const REDACTED_URL = 'https://redacted@example.com/sub/v1'

describe('redactCredentials', () => {
  it('strips userinfo credentials from a URL', () => {
    expect(redactCredentials(SECRET_URL)).toBe(REDACTED_URL)
  })

  it('preserves the host and path', () => {
    expect(redactCredentials('https://example.com:8080/a?b=1')).toBe('https://example.com:8080/a?b=1')
  })

  it('handles malformed URLs without leaking userinfo', () => {
    expect(redactCredentials('http://user:pass@')).toBe('http://[redacted]@')
  })

  it('redacts query parameter tokens (token)', () => {
    const url = 'https://example.com/sub?token=SECRET123'
    const result = redactCredentials(url)
    expect(result).not.toContain('SECRET123')
    expect(result).toContain('***REDACTED***')
  })

  it('redacts query parameter uuids', () => {
    const url = 'https://example.com/sub?uuid=deadbeef12345678'
    const result = redactCredentials(url)
    expect(result).not.toContain('deadbeef12345678')
    expect(result).toContain('***REDACTED***')
  })

  it('redacts multiple secret parameters', () => {
    const url = 'https://example.com/sub?token=TOK1&secret=SEC2&key=KEY3'
    const result = redactCredentials(url)
    expect(result).not.toContain('TOK1')
    expect(result).not.toContain('SEC2')
    expect(result).not.toContain('KEY3')
    expect((result.match(/\*\*\*REDACTED\*\*\*/g) || []).length).toBe(3)
  })

  it('redacts userinfo AND query tokens together', () => {
    const url = 'https://user:PASS@example.com/sub?token=TOKEN123'
    const result = redactCredentials(url)
    expect(result).not.toContain('PASS')
    expect(result).not.toContain('TOKEN123')
    expect(result).toContain('redacted')
    expect(result).toContain('***REDACTED***')
  })

  it('redacts common secret parameter names (case insensitive)', () => {
    const testCases = [
      ['access_token', 'abc123'],
      ['api_key', 'xyz789'],
      ['session_id', 'sess456'],
      ['client_secret', 'client-secret-123']
    ]
    for (const [param, secret] of testCases) {
      const url = `https://example.com/sub?${param}=${secret}`
      const result = redactCredentials(url)
      expect(result).not.toContain(secret)
    }
  })

  it('redacts long hex/UUID path segments', () => {
    const url = 'https://example.com/link/ABCDEF0123456789ABCDEF'
    const result = redactCredentials(url)
    expect(result).toContain('[UUID_REDACTED]')
    expect(result).not.toContain('ABCDEF0123456789ABCDEF')
  })
})

describe('SubscriptionFetcher', () => {
  it('rejects a hostname whose DNS answers include a private address', async () => {
    let fetchCalls = 0
    const fetcher = new SubscriptionFetcher({
      resolveHost: async () => ['127.0.0.1'],
      fetchFn: async () => {
        fetchCalls += 1
        return { ok: true, status: 200, text: async () => 'mode: rule\n' }
      }
    })
    await expect(fetcher.fetch('https://subscription.example/config')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    expect(fetchCalls).toBe(0)
  })

  it('rejects a redirect hostname that resolves into private space', async () => {
    let fetchCalls = 0
    const fetcher = new SubscriptionFetcher({
      resolveHost: async (hostname) => hostname === 'private.example' ? ['192.168.1.5'] : ['93.184.216.34'],
      fetchFn: async () => {
        fetchCalls += 1
        return {
          ok: true,
          status: 302,
          headers: { has: () => true, get: () => 'https://private.example/config' },
          text: async () => ''
        }
      }
    })
    await expect(fetcher.fetch('https://public.example/redirect')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    expect(fetchCalls).toBe(1)
  })

  it('fetches a subscription and persists only the redacted URL', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'proxies: []\n' })
    })
    const result = await fetcher.fetch(SECRET_URL)
    expect(result.document).toBe('proxies: []\n')
    expect(result.source).toMatchObject({ type: 'url', url: REDACTED_URL })
  })

  it('surfaces a transport failure without leaking credentials', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => { throw new Error('ECONNREFUSED') }
    })
    await expect(fetcher.fetch(SECRET_URL)).rejects.toMatchObject({
      code: 'UPSTREAM_UNREACHABLE'
    })
  })

  it('surfaces an HTTP error and redacts the URL in the message', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({ ok: false, status: 503, text: async () => '' })
    })
    const error = await fetcher.fetch(SECRET_URL).catch((value: Error) => value)
    expect(error.message).toContain(REDACTED_URL)
    expect(error.message).not.toContain('supersecret')
  })

  it('rejects an oversized subscription document with its own typed code', async () => {
    const fetcher = new SubscriptionFetcher({
      maxBytes: 5,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'this is far too long to fit' })
    })
    // A size rejection is an HTTP-level fault, NOT a transport failure: the generic
    // catch must not re-wrap an already-typed ProtocolError as UPSTREAM_UNREACHABLE.
    await expect(fetcher.fetch(SECRET_URL)).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' })
  })

  // CRITICAL FIX TESTS: Redirect handling
  it('follows redirects and validates each hop', async () => {
    let callCount = 0
    const fetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      maxRedirects: 3,
      fetchFn: async (url) => {
        callCount++
        if (callCount === 1) {
          return {
            ok: true,
            status: 302,
            headers: { has: () => true, get: () => 'https://example.com/sub' },
            text: async () => ''
          } as FetchResponseLike
        }
        return { ok: true, status: 200, text: async () => 'mode: rule\n' }
      }
    })
    const result = await fetcher.fetch('https://evil.example.com/redirect')
    expect(result.document).toBe('mode: rule\n')
    expect(callCount).toBe(2)
    expect(result.source.url).toBe('https://example.com/sub')
  })

  it('rejects redirects to internal addresses', async () => {
    const fetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      fetchFn: async () => ({
        ok: true,
        status: 302,
        headers: { has: () => true, get: () => 'http://169.254.169.254/metadata' },
        text: async () => ''
      } as FetchResponseLike)
    })
    await expect(fetcher.fetch('https://evil.example.com/redirect')).rejects.toThrow(/内部地址/)
  })

  it('rejects too many redirects', async () => {
    const fetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      maxRedirects: 2,
      fetchFn: async (url) => ({
        ok: true,
        status: 302,
        headers: { has: () => true, get: () => url + '/next' },
        text: async () => ''
      } as FetchResponseLike)
    })
    await expect(fetcher.fetch('https://example.com/a')).rejects.toThrow(/重定向次数过多/)
  })

  it('enforces size limit during streaming', async () => {
    let readCount = 0
    const fetcher = new SubscriptionFetcher({ 
      maxBytes: 100,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              readCount++
              if (readCount === 1) {
                return { done: false, value: new TextEncoder().encode('a'.repeat(60)) }
              } else if (readCount === 2) {
                return { done: false, value: new TextEncoder().encode('b'.repeat(60)) }
              }
              return { done: true, value: undefined }
            },
            cancel: async () => {}
          })
        },
        headers: { has: () => false, get: () => null },
        text: async () => ''
      } as FetchResponseLike)
    })
    await expect(fetcher.fetch('https://example.com/large')).rejects.toThrow(/超过上限/)
  })

  // IPv6 tests
  it('handles IPv6-mapped IPv4 loopback', async () => {
    const mockFetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'test' })
    })
    await expect(mockFetcher.fetch('http://[::ffff:127.0.0.1]:9090/sub')).rejects.toThrow(/内部地址/)
  })

  it('handles IPv6 ULA addresses', async () => {
    const mockFetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'test' })
    })
    await expect(mockFetcher.fetch('http://[fc00::1]/sub')).rejects.toThrow(/内部地址/)
    await expect(mockFetcher.fetch('http://[fd12:3456:789a:bcde::1]/sub')).rejects.toThrow(/内部地址/)
  })

  it('handles IPv6 link-local addresses', async () => {
    const mockFetcher = new SubscriptionFetcher({ 
      strictUrlValidation: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'test' })
    })
    await expect(mockFetcher.fetch('http://[fe80::1]/sub')).rejects.toThrow(/内部地址/)
  })

  it('can disable strict validation for testing', async () => {
    const fetcher = new SubscriptionFetcher({ 
      strictUrlValidation: false,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'mode: rule\n' })
    })
    const result = await fetcher.fetch('http://127.0.0.1:9090/sub')
    expect(result.document).toBe('mode: rule\n')
  })
})

/**
 * Regression coverage for credential leaks that the earlier tests missed because
 * they only asserted the happy-path redaction, never the message actually thrown.
 */
describe('SubscriptionFetcher credential leaks in error paths', () => {
  it('redacts credentials embedded in a transport error message', async () => {
    // undici puts the request URL inside the transport error itself, so wrapping
    // must redact the underlying message too, not just the URL it interpolates.
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => {
        throw new Error(`ECONNREFUSED connecting to ${SECRET_URL}`)
      }
    })
    const error = await fetcher.fetch(SECRET_URL).catch((e) => e as Error)
    expect(error.message).not.toContain('supersecret')
    expect((error as { code?: string }).code).toBe('UPSTREAM_UNREACHABLE')
  })

  it('redacts credentials in an unparseable-URL rejection', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'mode: rule\n' })
    })
    const error = await fetcher.fetch('ht!tp://user:supersecret@bad').catch((e) => e as Error)
    expect(error.message).not.toContain('supersecret')
  })

  it('redacts credentials in an invalid redirect target', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({
        ok: false,
        status: 302,
        headers: { has: () => true, get: () => 'ht!tp://user:supersecret@evil' },
        text: async () => ''
      })
    })
    const error = await fetcher.fetch('https://example.com/sub').catch((e) => e as Error)
    expect(error.message).not.toContain('supersecret')
  })

  it('redacts a URL embedded in free-form text', () => {
    const redacted = redactCredentials(`failed to reach ${SECRET_URL} after 3 tries`)
    expect(redacted).not.toContain('supersecret')
    expect(redacted).toContain('failed to reach')
  })
})

describe('SubscriptionFetcher transport contract', () => {
  it('passes the abort signal and manual redirect mode to the transport', async () => {
    // Without these, the timeout cannot abort a hung request and the global fetch
    // silently follows redirects, bypassing per-hop SSRF validation entirely.
    let seen: { signal?: AbortSignal; redirect?: string } | undefined
    const fetcher = new SubscriptionFetcher({
      fetchFn: async (_url, init) => {
        seen = init
        return { ok: true, status: 200, text: async () => 'mode: rule\n' }
      }
    })
    await fetcher.fetch('https://example.com/sub')
    expect(seen?.redirect).toBe('manual')
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    expect(seen?.signal?.aborted).toBe(false)
  })

  it('aborts the request once the timeout elapses', async () => {
    const fetcher = new SubscriptionFetcher({
      timeoutMs: 10,
      fetchFn: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    await expect(fetcher.fetch('https://slow.example.com/sub')).rejects.toThrow(/超时/)
  })
})

describe('SubscriptionFetcher streaming decode', () => {
  it('reassembles a multibyte UTF-8 character split across chunk boundaries', async () => {
    // "中" is 3 bytes (E4 B8 AD). Split it across two stream chunks: a naive
    // decoder that never flushes would drop the trailing byte and corrupt the tail.
    const full = Buffer.from('proxies: 中\n', 'utf8')
    const boundary = full.length - 2 // mid-way through the last multibyte char
    const chunks = [full.subarray(0, boundary), full.subarray(boundary)]
    let i = 0
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => full.toString('utf8'),
        body: {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: new Uint8Array(chunks[i++]) }
                : { done: true },
            cancel: async () => {}
          })
        }
      })
    })
    const result = await fetcher.fetch('https://example.com/sub')
    expect(result.document).toBe('proxies: 中\n')
  })
})
