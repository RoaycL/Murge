/**
 * Protocol-aware field layout for the node editor. Each field edits one
 * (dotted) key of the mihomo proxy map in place, so switching between the
 * form and the text view is lossless and keys the form does not know about
 * survive a save. Key names follow mihomo `adapter/outbound/*.go`.
 */
import type { ProxyConfig } from '@shared/local'

export type FieldKind = 'text' | 'secret' | 'number' | 'bool' | 'select' | 'segmented' | 'list' | 'kv' | 'multiline'

export interface FieldOption {
  value: string
  label: string
}

export interface FieldSpec {
  /** Dotted path into the proxy map (`ws-opts.headers.Host`). `$…` keys are editor-level. */
  key: string
  label: string
  kind: FieldKind
  placeholder?: string
  hint?: string
  options?: FieldOption[]
  required?: boolean
  /** Shown value when the key is absent (bool / select). */
  fallback?: unknown
  /** Bool fields: write `false` instead of deleting the key. */
  explicit?: boolean
  min?: number
  max?: number
  /** Select fields whose values are stored as numbers. */
  numeric?: boolean
  when?: (config: Record<string, unknown>) => boolean
  /** Custom value mapping (text shown <-> stored value). */
  format?: (value: unknown) => string
  parse?: (text: string) => unknown
}

export interface SectionSpec {
  title: string
  column: 'left' | 'right'
  fields: FieldSpec[]
  when?: (config: Record<string, unknown>) => boolean
}

export interface ProtocolSpec {
  id: string
  label: string
  type: string
  /** Has a server/port pair. */
  endpoint: boolean
  defaults: Record<string, unknown>
  sections: SectionSpec[]
  /** Separator after this entry in the protocol menu. */
  groupEnd?: boolean
}

// ---------------------------------------------------------------- helpers

const opts = (...values: Array<string | [string, string]>): FieldOption[] =>
  values.map((value) => (Array.isArray(value) ? { value: value[0], label: value[1] } : { value, label: value }))

const text = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'text', placeholder: '可选', ...extra })
const secret = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'secret', placeholder: '可选', ...extra })
const num = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'number', placeholder: '可选', ...extra })
const bool = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'bool', ...extra })
const select = (key: string, label: string, options: FieldOption[], extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'select', options, ...extra })
const list = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'list', placeholder: '可选，多个用逗号分隔', ...extra })

const isTrue = (key: string) => (config: Record<string, unknown>): boolean => getPath(config, key) === true
const isOneOf = (key: string, ...values: string[]) => (config: Record<string, unknown>): boolean => values.includes(String(getPath(config, key) ?? ''))

const CLIENT_FINGERPRINTS = opts(['', '默认'], 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random')

interface TlsOptions {
  /** The protocol has a `tls` on/off switch (otherwise TLS is always on). */
  toggle?: boolean
  sniKey?: 'sni' | 'servername' | null
  alpn?: boolean
  utls?: boolean
  reality?: boolean
  extra?: FieldSpec[]
}

function tlsSection(options: TlsOptions): SectionSpec {
  const on = options.toggle ? isTrue('tls') : undefined
  const fields: FieldSpec[] = []
  if (options.toggle) fields.push(bool('tls', '启用 TLS'))
  if (options.sniKey) fields.push(text(options.sniKey, '自定义 TLS SNI', { placeholder: '默认使用服务器地址', when: on }))
  fields.push(text('fingerprint', '证书固定', { placeholder: 'SHA-256 指纹，可选', when: on }))
  fields.push(bool('skip-cert-verify', '跳过服务器证书验证', { when: on }))
  if (options.alpn) fields.push(list('alpn', 'ALPN', { placeholder: '可选，例如 h2, http/1.1', when: on }))
  if (options.utls) fields.push(select('client-fingerprint', 'TLS 指纹（uTLS）', CLIENT_FINGERPRINTS, { fallback: '', when: on }))
  if (options.reality) {
    fields.push(text('reality-opts.public-key', 'REALITY 公钥', { hint: '填写后使用 REALITY', when: on }))
    fields.push(text('reality-opts.short-id', 'REALITY Short ID', { when: (c) => (!on || on(c)) && Boolean(getPath(c, 'reality-opts.public-key')) }))
  }
  fields.push(...(options.extra ?? []))
  return { title: 'TLS', column: 'left', fields }
}

function transportSection(networks: string[]): SectionSpec {
  const net = (...values: string[]) => isOneOf('network', ...values)
  return {
    title: '传输层',
    column: 'left',
    fields: [
      select('network', '传输方式', opts(...networks.map((value): [string, string] => [value, value === 'tcp' ? 'TCP（默认）' : value === 'ws' ? 'WebSocket' : value === 'grpc' ? 'gRPC' : value === 'h2' ? 'HTTP/2' : 'HTTP'])), { fallback: 'tcp' }),
      text('ws-opts.path', 'WebSocket 路径', { placeholder: '/', when: net('ws') }),
      text('ws-opts.headers.Host', 'WebSocket Host', { when: net('ws') }),
      bool('ws-opts.v2ray-http-upgrade', 'HTTPUpgrade', { hint: '使用 v2ray HTTPUpgrade 而不是 WebSocket', when: net('ws') }),
      text('grpc-opts.grpc-service-name', 'gRPC 服务名', { when: net('grpc') }),
      text('h2-opts.path', 'HTTP/2 路径', { placeholder: '/', when: net('h2') }),
      list('h2-opts.host', 'HTTP/2 Host', { when: net('h2') }),
      list('http-opts.path', 'HTTP 路径', { placeholder: '/', when: net('http') }),
      list('http-opts.headers.Host', 'HTTP Host', { when: net('http') })
    ]
  }
}

function credentials(userRequired = false): SectionSpec {
  return {
    title: '凭证',
    column: 'left',
    fields: [text('username', '用户名', userRequired ? { placeholder: '必填', required: true } : {}), secret('password', '密码')]
  }
}

function parseReserved(value: string): unknown {
  const textValue = value.trim()
  if (!textValue) return undefined
  const numbers = textValue.split(/[/,\s]+/).filter(Boolean).map(Number)
  if (numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return numbers
  if (/^[A-Za-z0-9+/]{4}$/.test(textValue)) return textValue
  throw new Error('Reserved 应为 1/2/3 形式的三个字节，或 4 位 base64')
}

const SS_CIPHERS = opts(
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
  'chacha20-ietf', 'xchacha20', 'rc4-md5', 'none'
)

const plugin = (...values: string[]) => isOneOf('plugin', ...values)

// --------------------------------------------------------------- protocols

export const PROTOCOLS: ProtocolSpec[] = [
  {
    id: 'http', label: 'HTTP', type: 'http', endpoint: true, defaults: {},
    sections: [credentials(), { title: 'HTTP', column: 'left', fields: [{ key: 'headers', label: 'Headers', kind: 'kv', placeholder: 'User-Agent: …\n每行一个' }] }]
  },
  {
    id: 'https', label: 'HTTPS', type: 'http', endpoint: true, defaults: { tls: true }, groupEnd: true,
    sections: [credentials(), tlsSection({ sniKey: 'sni' }), { title: 'HTTP', column: 'left', fields: [{ key: 'headers', label: 'Headers', kind: 'kv', placeholder: 'User-Agent: …\n每行一个' }] }]
  },
  { id: 'socks5', label: 'SOCKS5', type: 'socks5', endpoint: true, defaults: { udp: true }, sections: [credentials()] },
  { id: 'socks5-tls', label: 'SOCKS5-TLS', type: 'socks5', endpoint: true, defaults: { tls: true, udp: true }, groupEnd: true, sections: [credentials(), tlsSection({})] },
  {
    id: 'ssh', label: 'SSH', type: 'ssh', endpoint: true, defaults: { port: 22 }, groupEnd: true,
    sections: [{
      title: '凭证', column: 'left', fields: [
        text('username', '用户名', { placeholder: '必填', required: true }),
        secret('password', '密码'),
        { key: 'private-key', label: '私钥', kind: 'multiline', placeholder: '可选，粘贴私钥内容或填写文件路径' },
        secret('private-key-passphrase', '私钥密码'),
        list('host-key', '主机公钥', { hint: '填写后会校验服务器身份' })
      ]
    }]
  },
  {
    id: 'snell', label: 'Snell', type: 'snell', endpoint: true, defaults: { version: 3, udp: true },
    sections: [
      { title: 'Snell', column: 'left', fields: [
        secret('psk', 'PSK', { placeholder: '必填', required: true }),
        select('version', '版本', opts(['1', 'v1'], ['2', 'v2'], ['3', 'v3']), { fallback: '1', numeric: true }),
        select('obfs-opts.mode', '混淆', opts(['', '不使用'], 'http', 'tls'), { fallback: '' }),
        text('obfs-opts.host', '混淆 Host', { when: (c) => Boolean(getPath(c, 'obfs-opts.mode')) })
      ] }
    ]
  },
  {
    id: 'ss', label: 'Shadowsocks', type: 'ss', endpoint: true, defaults: { cipher: 'aes-128-gcm', udp: true },
    sections: [
      { title: 'Shadowsocks', column: 'left', fields: [
        select('cipher', '加密方式', SS_CIPHERS, { required: true }),
        secret('password', '密码', { placeholder: '必填', required: true }),
        bool('udp-over-tcp', 'UDP over TCP', { hint: '服务端需要支持' })
      ] },
      { title: '插件', column: 'left', fields: [
        select('plugin', '插件', opts(['', '不使用'], ['obfs', 'simple-obfs'], 'v2ray-plugin', 'shadow-tls'), { fallback: '' }),
        select('plugin-opts.mode', '模式', opts('http', 'tls'), { fallback: 'http', when: plugin('obfs') }),
        select('plugin-opts.mode', '模式', opts('websocket'), { fallback: 'websocket', when: plugin('v2ray-plugin') }),
        text('plugin-opts.host', 'Host', { when: plugin('obfs', 'v2ray-plugin', 'shadow-tls') }),
        text('plugin-opts.path', '路径', { when: plugin('v2ray-plugin') }),
        bool('plugin-opts.tls', 'TLS', { when: plugin('v2ray-plugin') }),
        secret('plugin-opts.password', 'ShadowTLS 密码', { when: plugin('shadow-tls') }),
        select('plugin-opts.version', 'ShadowTLS 版本', opts(['1', 'v1'], ['2', 'v2'], ['3', 'v3']), { fallback: '2', numeric: true, when: plugin('shadow-tls') })
      ] }
    ]
  },
  {
    id: 'vmess', label: 'VMess', type: 'vmess', endpoint: true, defaults: { uuid: '', alterId: 0, cipher: 'auto', udp: true },
    sections: [
      { title: 'VMess', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: '必填', required: true }),
        num('alterId', 'Alter ID', { placeholder: '0', min: 0, max: 65535, fallback: 0 }),
        select('cipher', '加密方式', opts('auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'), { fallback: 'auto' })
      ] },
      transportSection(['tcp', 'ws', 'grpc', 'h2', 'http']),
      tlsSection({ toggle: true, sniKey: 'servername', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'vless', label: 'VLESS', type: 'vless', endpoint: true, defaults: { uuid: '', udp: true, tls: true },
    sections: [
      { title: 'VLESS', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: '必填', required: true }),
        select('flow', 'Flow', opts(['', '不使用'], 'xtls-rprx-vision'), { fallback: '' }),
        select('packet-encoding', 'UDP 封装', opts(['', '默认'], 'xudp', 'packetaddr'), { fallback: '' })
      ] },
      transportSection(['tcp', 'ws', 'grpc', 'h2', 'http']),
      tlsSection({ toggle: true, sniKey: 'servername', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'trojan', label: 'Trojan', type: 'trojan', endpoint: true, defaults: { udp: true },
    sections: [
      { title: 'Trojan', column: 'left', fields: [secret('password', '密码', { placeholder: '必填', required: true })] },
      transportSection(['tcp', 'ws', 'grpc']),
      tlsSection({ sniKey: 'sni', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'anytls', label: 'AnyTLS', type: 'anytls', endpoint: true, defaults: { udp: true }, groupEnd: true,
    sections: [
      { title: 'AnyTLS', column: 'left', fields: [
        secret('password', '密码', { placeholder: '必填', required: true }),
        num('idle-session-check-interval', '空闲检查间隔（秒）', { placeholder: '30' }),
        num('idle-session-timeout', '空闲会话超时（秒）', { placeholder: '30' }),
        num('min-idle-session', '最少空闲会话', { placeholder: '0' })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true, utls: true })
    ]
  },
  {
    id: 'tuic', label: 'TUIC v5', type: 'tuic', endpoint: true, defaults: { uuid: '', password: '', alpn: ['h3'], 'congestion-controller': 'bbr', 'udp-relay-mode': 'native' },
    sections: [
      { title: 'TUIC', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: '必填', required: true }),
        secret('password', '密码', { placeholder: '必填', required: true }),
        select('congestion-controller', '拥塞控制', opts('bbr', 'cubic', 'new_reno'), { fallback: 'cubic' }),
        select('udp-relay-mode', 'UDP 转发模式', opts('native', 'quic'), { fallback: 'native' }),
        bool('reduce-rtt', '0-RTT', { hint: '减少握手延迟，有被重放的风险' }),
        num('heartbeat-interval', '心跳间隔（毫秒）', { placeholder: '10000' }),
        num('request-timeout', '请求超时（毫秒）', { placeholder: '8000' })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true, extra: [bool('disable-sni', '不发送 SNI')] })
    ]
  },
  {
    id: 'hysteria2', label: 'Hysteria 2', type: 'hysteria2', endpoint: true, defaults: {}, groupEnd: true,
    sections: [
      { title: 'Hysteria 2', column: 'left', fields: [
        secret('password', '密码', { placeholder: '必填', required: true }),
        text('ports', '端口跳跃', { placeholder: '可选，例如 20000-30000', hint: '填写后在这些端口之间跳跃' }),
        num('hop-interval', '跳跃间隔（秒）', { placeholder: '30', when: (c) => Boolean(c.ports) }),
        text('up', '上行带宽', { placeholder: '可选，例如 50 Mbps', hint: '同时填写上下行时使用 Brutal 拥塞控制' }),
        text('down', '下行带宽', { placeholder: '可选，例如 200 Mbps' }),
        select('obfs', '混淆', opts(['', '不使用'], 'salamander'), { fallback: '' }),
        secret('obfs-password', '混淆密码', { when: (c) => Boolean(c.obfs) })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true })
    ]
  },
  {
    id: 'wireguard', label: 'WireGuard', type: 'wireguard', endpoint: true, defaults: { port: 51820, udp: true, 'allowed-ips': ['0.0.0.0/0', '::/0'] },
    sections: [
      { title: '密钥', column: 'left', fields: [
        secret('private-key', '本机私钥', { placeholder: '必填', required: true }),
        text('public-key', '对端公钥', { placeholder: '必填', required: true }),
        secret('pre-shared-key', '预共享密钥')
      ] },
      { title: '隧道', column: 'left', fields: [
        text('ip', '隧道 IPv4', { placeholder: '例如 10.0.0.2/32', hint: 'IPv4 和 IPv6 至少填一个' }),
        text('ipv6', '隧道 IPv6'),
        list('allowed-ips', '允许的 IP', { placeholder: '0.0.0.0/0, ::/0', hint: '只填内网段时，这个节点只能访问这些地址' }),
        list('dns', '隧道内 DNS', { placeholder: '可选，例如 1.1.1.1' }),
        bool('remote-dns-resolve', '在隧道内解析域名', { when: (c) => Array.isArray(c.dns) && c.dns.length > 0 }),
        num('mtu', 'MTU', { placeholder: '1408', min: 576, max: 9000 }),
        num('persistent-keepalive', 'Keepalive（秒）', { min: 1, max: 3600 }),
        {
          key: 'reserved', label: 'Reserved', kind: 'text', placeholder: '可选，WARP 用，如 1/2/3',
          format: (value) => (Array.isArray(value) ? value.join('/') : value == null ? '' : String(value)),
          parse: parseReserved
        }
      ] }
    ]
  },
  {
    id: 'tailscale', label: 'Tailscale', type: 'tailscale', endpoint: false, defaults: { hostname: 'murge', 'accept-routes': true, udp: true },
    sections: [
      { title: 'Tailscale', column: 'left', fields: [
        secret('auth-key', 'Auth Key', { placeholder: '可选，tskey-auth-…', hint: '不填时，首次启动的登录链接会出现在“日志”页' }),
        text('control-url', 'Control URL', { placeholder: '可选，Headscale 等自建控制服务器' }),
        text('hostname', 'Hostname', { placeholder: '设备名' }),
        text('exit-node', 'Exit Node', { placeholder: '可选，节点名或 100.x 地址', hint: '不设置时只能访问 tailnet 内的设备' }),
        bool('exit-node-allow-lan-access', '使用 Exit Node 时仍可访问局域网', { fallback: true, explicit: true, when: (c) => Boolean(c['exit-node']) }),
        bool('accept-routes', '接受子网路由', { fallback: true, explicit: true }),
        bool('ephemeral', '临时设备', { hint: '离线后自动从 tailnet 移除' }),
        bool('$tailnetRules', '自动添加 MagicDNS 和 tailnet 规则', { hint: '*.ts.net、100.64.0.0/10、fd7a:115c:a1e0::/48 走此节点，MagicDNS 也经由它解析' })
      ] }
    ]
  },
  { id: 'direct', label: '绑定网络接口', type: 'direct', endpoint: false, defaults: {}, sections: [] }
]

const BY_ID = new Map(PROTOCOLS.map((spec) => [spec.id, spec]))

export function protocolById(id: string): ProtocolSpec | null {
  return BY_ID.get(id) ?? null
}

/** The editor protocol for a config, or null when the form does not cover it. */
export function protocolOf(config: Record<string, unknown>): ProtocolSpec | null {
  const type = String(config.type ?? '').toLowerCase()
  if (type === 'http') return BY_ID.get(config.tls === true ? 'https' : 'http')!
  if (type === 'socks5') return BY_ID.get(config.tls === true ? 'socks5-tls' : 'socks5')!
  if (type === 'shadowsocks') return BY_ID.get('ss')!
  return PROTOCOLS.find((spec) => spec.type === type && spec.id !== 'https' && spec.id !== 'socks5-tls') ?? null
}

/** Shared right-column sections: chain, outbound and options. */
export function commonSections(spec: ProtocolSpec, dialerOptions: FieldOption[]): SectionSpec[] {
  const sections: SectionSpec[] = []
  if (spec.id !== 'direct') {
    sections.push({ title: '代理链', column: 'right', fields: [select('dialer-proxy', '跳板代理', dialerOptions, { fallback: '', hint: '先经过这个代理再连接本节点' })] })
  }
  sections.push({
    title: '出站设置',
    column: 'right',
    fields: [
      text('interface-name', '网络接口', spec.id === 'direct'
        ? { placeholder: '必填，例如 以太网', required: true, hint: '经此策略的连接直接从这个网卡发出' }
        : { placeholder: '可选，例如 以太网', hint: '强制从指定网卡连接服务器，例如另一个网卡或 VPN' }),
      num('routing-mark', '路由标记', { min: 0, max: 2147483647, hint: 'Windows 上不生效' }),
      select('ip-version', 'IP 版本', opts(['', '默认'], ['dual', '双栈'], ['ipv4', '仅 IPv4'], ['ipv6', '仅 IPv6'], ['ipv4-prefer', 'IPv4 优先'], ['ipv6-prefer', 'IPv6 优先']), {
        fallback: '',
        hint: '只影响到服务器的连接，服务器填域名时才有意义'
      })
    ]
  })
  const options: FieldSpec[] = []
  if (['socks5', 'socks5-tls', 'snell', 'ss', 'vmess', 'vless', 'trojan', 'anytls'].includes(spec.id)) options.push(bool('udp', '转发 UDP', { hint: '关闭后 UDP 流量不经过此节点' }))
  if (spec.id !== 'tailscale' && spec.id !== 'wireguard') options.push(bool('tfo', 'TCP Fast Open（实验性）'))
  if (spec.id !== 'tailscale') options.push(bool('mptcp', 'Multipath TCP'))
  if (['ss', 'vmess', 'vless', 'trojan'].includes(spec.id)) {
    options.push(bool('smux.enabled', '多路复用（sing-mux）', { hint: '服务端需要支持' }))
    options.push(select('smux.protocol', '多路复用协议', opts('h2mux', 'smux', 'yamux'), { fallback: 'h2mux', when: isTrue('smux.enabled') }))
  }
  if (options.length) sections.push({ title: '选项', column: 'right', fields: options })
  return sections
}

// ------------------------------------------------------------ value access

export function getPath(config: Record<string, unknown>, path: string): unknown {
  let value: unknown = config
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Set a dotted key; `undefined` deletes it and prunes emptied parents. */
export function setPath(config: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const stack: Array<Record<string, unknown>> = [config]
  let node = config
  for (const part of parts.slice(0, -1)) {
    let next = node[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (value === undefined) return
      next = {}
      node[part] = next
    }
    node = next as Record<string, unknown>
    stack.push(node)
  }
  const last = parts[parts.length - 1]!
  if (value === undefined) delete node[last]
  else node[last] = value
  for (let index = stack.length - 1; index > 0; index--) {
    if (Object.keys(stack[index]!).length) break
    delete stack[index - 1]![parts[index - 1]!]
  }
}

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

/** Text shown in an input for a field. */
export function fieldText(field: FieldSpec, config: Record<string, unknown>): string {
  const value = getPath(config, field.key)
  if (field.format) return field.format(value)
  if (value === undefined || value === null) return ''
  if (field.kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value)
  if (field.kind === 'kv') {
    if (!value || typeof value !== 'object') return ''
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(', ') : String(item)}`).join('\n')
  }
  return String(value)
}

export function fieldBool(field: FieldSpec, config: Record<string, unknown>): boolean {
  const value = getPath(config, field.key)
  return value === undefined ? field.fallback === true : value === true
}

export function fieldSelectValue(field: FieldSpec, config: Record<string, unknown>): string {
  const value = getPath(config, field.key)
  return value === undefined || value === null ? String(field.fallback ?? field.options?.[0]?.value ?? '') : String(value)
}

/** Apply an edit from the form. Throws a readable message on invalid input. */
export function applyField(field: FieldSpec, config: Record<string, unknown>, input: string | boolean): void {
  if (field.kind === 'bool') {
    const on = input === true
    const isDefault = on === (field.fallback === true)
    setPath(config, field.key, isDefault && !field.explicit ? undefined : on)
    return
  }
  const raw = String(input)
  if (field.parse) {
    setPath(config, field.key, field.parse(raw))
    return
  }
  if (field.kind === 'select' || field.kind === 'segmented') {
    // Numeric option values (versions) are stored as numbers.
    setPath(config, field.key, raw === '' ? undefined : field.numeric ? Number(raw) : raw)
    return
  }
  if (field.kind === 'list') {
    const items = raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
    setPath(config, field.key, items.length ? items : undefined)
    return
  }
  if (field.kind === 'kv') {
    const map: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const index = line.indexOf(':')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      if (key) map[key] = line.slice(index + 1).trim()
    }
    setPath(config, field.key, Object.keys(map).length ? map : undefined)
    return
  }
  if (field.kind === 'number') {
    const textValue = raw.trim()
    if (!textValue) {
      setPath(config, field.key, undefined)
      return
    }
    // Keep partially typed input as text; validation reports it on save.
    const value = Number(textValue)
    setPath(config, field.key, Number.isFinite(value) && /^-?\d+(\.\d+)?$/.test(textValue) ? value : textValue)
    return
  }
  setPath(config, field.key, raw === '' ? undefined : field.kind === 'multiline' ? raw : raw.trim() === '' ? undefined : raw)
}

export function visibleSections(sections: SectionSpec[], config: Record<string, unknown>): SectionSpec[] {
  return sections
    .filter((section) => !section.when || section.when(config))
    .map((section) => ({ ...section, fields: section.fields.filter((field) => !field.when || field.when(config)) }))
    .filter((section) => section.fields.length > 0)
}

/** Keys kept when switching protocol: identity, endpoint and outbound basics. */
const PORTABLE_KEYS = ['name', 'server', 'port', 'dialer-proxy', 'interface-name', 'routing-mark', 'ip-version', 'tfo', 'mptcp']

export function switchProtocol(config: Record<string, unknown>, next: ProtocolSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { name: config.name ?? '', type: next.type }
  for (const key of PORTABLE_KEYS) {
    if (key === 'name') continue
    if ((key === 'server' || key === 'port') && !next.endpoint) continue
    if (config[key] !== undefined) out[key] = config[key]
  }
  for (const [key, value] of Object.entries(next.defaults)) {
    if (key === 'port' && out.port !== undefined) continue
    out[key] = structuredClone(value)
  }
  return out
}

export function newConfig(spec: ProtocolSpec): Record<string, unknown> {
  return switchProtocol({ name: '' }, spec)
}

/** Check a config against the form before saving. */
export function validateConfig(spec: ProtocolSpec, config: Record<string, unknown>, sections: SectionSpec[]): ProxyConfig {
  const name = String(config.name ?? '').trim()
  if (!name) throw new Error('请填写名称')
  if (spec.endpoint) {
    if (!String(config.server ?? '').trim()) throw new Error('请填写服务器地址')
    const port = config.port
    const hasPorts = spec.id === 'hysteria2' && Boolean(String(config.ports ?? '').trim())
    if (port === undefined && !hasPorts) throw new Error('请填写端口')
    if (port !== undefined && !(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)) throw new Error('端口应为 1-65535 的整数')
  }
  for (const section of visibleSections(sections, config)) {
    for (const field of section.fields) {
      if (field.key.startsWith('$')) continue
      const value = getPath(config, field.key)
      if (field.required && isBlank(value)) throw new Error(`请填写${field.label}`)
      if (field.kind === 'number' && value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field.label}应为数字`)
        if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          throw new Error(`${field.label}应在 ${field.min ?? '-∞'}-${field.max ?? '∞'} 之间`)
        }
      }
    }
  }
  if (spec.id === 'wireguard' && !Array.isArray(config.peers) && isBlank(config.ip) && isBlank(config.ipv6)) throw new Error('请至少填写一个隧道地址（IPv4 或 IPv6）')
  const out: Record<string, unknown> = { ...config, name, type: spec.type }
  if (typeof out.server === 'string') out.server = out.server.trim()
  return out as ProxyConfig
}
