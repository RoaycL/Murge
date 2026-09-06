import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RemoteIconCache } from '../src/main/services/remote-icon-cache'
import type { FetchFn, FetchResponseLike } from '../src/main/subscriptions/subscription-fetcher'

function response(bytes: Uint8Array, options: { status?: number; type?: string; location?: string } = {}): FetchResponseLike {
  let sent = false
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: {
      has: (name) => name.toLowerCase() === 'location' ? Boolean(options.location) : name.toLowerCase() === 'content-type',
      get: (name) => name.toLowerCase() === 'location' ? (options.location ?? null) : name.toLowerCase() === 'content-type' ? (options.type ?? 'image/png') : null
    },
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
        cancel: async () => undefined
      })
    }
  }
}

describe('RemoteIconCache', () => {
  it('serves the last successful bytes without a network request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murge-icons-'))
    const fetcher = vi.fn<FetchFn>().mockResolvedValue(response(new Uint8Array([1, 2, 3])))
    const cache = new RemoteIconCache(root, [fetcher], async () => ['1.1.1.1'])
    const url = 'https://icons.example/app.png'
    const fresh = await cache.get('policy:AI', url, true)
    expect(fresh).toBe('data:image/png;base64,AQID')
    fetcher.mockClear()
    expect(await cache.get('policy:AI')).toBe(fresh)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps stale cache when refreshing the icon fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murge-icons-'))
    const fetcher = vi.fn<FetchFn>()
      .mockResolvedValueOnce(response(new Uint8Array([4, 5, 6])))
      .mockRejectedValueOnce(new Error('offline'))
    const cache = new RemoteIconCache(root, [fetcher], async () => ['1.1.1.1'])
    const first = await cache.get('policy:AI', 'https://icons.example/old.png', true)
    expect(await cache.get('policy:AI', 'https://icons.example/new.png', true)).toBe(first)
  })

  it('validates every redirect hop and rejects private icon hosts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murge-icons-'))
    const fetcher = vi.fn<FetchFn>().mockResolvedValue(response(new Uint8Array(), {
      status: 302,
      location: 'https://localhost/private.png'
    }))
    const cache = new RemoteIconCache(root, [fetcher], async (host) => host === 'localhost' ? ['127.0.0.1'] : ['1.1.1.1'])
    expect(await cache.get('policy:AI', 'https://icons.example/app.png', true)).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
    // No cache file was committed after the rejected redirect.
    await expect(readFile(join(root, 'missing.json'))).rejects.toThrow()
  })
})
