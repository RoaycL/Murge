import { describe, expect, it, vi } from 'vitest'
import { InternetLatencyService } from '../src/main/services/internet-latency-service'
import type { MihomoGateway } from '@shared/gateways'

function mihomoStub(overrides: {
  proxies?: Awaited<ReturnType<MihomoGateway['getProxies']>>
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
      resolveGroupOrder: async () => ['节点选择'],
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

  it('uses active-profile group order instead of controller map order', async () => {
    const mihomo = mihomoStub({
      proxies: {
        proxies: {
          字母靠前但不是默认: { name: '字母靠前但不是默认', type: 'Selector', now: '错误节点', all: ['错误节点'] },
          默认策略: { name: '默认策略', type: 'Selector', now: '正确节点', all: ['正确节点'] },
          错误节点: { name: '错误节点', type: 'Shadowsocks' },
          正确节点: { name: '正确节点', type: 'Shadowsocks' }
        }
      }
    })
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['默认策略', '字母靠前但不是默认'],
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null })
    })

    const sample = await service.sample()
    expect(sample.proxyNode).toBe('正确节点')
    expect(mihomo.delayTest).toHaveBeenCalledWith('正确节点')
  })

  it('skips placeholder selector targets (DIRECT/REJECT/GLOBAL-now)', async () => {
    const mihomo = mihomoStub({
      proxies: {
        proxies: {
          GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
          规则组: { name: '规则组', type: 'Selector', now: 'REJECT', all: ['REJECT'] }
        }
      }
    })
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['GLOBAL', '规则组'],
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null })
    })
    const sample = await service.sample()
    expect(sample.proxyNode).toBeNull()
    expect(sample.proxyMs).toBeNull()
    expect(mihomo.delayTest).not.toHaveBeenCalled()
  })

  it('each slot fails independently to null', async () => {
    const mihomo = mihomoStub({ delay: new Error('timeout'), dns: new Error('dns down') })
    let tick = 0
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['节点选择'],
      measureGatewayRttFn: async () => ({ gateway: '192.168.1.1', rttMs: 3 }),
      // A generic kernel DNS failure must stay null; it must not be disguised
      // by a successful system-resolver fallback.
      systemDnsProbeFn: async () => 'failed',
      nowFn: () => (tick += 7)
    })
    const sample = await service.sample()
    expect(sample).toEqual({ gatewayMs: 3, dnsMs: null, proxyMs: null, proxyNode: '香港 01' })
  })

  it('does not disguise a generic kernel DNS failure with a system-DNS result', async () => {
    const mihomo = mihomoStub({ dns: new Error('controller unreachable') })
    const systemDnsProbeFn = vi.fn().mockResolvedValue('answered' as const)
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['节点选择'],
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null }),
      systemDnsProbeFn
    })

    const sample = await service.sample()
    expect(sample.dnsMs).toBeNull()
    expect(systemDnsProbeFn).not.toHaveBeenCalled()
  })

  it('dns falls back to the system resolver when the kernel module is disabled', async () => {
    const mihomo = mihomoStub({ dns: new Error('DNS section is disabled') })
    let tick = 0
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['节点选择'],
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
      resolveGroupOrder: async () => ['节点选择'],
      measureGatewayRttFn: async () => {
        throw new Error('boom')
      }
    })
    const sample = await service.sample()
    expect(sample.gatewayMs).toBeNull()
    expect(sample.proxyMs).toBe(231)
  })

  it('a proxies read failure does not suppress the independent DNS probe', async () => {
    const mihomo = mihomoStub()
    mihomo.getProxies = vi.fn().mockRejectedValue(new Error('kernel down'))
    const service = new InternetLatencyService({
      mihomo,
      resolveGroupOrder: async () => ['节点选择'],
      measureGatewayRttFn: async () => ({ gateway: null, rttMs: null })
    })
    const sample = await service.sample()
    expect(sample.gatewayMs).toBeNull()
    expect(sample.dnsMs).toEqual(expect.any(Number))
    expect(sample.proxyMs).toBeNull()
    expect(sample.proxyNode).toBeNull()
    expect(mihomo.dnsQuery).toHaveBeenCalledOnce()
  })
})
