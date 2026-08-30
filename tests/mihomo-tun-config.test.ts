import { describe, expect, it } from 'vitest'
import { assertMihomoTunConfig, generateMihomoTunConfig, mihomoTunConfigErrors } from '../src/main/tun/mihomo-tun-config'

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
    ['strict-route: false', 'strict-route: true'],
    ['auto-route: true', 'auto-route: false'],
    ['auto-detect-interface: true', 'auto-detect-interface: false'],
    ['external-controller: 127.0.0.1:19090', 'external-controller: 0.0.0.0:19090'],
    ['allow-lan: false', 'allow-lan: true'],
    ['- MATCH,DIRECT', '- MATCH,REJECT']
  ])('rejects mutation %s -> %s', (safe, unsafe) => {
    const text = generateMihomoTunConfig(options).replace(safe, unsafe)
    expect(() => assertMihomoTunConfig(text)).toThrow(/unsafe TUN config/)
  })

  it('rejects duplicate keys, aliases, tags and unknown members', () => {
    const base = generateMihomoTunConfig(options)
    expect(mihomoTunConfigErrors(`${base}tun:\n  enable: true\n`)).not.toEqual([])
    expect(mihomoTunConfigErrors(base.replace('device: Product TUN', 'device: &d Product TUN\n  extra: *d'))).not.toEqual([])
    expect(mihomoTunConfigErrors(base.replace('device: Product TUN', 'device: !!str Product TUN'))).not.toEqual([])
    expect(mihomoTunConfigErrors(base.replace('  stack: mixed', '  stack: mixed\n  mtu: 9000'))).toContain('unknown tun key: mtu')
  })

  it('rejects unsafe identity, ports and secrets before rendering', () => {
    expect(() => generateMihomoTunConfig({ ...options, device: 'bad\nname' })).toThrow()
    expect(() => generateMihomoTunConfig({ ...options, mixedPort: 53 })).toThrow()
    expect(() => generateMihomoTunConfig({ ...options, secret: 'secret' })).toThrow()
  })
})
