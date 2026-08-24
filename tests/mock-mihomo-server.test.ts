import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { startMockMihomoServer, type MockMihomoServerHandle } from '../src/main/testing/mock-mihomo-server'

const handles: MockMihomoServerHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

function firstMessage(url: string, secret?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: secret ? { Authorization: `Bearer ${secret}` } : undefined })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('timed out waiting for a stream message'))
    }, 3000)
    ws.on('message', (data) => {
      clearTimeout(timer)
      ws.close()
      resolve(data.toString())
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('mock mihomo server', () => {
  it('serves the version over REST', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000, version: { meta: true, version: '1.18.9-mock' } })
    handles.push(server)
    const response = await fetch(`${server.baseUrl}/version`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ meta: true, version: '1.18.9-mock' })
  })

  it('serves a config snapshot with a mode', async () => {
    const server = await startMockMihomoServer()
    handles.push(server)
    const response = await fetch(`${server.baseUrl}/configs`)
    const config = await response.json() as { mode: string; port: number }
    expect(config.mode).toBe('rule')
    expect(typeof config.port).toBe('number')
  })

  it('streams traffic messages on the /traffic WebSocket', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 25 })
    handles.push(server)
    const message = await firstMessage(`${server.wsBaseUrl}/traffic`)
    const traffic = JSON.parse(message)
    expect(typeof traffic.up).toBe('number')
    expect(typeof traffic.down).toBe('number')
    expect(typeof traffic.upTotal).toBe('number')
    expect(traffic.upTotal).toBeGreaterThan(0)
  })

  it('rejects REST requests when the secret does not match', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000, secret: 'top-secret' })
    handles.push(server)
    const bad = await fetch(`${server.baseUrl}/version`, { headers: { Authorization: 'Bearer wrong' } })
    expect(bad.status).toBe(401)
    const good = await fetch(`${server.baseUrl}/version`, { headers: { Authorization: 'Bearer top-secret' } })
    expect(good.status).toBe(200)
  })

  it('rejects anonymous WebSocket upgrades when a secret is enforced', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000, secret: 'top-secret' })
    handles.push(server)
    await expect(firstMessage(`${server.wsBaseUrl}/traffic`)).rejects.toThrow(/Unexpected server response: 401/)
  })

  describe('Phase 4 selection, delay and providers', () => {
    it('persists a proxy selection so a later read reflects it', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const group = encodeURIComponent('节点选择')
      const response = await fetch(`${server.baseUrl}/proxies/${group}`, {
        method: 'PUT',
        body: JSON.stringify({ name: '香港 02' })
      })
      expect(response.status).toBe(204)
      const proxies = await fetch(`${server.baseUrl}/proxies`).then((r) => r.json()) as { proxies: Record<string, { all: string[]; now: string }> }
      expect(proxies.proxies['节点选择'].now).toBe('香港 02')
    })

    it('serves an individual delay result', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const node = encodeURIComponent('香港 01')
      const res = await fetch(`${server.baseUrl}/proxies/${node}/delay?timeout=5000`)
      expect(res.status).toBe(200)
      const body = await res.json() as { delay: number }
      expect(typeof body.delay).toBe('number')
    })

    it('maps an unreachable node to 504', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const node = encodeURIComponent('香港 02')
      const res = await fetch(`${server.baseUrl}/proxies/${node}/delay`)
      expect(res.status).toBe(504)
    })

    it('serves a group delay map that omits unreachable members', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const group = encodeURIComponent('节点选择')
      const res = await fetch(`${server.baseUrl}/group/${group}/delay`)
      expect(res.status).toBe(200)
      const map = await res.json() as Record<string, number>
      expect(map['香港 01']).toBeGreaterThan(0)
      expect(map['香港 02']).toBeUndefined()
    })

    it('serves proxy and rule provider metadata', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const proxyRes = await fetch(`${server.baseUrl}/providers/proxies`).then((r) => r.json()) as { providers: Record<string, { type: string; proxiesCount: number }> }
      const proxyProvider = proxyRes.providers['机场 A']
      expect(proxyProvider.type).toBe('Proxy')
      expect(proxyProvider.proxiesCount).toBe(2)
      const ruleRes = await fetch(`${server.baseUrl}/providers/rules`).then((r) => r.json()) as { providers: Record<string, { type: string; ruleCount: number }> }
      expect(ruleRes.providers['规则集 A'].type).toBe('Rule')
    })

    it('refreshes a proxy provider and returns 204 and bumps updatedAt', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const provider = encodeURIComponent('机场 A')
      const res = await fetch(`${server.baseUrl}/providers/proxies/${provider}`, { method: 'PUT' })
      expect(res.status).toBe(204)
      const refetched = await fetch(`${server.baseUrl}/providers/proxies`).then((r) => r.json()) as { providers: Record<string, { updatedAt: string }> }
      expect(typeof refetched.providers['机场 A'].updatedAt).toBe('string')
    })

    it('health-checks a proxy provider into a delay map', async () => {
      const server = await startMockMihomoServer()
      handles.push(server)
      const provider = encodeURIComponent('机场 A')
      const res = await fetch(`${server.baseUrl}/providers/proxies/${provider}/healthcheck`)
      expect(res.status).toBe(200)
      const map = await res.json() as Record<string, number>
      expect(map['香港 01']).toBeGreaterThan(0)
    })
  })
})
