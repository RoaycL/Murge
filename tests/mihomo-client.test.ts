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
})
