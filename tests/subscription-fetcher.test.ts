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
    // `new URL` rejects a scheme with no host; the fallback still redacts userinfo.
    expect(redactCredentials('http://user:pass@')).toBe('http://[redacted]@')
  })
})

describe('SubscriptionFetcher', () => {
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

  it('rejects an oversized subscription document', async () => {
    const fetcher = new SubscriptionFetcher({
      maxBytes: 5,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'this is far too long to fit' })
    })
    await expect(fetcher.fetch(SECRET_URL)).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' })
  })
})
