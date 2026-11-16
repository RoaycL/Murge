/**
 * Protocol-aware field layout for the node editor. Each field edits one
 * (dotted) key of the mihomo proxy map in place, so switching between the
 * form and the text view is lossless and keys the form does not know about
 * survive a save. Key names follow mihomo `adapter/outbound/*.go`.
 */
import { locale, t } from '@shared/i18n'
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

const text = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'text', placeholder: t('common.optional'), ...extra })
const secret = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'secret', placeholder: t('common.optional'), ...extra })
const num = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'number', placeholder: t('common.optional'), ...extra })
const bool = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'bool', ...extra })
const select = (key: string, label: string, options: FieldOption[], extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'select', options, ...extra })
const list = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: 'list', placeholder: t('proxyForm.optionalList'), ...extra })

const isTrue = (key: string) => (config: Record<string, unknown>): boolean => getPath(config, key) === true
const isOneOf = (key: string, ...values: string[]) => (config: Record<string, unknown>): boolean => values.includes(String(getPath(config, key) ?? ''))

const clientFingerprints = (): FieldOption[] => opts(['', t('common.default')], 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random')

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
  if (options.toggle) fields.push(bool('tls', t('proxyForm.enableTls')))
  if (options.sniKey) fields.push(text(options.sniKey, t('proxyForm.customSni'), { placeholder: t('proxyForm.sniPlaceholder'), when: on }))
  fields.push(text('fingerprint', t('proxyForm.certPin'), { placeholder: t('proxyForm.certPinPlaceholder'), when: on }))
  fields.push(bool('skip-cert-verify', t('proxyForm.skipCertVerify'), { when: on }))
  if (options.alpn) fields.push(list('alpn', 'ALPN', { placeholder: t('proxyForm.alpnPlaceholder'), when: on }))
  if (options.utls) fields.push(select('client-fingerprint', t('proxyForm.utls'), clientFingerprints(), { fallback: '', when: on }))
  if (options.reality) {
    fields.push(text('reality-opts.public-key', t('proxyForm.realityKey'), { hint: t('proxyForm.realityHint'), when: on }))
    fields.push(text('reality-opts.short-id', 'REALITY Short ID', { when: (c) => (!on || on(c)) && Boolean(getPath(c, 'reality-opts.public-key')) }))
  }
  fields.push(...(options.extra ?? []))
  return { title: 'TLS', column: 'left', fields }
}

function transportSection(networks: string[]): SectionSpec {
  const net = (...values: string[]) => isOneOf('network', ...values)
  return {
    title: t('proxyForm.transport'),
    column: 'left',
    fields: [
      select('network', t('proxyForm.network'), opts(...networks.map((value): [string, string] => [value, value === 'tcp' ? t('proxyForm.tcpDefault') : value === 'ws' ? 'WebSocket' : value === 'grpc' ? 'gRPC' : value === 'h2' ? 'HTTP/2' : 'HTTP'])), { fallback: 'tcp' }),
      text('ws-opts.path', t('proxyForm.wsPath'), { placeholder: '/', when: net('ws') }),
      text('ws-opts.headers.Host', 'WebSocket Host', { when: net('ws') }),
      bool('ws-opts.v2ray-http-upgrade', 'HTTPUpgrade', { hint: t('proxyForm.httpUpgradeHint'), when: net('ws') }),
      text('grpc-opts.grpc-service-name', t('proxyForm.grpcService'), { when: net('grpc') }),
      text('h2-opts.path', t('proxyForm.h2Path'), { placeholder: '/', when: net('h2') }),
      list('h2-opts.host', 'HTTP/2 Host', { when: net('h2') }),
      list('http-opts.path', t('proxyForm.httpPath'), { placeholder: '/', when: net('http') }),
      list('http-opts.headers.Host', 'HTTP Host', { when: net('http') })
    ]
  }
}

function credentials(userRequired = false): SectionSpec {
  return {
    title: t('proxyForm.credentials'),
    column: 'left',
    fields: [text('username', t('proxyForm.username'), userRequired ? { placeholder: t('common.required'), required: true } : {}), secret('password', t('proxyForm.password'))]
  }
}

function parseReserved(value: string): unknown {
  const textValue = value.trim()
  if (!textValue) return undefined
  const numbers = textValue.split(/[/,\s]+/).filter(Boolean).map(Number)
  if (numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return numbers
  if (/^[A-Za-z0-9+/]{4}$/.test(textValue)) return textValue
  throw new Error(t('proxyForm.reservedInvalid'))
}

const SS_CIPHERS = opts(
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
  'chacha20-ietf', 'xchacha20', 'rc4-md5', 'none'
)

const plugin = (...values: string[]) => isOneOf('plugin', ...values)

// --------------------------------------------------------------- protocols

const buildProtocols = (): ProtocolSpec[] => [
  {
    id: 'http', label: 'HTTP', type: 'http', endpoint: true, defaults: {},
    sections: [credentials(), { title: 'HTTP', column: 'left', fields: [{ key: 'headers', label: 'Headers', kind: 'kv', placeholder: t('proxyForm.headersPlaceholder') }] }]
  },
  {
    id: 'https', label: 'HTTPS', type: 'http', endpoint: true, defaults: { tls: true }, groupEnd: true,
    sections: [credentials(), tlsSection({ sniKey: 'sni' }), { title: 'HTTP', column: 'left', fields: [{ key: 'headers', label: 'Headers', kind: 'kv', placeholder: t('proxyForm.headersPlaceholder') }] }]
  },
  { id: 'socks5', label: 'SOCKS5', type: 'socks5', endpoint: true, defaults: { udp: true }, sections: [credentials()] },
  { id: 'socks5-tls', label: 'SOCKS5-TLS', type: 'socks5', endpoint: true, defaults: { tls: true, udp: true }, groupEnd: true, sections: [credentials(), tlsSection({})] },
  {
    id: 'ssh', label: 'SSH', type: 'ssh', endpoint: true, defaults: { port: 22 }, groupEnd: true,
    sections: [{
      title: t('proxyForm.credentials'), column: 'left', fields: [
        text('username', t('proxyForm.username'), { placeholder: t('common.required'), required: true }),
        secret('password', t('proxyForm.password')),
        { key: 'private-key', label: t('proxyForm.privateKey'), kind: 'multiline', placeholder: t('proxyForm.privateKeyPlaceholder') },
        secret('private-key-passphrase', t('proxyForm.privateKeyPassphrase')),
        list('host-key', t('proxyForm.hostKey'), { hint: t('proxyForm.hostKeyHint') })
      ]
    }]
  },
  {
    id: 'snell', label: 'Snell', type: 'snell', endpoint: true, defaults: { version: 3, udp: true },
    sections: [
      { title: 'Snell', column: 'left', fields: [
        secret('psk', 'PSK', { placeholder: t('common.required'), required: true }),
        select('version', t('proxyForm.version'), opts(['1', 'v1'], ['2', 'v2'], ['3', 'v3']), { fallback: '1', numeric: true }),
        select('obfs-opts.mode', t('proxyForm.obfs'), opts(['', t('nodeEditor.notUsed')], 'http', 'tls'), { fallback: '' }),
        text('obfs-opts.host', t('proxyForm.obfsHost'), { when: (c) => Boolean(getPath(c, 'obfs-opts.mode')) })
      ] }
    ]
  },
  {
    id: 'ss', label: 'Shadowsocks', type: 'ss', endpoint: true, defaults: { cipher: 'aes-128-gcm', udp: true },
    sections: [
      { title: 'Shadowsocks', column: 'left', fields: [
        select('cipher', t('proxyForm.cipher'), SS_CIPHERS, { required: true }),
        secret('password', t('proxyForm.password'), { placeholder: t('common.required'), required: true }),
        bool('udp-over-tcp', 'UDP over TCP', { hint: t('proxyForm.serverSupport') })
      ] },
      { title: t('proxyForm.plugin'), column: 'left', fields: [
        select('plugin', t('proxyForm.plugin'), opts(['', t('nodeEditor.notUsed')], ['obfs', 'simple-obfs'], 'v2ray-plugin', 'shadow-tls'), { fallback: '' }),
        select('plugin-opts.mode', t('proxyForm.mode'), opts('http', 'tls'), { fallback: 'http', when: plugin('obfs') }),
        select('plugin-opts.mode', t('proxyForm.mode'), opts('websocket'), { fallback: 'websocket', when: plugin('v2ray-plugin') }),
        text('plugin-opts.host', 'Host', { when: plugin('obfs', 'v2ray-plugin', 'shadow-tls') }),
        text('plugin-opts.path', t('proxyForm.path'), { when: plugin('v2ray-plugin') }),
        bool('plugin-opts.tls', 'TLS', { when: plugin('v2ray-plugin') }),
        secret('plugin-opts.password', t('proxyForm.shadowTlsPassword'), { when: plugin('shadow-tls') }),
        select('plugin-opts.version', t('proxyForm.shadowTlsVersion'), opts(['1', 'v1'], ['2', 'v2'], ['3', 'v3']), { fallback: '2', numeric: true, when: plugin('shadow-tls') })
      ] }
    ]
  },
  {
    id: 'vmess', label: 'VMess', type: 'vmess', endpoint: true, defaults: { uuid: '', alterId: 0, cipher: 'auto', udp: true },
    sections: [
      { title: 'VMess', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: t('common.required'), required: true }),
        num('alterId', 'Alter ID', { placeholder: '0', min: 0, max: 65535, fallback: 0 }),
        select('cipher', t('proxyForm.cipher'), opts('auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'), { fallback: 'auto' })
      ] },
      transportSection(['tcp', 'ws', 'grpc', 'h2', 'http']),
      tlsSection({ toggle: true, sniKey: 'servername', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'vless', label: 'VLESS', type: 'vless', endpoint: true, defaults: { uuid: '', udp: true, tls: true },
    sections: [
      { title: 'VLESS', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: t('common.required'), required: true }),
        select('flow', 'Flow', opts(['', t('nodeEditor.notUsed')], 'xtls-rprx-vision'), { fallback: '' }),
        select('packet-encoding', t('proxyForm.udpEncapsulation'), opts(['', t('common.default')], 'xudp', 'packetaddr'), { fallback: '' })
      ] },
      transportSection(['tcp', 'ws', 'grpc', 'h2', 'http']),
      tlsSection({ toggle: true, sniKey: 'servername', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'trojan', label: 'Trojan', type: 'trojan', endpoint: true, defaults: { udp: true },
    sections: [
      { title: 'Trojan', column: 'left', fields: [secret('password', t('proxyForm.password'), { placeholder: t('common.required'), required: true })] },
      transportSection(['tcp', 'ws', 'grpc']),
      tlsSection({ sniKey: 'sni', alpn: true, utls: true, reality: true })
    ]
  },
  {
    id: 'anytls', label: 'AnyTLS', type: 'anytls', endpoint: true, defaults: { udp: true }, groupEnd: true,
    sections: [
      { title: 'AnyTLS', column: 'left', fields: [
        secret('password', t('proxyForm.password'), { placeholder: t('common.required'), required: true }),
        num('idle-session-check-interval', t('proxyForm.idleCheckInterval'), { placeholder: '30' }),
        num('idle-session-timeout', t('proxyForm.idleTimeout'), { placeholder: '30' }),
        num('min-idle-session', t('proxyForm.minIdle'), { placeholder: '0' })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true, utls: true })
    ]
  },
  {
    id: 'tuic', label: 'TUIC v5', type: 'tuic', endpoint: true, defaults: { uuid: '', password: '', alpn: ['h3'], 'congestion-controller': 'bbr', 'udp-relay-mode': 'native' },
    sections: [
      { title: 'TUIC', column: 'left', fields: [
        text('uuid', 'UUID', { placeholder: t('common.required'), required: true }),
        secret('password', t('proxyForm.password'), { placeholder: t('common.required'), required: true }),
        select('congestion-controller', t('proxyForm.congestion'), opts('bbr', 'cubic', 'new_reno'), { fallback: 'cubic' }),
        select('udp-relay-mode', t('proxyForm.udpRelayMode'), opts('native', 'quic'), { fallback: 'native' }),
        bool('reduce-rtt', '0-RTT', { hint: t('proxyForm.zeroRttHint') }),
        num('heartbeat-interval', t('proxyForm.heartbeat'), { placeholder: '10000' }),
        num('request-timeout', t('proxyForm.requestTimeout'), { placeholder: '8000' })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true, extra: [bool('disable-sni', t('proxyForm.disableSni'))] })
    ]
  },
  {
    id: 'hysteria2', label: 'Hysteria 2', type: 'hysteria2', endpoint: true, defaults: {}, groupEnd: true,
    sections: [
      { title: 'Hysteria 2', column: 'left', fields: [
        secret('password', t('proxyForm.password'), { placeholder: t('common.required'), required: true }),
        text('ports', t('proxyForm.portHopping'), { placeholder: t('proxyForm.portsPlaceholder'), hint: t('proxyForm.portsHint') }),
        num('hop-interval', t('proxyForm.hopInterval'), { placeholder: '30', when: (c) => Boolean(c.ports) }),
        text('up', t('proxyForm.up'), { placeholder: t('proxyForm.upPlaceholder'), hint: t('proxyForm.brutalHint') }),
        text('down', t('proxyForm.down'), { placeholder: t('proxyForm.downPlaceholder') }),
        select('obfs', t('proxyForm.obfs'), opts(['', t('nodeEditor.notUsed')], 'salamander'), { fallback: '' }),
        secret('obfs-password', t('proxyForm.obfsPassword'), { when: (c) => Boolean(c.obfs) })
      ] },
      tlsSection({ sniKey: 'sni', alpn: true })
    ]
  },
  {
    id: 'wireguard', label: 'WireGuard', type: 'wireguard', endpoint: true, defaults: { port: 51820, udp: true, 'allowed-ips': ['0.0.0.0/0', '::/0'] },
    sections: [
      { title: t('proxyForm.keys'), column: 'left', fields: [
        secret('private-key', t('proxyForm.wgPrivateKey'), { placeholder: t('common.required'), required: true }),
        text('public-key', t('proxyForm.wgPublicKey'), { placeholder: t('common.required'), required: true }),
        secret('pre-shared-key', t('proxyForm.presharedKey'))
      ] },
      { title: t('proxyForm.tunnel'), column: 'left', fields: [
        text('ip', t('proxyForm.tunnelIpv4'), { placeholder: t('proxyForm.tunnelIpv4Placeholder'), hint: t('proxyForm.tunnelHint') }),
        text('ipv6', t('proxyForm.tunnelIpv6')),
        list('allowed-ips', t('proxyForm.allowedIps'), { placeholder: '0.0.0.0/0, ::/0', hint: t('proxyForm.allowedIpsHint') }),
        list('dns', t('proxyForm.tunnelDns'), { placeholder: t('proxyForm.tunnelDnsPlaceholder') }),
        bool('remote-dns-resolve', t('proxyForm.remoteDnsResolve'), { when: (c) => Array.isArray(c.dns) && c.dns.length > 0 }),
        num('mtu', 'MTU', { placeholder: '1408', min: 576, max: 9000 }),
        num('persistent-keepalive', t('proxyForm.keepalive'), { min: 1, max: 3600 }),
        {
          key: 'reserved', label: 'Reserved', kind: 'text', placeholder: t('proxyForm.reservedPlaceholder'),
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
        secret('auth-key', 'Auth Key', { placeholder: t('proxyForm.authKeyPlaceholder'), hint: t('proxyForm.authKeyHint') }),
        text('control-url', 'Control URL', { placeholder: t('proxyForm.controlUrlPlaceholder') }),
        text('hostname', 'Hostname', { placeholder: t('proxyForm.hostname') }),
        text('exit-node', 'Exit Node', { placeholder: t('proxyForm.exitNodePlaceholder'), hint: t('proxyForm.exitNodeHint') }),
        bool('exit-node-allow-lan-access', t('proxyForm.exitNodeLan'), { fallback: true, explicit: true, when: (c) => Boolean(c['exit-node']) }),
        bool('accept-routes', t('proxyForm.acceptRoutes'), { fallback: true, explicit: true }),
        bool('ephemeral', t('proxyForm.ephemeral'), { hint: t('proxyForm.ephemeralHint') }),
        bool('$tailnetRules', t('proxyForm.magicDnsRules'), { hint: t('proxyForm.magicDnsHint') })
      ] }
    ]
  },
  { id: 'direct', label: t('proxyForm.bindInterface'), type: 'direct', endpoint: false, defaults: {}, sections: [] }
]

// Labels are translated, so the table is built once per interface language.
const built = new Map<string, ProtocolSpec[]>()

export function protocols(): ProtocolSpec[] {
  let list = built.get(locale.value)
  if (!list) {
    list = buildProtocols()
    built.set(locale.value, list)
  }
  return list
}

const byId = (id: string): ProtocolSpec | undefined => protocols().find((spec) => spec.id === id)

export function protocolById(id: string): ProtocolSpec | null {
  return byId(id) ?? null
}

/** The editor protocol for a config, or null when the form does not cover it. */
export function protocolOf(config: Record<string, unknown>): ProtocolSpec | null {
  const type = String(config.type ?? '').toLowerCase()
  if (type === 'http') return byId(config.tls === true ? 'https' : 'http')!
  if (type === 'socks5') return byId(config.tls === true ? 'socks5-tls' : 'socks5')!
  if (type === 'shadowsocks') return byId('ss')!
  return protocols().find((spec) => spec.type === type && spec.id !== 'https' && spec.id !== 'socks5-tls') ?? null
}

/** Shared right-column sections: chain, outbound and options. */
export function commonSections(spec: ProtocolSpec, dialerOptions: FieldOption[]): SectionSpec[] {
  const sections: SectionSpec[] = []
  if (spec.id !== 'direct') {
    sections.push({ title: t('proxyForm.proxyChain'), column: 'right', fields: [select('dialer-proxy', t('proxyForm.dialerProxy'), dialerOptions, { fallback: '', hint: t('proxyForm.dialerProxyHint') })] })
  }
  sections.push({
    title: t('proxyForm.outbound'),
    column: 'right',
    fields: [
      text('interface-name', t('proxyForm.interface'), spec.id === 'direct'
        ? { placeholder: t('proxyForm.interfaceRequired'), required: true, hint: t('proxyForm.interfaceDirectHint') }
        : { placeholder: t('proxyForm.interfaceOptional'), hint: t('proxyForm.interfaceHint') }),
      num('routing-mark', t('proxyForm.routingMark'), { min: 0, max: 2147483647, hint: t('proxyForm.routingMarkHint') }),
      select('ip-version', t('proxyForm.ipVersion'), opts(['', t('common.default')], ['dual', t('proxyForm.dual')], ['ipv4', t('proxyForm.ipv4Only')], ['ipv6', t('proxyForm.ipv6Only')], ['ipv4-prefer', t('proxyForm.ipv4Prefer')], ['ipv6-prefer', t('proxyForm.ipv6Prefer')]), {
        fallback: '',
        hint: t('proxyForm.ipVersionHint')
      })
    ]
  })
  const options: FieldSpec[] = []
  if (['socks5', 'socks5-tls', 'snell', 'ss', 'vmess', 'vless', 'trojan', 'anytls'].includes(spec.id)) options.push(bool('udp', t('proxyForm.udp'), { hint: t('proxyForm.udpHint') }))
  if (spec.id !== 'tailscale' && spec.id !== 'wireguard') options.push(bool('tfo', t('proxyForm.tfo')))
  if (spec.id !== 'tailscale') options.push(bool('mptcp', 'Multipath TCP'))
  if (['ss', 'vmess', 'vless', 'trojan'].includes(spec.id)) {
    options.push(bool('smux.enabled', t('proxyForm.smux'), { hint: t('proxyForm.serverSupport') }))
    options.push(select('smux.protocol', t('proxyForm.smuxProtocol'), opts('h2mux', 'smux', 'yamux'), { fallback: 'h2mux', when: isTrue('smux.enabled') }))
  }
  if (options.length) sections.push({ title: t('proxyForm.options'), column: 'right', fields: options })
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
  if (!name) throw new Error(t('groupWizard.nameRequired'))
  if (spec.endpoint) {
    if (!String(config.server ?? '').trim()) throw new Error(t('proxyForm.serverRequired'))
    const port = config.port
    const hasPorts = spec.id === 'hysteria2' && Boolean(String(config.ports ?? '').trim())
    if (port === undefined && !hasPorts) throw new Error(t('proxyForm.portRequired'))
    if (port !== undefined && !(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)) throw new Error(t('proxyForm.portInvalid'))
  }
  for (const section of visibleSections(sections, config)) {
    for (const field of section.fields) {
      if (field.key.startsWith('$')) continue
      const value = getPath(config, field.key)
      if (field.required && isBlank(value)) throw new Error(t('proxyForm.fieldRequired', [field.label]))
      if (field.kind === 'number' && value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(t('proxyForm.fieldNumber', [field.label]))
        if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          throw new Error(t('proxyForm.fieldRange', [field.label, field.min ?? '-∞', field.max ?? '∞']))
        }
      }
    }
  }
  if (spec.id === 'wireguard' && !Array.isArray(config.peers) && isBlank(config.ip) && isBlank(config.ipv6)) throw new Error(t('proxyForm.tunnelRequired'))
  const out: Record<string, unknown> = { ...config, name, type: spec.type }
  if (typeof out.server === 'string') out.server = out.server.trim()
  return out as ProxyConfig
}
