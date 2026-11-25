import { describe, expect, it } from 'vitest'
import { summarizeUsagePeriod, usageHistorySince, usagePeriodSlots } from '../src/renderer/src/lib/usage-period'
import { collectNodeLatencies, latencyAxisMax, latencyTone, sortNodeLatencies } from '../src/renderer/src/lib/policy-latency'
import { clockTime, countryFlag, dnsStats, niceBytesCeiling, pickLocalAddress, splitAsn } from '../src/renderer/src/lib/activity-widgets'
import type { MihomoProxy } from '../src/shared/mihomo-api'

const at = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime()

describe('流量用量 periods', () => {
  const now = new Date(2026, 10, 25, 12, 30) // 25 Nov 2026, 12:30 local
  const buckets = [
    { bucketStart: at(2026, 10, 3, 9), up: 10, down: 90, count: 0 }, // last month, no split (old bucket)
    { bucketStart: at(2026, 11, 2, 8), up: 5, down: 15, count: 0, proxy: 12, direct: 8 },
    { bucketStart: at(2026, 11, 25, 0), up: 1, down: 3, count: 0, proxy: 4, direct: 0 },
    { bucketStart: at(2026, 11, 25, 11), up: 100, down: 300, count: 0, proxy: 100, direct: 300 }
  ]

  it('groups today by local hour with future hours marked', () => {
    const today = summarizeUsagePeriod(buckets, 'today', now)
    expect(today.slotKind).toBe('hour')
    expect(today.slots).toHaveLength(24)
    expect(today.total).toBe(404)
    expect([today.up, today.down, today.proxy, today.direct]).toEqual([101, 303, 104, 300])
    expect(today.slots[0].bytes).toBe(4)
    expect(today.slots[11].bytes).toBe(400)
    expect(today.slots[12].future).toBe(false)
    expect(today.slots[13].future).toBe(true)
  })

  it('groups this month and last month by local day', () => {
    const month = summarizeUsagePeriod(buckets, 'month', now)
    expect(month.slots).toHaveLength(30)
    expect(month.total).toBe(424)
    expect(month.slots[1].bytes).toBe(20)
    expect(month.slots[24].bytes).toBe(404)
    const last = summarizeUsagePeriod(buckets, 'lastMonth', now)
    expect(last.slots).toHaveLength(31)
    expect(last.total).toBe(100)
    expect(last.slots[2].bytes).toBe(100)
    expect(last.splitKnown).toBe(false)
    expect(last.slots.every((slot) => !slot.future)).toBe(true)
  })

  it('asks the shell for history from the first day of last month, across a year boundary too', () => {
    expect(usageHistorySince(now)).toBe(at(2026, 10, 1))
    expect(usageHistorySince(new Date(2027, 0, 9))).toBe(at(2026, 12, 1))
    expect(usagePeriodSlots('lastMonth', new Date(2027, 0, 9)).starts).toHaveLength(31)
    expect(usagePeriodSlots('month', new Date(2028, 1, 3)).starts).toHaveLength(29)
  })
})

describe('策略延迟', () => {
  const node = (name: string, delays: number[], extra: Partial<MihomoProxy> = {}): MihomoProxy => ({ name, type: 'Vless', history: delays.map((delay) => ({ time: '', delay })), ...extra })
  const proxies: Record<string, MihomoProxy> = {
    a: node('CC US VLESS', [300, 190]),
    b: node('Oracle KR AnyTLS', [236]),
    c: node('Timed out', [120, 0]),
    d: node('Never tested', []),
    g: node('节点选择', [50], { type: 'Selector', all: ['CC US VLESS'] }),
    direct: node('DIRECT', [5], { type: 'Direct' })
  }

  it('keeps concrete nodes with a latest delay, fastest first, and flips on request', () => {
    const provider = { p: node('Provider node', [205]), dup: node('CC US VLESS', [999]) }
    const nodes = collectNodeLatencies(proxies, provider)
    expect(sortNodeLatencies(nodes, 'asc').map((entry) => `${entry.name}:${entry.delay}`)).toEqual(['CC US VLESS:190', 'Provider node:205', 'Oracle KR AnyTLS:236'])
    expect(sortNodeLatencies(nodes, 'desc')[0].name).toBe('Oracle KR AnyTLS')
  })

  it('rounds the axis and colours by band', () => {
    expect(latencyAxisMax([{ name: 'x', delay: 236 }])).toBe(300)
    expect(latencyAxisMax([])).toBe(100)
    expect([latencyTone(190), latencyTone(200), latencyTone(800)]).toEqual(['good', 'fair', 'poor'])
  })
})

describe('widget helpers', () => {
  it('picks the local address on the gateway subnet', () => {
    const list = [
      { name: 'Tailscale', address: '100.64.0.2', lan: false },
      { name: 'vEthernet', address: '172.20.0.1', lan: true },
      { name: 'WLAN', address: '192.168.1.4', lan: true },
      { name: 'WLAN', address: 'fe80::1', lan: false }
    ]
    expect(pickLocalAddress(list, '192.168.1.1')).toBe('192.168.1.4')
    expect(pickLocalAddress(list, null)).toBe('172.20.0.1')
    expect(pickLocalAddress([], '192.168.1.1')).toBeNull()
  })

  it('splits ASN text and builds flags only from country codes', () => {
    expect(splitAsn('AS140726 UNICOM AnHui province network')).toEqual({ number: 'AS140726', org: 'UNICOM AnHui province network' })
    expect(splitAsn('AS7922')).toEqual({ number: 'AS7922', org: null })
    expect(splitAsn('China Telecom (AS4134)')).toEqual({ org: 'China Telecom', number: 'AS4134' })
    expect(splitAsn(null)).toEqual({ org: null, number: null })
    expect(countryFlag('cn')).toBe('🇨🇳')
    expect(countryFlag('China')).toBe('')
  })

  it('summarises DNS timings, rounds chart ceilings and formats clock times', () => {
    expect(dnsStats([])).toEqual({ average: null, max: null })
    expect(dnsStats([80, 90, 256])).toEqual({ average: 142, max: 256 })
    expect(niceBytesCeiling(0)).toBe(0)
    expect(niceBytesCeiling(100)).toBe(1024)
    expect(niceBytesCeiling(140 * 1024 * 1024)).toBe(256 * 1024 * 1024)
    expect(clockTime(new Date(2026, 0, 1, 9, 5))).toBe('09:05')
    expect(clockTime('nope')).toBe('')
  })
})

describe('活动 request counter', () => {
  it('counts each connection once, closed ones included', async () => {
    const { CumulativeTraffic } = await import('../src/renderer/src/lib/cumulative-traffic')
    const tracker = new CumulativeTraffic({ process: () => 'p', host: () => 'h', policy: () => 'x', iconPath: () => undefined, isProxy: () => false })
    const conn = (id: string, bytes: number) => ({ id, upload: bytes, download: 0, chains: ['DIRECT'], metadata: {} }) as never
    tracker.observe([conn('a', 1), conn('b', 1)])
    tracker.observe([conn('b', 5), conn('c', 0)])
    tracker.observe([conn('c', 2)])
    expect(tracker.requests).toBe(3)
  })
})
