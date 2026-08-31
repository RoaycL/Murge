import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { extractIp, fetchExternalIpViaProxy } from '../src/main/services/external-ip'

describe('extractIp', () => {
  it('extracts a bare IPv4 from a plain echo response', () => {
    expect(extractIp('1.2.3.4')).toBe('1.2.3.4')
    expect(extractIp('\n8.8.8.8\n')).toBe('8.8.8.8')
  })

  it('finds the first IPv4 inside a larger payload', () => {
    expect(extractIp('your ip is 203.0.113.42 today')).toBe('203.0.113.42')
  })

  it('returns null when no IPv4 is present', () => {
    expect(extractIp('<html>404</html>')).toBeNull()
    expect(extractIp('')).toBeNull()
  })
})

describe('fetchExternalIpViaProxy', () => {
  it('routes an absolute-form GET through the proxy and parses the echoed IP', async () => {
    const server: Server = createServer((req, res) => {
      expect(req.method).toBe('GET')
      // The proxy receives the absolute-form request target, not a path.
      expect(req.url).toBe('http://ip.sb/')
      expect(req.headers.host).toBe('ip.sb')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('203.0.113.9')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock proxy did not bind')

    const result = await fetchExternalIpViaProxy({
      host: '127.0.0.1',
      port: address.port,
      url: 'http://ip.sb',
      timeoutMs: 3000
    })
    expect(result).toBe('203.0.113.9')

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('degrades to null on an unreachable proxy', async () => {
    const result = await fetchExternalIpViaProxy({ host: '127.0.0.1', port: 1, timeoutMs: 300 })
    expect(result).toBeNull()
  })

  it('rejects non-http targets (no CONNECT tunnel support)', async () => {
    const result = await fetchExternalIpViaProxy({ host: '127.0.0.1', port: 9, url: 'https://api.ipify.org', timeoutMs: 300 })
    expect(result).toBeNull()
  })
})
