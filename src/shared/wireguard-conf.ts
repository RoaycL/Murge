/**
 * WireGuard config import: wg-quick `.conf` files (the format every
 * WireGuard server/app exports, incl. AmneziaWG fields) and Surge's
 * `[WireGuard name]` sections, converted to a mihomo `type: wireguard` proxy.
 */
import type { ProxyConfig } from './local'

export interface WireGuardImport {
  config: ProxyConfig
  warnings: string[]
}

interface Endpoint {
  server: string
  port: number
}

export function parseEndpoint(value: string): Endpoint | null {
  const text = value.trim()
  const bracketed = text.match(/^\[([^\]]+)\]:(\d{1,5})$/)
  const plain = text.match(/^([^:\s]+):(\d{1,5})$/)
  const match = bracketed ?? plain
  if (!match) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { server: match[1], port }
}

const splitList = (value: string): string[] =>
  value
    .replace(/^"|"$/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const isIpv6 = (address: string): boolean => address.includes(':')
const isIp = (value: string): boolean => /^[\d.]+$/.test(value) || /^[0-9a-f:]+$/i.test(value)

/** `1/2/3`, `[1,2,3]` or base64 → three reserved bytes. */
function parseReserved(value: string): number[] | string | null {
  const text = value.trim().replace(/^\[|\]$/g, '')
  const numbers = text.split(/[/,\s]+/).filter(Boolean).map(Number)
  if (numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return numbers
  if (/^[A-Za-z0-9+/]{4}$/.test(text)) return text
  return null
}

const AMNEZIA_KEYS: Record<string, string> = {
  jc: 'jc',
  jmin: 'jmin',
  jmax: 'jmax',
  s1: 's1',
  s2: 's2',
  s3: 's3',
  s4: 's4',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  i1: 'i1',
  i2: 'i2',
  i3: 'i3',
  i4: 'i4',
  i5: 'i5'
}
const AMNEZIA_NUMERIC = new Set(['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'])
const IGNORED_INTERFACE_KEYS = new Set(['listenport', 'table', 'fwmark', 'saveconfig', 'preup', 'postup', 'predown', 'postdown'])

interface PeerDraft {
  'public-key'?: string
  'pre-shared-key'?: string
  'allowed-ips'?: string[]
  server?: string
  port?: number
  reserved?: number[] | string
  keepalive?: number
}

function applyInterfaceAddresses(config: Record<string, unknown>, addresses: string[]): void {
  for (const address of addresses) {
    const ip = address.trim()
    if (isIpv6(ip)) {
      if (!config.ipv6) config.ipv6 = ip
    } else if (!config.ip) {
      config.ip = ip
    }
  }
}

function finish(config: Record<string, unknown>, peers: PeerDraft[], warnings: string[], name: string): WireGuardImport {
  if (!config['private-key']) throw new Error('缺少 PrivateKey（本机私钥）')
  if (!config.ip && !config.ipv6) throw new Error('缺少 Address（隧道内地址）')
  const usable = peers.filter((peer) => peer['public-key'] && peer.server && peer.port)
  if (usable.length === 0) throw new Error('缺少可用的 [Peer]：需要 PublicKey 和 Endpoint')
  if (usable.length < peers.length) warnings.push('已跳过缺少 PublicKey 或 Endpoint 的 Peer')
  const keepalive = usable.map((peer) => peer.keepalive).find((value) => typeof value === 'number' && value > 0)
  if (keepalive) config['persistent-keepalive'] = keepalive
  const out: Record<string, unknown> = { name, type: 'wireguard', ...config }
  if (usable.length === 1) {
    const [peer] = usable
    out.server = peer.server
    out.port = peer.port
    out['public-key'] = peer['public-key']
    if (peer['pre-shared-key']) out['pre-shared-key'] = peer['pre-shared-key']
    if (peer.reserved) out.reserved = peer.reserved
    out['allowed-ips'] = peer['allowed-ips']?.length ? peer['allowed-ips'] : ['0.0.0.0/0', '::/0']
  } else {
    out.peers = usable.map((peer) => {
      const entry: Record<string, unknown> = {
        server: peer.server,
        port: peer.port,
        'public-key': peer['public-key'],
        'allowed-ips': peer['allowed-ips']?.length ? peer['allowed-ips'] : ['0.0.0.0/0', '::/0']
      }
      if (peer['pre-shared-key']) entry['pre-shared-key'] = peer['pre-shared-key']
      if (peer.reserved) entry.reserved = peer.reserved
      return entry
    })
  }
  out.udp = true
  return { config: out as ProxyConfig, warnings }
}

/** Parse a wg-quick `.conf`. `name` defaults from the file name by the caller. */
export function parseWgQuickConf(text: string, name = 'WireGuard'): WireGuardImport {
  const config: Record<string, unknown> = {}
  const amnezia: Record<string, unknown> = {}
  const peers: PeerDraft[] = []
  const warnings: string[] = []
  let section: 'interface' | 'peer' | null = null
  let peer: PeerDraft | null = null
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s[#;].*$/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = line.match(/^\[(\w+)\]$/)
    if (header) {
      const kind = header[1].toLowerCase()
      if (kind === 'interface') {
        section = 'interface'
      } else if (kind === 'peer') {
        section = 'peer'
        peer = {}
        peers.push(peer)
      } else {
        section = null
        warnings.push(`已忽略未知段落 [${header[1]}]`)
      }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || section === null) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (section === 'interface') {
      if (key === 'privatekey') config['private-key'] = value
      else if (key === 'address') applyInterfaceAddresses(config, splitList(value))
      else if (key === 'dns') {
        const servers = splitList(value).filter(isIp)
        if (servers.length) {
          config['remote-dns-resolve'] = true
          config.dns = servers
        }
        if (splitList(value).length > servers.length) warnings.push('DNS 中的搜索域已忽略')
      } else if (key === 'mtu') {
        const mtu = Number(value)
        if (Number.isInteger(mtu) && mtu >= 576 && mtu <= 9000) config.mtu = mtu
      } else if (key in AMNEZIA_KEYS) {
        amnezia[AMNEZIA_KEYS[key]] = AMNEZIA_NUMERIC.has(key) ? Number(value) : value
      } else if (IGNORED_INTERFACE_KEYS.has(key)) {
        warnings.push(`已忽略 ${line.slice(0, eq).trim()}（仅系统 WireGuard 客户端使用）`)
      }
    } else if (peer) {
      if (key === 'publickey') peer['public-key'] = value
      else if (key === 'presharedkey') peer['pre-shared-key'] = value
      else if (key === 'allowedips') peer['allowed-ips'] = splitList(value)
      else if (key === 'endpoint') {
        const endpoint = parseEndpoint(value)
        if (endpoint) Object.assign(peer, endpoint)
        else warnings.push(`无法识别 Endpoint「${value}」`)
      } else if (key === 'persistentkeepalive') {
        const seconds = Number(value)
        if (Number.isInteger(seconds) && seconds > 0) peer.keepalive = seconds
      } else if (key === 'reserved') {
        const reserved = parseReserved(value)
        if (reserved) peer.reserved = reserved
      }
    }
  }
  if (Object.keys(amnezia).length) config['amnezia-wg-option'] = amnezia
  return finish(config, peers, warnings, name)
}

/** Split a Surge `peer = (k = v, k = "a, b")` value into its fields. */
function parseSurgePeer(value: string): PeerDraft {
  const body = value.trim().replace(/^\(|\)$/g, '')
  const fields: Record<string, string> = {}
  const pattern = /([\w-]+)\s*=\s*("[^"]*"|[^,]*)/g
  for (const match of body.matchAll(pattern)) fields[match[1].toLowerCase()] = match[2].trim().replace(/^"|"$/g, '')
  const peer: PeerDraft = {}
  if (fields['public-key']) peer['public-key'] = fields['public-key']
  if (fields['preshared-key']) peer['pre-shared-key'] = fields['preshared-key']
  if (fields['allowed-ips']) peer['allowed-ips'] = splitList(fields['allowed-ips'])
  if (fields.endpoint) Object.assign(peer, parseEndpoint(fields.endpoint) ?? {})
  if (fields.keepalive && Number(fields.keepalive) > 0) peer.keepalive = Number(fields.keepalive)
  if (fields['client-id']) {
    const reserved = parseReserved(fields['client-id'])
    if (reserved) peer.reserved = reserved
  }
  return peer
}

/** Parse a Surge `[WireGuard name]` section (header optional). */
export function parseSurgeWireGuard(text: string, fallbackName = 'WireGuard'): WireGuardImport {
  const config: Record<string, unknown> = {}
  const peers: PeerDraft[] = []
  const warnings: string[] = []
  let name = fallbackName
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue
    const header = line.match(/^\[WireGuard\s+(.+)\]$/i)
    if (header) {
      name = header[1].trim()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (key === 'private-key') config['private-key'] = value
    else if (key === 'self-ip' || key === 'self-ip-v6') applyInterfaceAddresses(config, [value])
    else if (key === 'dns-server') {
      const servers = splitList(value).filter(isIp)
      if (servers.length) {
        config['remote-dns-resolve'] = true
        config.dns = servers
      }
    } else if (key === 'mtu' && Number(value) >= 576) config.mtu = Number(value)
    else if (key === 'peer') {
      // Surge allows several `(…)` groups on one line.
      for (const group of value.match(/\([^)]*\)/g) ?? [value]) peers.push(parseSurgePeer(group))
    }
  }
  return finish(config, peers, warnings, name)
}

/** Detect the format and parse. */
export function parseWireGuardText(text: string, fallbackName = 'WireGuard'): WireGuardImport {
  if (/^\s*\[Interface\]/im.test(text)) return parseWgQuickConf(text, fallbackName)
  if (/^\s*\[WireGuard\s+/im.test(text) || /^\s*private-key\s*=/im.test(text)) return parseSurgeWireGuard(text, fallbackName)
  throw new Error('无法识别的 WireGuard 配置：需要 wg-quick 的 [Interface]/[Peer]，或 Surge 的 [WireGuard 名称] 段落')
}

/** A node name from an imported file name (`home.conf` → `home`). */
export function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(conf|txt)$/i, '').trim()
  return base || 'WireGuard'
}
