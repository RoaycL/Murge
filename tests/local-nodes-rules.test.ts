import { describe, expect, it } from 'vitest'
import { nameFromFileName, parseEndpoint, parseWireGuardText } from '@shared/wireguard-conf'
import { formatRuleLine, isTailscaleDnsSafeName, parseRuleLine, ruleIdentity, splitRuleLine, tailnetRulesFor } from '@shared/local'
import { nodeSummary, parseNodeText, parseProxiesYaml } from '@renderer/lib/local-node-form'
import {
  PROTOCOLS,
  applyField,
  commonSections,
  fieldText,
  getPath,
  newConfig,
  protocolById,
  protocolOf,
  setPath,
  switchProtocol,
  validateConfig,
  visibleSections,
  type FieldSpec
} from '@renderer/lib/proxy-schema'
import { parseShareLink, parseSurgeLine } from '@shared/proxy-import'

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

describe('node editor schema', () => {
  const sectionsOf = (id: string) => {
    const spec = protocolById(id)!
    return [...spec.sections, ...commonSections(spec, [{ value: '', label: '不使用' }])]
  }
  const field = (id: string, key: string): FieldSpec => sectionsOf(id).flatMap((section) => section.fields).find((item) => item.key === key)!

  it('maps configs to editor protocols', () => {
    expect(protocolOf({ type: 'http', tls: true })?.id).toBe('https')
    expect(protocolOf({ type: 'socks5' })?.id).toBe('socks5')
    expect(protocolOf({ type: 'Shadowsocks' })?.id).toBe('ss')
    expect(protocolOf({ type: 'hysteria2' })?.id).toBe('hysteria2')
    expect(protocolOf({ type: 'mieru' })).toBeNull()
    expect(new Set(PROTOCOLS.map((spec) => spec.id)).size).toBe(PROTOCOLS.length)
  })

  it('edits dotted keys and prunes emptied objects', () => {
    const config: Record<string, unknown> = { name: 'a' }
    setPath(config, 'ws-opts.headers.Host', 'cdn.example.com')
    expect(getPath(config, 'ws-opts.headers.Host')).toBe('cdn.example.com')
    setPath(config, 'ws-opts.headers.Host', undefined)
    expect(config['ws-opts']).toBeUndefined()
  })

  it('applies typed field input and keeps unknown keys', () => {
    const config: Record<string, unknown> = { ...newConfig(protocolById('wireguard')!), name: 'wg', 'refresh-server-ip-interval': 60 }
    applyField(field('wireguard', 'reserved'), config, '1/2/3')
    applyField(field('wireguard', 'allowed-ips'), config, '10.0.0.0/8, 192.168.0.0/16')
    applyField(field('wireguard', 'mtu'), config, '1380')
    expect(config).toMatchObject({ reserved: [1, 2, 3], 'allowed-ips': ['10.0.0.0/8', '192.168.0.0/16'], mtu: 1380, 'refresh-server-ip-interval': 60 })
    expect(fieldText(field('wireguard', 'reserved'), config)).toBe('1/2/3')
    expect(() => applyField(field('wireguard', 'reserved'), config, '1/2')).toThrow('Reserved')
    const snell: Record<string, unknown> = newConfig(protocolById('snell')!)
    applyField(field('snell', 'version'), snell, '2')
    expect(snell.version).toBe(2)
    applyField(field('snell', 'udp'), snell, false)
    expect(snell.udp).toBeUndefined()
  })

  it('switches protocol keeping endpoint and outbound basics', () => {
    const next = switchProtocol({ name: 'n', type: 'ss', server: 's', port: 8388, cipher: 'aes-128-gcm', password: 'p', 'dialer-proxy': 'Relay' }, protocolById('trojan')!)
    expect(next).toEqual({ name: 'n', type: 'trojan', server: 's', port: 8388, 'dialer-proxy': 'Relay', udp: true })
    expect(switchProtocol(next, protocolById('tailscale')!)).toMatchObject({ name: 'n', type: 'tailscale', 'accept-routes': true })
    expect(switchProtocol(next, protocolById('tailscale')!).server).toBeUndefined()
  })

  it('validates required and numeric fields of visible sections only', () => {
    const spec = protocolById('vmess')!
    const config: Record<string, unknown> = { ...newConfig(spec), name: 'v', server: 'h', port: 443 }
    expect(() => validateConfig(spec, config, sectionsOf('vmess'))).toThrow('UUID')
    config.uuid = 'id'
    config.alterId = 'x'
    expect(() => validateConfig(spec, config, sectionsOf('vmess'))).toThrow('Alter ID')
    config.alterId = 0
    expect(validateConfig(spec, config, sectionsOf('vmess'))).toMatchObject({ type: 'vmess', uuid: 'id' })
    expect(() => validateConfig(spec, { ...config, port: 70000 }, sectionsOf('vmess'))).toThrow('端口')
    const wg = protocolById('wireguard')!
    expect(() => validateConfig(wg, { ...newConfig(wg), name: 'w', server: 's', 'private-key': 'k', 'public-key': 'p' }, sectionsOf('wireguard'))).toThrow('隧道地址')
    const hy2 = protocolById('hysteria2')!
    expect(validateConfig(hy2, { name: 'h', type: 'hysteria2', server: 'h', ports: '2000-3000', password: 'p' }, sectionsOf('hysteria2')).ports).toBe('2000-3000')
  })

  it('shows transport and TLS fields only when they apply', () => {
    const titles = (config: Record<string, unknown>) => visibleSections(sectionsOf('vmess'), config).flatMap((section) => section.fields.map((item) => item.key))
    const base = { type: 'vmess', network: 'tcp' }
    expect(titles(base)).not.toContain('ws-opts.path')
    expect(titles({ ...base, network: 'ws' })).toContain('ws-opts.path')
    expect(titles(base)).not.toContain('servername')
    expect(titles({ ...base, tls: true })).toContain('servername')
  })

  it('summarizes Tailscale nodes', () => {
    expect(nodeSummary({ type: 'tailscale', 'control-url': 'https://hs.example.com', 'exit-node': 'office' })).toBe('hs.example.com · 出口节点 office')
  })
})

describe('pasted node import', () => {
  it('parses share links', () => {
    const ss = parseShareLink('ss://' + btoa('aes-256-gcm:pa:ss') + '@1.2.3.4:8388?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dexample.com#%E9%A6%99%E6%B8%AF')
    expect(ss).toMatchObject({ name: '香港', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'pa:ss', plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'example.com' } })
    const vmess = parseShareLink('vmess://' + btoa(JSON.stringify({ v: '2', ps: 'JP', add: 'jp.example.com', port: '443', id: 'uuid', aid: '0', net: 'ws', host: 'cdn.example.com', path: '/ray', tls: 'tls', sni: 'jp.example.com' })))
    expect(vmess).toMatchObject({ name: 'JP', type: 'vmess', port: 443, uuid: 'uuid', alterId: 0, network: 'ws', tls: true, servername: 'jp.example.com', 'ws-opts': { path: '/ray', headers: { Host: 'cdn.example.com' } } })
    const vless = parseShareLink('vless://uuid@1.2.3.4:443?security=reality&sni=www.apple.com&fp=chrome&pbk=PUB&sid=ab&flow=xtls-rprx-vision&type=tcp#R')
    expect(vless).toMatchObject({ type: 'vless', tls: true, flow: 'xtls-rprx-vision', servername: 'www.apple.com', 'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': 'PUB', 'short-id': 'ab' } })
    expect(parseShareLink('hy2://secret@[2001:db8::1]:443?sni=a.com&obfs=salamander&obfs-password=o&insecure=1&mport=20000-30000#H')).toMatchObject({ type: 'hysteria2', server: '2001:db8::1', password: 'secret', ports: '20000-30000', obfs: 'salamander', 'skip-cert-verify': true })
    expect(parseShareLink('tuic://u:p@t.example.com:443?congestion_control=bbr&alpn=h3#T')).toMatchObject({ type: 'tuic', uuid: 'u', password: 'p', 'congestion-controller': 'bbr', alpn: ['h3'] })
    expect(parseShareLink('trojan://pw@t.example.com:443?sni=s.com&type=grpc&serviceName=svc#Tr')).toMatchObject({ type: 'trojan', sni: 's.com', network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc' } })
    expect(parseShareLink('socks5://u:p@10.0.0.1:1080#S')).toMatchObject({ type: 'socks5', username: 'u', password: 'p', port: 1080 })
    expect(() => parseShareLink('wat://x')).toThrow('不支持')
  })

  it('parses Surge proxy lines', () => {
    expect(parseSurgeLine('家宽 = snell, 1.2.3.4, 6160, psk=abc, version=3, obfs=http, obfs-host=bing.com, tfo=true')).toEqual({
      name: '家宽', type: 'snell', server: '1.2.3.4', port: 6160, psk: 'abc', version: 3, 'obfs-opts': { mode: 'http', host: 'bing.com' }, udp: true, tfo: true
    })
    expect(parseSurgeLine('H = https, h.example.com, 443, user, pass, skip-cert-verify=true')).toMatchObject({ type: 'http', tls: true, username: 'user', password: 'pass', 'skip-cert-verify': true })
    expect(parseSurgeLine('V = vmess, v.example.com, 443, username=uuid, ws=true, ws-path=/w, ws-headers=Host:cdn.com, tls=true, underlying-proxy=Relay')).toMatchObject({ uuid: 'uuid', alterId: 0, network: 'ws', 'ws-opts': { path: '/w', headers: { Host: 'cdn.com' } }, tls: true, 'dialer-proxy': 'Relay' })
    expect(parseSurgeLine('Y = hysteria2, y.example.com, 443, password=p, download-bandwidth=100, port-hopping="5000-6000;7000"')).toMatchObject({ type: 'hysteria2', down: '100 Mbps', ports: '5000-6000,7000' })
    expect(() => parseSurgeLine('S = snell, 1.2.3.4, 1, psk=a, version=4')).toThrow('v1-v3')
  })

  it('detects the content shape', () => {
    expect(parseNodeText('a = trojan, t.com, 443, password=x\nb = anytls, a.com, 443, password=y').configs.map((c) => c.type)).toEqual(['trojan', 'anytls'])
    expect(parseNodeText('{name: y, type: ss, server: s, port: 1}').configs[0]!.name).toBe('y')
    expect(parseNodeText(WG_QUICK, 'home').configs[0]!.type).toBe('wireguard')
    const blob = btoa('trojan://x@t.com:443#A\ntrojan://y@u.com:443#B')
    expect(parseNodeText(blob).configs).toHaveLength(2)
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

describe('node text round trip', () => {
  it('switches text back to the form while the name is still empty', async () => {
    const { parseNodeText } = await import('../src/renderer/src/lib/local-node-form')
    expect(() => parseNodeText('name: ""\ntype: ss\nserver: 1.2.3.4\nport: 8388\ncipher: aes-128-gcm\npassword: x', '')).toThrow()
    const { configs } = parseNodeText('name: ""\ntype: ss\nserver: 1.2.3.4\nport: 8388\ncipher: aes-128-gcm\npassword: x', '', { allowEmptyName: true })
    expect(configs[0]).toMatchObject({ type: 'ss', server: '1.2.3.4' })
  })
})

describe('Tailscale / WireGuard node info', () => {
  it('lists Surge-style sections and counts connections by network', async () => {
    const { nodeInfoSections } = await import('../src/renderer/src/lib/local-node-info')
    const connection = (network: string, exit: string) => ({ id: network + exit, metadata: { network }, upload: 0, download: 0, start: '', chains: [exit, 'Proxy'], rule: '', rulePayload: '' })
    const sections = nodeInfoSections({ name: 'TS', type: 'tailscale', hostname: 'pc', 'exit-node': 'nas' }, { status: '运行中', connections: [connection('tcp', 'TS'), connection('udp', 'TS'), connection('tcp', 'HK')] })
    expect(sections.map((section) => section.title)).toEqual(['连接', '设备', '活动', '路由'])
    expect(sections[2]!.rows).toEqual([{ label: '活跃 TCP 连接', value: '1' }, { label: '活跃 UDP 连接', value: '1' }])
    expect(sections[3]!.rows[0]).toEqual({ label: 'Exit Node', value: 'nas' })
    const wg = nodeInfoSections({ name: 'WG', type: 'wireguard', server: '1.2.3.4', port: 51820, ip: '10.0.0.2/32' }, { status: '运行中', connections: [] })
    expect(wg[0]!.rows).toContainEqual({ label: '服务器', value: '1.2.3.4:51820' })
    expect(wg[1]!.rows[0]).toEqual({ label: 'IPv4', value: '10.0.0.2/32' })
  })

  it('maps processes and proxy types to built-in marks', async () => {
    const { processBrand, proxyTypeBrand } = await import('../src/renderer/src/lib/brand-icons')
    expect(processBrand('tailscaled.exe')).toBe('tailscale')
    expect(processBrand(undefined, 'C:\\Program Files\\WireGuard\\wireguard.exe')).toBe('wireguard')
    expect(processBrand('chrome.exe')).toBeNull()
    expect(proxyTypeBrand('Tailscale')).toBe('tailscale')
    expect(proxyTypeBrand('WireGuard')).toBe('wireguard')
  })
})
