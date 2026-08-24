import { describe, it, expect, vi, afterEach } from 'vitest'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

/** Minimal Response-compatible stub for the handful of members the client uses. */
function fakeResponse(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token')
      return body
    }
  } as Response
}

/** A pending Response promise that rejects with an AbortError when `signal` aborts,
 * mirroring how a real fetch reacts to an AbortController. */
function hangingResponse(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}

/** A body-read promise that stays pending until `signal` aborts, simulating a
 * controller that sends headers then stalls its body. */
function hangingBody(signal: AbortSignal | undefined): Promise<string | never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('MihomoClient', () => {
  it('parses a valid version response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ meta: true, version: '1.18.9' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const version = await client.getVersion()
    expect(version.version).toBe('1.18.9')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('sends the bearer secret in the Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ meta: true, version: '1.18.9' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MihomoClient('http://127.0.0.1:9090', 'sekret')
    await client.getVersion()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sekret')
  })

  it('maps HTTP 401 to UNAUTHORIZED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('unauthorized', 401)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'wrong-secret')
    const error = await client.getVersion().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UNAUTHORIZED)
  })

  it('maps other non-2xx to UPSTREAM_HTTP_ERROR and preserves the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('bad gateway', 502)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const error = await client.getProxies().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_HTTP_ERROR)
    expect((error as ProtocolError).details?.reason).toContain('bad gateway')
  })

  it('maps invalid JSON on a 2xx to INVALID_UPSTREAM', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('not json {', 200)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const error = await client.getVersion().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_UPSTREAM)
  })

  it('maps a transport failure to UPSTREAM_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const error = await client.getConfig().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_UNREACHABLE)
  })

  it('resolves undefined for a 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('', 204)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    await expect(client.closeConnection('conn-1')).resolves.toBeUndefined()
  })

  it('maps a request that exceeds the timeout to UPSTREAM_TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => hangingResponse(init?.signal)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret', { timeoutMs: 25 })
    const error = await client.getVersion().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TIMEOUT)
  })

  it('maps an external cancellation to UPSTREAM_UNREACHABLE with an aborted reason', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => hangingResponse(init?.signal)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const abort = new AbortController()
    const pending = client.getConnections(abort.signal)
    abort.abort()
    const error = (await pending.catch((e) => e)) as ProtocolError
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.code).toBe(ProtocolErrorCode.UPSTREAM_UNREACHABLE)
    expect(error.details?.reason).toBe('aborted')
  })

  it('times out when json() hangs after headers were received', async () => {
    const fetchMock = vi.fn((_url, init) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => hangingBody(init?.signal),
      text: async () => ''
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret', { timeoutMs: 25 })
    const error = await client.getVersion().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TIMEOUT)
  })

  it('times out when text() hangs on an HTTP error response', async () => {
    const fetchMock = vi.fn((_url, init) => Promise.resolve({
      ok: false,
      status: 500,
      text: () => hangingBody(init?.signal),
      json: async () => ''
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret', { timeoutMs: 25 })
    const error = await client.getVersion().catch((e) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TIMEOUT)
  })

  it('uses a 10000ms default REST timeout when none is configured', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => hangingResponse(init?.signal)))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const pending = client.getVersion().catch((e) => e)
    await vi.advanceTimersByTimeAsync(10000)
    const error = await pending
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TIMEOUT)
  })

  it('rejects a non-http(s) probe URL before reaching the controller', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    // delayTest validates the probe URL synchronously, before any fetch.
    expect(() => client.delayTest('香港 01', { url: 'file:///etc/passwd' })).toThrowError(ProtocolError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes the external abort listener after a successful request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ meta: true, version: '1.18.9' })))
    const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const signal = { aborted: false, addEventListener, removeEventListener } as unknown as AbortSignal
    await client.getVersion(signal)
    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    const listener = addEventListener.mock.calls[0][1]
    expect(removeEventListener).toHaveBeenCalledWith('abort', listener)
  })

  describe('delay and provider APIs', () => {
    it('tests a node delay with the default url and timeout', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ delay: 42 }))
      vi.stubGlobal('fetch', fetchMock)
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const result = await client.delayTest('香港 01')
      expect(result.delay).toBe(42)
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('/proxies/%E9%A6%99%E6%B8%AF%2001/delay')
      expect(url).toContain('timeout=5000')
      expect(url).toContain('url=')
    })

    it('honors custom delay options', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ delay: 12, url: 'https://example.com' }))
      vi.stubGlobal('fetch', fetchMock)
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const result = await client.delayTest('node', { timeout: 2000, url: 'https://example.com' })
      expect(result.delay).toBe(12)
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('timeout=2000')
      expect(url).toContain('url=https%3A%2F%2Fexample.com')
    })

    it('tests a group delay and parses the member map', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ '香港 01': 42, DIRECT: 6 }))
      vi.stubGlobal('fetch', fetchMock)
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const map = await client.groupDelayTest('节点选择')
      expect(map['香港 01']).toBe(42)
      expect(map.DIRECT).toBe(6)
      expect(String(fetchMock.mock.calls[0][0])).toContain('/group/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9/delay')
    })

    it('maps a 504 delay timeout to UPSTREAM_TIMEOUT', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ message: 'timeout' }, 504)))
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const error = await client.delayTest('香港 02').catch((e) => e)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TIMEOUT)
    })

    it('maps a 408 delay failure to UPSTREAM_HTTP_ERROR (upstream has no 408)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ message: 'unexpected status' }, 408)))
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const error = await client.delayTest('node').catch((e) => e)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_HTTP_ERROR)
    })

    it('maps a 503 probe failure to UPSTREAM_TEST_FAILED', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ message: 'node unreachable' }, 503)))
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const error = await client.delayTest('node').catch((e) => e)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.UPSTREAM_TEST_FAILED)
    })

    it('fetches proxy and rule providers', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
        providers: { '机场 A': { name: '机场 A', type: 'Proxy', vehicleType: 'HTTP', proxiesCount: 2 } }
      })))
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      const providers = await client.getProxyProviders()
      expect(providers.providers['机场 A'].proxiesCount).toBe(2)
    })

    it('refreshes a proxy provider with a PUT and resolves undefined on 204', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('', 204))
      vi.stubGlobal('fetch', fetchMock)
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      await expect(client.refreshProxyProvider('机场 A')).resolves.toBeUndefined()
      expect(String(fetchMock.mock.calls[0][0])).toContain('/providers/proxies/')
      expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
    })

    it('health-checks a proxy provider as a fire-and-forget 204', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('', 204))
      vi.stubGlobal('fetch', fetchMock)
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      await expect(client.healthCheckProxyProvider('机场 A')).resolves.toBeUndefined()
      expect(String(fetchMock.mock.calls[0][0])).toContain('/providers/proxies/%E6%9C%BA%E5%9C%BA%20A/healthcheck')
    })

    it('resolves undefined for any 2xx when empty204 is set (no JSON parse)', async () => {
      // A 200 with an empty/non-JSON body must not be parsed when the action has
      // no payload (provider refresh, select, patch, healthcheck).
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('', 200)))
      const client = new MihomoClient('http://127.0.0.1:9090', 'secret')
      await expect(client.refreshProxyProvider('机场 A')).resolves.toBeUndefined()
    })
  })
})
