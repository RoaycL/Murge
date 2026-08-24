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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse('bad gateway', 503)))
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
})
