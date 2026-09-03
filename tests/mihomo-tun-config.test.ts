import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  assertMihomoTunConfig,
  assertProxiedTunConfig,
  generateMihomoTunConfig,
  generateProxiedTunConfig,
  mihomoTunConfigErrors,
  proxiedTunConfigErrors
} from '../src/main/tun/mihomo-tun-config'
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

describe('proxied TUN config (real subscription content)', () => {
  const document = [
    'mixed-port: 7890',
    'allow-lan: true',
    'mode: rule',
    'proxies:',
    '  - name: node-a',
    '    type: ss',
    '    server: example.invalid',
    '    port: 8388',
    '    cipher: aes-128-gcm',
    '    password: pw',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    '      - node-a',
    '      - DIRECT',
    'rule-providers:',
    '  reject:',
    '    type: http',
    '    behavior: domain',
    '    url: https://example.invalid/reject.yaml',
    '    path: ./ruleset/reject.yaml',
    'rules:',
    '  - RULE-SET,reject,REJECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,PROXY',
    ''
  ].join('\n')

  const proxied = { ...options, document }

  it('carries the profile proxies, groups, providers and rules', () => {
    const text = generateProxiedTunConfig(proxied)
    expect(proxiedTunConfigErrors(text)).toEqual([])
    // The whole point of the change: real proxy content reaches the elevated child.
    expect(text).toContain('node-a')
    expect(text).toContain('PROXY')
    expect(text).toContain('RULE-SET,reject,REJECT')
    expect(text).toContain('MATCH,PROXY')
    // mode:rule is what makes those rules take effect at all.
    expect(text).toMatch(/mode:\s*rule/)
    expect(text).not.toMatch(/MATCH,DIRECT/)
  })

  it('enables TUN and forces the fake-ip DNS keys', () => {
    const text = generateProxiedTunConfig(proxied)
    const config = parse(text) as Record<string, any>
    expect(config.tun.enable).toBe(true)
    expect(config.tun.device).toBe('Product TUN')
    expect(config.tun.stack).toBe('mixed')
    expect(config.tun['dns-hijack']).toEqual(['any:53'])
    expect(config.dns.enable).toBe(true)
    expect(config.dns['enhanced-mode']).toBe('fake-ip')
    expect(config.dns['fake-ip-range']).toBe('198.18.0.1/16')
  })

  it('keeps the profile nameserver split while forcing fake-ip', () => {
    const withDns = `${document}dns:\n  enable: false\n  enhanced-mode: redir-host\n  nameserver:\n    - 223.5.5.5\n  fallback:\n    - 1.1.1.1\n`
    const config = parse(generateProxiedTunConfig({ ...proxied, document: withDns })) as Record<string, any>
    // fake-ip is non-negotiable for TUN...
    expect(config.dns['enhanced-mode']).toBe('fake-ip')
    expect(config.dns.enable).toBe(true)
    // ...but the user's own resolver routing is their intent and must survive.
    expect(config.dns.nameserver).toEqual(['223.5.5.5'])
    expect(config.dns.fallback).toEqual(['1.1.1.1'])
  })

  it('still neutralizes host-network mutation and forces the auth keys', () => {
    const hostile = `${document}listeners:\n  - name: in\n    type: http\n    port: 1080\nredir-port: 7892\ntproxy-port: 7893\nexternal-controller-pipe: \\\\.\\pipe\\evil\nexternal-doh-server: /dns-query\ndns:\n  enable: true\n  listen: 0.0.0.0:53\n`
    const text = generateProxiedTunConfig({ ...proxied, document: hostile })
    expect(proxiedTunConfigErrors(text)).toEqual([])
    const config = parse(text) as Record<string, any>
    for (const key of ['listeners', 'redir-port', 'tproxy-port', 'external-controller-pipe', 'external-doh-server']) {
      expect(config[key]).toBeUndefined()
    }
    expect(config.dns.listen).toBeUndefined()
    // allow-lan:true in the profile must not survive into a SYSTEM-run child.
    expect(config['allow-lan']).toBe(false)
    expect(config['external-controller']).toBe(`127.0.0.1:${options.controllerPort}`)
    expect(config['mixed-port']).toBe(options.mixedPort)
    expect(config.secret).toBe(options.secret)
  })

  it('folds a user-tuned TUN model into the proxied profile', () => {
    const model: TunConfigModel = {
      stack: 'gvisor',
      device: 'TUN-1',
      mtu: 1400,
      strictRoute: true,
      autoRoute: false,
      autoDetectInterface: false,
      dnsHijack: ['any:53', '198.18.0.2:53'],
      routeAddress: ['192.168.0.0/16'],
      routeExcludeAddress: ['10.0.0.0/8']
    }
    const config = parse(generateProxiedTunConfig({ ...proxied, tunConfig: model })) as Record<string, any>
    expect(config.tun.stack).toBe('gvisor')
    expect(config.tun.device).toBe('TUN-1')
    expect(config.tun.mtu).toBe(1400)
    expect(config.tun['strict-route']).toBe(true)
    expect(config.tun['auto-route']).toBe(false)
    expect(config.tun['route-address']).toEqual(['192.168.0.0/16'])
    expect(config.tun['route-exclude-address']).toEqual(['10.0.0.0/8'])
  })

  it('rejects a profile that exceeds the privileged service byte ceiling', () => {
    // An inlined ruleset is the realistic way to blow the 64 KiB service cap.
    const huge = `${document}${Array.from({ length: 4000 }, (_, i) => `  - DOMAIN-SUFFIX,host-${i}-padding-padding.example.invalid,PROXY`).join('\n')}\n`
    expect(() => generateProxiedTunConfig({ ...proxied, document: huge })).toThrow(/超过特权服务/)
  })

  it('strips the external-UI family so the SYSTEM child never downloads or serves it', () => {
    // A real subscription may carry these; mihomo would fetch that ZIP and unpack
    // it under the configured directory as SYSTEM. Strip (so the profile stays
    // usable) but never emit them.
    const withUi = `${document}external-ui: C:\\Windows\\Temp\\ui\nexternal-ui-url: https://attacker.invalid/ui.zip\nexternal-ui-name: x\n`
    const text = generateProxiedTunConfig({ ...proxied, document: withUi })
    expect(proxiedTunConfigErrors(text)).toEqual([])
    const config = parse(text) as Record<string, any>
    expect(config['external-ui']).toBeUndefined()
    expect(config['external-ui-url']).toBeUndefined()
    expect(config['external-ui-name']).toBeUndefined()
    expect(config.proxies).toHaveLength(1)
  })

  it('flags an external-UI key in a hand-authored profile', () => {
    const text = generateProxiedTunConfig(proxied)
    for (const key of ['external-ui', 'external-ui-url', 'external-ui-name']) {
      expect(proxiedTunConfigErrors(`${text}${key}: evil\n`)).not.toEqual([])
    }
  })

  it('strips the keys that would give the SYSTEM child extra reach', () => {
    // tunnels binds arbitrary local ports and forwards them to arbitrary hosts;
    // ntp.write-to-system lets a SYSTEM process set the machine clock; the CORS
    // block widens who may reach the controller. None are needed to proxy.
    const hostile = `${document}tunnels:\n  - tcp/udp,0.0.0.0:12345,10.0.0.5:22,node-a\nntp:\n  enable: true\n  server: 1.2.3.4\n  write-to-system: true\nexternal-controller-cors:\n  allow-origins:\n    - '*'\n  allow-private-network: true\n`
    const text = generateProxiedTunConfig({ ...proxied, document: hostile })
    expect(proxiedTunConfigErrors(text)).toEqual([])
    const config = parse(text) as Record<string, any>
    expect(config.tunnels).toBeUndefined()
    expect(config.ntp).toBeUndefined()
    expect(config['external-controller-cors']).toBeUndefined()
    expect(text).not.toContain('write-to-system')
    expect(config.proxies).toHaveLength(1)
  })

  it('confines an escaping provider path to the state directory', () => {
    // mihomo WRITES downloaded provider content to `path` as SYSTEM, so an
    // absolute or `..` path is an arbitrary file write. Rewrite rather than reject
    // so the provider keeps working.
    const escaping = `${document}proxy-providers:\n  vendor:\n    type: http\n    url: https://example.invalid/sub.yaml\n    path: ../../../../Windows/System32/evil.dll\n`
    const text = generateProxiedTunConfig({ ...proxied, document: escaping })
    expect(proxiedTunConfigErrors(text)).toEqual([])
    const config = parse(text) as Record<string, any>
    expect(config['proxy-providers'].vendor.path).toBe('./proxy-providers/vendor.yaml')
    expect(text).not.toContain('System32')
    // The provider itself survives — only its write location was corrected.
    expect(config['proxy-providers'].vendor.url).toBe('https://example.invalid/sub.yaml')
  })

  it('preserves a provider path that is already contained', () => {
    const config = parse(generateProxiedTunConfig(proxied)) as Record<string, any>
    expect(config['rule-providers'].reject.path).toBe('./ruleset/reject.yaml')
  })

  it('flags unsafe provider paths in a hand-authored profile', () => {
    const text = generateProxiedTunConfig(proxied)
    for (const bad of ['C:\\Windows\\evil.dll', '/etc/evil', '../escape.yaml', 'C:evil.dll']) {
      const tampered = text.replace('./ruleset/reject.yaml', bad)
      expect(proxiedTunConfigErrors(tampered)).not.toEqual([])
    }
  })

  it('rejects unsafe identity, ports and secrets before rendering', () => {
    expect(() => generateProxiedTunConfig({ ...proxied, device: 'bad\nname' })).toThrow()
    expect(() => generateProxiedTunConfig({ ...proxied, mixedPort: 53 })).toThrow()
    expect(() => generateProxiedTunConfig({ ...proxied, secret: 'secret' })).toThrow()
    expect(() => generateProxiedTunConfig({ ...proxied, mixedPort: options.controllerPort })).toThrow()
  })

  it('flags a hand-authored profile that violates a non-negotiable invariant', () => {
    const text = generateProxiedTunConfig(proxied)
    expect(proxiedTunConfigErrors(text.replace('allow-lan: false', 'allow-lan: true'))).not.toEqual([])
    expect(proxiedTunConfigErrors(text.replace(`127.0.0.1:${options.controllerPort}`, `0.0.0.0:${options.controllerPort}`))).not.toEqual([])
    expect(proxiedTunConfigErrors(text.replace('enable: true', 'enable: false'))).not.toEqual([])
    expect(() => assertProxiedTunConfig(`${text}listeners:\n  - name: x\n`)).toThrow(/unsafe TUN config/)
  })
})
