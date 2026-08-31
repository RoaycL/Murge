import { describe, expect, it } from 'vitest'
import { assertMihomoTunConfig, generateMihomoTunConfig, mihomoTunConfigErrors } from '../src/main/tun/mihomo-tun-config'
import type { TunConfigModel } from '../src/shared/tun-config'

const options = {
  mixedPort: 17890,
  controllerPort: 19090,
  secret: 'ab'.repeat(32),
  device: 'Product TUN'
}

describe('Phase 9B mihomo-owned TUN config', () => {
  it('generates a strict conservative profile', () => {
    const text = generateMihomoTunConfig(options)
    expect(mihomoTunConfigErrors(text)).toEqual([])
    expect(text).toContain('auto-route: true')
    expect(text).toContain('auto-detect-interface: true')
    expect(text).toContain('strict-route: false')
    expect(text).toContain('enable: true')
  })

  it.each([
    ['external-controller: 127.0.0.1:19090', 'external-controller: 0.0.0.0:19090'],
    ['allow-lan: false', 'allow-lan: true'],
    ['- MATCH,DIRECT', '- MATCH,REJECT']
  ])('rejects unsafe mutation %s -> %s', (safe, unsafe) => {
    const text = generateMihomoTunConfig(options).replace(safe, unsafe)
    expect(() => assertMihomoTunConfig(text)).toThrow(/unsafe TUN config/)
  })

  it('rejects duplicate keys, aliases, tags and unknown members', () => {
    const base = generateMihomoTunConfig(options)
    expect(mihomoTunConfigErrors(`${base}tun:\n  enable: true\n`)).not.toEqual([])
    expect(mihomoTunConfigErrors(base.replace('device: Product TUN', 'device: &d Product TUN\n  extra: *d'))).not.toEqual([])
    expect(mihomoTunConfigErrors(base.replace('device: Product TUN', 'device: !!str Product TUN'))).not.toEqual([])
    // TUN stack and device are still strict.
    expect(mihomoTunConfigErrors(base.replace('  stack: mixed', '  stack: hyper') )).not.toEqual([])
  })

  it('accepts a user-tuned model and folds it into the tun block', () => {
    const model: TunConfigModel = {
      stack: 'system',
      device: 'TUN-0',
      mtu: 1500,
      strictRoute: true,
      autoRoute: false,
      autoDetectInterface: false,
      dnsHijack: ['any:53', '198.18.0.2:53'],
      routeAddress: ['192.168.0.0/16'],
      routeExcludeAddress: ['10.0.0.0/8']
    }
    const text = generateMihomoTunConfig({ ...options, tunConfig: model })
    expect(mihomoTunConfigErrors(text)).toEqual([])
    expect(text).toContain('  stack: system')
    expect(text).toContain('  device: TUN-0')
    expect(text).toContain('  mtu: 1500')
    expect(text).toContain('  strict-route: true')
    expect(text).toContain('  auto-route: false')
    expect(text).toContain('  auto-detect-interface: false')
    expect(text).toContain('    - 198.18.0.2:53')
    expect(text).toContain('  route-address:')
    expect(text).toContain('    - 192.168.0.0/16')
    expect(text).toContain('  route-exclude-address:')
    expect(text).toContain('    - 10.0.0.0/8')
  })

  it('rejects an invalid configurable TUN field before rendering', () => {
    const base = generateMihomoTunConfig(options)
    // MTU out of range.
    expect(mihomoTunConfigErrors(base.replace('  stack: mixed', '  stack: mixed\n  mtu: 100'))).toContain('mtu must be an integer between 576 and 65535')
    // Empty dns-hijack must be rejected.
    expect(mihomoTunConfigErrors(base.replace('    - any:53', '    - '))).not.toEqual([])
    // Invalid dns-hijack entry.
    expect(mihomoTunConfigErrors(base.replace('    - any:53', '    - not-a-host:99999'))).not.toEqual([])
    // Invalid route CIDR.
    expect(mihomoTunConfigErrors(base.replace('  stack: mixed', '  stack: mixed\n  route-address:\n    - 999.999.999.999/33'))).not.toEqual([])
  })

  it('rejects a corrupt configurable field in a hand-authored profile', () => {
    const text = generateMihomoTunConfig(options).replace('  stack: mixed', '  stack: mixed\n  mtu: "not-a-number"')
    expect(() => assertMihomoTunConfig(text)).toThrow(/unsafe TUN config/)
  })

  it('rejects unsafe identity, ports and secrets before rendering', () => {
    expect(() => generateMihomoTunConfig({ ...options, device: 'bad\nname' })).toThrow()
    expect(() => generateMihomoTunConfig({ ...options, mixedPort: 53 })).toThrow()
    expect(() => generateMihomoTunConfig({ ...options, secret: 'secret' })).toThrow()
  })
})
