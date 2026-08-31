import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTrafficStore } from '../src/renderer/src/stores/traffic'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import type { MihomoConnectionsSnapshot, MihomoStreamError } from '../src/shared/mihomo-api'
import type { TrafficSample } from '../src/shared/runtime'

type Mh = {
  trafficListeners: Set<(sample: TrafficSample) => void>
  connectionsListeners: Set<(snapshot: MihomoConnectionsSnapshot) => void>
  errorListeners: Set<(error: MihomoStreamError) => void>
  getConnections: ReturnType<typeof vi.fn>
  closeConnection: ReturnType<typeof vi.fn>
  onTraffic: (listener: (sample: TrafficSample) => void) => () => void
  onConnections: (listener: (snapshot: MihomoConnectionsSnapshot) => void) => () => void
  onLogs: (listener: (message: unknown) => void) => () => void
  onStreamError: (listener: (error: MihomoStreamError) => void) => () => void
}

let mihomo: Mh

beforeEach(() => {
  setActivePinia(createPinia())
  const listeners = {
    trafficListeners: new Set<(sample: TrafficSample) => void>(),
    connectionsListeners: new Set<(snapshot: MihomoConnectionsSnapshot) => void>(),
    errorListeners: new Set<(error: MihomoStreamError) => void>()
  }
  mihomo = {
    ...listeners,
    getConnections: vi.fn(),
    closeConnection: vi.fn(),
    onTraffic: (listener) => {
      listener && listeners.trafficListeners.add(listener)
      return () => listeners.trafficListeners.delete(listener)
    },
    onConnections: (listener) => {
      listener && listeners.connectionsListeners.add(listener)
      return () => listeners.connectionsListeners.delete(listener)
    },
    onLogs: () => () => undefined,
    onStreamError: (listener) => {
      listener && listeners.errorListeners.add(listener)
      return () => listeners.errorListeners.delete(listener)
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = { desktop: { mihomo } }
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as unknown as { window?: unknown }).window = undefined
})

function emitConnections(store: ReturnType<typeof useConnectionsStore>, value: MihomoConnectionsSnapshot): void {
  for (const listener of Array.from(mihomo.connectionsListeners)) listener(value)
}

function sample(up = 10, down = 20): TrafficSample {
  return { timestamp: Date.now(), up, down, upTotal: 1000, downTotal: 2000 }
}

function emitTraffic(store: ReturnType<typeof useTrafficStore>, value: TrafficSample): void {
  for (const listener of Array.from(mihomo.trafficListeners)) listener(value)
}

describe('traffic store', () => {
  it('bounds history to a single minute and transitions to live on first sample', () => {
    const store = useTrafficStore()
    expect(store.status).toBe('loading')
    store.connect()
    expect(store.status).toBe('loading')

    for (let i = 0; i < 80; i += 1) emitTraffic(store, sample(i, i))
    expect(store.status).toBe('live')
    expect(store.samples.length).toBe(60)
    expect(store.current).toEqual(store.samples[59])
    expect(store.downloadSeries).toHaveLength(60)
    store.disconnect()
  })

  it('maps stream errors to disconnected or error by kind and filters other sources', () => {
    const store = useTrafficStore()
    store.connect()
    emitTraffic(store, sample())
    expect(store.status).toBe('live')

    const connError: MihomoStreamError = { code: 'UPSTREAM_UNREACHABLE', message: 'traffic stream: closed', source: 'traffic', kind: 'connection' }
    for (const listener of Array.from(mihomo.errorListeners)) listener(connError)
    expect(store.status).toBe('disconnected')
    expect(store.lastError).toBe('traffic stream: closed')

    const wrongSource: MihomoStreamError = { code: 'UPSTREAM_UNREACHABLE', message: 'connections stream: closed', source: 'connections', kind: 'connection' }
    for (const listener of Array.from(mihomo.errorListeners)) listener(wrongSource)
    expect(store.status).toBe('disconnected')

    const parseError: MihomoStreamError = { code: 'UPSTREAM_UNREACHABLE', message: 'traffic stream: bad data', source: 'traffic', kind: 'parse' }
    for (const listener of Array.from(mihomo.errorListeners)) listener(parseError)
    expect(store.status).toBe('error')
    store.disconnect()
  })

  it('re-arms the watchdog after every sample and recovers live after silence', () => {
    vi.useFakeTimers()
    const store = useTrafficStore()
    store.connect()
    emitTraffic(store, sample(1, 1))
    expect(store.status).toBe('live')
    expect(store.lastError).toBeNull()

    // No message for the full watchdog window must flip to disconnected.
    vi.advanceTimersByTime(5000)
    expect(store.status).toBe('disconnected')
    expect(store.lastError).toBe('未收到流量数据')

    // A fresh valid sample recovers to live and clears the stale error.
    emitTraffic(store, sample(2, 2))
    expect(store.status).toBe('live')
    expect(store.lastError).toBeNull()
    store.disconnect()
  })

  it('subscribes once even when connect is called repeatedly (no duplicate messages)', () => {
    const store = useTrafficStore()
    store.connect()
    store.connect()
    expect(mihomo.trafficListeners.size).toBe(1)

    emitTraffic(store, sample(1, 1))
    emitTraffic(store, sample(2, 2))
    expect(store.samples).toHaveLength(2)
    expect(store.samples[1].up).toBe(2)
    store.disconnect()
  })

  it('disconnect releases the watchdog and listeners and stops further updates', () => {
    const store = useTrafficStore()
    store.connect()
    emitTraffic(store, sample(1, 1))
    expect(store.status).toBe('live')

    store.disconnect()
    expect(mihomo.trafficListeners.size).toBe(0)
    expect(mihomo.errorListeners.size).toBe(0)
    expect(store.status).toBe('loading')
    expect(store.lastError).toBeNull()

    // A message emitted after disconnect must not mutate the store.
    emitTraffic(store, sample(2, 2))
    expect(store.samples).toHaveLength(1)
    expect(store.status).toBe('loading')
  })
})

describe('connections store', () => {
  const snapshot: MihomoConnectionsSnapshot = {
    downloadTotal: 1000,
    uploadTotal: 200,
    memory: 512000,
    connections: [
      { id: 'c1', metadata: { process: 'curl', sourceIP: '10.0.0.1' }, upload: 10, download: 100, start: 'x', chains: ['DIRECT'], rule: 'R', rulePayload: '' },
      { id: 'c2', metadata: { process: 'Browser', sourceIP: '10.0.0.1' }, upload: 20, download: 200, start: 'x', chains: ['Socks5', 'Proxy'], rule: 'R', rulePayload: '' },
      { id: 'c3', metadata: { process: 'curl', sourceIP: '10.0.0.2' }, upload: 5, download: 50, start: 'x', chains: ['DIRECT'], rule: 'R', rulePayload: '' }
    ]
  }

  it('aggregates connections into a bounded summary and ranks processes', () => {
    const store = useConnectionsStore()
    mihomo.getConnections.mockResolvedValue(snapshot)
    store.connect()
    for (const listener of Array.from(mihomo.connectionsListeners)) listener(snapshot)

    const summary = store.summary
    expect(summary).toBeTruthy()
    expect(summary?.totalConnections).toBe(3)
    expect(summary?.distinctProcesses).toBe(2)
    expect(summary?.distinctDevices).toBe(2)
    expect(summary?.directDownload).toBe(150)
    expect(summary?.proxyDownload).toBe(200)
    expect(summary?.topProcesses[0]?.name).toBe('Browser')
    expect(summary?.topProcesses[0]?.download).toBe(200)
    expect(summary?.topProcesses[1]?.name).toBe('curl')
    expect(store.status).toBe('live')
    store.disconnect()
  })

  it('re-arms the watchdog after every snapshot and recovers live after silence', async () => {
    vi.useFakeTimers()
    mihomo.getConnections.mockResolvedValue(snapshot)
    const store = useConnectionsStore()
    store.connect()
    emitConnections(store, snapshot)
    expect(store.status).toBe('live')

    vi.advanceTimersByTime(5000)
    expect(store.status).toBe('disconnected')
    expect(store.lastError).toBe('未收到连接数据')

    emitConnections(store, snapshot)
    expect(store.status).toBe('live')
    expect(store.lastError).toBeNull()
    store.disconnect()
    await Promise.resolve()
  })

  it('disconnect releases the watchdogs and listeners and stops further updates', async () => {
    mihomo.getConnections.mockResolvedValue(snapshot)
    const store = useConnectionsStore()
    store.connect()
    emitConnections(store, snapshot)
    expect(store.status).toBe('live')

    store.disconnect()
    expect(mihomo.connectionsListeners.size).toBe(0)
    expect(mihomo.errorListeners.size).toBe(0)
    expect(store.status).toBe('loading')
    expect(store.lastError).toBeNull()

    emitConnections(store, snapshot)
    expect(store.status).toBe('loading')
    await Promise.resolve()
  })

  it('filters and selects live connection details', () => {
    const store = useConnectionsStore()
    mihomo.getConnections.mockResolvedValue(snapshot)
    store.connect()
    emitConnections(store, snapshot)
    store.search = 'browser'
    expect(store.visibleConnections.map((connection) => connection.id)).toEqual(['c2'])
    store.select('c2')
    expect(store.selectedConnection?.metadata.process).toBe('Browser')
    store.disconnect()
  })

  it('closes once and only reports success after a confirming controller read', async () => {
    const store = useConnectionsStore()
    emitConnections(store, snapshot)
    mihomo.closeConnection.mockResolvedValue(undefined)
    mihomo.getConnections.mockResolvedValue({ ...snapshot, connections: snapshot.connections.filter((connection) => connection.id !== 'c2') })

    const result = await store.close('c2')
    expect(result).toBe(true)
    expect(mihomo.closeConnection).toHaveBeenCalledTimes(1)
    expect(mihomo.closeConnection).toHaveBeenCalledWith('c2')
    expect(store.snapshot?.connections.some((connection) => connection.id === 'c2')).toBe(false)
    expect(store.actionError).toBeNull()
  })

  it('keeps the connection visible and recoverable when confirmation diverges', async () => {
    const store = useConnectionsStore()
    emitConnections(store, snapshot)
    mihomo.closeConnection.mockResolvedValue(undefined)
    mihomo.getConnections.mockResolvedValue(snapshot)

    expect(await store.close('c1')).toBe(false)
    expect(store.actionError).toBe('控制器未确认连接已关闭')
    expect(store.snapshot?.connections.some((connection) => connection.id === 'c1')).toBe(true)
    expect(store.closingIds).toEqual([])
  })

  it('deduplicates an in-flight close and surfaces a typed failure', async () => {
    const store = useConnectionsStore()
    let rejectClose: ((error: Error) => void) | undefined
    mihomo.closeConnection.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectClose = reject }))

    const first = store.close('c3')
    expect(store.closingIds).toEqual(['c3'])
    expect(await store.close('c3')).toBe(false)
    expect(mihomo.closeConnection).toHaveBeenCalledTimes(1)
    rejectClose?.(new Error('controller unavailable'))
    expect(await first).toBe(false)
    expect(store.actionError).toContain('controller unavailable')
    expect(store.closingIds).toEqual([])
  })
})

describe('activity ranking scope', () => {
  const rich: MihomoConnectionsSnapshot = {
    downloadTotal: 0,
    uploadTotal: 0,
    memory: 0,
    connections: [
      { id: 'p1', metadata: { process: 'curl', host: 'a.com', sourceIP: '10.0.0.1' }, upload: 0, download: 100, start: '', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '' },
      { id: 'p2', metadata: { process: 'Browser', host: 'b.com', sourceIP: '10.0.0.1' }, upload: 0, download: 200, start: '', chains: ['Socks5', 'Proxy'], rule: 'GEOIP,CN', rulePayload: '' },
      { id: 'p3', metadata: { process: 'curl', host: 'a.com', sourceIP: '10.0.0.2' }, upload: 0, download: 50, start: '', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '' }
    ]
  }

  it('ranks by host and policy and honors the 全部/仅代理 scope', () => {
    const store = useConnectionsStore()
    mihomo.getConnections.mockResolvedValue(rich)
    store.connect()
    emitConnections(store, rich)

    expect(store.rankScope).toBe('all')
    // 域名: b.com (200) ahead of a.com (150).
    expect(store.topHosts[0]?.name).toBe('b.com')
    expect(store.topHosts[0]?.download).toBe(200)
    expect(store.topHosts[1]?.name).toBe('a.com')
    // 策略: `GEOIP,CN` (200) ahead of `MATCH` (150).
    expect(store.topPolicies[0]?.name).toBe('GEOIP,CN')
    expect(store.topPolicies[1]?.name).toBe('MATCH')

    store.setRankScope('proxy')
    expect(store.rankScope).toBe('proxy')
    // Only the proxied connection (p2) remains in every breakdown slot.
    expect(store.topHosts.map((r) => r.name)).toEqual(['b.com'])
    expect(store.topPolicies.map((r) => r.name)).toEqual(['GEOIP,CN'])
    expect(store.topProcesses.map((r) => r.name)).toEqual(['Browser'])
    store.disconnect()
  })

  it('keeps the summary process rank bounded to the live snapshot', () => {
    const store = useConnectionsStore()
    mihomo.getConnections.mockResolvedValue(rich)
    store.connect()
    emitConnections(store, rich)

    expect(store.summary?.topProcesses[0]?.name).toBe('Browser')
    expect(store.summary?.topProcesses[1]?.name).toBe('curl')
    store.disconnect()
  })
})
