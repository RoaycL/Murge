import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { buildProfileKernelConfig, profileKernelConfigErrors } from '../src/main/kernel/profile-kernel-config'

// A representative user subscription config exercising anchors, merge keys, a
// TUN block, a public DNS listener and transparent-proxy ports — the shape this
// transform must carry (content) and neutralize (system mutation).
const USER_CONFIG = `
port: 7890
socks-port: 7891
mixed-port: 7892
allow-lan: true
mode: rule
external-controller: 0.0.0.0:9090
redir-port: 7893
tproxy-port: 7894

NodeParam: &NodeParam
  type: http
  interval: 3600
  health-check:
    enable: true
    url: http://www.google.com/blank.html
    interval: 6

proxy-providers:
  CloudCone:
    url: https://example.com/cloud
    <<: *NodeParam
    path: ./proxy_providers/CloudCone.yaml

proxy-groups:
  - name: 全球选择
    type: select
    proxies:
      - DIRECT
  - name: VMISS
    type: url-test
    use:
      - CloudCone

rule-providers:
  China:
    type: http
    behavior: classical
    url: https://example.com/rules/china.yaml
    path: ./rules/china.yaml

dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip

listeners:
  - name: socks5-in-1
    type: socks
    port: 10808
    listen: 0.0.0.0
    proxy: DIRECT

tun:
  enable: true
  stack: system
  auto-route: true
  dns-hijack:
    - any:53

rules:
  - DOMAIN-SUFFIX,example.com,CloudCone
  - GEOIP,CN,DIRECT
  - MATCH,漏网之鱼
`

// A near-complete mihomo subscription config matching the reported shape: many
// providers, a shared `RuleProviders` anchor, an `include-all-providers` group
// with a `filter`, plus `geox-url`/`profile`/`sniffer`. All of it must be carried
// through the transform (only the system-mutating blocks are neutralized).
const FULL_CONFIG = `
mixed-port: 7892
allow-lan: true
mode: rule
log-level: info
ipv6: true
udp: true
external-controller: 0.0.0.0:9090
geox-url: &GeoxUrl
  geox: https://example.com/geo
profile:
  store-selected: true
  store-fake-ip: true
sniffer:
  enable: true

NodeParam: &NodeParam
  type: http
  interval: 3600
  health-check:
    enable: true
    url: http://www.google.com/blank.html
    interval: 6

RuleProviders: &RuleProviders
  type: http
  behavior: classical
  interval: 3600
  format: yaml
  proxy: DIRECT

proxy-providers:
  CloudCone: { url: "https://example.com/a", <<: *NodeParam, path: "./pp/CloudCone.yaml", override: { additional-prefix: "[CC] " } }
  VMISS: { url: "https://example.com/b", <<: *NodeParam, path: "./pp/VMISS.yaml", override: { additional-prefix: "[VMISS] " } }
  PaoPaoGou: { url: "https://example.com/c", <<: *NodeParam, path: "./pp/PPG.yaml" }

proxy-groups:
  - name: 全球选择
    type: select
    proxies: [DIRECT]
  - name: 境外下载
    type: select
    include-all-providers: true
    filter: ^(?=.*((?i)游戏|🎮)).*$
  - name: 手动切换
    type: fallback
    proxies:
      - 全球选择
      - VMISS

rule-providers:
  LAN: { <<: *RuleProviders, url: "https://example.com/r/lan.yaml", path: "./rules/lan.yaml" }
  Direct: { <<: *RuleProviders, url: "https://example.com/r/direct.yaml", path: "./rules/direct.yaml" }
  China: { <<: *RuleProviders, url: "https://example.com/r/china.yaml", path: "./rules/china.yaml" }

dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip
  fake-ip-range: 28.0.0.1/8
  default-nameserver:
    - 1.1.1.1
  nameserver:
    - 8.8.8.8

listeners:
  - name: socks5-in-1
    type: socks
    port: 10808
    listen: 0.0.0.0
    proxy: DIRECT

tun:
  enable: true
  stack: system
  auto-route: true
  dns-hijack:
    - any:53

rules:
  - DOMAIN,example.com,CloudCone
  - RULE-SET,LAN,DIRECT
  - RULE-SET,Direct,DIRECT
  - RULE-SET,China,Direct
  - GEOIP,CN,DIRECT
  - MATCH,漏网之鱼
`

const SECRET = 'a'.repeat(64)

describe('buildProfileKernelConfig', () => {
  it('carries the real user-subscription config while neutralizing system mutation', async () => {
    const fixturePath = new URL('./fixtures/user-subscription-config.yaml', import.meta.url)
    const doc = await readFile(fixturePath, 'utf8')

    const out = buildProfileKernelConfig(doc, {
      mixedPort: 34567,
      controllerPort: 34568,
      secret: SECRET
    })

    // Every provider survives the transform, with the NodeParam merge resolved.
    for (const name of [
      'CloudCone', 'VMISS', 'Oracle', 'SKYLUMO', 'PaoPaoGou', 'DingJiJiChang', 'DigitalOcean'
    ]) {
      expect(out).toContain(name)
    }
    // Proxy-groups (incl. the include-all-providers group) survive.
    expect(out).toContain('全球选择')
    expect(out).toContain('境外下载')
    expect(out).toContain('include-all-providers')
    // Every rule-provider survives, with the shared RuleProviders anchor merged.
    for (const name of ['LAN', 'Direct', 'AI', 'OpenAI', 'Claude', 'China', 'Global']) {
      expect(out).toContain(name)
    }
    expect(out).toMatch(/behavior: classical/)
    // The final rule and the DNS fake-ip settings survive.
    expect(out).toContain('MATCH,漏网之鱼')
    expect(out).toContain('fake-ip-range: 28.0.0.1/8')

    // System mutation is neutralized.
    expect(profileKernelConfigErrors(out)).toEqual([])
    expect(out).not.toMatch(/tun:/)
    expect(out).not.toMatch(/listeners:/)
    expect(out).not.toMatch(/redir-port:/)
    expect(out).not.toMatch(/tproxy-port:/)
    expect(out).not.toMatch(/listen: 0\.0\.0\.0:1053/)
    expect(out).toContain('allow-lan: false')
    expect(out).toContain('external-controller: 127.0.0.1:34568')
    expect(out).toContain(`secret: ${SECRET}`)
  })

  it('preserves content sections while neutralizing host-network mutation', () => {
    const out = buildProfileKernelConfig(USER_CONFIG, {
      mixedPort: 34567,
      controllerPort: 34568,
      secret: SECRET
    })

    expect(out).toContain('proxy-providers:')
    expect(out).toContain('CloudCone:')
    expect(out).toContain('全球选择')
    expect(out).toContain('VMISS')
    expect(out).toContain('漏网之鱼')
    expect(out).toContain('rule-providers:')

    // Neutralized system-mutating blocks.
    expect(out).not.toMatch(/tun:/)
    expect(out).not.toMatch(/listeners:/)
    expect(out).not.toMatch(/redir-port:/)
    expect(out).not.toMatch(/tproxy-port:/)
    const runtime = parse(out) as Record<string, unknown>
    expect(runtime.port).toBeUndefined()
    expect(runtime['socks-port']).toBeUndefined()
    expect(out).not.toMatch(/listen: 0\.0\.0\.0:1053/)

    // Forced app-critical keys.
    expect(out).toContain('mixed-port: 34567')
    expect(out).toContain('external-controller: 127.0.0.1:34568')
    expect(out).toContain('allow-lan: false')
    expect(out).toContain(`secret: ${SECRET}`)

    // Resolved anchor merge: CloudCone inherits type/http + interval.
    expect(out).toMatch(/CloudCone:/)
    expect(out).toMatch(/type: http/)
  })

  it('strips every extra inbound and unauthenticated controller surface from the runtime copy', () => {
    const dangerous = `${USER_CONFIG}\nexternal-controller-unix: mihomo.sock\nexternal-controller-pipe: '\\\\.\\pipe\\mihomo'\nexternal-controller-tls: 0.0.0.0:9443\nexternal-doh-server: /dns-query\nss-config:\n  listen: 0.0.0.0:10001\nvmess-config:\n  listen: 0.0.0.0:10002\ntuic-server:\n  listen: 0.0.0.0:10003\n`
    const out = buildProfileKernelConfig(dangerous, {
      mixedPort: 34567,
      controllerPort: 34568,
      secret: SECRET
    })
    const runtime = parse(out) as Record<string, unknown>

    for (const key of [
      'port', 'socks-port', 'redir-port', 'tproxy-port', 'listeners', 'tun',
      'ss-config', 'vmess-config', 'tuic-server', 'external-controller-unix',
      'external-controller-pipe', 'external-controller-tls', 'external-doh-server'
    ]) {
      expect(runtime[key], key).toBeUndefined()
    }
    expect(runtime['mixed-port']).toBe(34567)
    expect(runtime['external-controller']).toBe('127.0.0.1:34568')
    expect(runtime['bind-address']).toBe('127.0.0.1')
    // Transformation is copy-only; the imported document remains usable in
    // another client with all of its original fields intact.
    expect(dangerous).toContain('external-controller-pipe:')
  })

  it('carries a near-complete subscription config through the transform', () => {
    const out = buildProfileKernelConfig(FULL_CONFIG, {
      mixedPort: 34567,
      controllerPort: 34568,
      secret: SECRET
    })

    // All providers survive and are re-validatable by mihomo.
    expect(profileKernelConfigErrors(out)).toEqual([])
    expect(out).toContain('CloudCone')
    expect(out).toContain('PaoPaoGou')
    expect(out).toContain('境外下载')
    expect(out).toContain('include-all-providers')
    expect(out).toContain('geox-url')
    expect(out).toContain('store-selected')
    expect(out).toContain('fake-ip-range: 28.0.0.1/8')
    expect(out).toContain('MATCH,漏网之鱼')

    // The shared RuleProviders anchor is merged into each entry, so every
    // rule-provider retains its behavior/interval.
    expect(out).toMatch(/behavior: classical/)

    // Safety overrides hold even for the large config.
    expect(out).not.toMatch(/tun:/)
    expect(out).not.toMatch(/listeners:/)
    expect(out).not.toMatch(/listen: 0\.0\.0\.0:1053/)
    expect(out).toContain('allow-lan: false')
    expect(out).toContain('external-controller: 127.0.0.1:34568')
  })

  it('rejects a malformed caller secret', () => {
    expect(() =>
      buildProfileKernelConfig(USER_CONFIG, {
        mixedPort: 34567,
        controllerPort: 34568,
        secret: 'short'
      })
    ).toThrowError(/64-character/)
  })

  it('rejects when mixed-port equals the controller port', () => {
    expect(() =>
      buildProfileKernelConfig(USER_CONFIG, {
        mixedPort: 34568,
        controllerPort: 34568,
        secret: SECRET
      })
    ).toThrowError(/must differ/)
  })

  it('rejects a non-integer or privileged mixed-port', () => {
    expect(() =>
      buildProfileKernelConfig(USER_CONFIG, {
        mixedPort: 80,
        controllerPort: 34568,
        secret: SECRET
      })
    ).toThrowError(/invalid mixed-port/)
  })

  it('rejects a document that fails to parse as a mapping', () => {
    expect(() =>
      buildProfileKernelConfig('{{{{', {
        mixedPort: 34567,
        controllerPort: 34568,
        secret: SECRET
      })
    ).toThrowError(/解析失败/)
  })

  it('fails closed on an unresolvable YAML alias instead of leaking a raw error', () => {
    const broken = `rules:
  - MATCH,漏网之鱼
proxy-groups:
  - name: x
    type: select
    filter: *MissingAnchor
`
    expect(() =>
      buildProfileKernelConfig(broken, {
        mixedPort: 34567,
        controllerPort: 34568,
        secret: SECRET
      })
    ).toThrowError(/解析失败/)
  })
})

describe('profileKernelConfigErrors', () => {
  it('accepts a built profile config that has content', () => {
    const out = buildProfileKernelConfig(USER_CONFIG, {
      mixedPort: 34567,
      controllerPort: 34568,
      secret: SECRET
    })
    expect(profileKernelConfigErrors(out)).toEqual([])
  })

  it('flags an empty document', () => {
    expect(profileKernelConfigErrors('')).toEqual(['配置文档为空'])
  })

  it('flags a document without proxies/groups/rules', () => {
    const errors = profileKernelConfigErrors('mode: rule\n')
    expect(errors).toContain('文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段')
  })

  it('flags malformed YAML', () => {
    const errors = profileKernelConfigErrors('proxies: [ oops')
    expect(errors.some((m) => m.startsWith('YAML 解析错误'))).toBe(true)
  })
})
