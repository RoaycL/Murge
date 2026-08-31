import { describe, it, expect } from 'vitest'
import { parseTunConfig } from '../src/shared/schemas/ipc'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'

describe('TUN config IPC schema', () => {
  it('accepts a valid full model', () => {
    const parsed = parseTunConfig({
      stack: 'gvisor',
      device: 'TUN-0',
      mtu: 1500,
      strictRoute: true,
      autoRoute: false,
      autoDetectInterface: true,
      dnsHijack: ['any:53', '198.18.0.2:53'],
      routeAddress: ['192.168.0.0/16'],
      routeExcludeAddress: ['10.0.0.0/8']
    })
    expect(parsed).toEqual({
      stack: 'gvisor',
      device: 'TUN-0',
      mtu: 1500,
      strictRoute: true,
      autoRoute: false,
      autoDetectInterface: true,
      dnsHijack: ['any:53', '198.18.0.2:53'],
      routeAddress: ['192.168.0.0/16'],
      routeExcludeAddress: ['10.0.0.0/8']
    })
  })

  it('rejects a non-object input', () => {
    expect(() => parseTunConfig(null)).toThrow(/tun config must be an object/)
    expect(() => parseTunConfig('x')).toThrow(/tun config must be an object/)
  })

  it('rejects unknown keys', () => {
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, extra: true })).toThrow(/invalid tun config/)
  })

  it('rejects an invalid stack, device, mtu or empty dns-hijack', () => {
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, stack: 'hyper' })).toThrow(/invalid tun config/)
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, device: 'bad\nname' })).toThrow(/invalid tun config/)
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, mtu: 100 })).toThrow(/invalid tun config/)
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, dnsHijack: [] })).toThrow(/invalid tun config/)
  })

  it('rejects invalid dns-hijack entries and route CIDRs', () => {
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, dnsHijack: ['bad:99999'] })).toThrow(/invalid tun config/)
    expect(() => parseTunConfig({ ...EMPTY_TUN_CONFIG, routeAddress: ['999.999.999.999/33'] })).toThrow(/invalid tun config/)
  })
})
