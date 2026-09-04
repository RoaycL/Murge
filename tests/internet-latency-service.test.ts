import { describe, expect, it, vi } from 'vitest'
import { InternetLatencyService } from '../src/main/services/internet-latency-service'
import type { MihomoGateway } from '@shared/gateways'

function mihomoStub(overrides: {
  proxies?: unknown
  delay?: number | Error
  dns?: Error | null
} = {}): Pick<MihomoGateway, 'getProxies' | 'delayTest' | 'dnsQuery'> & {
  delayTest: ReturnType<typeof vi.fn>
  dnsQuery: ReturnType<typeof vi.fn>
} {
  const proxies =
    overrides.proxies ?? {
      proxies: {
        DIRECT: { name: 'DIRECT', type: 'Direct' },
        GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
        节点选择: { name: '节点选择', type: 'Selector', now: '香港 01', all: ['香港 01', '香港 02'] },
        '香港 01': { name: '香港 01', type: 'Shadowsocks' }
      }
    }
  return {
    getProxies: vi.fn().mockResolvedValue(proxies),
    delayTest: vi.fn().mockImplementation(() =>
      overrides.delay instanceof Error ? Promise.reject(overrides.delay) : Promise.resolve({ delay: overrides.delay ?? 231 })
    ),
    dnsQuery: vi.fn().mockImplementation(() =>
      overrides.dns ? Promise.reject(overrides.dns) : Promise.resolve({ Status: 0, Question: [], TC: false, RD: true, RA: true, AD: false, CD: false })
    )
  } as never
}

describe('InternetLatencyService', () => {
  it('collects all three slots and reports the selector current node', async () => {
    const mihomo = mihomoStub()
    let tick = 0
    const service = new InternetLatencyService({
      mihomo,
      measureGatewayRttFn: async () => ({ gateway: '192.168.1.1', rttMs: 1 }),
      nowFn: () => (tick += 9)
    })
    const sample = await service.sample()
    expect(sample.gatewayMs).toBe(1)
    expect(sample.dnsMs).toBe(9)
    expect(sample.proxyMs).toBe(231)
    expect(sample.proxyNode).toBe('香港 01')
    expect(mihomo.delayTest).toHaveBeenCalledWith('香港 01')
  })

  it('skips placeholder selector targets (DIRECT/REJECT/GLOBAL-now)', async () => {
    const mihomo = mihomoStub({
      proxies: {
        GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
        规则组: { name: '规则组', type: 'Selector', now: 'REJECT', all: ['REJECT'] }
      }
    })
    const service = new InternetLatencyService({
      mihomo,
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null })
    })
    const sample = await service.sample()
    expect(sample.proxyNode).toBeNull()
    expect(sample.proxyMs).toBeNull()
    expect(mihomo.delayTest).not.toHaveBeenCalled()
  })

  it('each slot fails independently to null (dns falls back to the system resolver)', async () => {
    const mihomo = mihomoStub({ delay: new Error('timeout'), dns: new Error('dns down') })
    let tick = 0
    const service = new InternetLatencyService({
      mihomo,
      measureGatewayRttFn: async () => ({ gateway: '192.168.1.1', rttMs: 3 }),
      // Deterministic fallback: the system resolver is UNREACHABLE here, so the
      // slot stays null (the ENODATA-becomes-answered path has its own case).
      systemDnsProbeFn: async () => 'failed',
      nowFn: () => (tick += 7)
    })
    const sample = await service.sample()
    expect(sample).toEqual({ gatewayMs: 3, dnsMs: null, proxyMs: null, proxyNode: '香港 01' })
  })

  it('dns falls back to the system resolver when the kernel module is disabled', async () => {
    const mihomo = mihomoStub({ dns: new Error('DNS section is disabled') })
    let tick = 0
    const service = new InternetLatencyService({
      mihomo,
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null }),
      systemDnsProbeFn: async () => 'answered',
      nowFn: () => (tick += 11)
    })
    const sample = await service.sample()
    expect(sample.dnsMs).toBe(11)
  })

  it('a gateway probe crash never fails the whole sample', async () => {
    const service = new InternetLatencyService({
      mihomo: mihomoStub(),
      measureGatewayRttFn: async () => {
        throw new Error('boom')
      }
    })
    const sample = await service.sample()
    expect(sample.gatewayMs).toBeNull()
    expect(sample.proxyMs).toBe(231)
  })

  it('a proxies read failure yields an all-null sample instead of throwing', async () => {
    const mihomo = mihomoStub()
    mihomo.getProxies = vi.fn().mockRejectedValue(new Error('kernel down'))
    const service = new InternetLatencyService({
      mihomo,
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null })
    })
    const sample = await service.sample()
    expect(sample).toEqual({ gatewayMs: null, dnsMs: null, proxyMs: null, proxyNode: null })
  })
})
