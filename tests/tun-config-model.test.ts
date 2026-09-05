import { describe, it, expect } from 'vitest'
import {
  buildTunBlock,
  coerceTunConfig,
  coerceTunConfigSnapshot,
  EMPTY_TUN_CONFIG,
  isValidDnsHijackEntry,
  isValidTunDevice,
  isValidTunMtu,
  isValidTunRouteAddress,
  isValidTunStack,
  TUN_MTU_MAX,
  TUN_MTU_MIN
} from '../src/shared/tun-config'

describe('TUN config model', () => {
  it('exposes safe defaults', () => {
    expect(EMPTY_TUN_CONFIG).toEqual({
      stack: 'mixed',
      device: 'Mihomo',
      mtu: 1500,
      strictRoute: false,
      autoRoute: true,
      autoDetectInterface: true,
      dnsHijack: ['any:53'],
      routeAddress: [],
      routeExcludeAddress: []
    })
  })

  it('validates stack, device, mtu and routes', () => {
    expect(isValidTunStack('mixed')).toBe(true)
    expect(isValidTunStack('system')).toBe(true)
    expect(isValidTunStack('gvisor')).toBe(true)
    expect(isValidTunStack('hyper')).toBe(false)
    expect(isValidTunDevice('TUN-0')).toBe(true)
    expect(isValidTunDevice('')).toBe(false)
    expect(isValidTunDevice('bad\nname')).toBe(false)
    expect(isValidTunMtu(TUN_MTU_MIN)).toBe(true)
    expect(isValidTunMtu(TUN_MTU_MAX)).toBe(true)
    expect(isValidTunMtu(TUN_MTU_MIN - 1)).toBe(false)
    expect(isValidTunMtu(1500.5)).toBe(false)
    expect(isValidTunRouteAddress('192.168.0.0/16')).toBe(true)
    expect(isValidTunRouteAddress('not-an-ip')).toBe(false)
  })

  it.each([
    ['any', true],
    ['any:53', true],
    ['198.18.0.2:53', true],
    ['1.1.1.1', true],
    ['[::1]:53', true],
    ['dns.example.com:53', true],
    ['', false],
    ['not-a-host:99999', false],
    ['1.2.3.4:0', false]
  ])('validates dns-hijack entry %s -> %s', (entry, expected) => {
    expect(isValidDnsHijackEntry(entry)).toBe(expected)
  })

  it('coerces an unknown value into a safe model', () => {
    const config = coerceTunConfig({
      stack: 'bad',
      device: '',
      mtu: 100,
      strictRoute: 'yes',
      autoRoute: false,
      autoDetectInterface: true,
      dnsHijack: ['any:53', 'bad:99999', 42],
      routeAddress: ['192.168.0.0/16', 'bogus'],
      routeExcludeAddress: ['10.0.0.0/8', 'nope']
    })
    expect(config.stack).toBe(EMPTY_TUN_CONFIG.stack)
    expect(config.device).toBe(EMPTY_TUN_CONFIG.device)
    expect(config.mtu).toBe(EMPTY_TUN_CONFIG.mtu)
    expect(config.strictRoute).toBe(EMPTY_TUN_CONFIG.strictRoute)
    expect(config.autoRoute).toBe(false)
    expect(config.autoDetectInterface).toBe(true)
    expect(config.dnsHijack).toEqual(['any:53'])
    expect(config.routeAddress).toEqual(['192.168.0.0/16'])
    expect(config.routeExcludeAddress).toEqual(['10.0.0.0/8'])
  })

  it('coerces a snapshot', () => {
    const snapshot = coerceTunConfigSnapshot({ config: { autoRoute: false } })
    expect(snapshot.config.autoRoute).toBe(false)
    expect(snapshot.config.device).toBe(EMPTY_TUN_CONFIG.device)
    expect(coerceTunConfigSnapshot(undefined).config).toEqual(EMPTY_TUN_CONFIG)
  })

  it('builds the tun block and omits empty route lists', () => {
    const block = buildTunBlock({ ...EMPTY_TUN_CONFIG, strictRoute: true })
    expect(block).toEqual({
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': true,
      device: 'Mihomo',
      stack: 'mixed',
      mtu: 1500,
      'dns-hijack': ['any:53']
    })
    const withRoutes = buildTunBlock({ ...EMPTY_TUN_CONFIG, routeAddress: ['192.168.0.0/16'] })
    expect(withRoutes['route-address']).toEqual(['192.168.0.0/16'])
    expect('route-exclude-address' in withRoutes).toBe(false)
  })
})
