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
})
