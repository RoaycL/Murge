import { describe, it, expect, afterEach, vi } from 'vitest'
import { startMockMihomoServer, type MockMihomoServerHandle } from '../src/main/testing/mock-mihomo-server'
import { MihomoClient } from '../src/main/services/mihomo-client'
import { MihomoService } from '../src/main/services/mihomo-service'
import type { TrafficSample } from '../src/shared/runtime'
import type { MihomoConnectionsSnapshot, MihomoStreamError, MihomoLogsSnapshot } from '../src/shared/mihomo-api'

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

  it('tests group members through provider-aware and nested-group routes', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 1000 })
    handles.push(server)
    const service = new MihomoService(new MihomoClient(server.baseUrl, ''), {
      wsBaseUrl: server.wsBaseUrl,
      enabled: false
    })

    await expect(service.groupMemberDelayTest('节点选择', '香港 01', { timeout: 10000 })).resolves.toEqual({
      delay: 42,
      url: 'https://www.gstatic.com/generate_204'
    })
    await expect(service.groupMemberDelayTest('嵌套选择', '自动选择', { timeout: 10000 })).resolves.toEqual({
      delay: 45,
      url: 'https://www.gstatic.com/generate_204'
    })
    await expect(service.groupMemberDelayTest('节点选择', 'not-a-member')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    service.dispose()
  })

  it('uses the owning group test URL and the provider key for leaf-node probes', async () => {
    const getProxies = vi.fn().mockResolvedValue({
      proxies: {
        Select: {
          name: 'Select',
          type: 'Selector',
          now: 'leaf',
          all: ['leaf', 'Nested'],
          testUrl: 'https://probe.example/generate_204'
        },
        leaf: { name: 'leaf', type: 'Shadowsocks' },
        Nested: { name: 'Nested', type: 'URLTest', now: 'leaf', all: ['leaf'] }
      }
    })
    const getProxyProviders = vi.fn().mockResolvedValue({
      providers: {
        'provider-record-key': {
          name: 'display name is not an endpoint key',
          type: 'Proxy',
          proxies: [{ name: 'leaf', type: 'Shadowsocks' }]
        }
      }
    })
    const providerDelayTest = vi.fn().mockResolvedValue({ delay: 12 })
    const delayTest = vi.fn().mockResolvedValue({ delay: 20 })
    const client = {
      getProxies,
      getProxyProviders,
      providerDelayTest,
      delayTest
    } as unknown as MihomoClient
    const service = new MihomoService(client, { wsBaseUrl: 'ws://127.0.0.1', enabled: false })

    await expect(service.groupMemberDelayTest('Select', 'leaf', { timeout: 9000 })).resolves.toEqual({ delay: 12 })
    expect(providerDelayTest).toHaveBeenCalledWith('provider-record-key', 'leaf', {
      timeout: 9000,
      url: 'https://probe.example/generate_204'
    })

    await expect(service.groupMemberDelayTest('Select', 'Nested', { timeout: 9000 })).resolves.toEqual({ delay: 20 })
    expect(delayTest).toHaveBeenCalledWith('Nested', {
      timeout: 9000,
      url: 'https://probe.example/generate_204'
    })
    expect(getProxyProviders).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('uses the client default when a configured group omitted url, ignoring inherited controller urls', async () => {
    const delayTest = vi.fn().mockResolvedValue({ delay: 20 })
    const client = {
      getProxies: vi.fn().mockResolvedValue({
        proxies: {
          Download: { name: 'Download', type: 'Selector', all: ['DIRECT'], testUrl: 'http://provider.example/check' },
          DIRECT: { name: 'DIRECT', type: 'Direct' }
        }
      }),
      getProxyProviders: vi.fn().mockResolvedValue({ providers: {} }),
      delayTest
    } as unknown as MihomoClient
    const service = new MihomoService(client, {
      wsBaseUrl: 'ws://127.0.0.1',
      enabled: false,
      resolveGroupTestUrls: async () => ({ Download: null })
    })

    await service.groupMemberDelayTest('Download', 'DIRECT', { timeout: 9000 })
    expect(delayTest).toHaveBeenCalledWith('DIRECT', { timeout: 9000 })
    service.dispose()
  })

  it('prefers an explicit group url, or the global url when global scope is selected', async () => {
    const delayTest = vi.fn().mockResolvedValue({ delay: 20 })
    const client = {
      getProxies: vi.fn().mockResolvedValue({
        proxies: {
          Select: { name: 'Select', type: 'Selector', all: ['Nested'], testUrl: '' },
          Nested: { name: 'Nested', type: 'URLTest', all: ['DIRECT'] }
        }
      }),
      delayTest
    } as unknown as MihomoClient
    let scope: 'group' | 'global' = 'group'
    const service = new MihomoService(client, {
      wsBaseUrl: 'ws://127.0.0.1',
      enabled: false,
      resolveGroupTestUrls: async () => ({ Select: 'https://group.example/204' }),
      resolveDelayTestSettings: async () => ({ scope, url: 'https://global.example/204' })
    })
    await service.groupMemberDelayTest('Select', 'Nested')
    expect(delayTest).toHaveBeenLastCalledWith('Nested', { url: 'https://group.example/204' })
    scope = 'global'
    await service.groupMemberDelayTest('Select', 'Nested')
    expect(delayTest).toHaveBeenLastCalledWith('Nested', { url: 'https://global.example/204' })
    service.dispose()
  })

  it('coalesces provider discovery and falls back safely for duplicate provider node names', async () => {
    const getProxyProviders = vi.fn().mockResolvedValue({
      providers: {
        one: { name: 'one', type: 'Proxy', proxies: [{ name: 'duplicate', type: 'Shadowsocks' }] },
        two: { name: 'two', type: 'Proxy', proxies: [{ name: 'duplicate', type: 'Shadowsocks' }] }
      }
    })
    const delayTest = vi.fn().mockResolvedValue({ delay: 20 })
    const providerDelayTest = vi.fn().mockResolvedValue({ delay: 10 })
    const client = {
      getProxies: vi.fn().mockResolvedValue({
        proxies: {
          Select: { name: 'Select', type: 'Selector', all: ['duplicate'] },
          duplicate: { name: 'duplicate', type: 'Shadowsocks' }
        }
      }),
      getProxyProviders,
      delayTest,
      providerDelayTest
    } as unknown as MihomoClient
    const service = new MihomoService(client, { wsBaseUrl: 'ws://127.0.0.1', enabled: false })

    await Promise.all([
      service.groupMemberDelayTest('Select', 'duplicate'),
      service.groupMemberDelayTest('Select', 'duplicate')
    ])
    expect(getProxyProviders).toHaveBeenCalledTimes(1)
    expect(providerDelayTest).not.toHaveBeenCalled()
    expect(delayTest).toHaveBeenCalledTimes(2)
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

  it('retains log history in the main-process buffer independent of subscribers', async () => {
    // The mock server emits a random /logs line ~60% of each traffic tick.
    const server = await startMockMihomoServer({ trafficIntervalMs: 25 })
    handles.push(server)
    const service = new MihomoService(new MihomoClient(server.baseUrl, ''), {
      wsBaseUrl: server.wsBaseUrl,
      enabled: true
    })
    // A subscriber keeps the WebSocket connected so messages actually flow.
    const unsub = service.onLogs(() => undefined)
    // waitFor takes a SYNC boolean; poll the async snapshot directly.
    const start = Date.now()
    let firstSnapshot: MihomoLogsSnapshot = { entries: [], lastSeq: 0 }
    while (Date.now() - start < 4000) {
      firstSnapshot = await service.logsSnapshot()
      if (firstSnapshot.entries.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(firstSnapshot.lastSeq).toBeGreaterThan(0)
    expect(firstSnapshot.entries.length).toBeGreaterThan(0)
    expect(firstSnapshot.entries.every((entry) => typeof entry.seq === 'number' && entry.seq > 0)).toBe(true)
    const firstSeq = firstSnapshot.lastSeq

    // After the only subscriber leaves, the buffer still serves the retained tail
    // — this is the invariant that lets a reopened logs view recover history.
    unsub()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const retained = await service.logsSnapshot(firstSeq)
    expect(retained.entries.every((entry) => (entry.seq ?? 0) > firstSeq)).toBe(true)
    service.dispose()
  })
})
