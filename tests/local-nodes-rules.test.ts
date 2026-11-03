import { describe, expect, it } from 'vitest'
import { nameFromFileName, parseEndpoint, parseWireGuardText } from '@shared/wireguard-conf'
import { formatRuleLine, isTailscaleDnsSafeName, parseRuleLine, ruleIdentity, splitRuleLine, tailnetRulesFor } from '@shared/local'
import {
  nodeSummary,
  parseProxiesYaml,
  tailscaleConfigFrom,
  tailscaleFormFrom,
  emptyTailscaleForm,
  wireGuardConfigFrom,
  wireGuardFormFrom,
  wireGuardNeedsYaml
} from '@renderer/lib/local-node-form'

const WG_QUICK = `[Interface]
# home server
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5MDA=
Address = 10.8.0.2/32, fd00:8::2/128
DNS = 1.1.1.1, 8.8.8.8, home.lan
MTU = 1420
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT

[Peer]
PublicKey = cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMDA=
PresharedKey = cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrMDA=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`

describe('wg-quick import', () => {
  it('maps a single-peer config to a mihomo wireguard proxy', () => {
    const { config, warnings } = parseWireGuardText(WG_QUICK, 'home')
    expect(config).toEqual({
      name: 'home',
      type: 'wireguard',
      'private-key': 'cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5MDA=',
      ip: '10.8.0.2/32',
      ipv6: 'fd00:8::2/128',
      'remote-dns-resolve': true,
      dns: ['1.1.1.1', '8.8.8.8'],
      mtu: 1420,
      'persistent-keepalive': 25,
      server: 'vpn.example.com',
      port: 51820,
      'public-key': 'cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMDA=',
      'pre-shared-key': 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrMDA=',
      'allowed-ips': ['0.0.0.0/0', '::/0'],
      udp: true
    })
    expect(warnings.join()).toContain('PostUp')
    expect(warnings.join()).toContain('搜索域')
  })

  it('keeps several peers and AmneziaWG fields', () => {
    const text = `[Interface]
PrivateKey = a
Address = 10.0.0.2/24
Jc = 4
H1 = 1234

[Peer]
PublicKey = p1
Endpoint = [2001:db8::1]:51820
AllowedIPs = 10.0.1.0/24

[Peer]
PublicKey = p2
Endpoint = 203.0.113.9:443
AllowedIPs = 10.0.2.0/24
`
    const { config } = parseWireGuardText(text)
    expect(config['amnezia-wg-option']).toEqual({ jc: 4, h1: '1234' })
    expect(config.peers).toEqual([
      { server: '2001:db8::1', port: 51820, 'public-key': 'p1', 'allowed-ips': ['10.0.1.0/24'] },
      { server: '203.0.113.9', port: 443, 'public-key': 'p2', 'allowed-ips': ['10.0.2.0/24'] }
    ])
    expect(config.server).toBeUndefined()
    expect(wireGuardNeedsYaml(config)).toBe(true)
  })

  it('reads Surge [WireGuard] sections including WARP client-id', () => {
    const text = `[WireGuard warp]
private-key = k
self-ip = 172.16.0.2
self-ip-v6 = 2606:4700::2
dns-server = 1.1.1.1
mtu = 1280
peer = (public-key = pub, allowed-ips = "0.0.0.0/0, ::/0", endpoint = engage.cloudflareclient.com:2408, keepalive = 45, client-id = 83/12/235)
`
    const { config } = parseWireGuardText(text)
    expect(config.name).toBe('warp')
    expect(config.ip).toBe('172.16.0.2')
    expect(config.ipv6).toBe('2606:4700::2')
    expect(config.reserved).toEqual([83, 12, 235])
    expect(config['allowed-ips']).toEqual(['0.0.0.0/0', '::/0'])
    expect(config['persistent-keepalive']).toBe(45)
  })

  it('rejects incomplete configs with a readable reason', () => {
    expect(() => parseWireGuardText('[Interface]\nAddress = 10.0.0.2\n[Peer]\nPublicKey = x\nEndpoint = a:1\n')).toThrow('PrivateKey')
    expect(() => parseWireGuardText('[Interface]\nPrivateKey = k\nAddress = 10.0.0.2\n[Peer]\nPublicKey = x\n')).toThrow('Peer')
    expect(() => parseWireGuardText('hello')).toThrow('无法识别')
  })

  it('parses endpoints and file names', () => {
    expect(parseEndpoint('[::1]:51820')).toEqual({ server: '::1', port: 51820 })
    expect(parseEndpoint('host:70000')).toBeNull()
    expect(nameFromFileName('C:\\Users\\a\\家里.conf')).toBe('家里')
  })
})

describe('node editor forms', () => {
  it('round-trips WireGuard and keeps unmanaged keys', () => {
    const { config } = parseWireGuardText(WG_QUICK, 'home')
    const base = { ...config, 'refresh-server-ip-interval': 60 }
    const form = wireGuardFormFrom(base)
    expect(form.dns).toBe('1.1.1.1, 8.8.8.8')
    form.dns = ''
    form.reserved = '1/2/3'
    const next = wireGuardConfigFrom(form, base)
    expect(next['refresh-server-ip-interval']).toBe(60)
    expect(next.dns).toBeUndefined()
    expect(next['remote-dns-resolve']).toBeUndefined()
    expect(next.reserved).toEqual([1, 2, 3])
    expect(() => wireGuardConfigFrom({ ...form, port: '0' })).toThrow('端口')
  })

  it('builds Tailscale configs', () => {
    const form = { ...emptyTailscaleForm(), authKey: 'tskey-auth-x', controlUrl: 'https://hs.example.com', exitNode: 'office' }
    const config = tailscaleConfigFrom(form)
    expect(config).toMatchObject({ name: 'Tailscale', type: 'tailscale', 'auth-key': 'tskey-auth-x', 'control-url': 'https://hs.example.com', 'exit-node': 'office', 'accept-routes': true, 'exit-node-allow-lan-access': true, udp: true })
    expect(tailscaleFormFrom(config).exitNode).toBe('office')
    expect(nodeSummary(config)).toBe('hs.example.com · 出口节点 office')
    expect(() => tailscaleConfigFrom({ ...form, hostname: 'bad name' })).toThrow('设备名')
  })

  it('parses pasted proxies in every common shape', () => {
    expect(parseProxiesYaml('{name: a, type: ss, server: s, port: 1}')).toHaveLength(1)
    expect(parseProxiesYaml('- {name: a, type: ss}\n- {name: b, type: vmess}\n')).toHaveLength(2)
    expect(parseProxiesYaml('proxies:\n  - name: c\n    type: trojan\n')[0].name).toBe('c')
    expect(() => parseProxiesYaml('- {type: ss}')).toThrow('name')
  })
})

describe('rule helpers', () => {
  it('splits logic rules and formats lines', () => {
    expect(splitRuleLine('AND,((DOMAIN,a),(NETWORK,UDP)),REJECT')).toEqual(['AND', '((DOMAIN,a),(NETWORK,UDP))', 'REJECT'])
    expect(parseRuleLine('ip-cidr,10.0.0.0/8,DIRECT,no-resolve')).toEqual({ type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'DIRECT', noResolve: true })
    expect(formatRuleLine({ type: 'DOMAIN', payload: ' a.com ', target: 'P', noResolve: true })).toBe('DOMAIN,a.com,P')
    expect(formatRuleLine({ type: 'MATCH', payload: '', target: 'P', noResolve: false })).toBe('MATCH,P')
    expect(parseRuleLine('DOMAIN,a.com')).toBeNull()
  })

  it('compares config rules with controller rows', () => {
    expect(ruleIdentity('DOMAIN-SUFFIX', 'Google.com', 'Proxy')).toBe(ruleIdentity('DomainSuffix', 'google.com', 'Proxy'))
    expect(ruleIdentity('IP-CIDR6', 'fd00::/8', 'D')).toBe(ruleIdentity('IPCIDR', 'fd00::/8', 'D'))
  })

  it('matches the Rust tailnet rule set and DNS-safe names', () => {
    expect(tailnetRulesFor('TS')).toEqual(['DOMAIN-SUFFIX,ts.net,TS', 'IP-CIDR,100.64.0.0/10,TS,no-resolve', 'IP-CIDR6,fd7a:115c:a1e0::/48,TS,no-resolve'])
    expect(isTailscaleDnsSafeName('家里')).toBe(true)
    expect(isTailscaleDnsSafeName('my tailnet')).toBe(false)
  })
})
