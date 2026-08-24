import { describe, it, expect, afterEach } from 'vitest'
import { startMockMihomoServer, type MockMihomoServerHandle } from '../src/main/testing/mock-mihomo-server'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { MihomoService } from '../src/main/services/mihomo-service'
import type { TrafficSample } from '../src/shared/runtime'
import type { MihomoConnectionsSnapshot, MihomoStreamError } from '../src/shared/mihomo-api'

const handles: MockMihomoServerHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('mihomo service gateway', () => {
  it('delegates REST calls and leaves streams closed when disabled', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000 })
    handles.push(server)
    const service = new MihomoService(new MihomoClient(server.baseUrl, ''), {
      wsBaseUrl: server.wsBaseUrl,
      enabled: false
    })
    const config = await service.getConfig()
    expect(config.mode).toBe('rule')

    let fired = false
    service.onTraffic(() => { fired = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fired).toBe(false)
    service.dispose()
  })

  it('forwards live traffic and connection snapshots through the shared streams', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 25 })
    handles.push(server)
    const service = new MihomoService(new MihomoClient(server.baseUrl, ''), {
      wsBaseUrl: server.wsBaseUrl,
      enabled: true
    })
    const samples: TrafficSample[] = []
    const snapshots: MihomoConnectionsSnapshot[] = []
    service.onTraffic((sample) => samples.push(sample))
    service.onConnections((snapshot) => snapshots.push(snapshot))

    await waitFor(() => samples.length >= 2)
    expect(samples[0]).toHaveProperty('up')
    expect(samples[0]).toHaveProperty('down')
    expect(samples[0]).toHaveProperty('timestamp')

    await waitFor(() => snapshots.length >= 1)
    expect(snapshots[0].connections.length).toBeGreaterThan(0)
    service.dispose()
  })

  it('emits typed stream errors with source and kind when an upgrade is refused', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000, secret: 'real-secret' })
    handles.push(server)
    const service = new MihomoService(new MihomoClient(server.baseUrl, 'wrong-secret'), {
      wsBaseUrl: server.wsBaseUrl,
      secret: 'wrong-secret',
      enabled: true
    })
    const errors: MihomoStreamError[] = []
    service.onStreamError((error) => errors.push(error))
    service.onTraffic(() => undefined)

    await waitFor(() =>
      errors.some((error) => error.source === 'traffic' && error.kind === 'connection' && error.message.includes('traffic stream'))
    )
    expect(errors[0].code).toBe('UPSTREAM_UNREACHABLE')
    service.dispose()
  })
})
