import { describe, expect, it, vi } from 'vitest'
import {
  measureGatewayRtt,
  parseDarwinDefaultGateway,
  parseLinuxProcRoute,
  parseWindowsRoutePrint
} from '../src/main/services/route-latency-service'

const T = String.fromCharCode(9) // tab — /proc/net/route and route print are tab/column files
const NL = String.fromCharCode(10)

describe('default gateway parsers', () => {
  it('parses the macOS `route -n get default` gateway line', () => {
    const stdout = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 192.168.1.1',
      '  interface: en0'
    ].join(NL)
    expect(parseDarwinDefaultGateway(stdout)).toBe('192.168.1.1')
  })

  it('rejects a non-IPv4 macOS gateway (tunnel interface)', () => {
    expect(parseDarwinDefaultGateway('    gateway: utun5' + NL)).toBeNull()
  })

  it('parses the linux /proc/net/route default row (little-endian hex)', () => {
    const proc = [
      ['Iface', 'Destination', 'Gateway', 'Flags', 'RefCnt', 'Use', 'Metric', 'Mask', 'MTU'].join(T),
      ['eth0', '00000000', '0100A8C0', '0003', '0', '0', '100', '00000000', '0'].join(T),
      ['eth0', '0000A8C0', '00000000', '0001', '0', '0', '100', '0000FFFF', '0'].join(T)
    ].join(NL)
    // 0100A8C0 little-endian → 192.168.0.1
    expect(parseLinuxProcRoute(proc)).toBe('192.168.0.1')
  })

  it('returns null when /proc/net/route has no default route', () => {
    const proc = [['eth0', '0000A8C0', '00000000', '0001', '0', '0', '100', '0000FFFF', '0'].join(T)]
    expect(parseLinuxProcRoute(proc.join(NL))).toBeNull()
  })

  it('parses the first active Windows `route print` default row', () => {
    const stdout = [
      'Active Routes:',
      '  Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.100     25',
      '          0.0.0.0          0.0.0.0      10.0.0.1        10.0.0.5        26',
      '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331'
    ].join(NL)
    expect(parseWindowsRoutePrint(stdout)).toBe('192.168.1.1')
  })

  it('returns null when only On-link rows exist', () => {
    const stdout = ['          0.0.0.0          0.0.0.0          On-link      192.168.1.100    331'].join(NL)
    expect(parseWindowsRoutePrint(stdout)).toBeNull()
  })
})

describe('measureGatewayRtt', () => {
  it('times a TCP handshake against the detected gateway', async () => {
    const result = await measureGatewayRtt({
      platform: 'darwin',
      runCommandFn: async () => '    gateway: 192.168.1.1' + NL,
      connectFn: async () => 7
    })
    expect(result).toEqual({ gateway: '192.168.1.1', rttMs: 7 })
  })

  it('falls back from a closed port to the next probe port', async () => {
    const tried: number[] = []
    const result = await measureGatewayRtt({
      platform: 'linux',
      readFileFn: async () => [['eth0', '00000000', '0100A8C0', '0003', '0', '0', '100', '00000000', '0'].join(T)].join(NL),
      connectFn: async ({ port }) => {
        tried.push(port)
        if (port === 53) throw new Error('ECONNREFUSED')
        return 4
      }
    })
    expect(tried).toEqual([53, 80])
    expect(result.rttMs).toBe(4)
    expect(result.gateway).toBe('192.168.0.1')
  })

  it('degrades to nulls when the gateway cannot be detected', async () => {
    const result = await measureGatewayRtt({
      platform: 'darwin',
      runCommandFn: async () => {
        throw new Error('route: bad')
      },
      connectFn: async () => 1
    })
    expect(result).toEqual({ gateway: null, rttMs: null })
  })

  it('degrades to rtt null when every gateway port refuses', async () => {
    const result = await measureGatewayRtt({
      platform: 'linux',
      readFileFn: async () => [['eth0', '00000000', '0100A8C0', '0003', '0', '0', '100', '00000000', '0'].join(T)].join(NL),
      connectFn: async () => {
        throw new Error('timeout')
      }
    })
    expect(result).toEqual({ gateway: '192.168.0.1', rttMs: null })
  })

  it('never probes anything on unknown platforms', async () => {
    const run = vi.fn()
    const read = vi.fn()
    const result = await measureGatewayRtt({
      platform: 'sunos' as NodeJS.Platform,
      runCommandFn: run,
      readFileFn: read,
      connectFn: async () => 1
    })
    expect(result).toEqual({ gateway: null, rttMs: null })
    expect(run).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})
