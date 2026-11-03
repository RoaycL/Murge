/**
 * Turn pasted node text into mihomo proxy maps: share links (ss://, vmess://,
 * vless://, trojan://, hysteria2://, tuic://, anytls://, socks5://, http(s)://)
 * and Surge `[Proxy]` lines (`Name = snell, host, port, psk=…`). YAML and
 * WireGuard files are handled by the callers.
 */

export type ImportedProxy = Record<string, unknown> & { name: string; type: string }

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const truthy = (value: string | null | undefined): boolean => value === '1' || value?.toLowerCase() === 'true'

function splitList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function portOf(value: string | number | undefined, label = '端口'): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}无效：${String(value ?? '')}`)
  return port
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

function nameOf(url: URL, fallback: string): string {
  const hash = url.hash.replace(/^#/, '')
  if (!hash) return fallback
  try {
    return decodeURIComponent(hash).trim() || fallback
  } catch {
    return hash
  }
}

function setIf(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return
  target[key] = value
}

/** Transport and TLS query keys shared by vless / trojan / vmess links. */
function applyV2rayQuery(proxy: Record<string, unknown>, query: URLSearchParams, sniKey: 'sni' | 'servername'): void {
  const network = query.get('type') ?? query.get('net') ?? 'tcp'
  const host = query.get('host') ?? ''
  const path = query.get('path') ?? ''
  if (network === 'ws' || network === 'httpupgrade') {
    proxy.network = 'ws'
    const ws: Record<string, unknown> = {}
    setIf(ws, 'path', path || '/')
    if (host) ws.headers = { Host: host }
    if (network === 'httpupgrade') ws['v2ray-http-upgrade'] = true
    proxy['ws-opts'] = ws
  } else if (network === 'grpc') {
    proxy.network = 'grpc'
    proxy['grpc-opts'] = { 'grpc-service-name': query.get('serviceName') ?? path }
  } else if (network === 'h2') {
    proxy.network = 'h2'
    const h2: Record<string, unknown> = {}
    setIf(h2, 'path', path)
    setIf(h2, 'host', splitList(host))
    proxy['h2-opts'] = h2
  } else if (network === 'http' || (network === 'tcp' && query.get('headerType') === 'http')) {
    proxy.network = 'http'
    const http: Record<string, unknown> = {}
    setIf(http, 'path', splitList(path))
    if (host) http.headers = { Host: splitList(host) }
    proxy['http-opts'] = http
  }
  setIf(proxy, sniKey, query.get('sni') ?? query.get('peer') ?? undefined)
  setIf(proxy, 'alpn', splitList(query.get('alpn')))
  setIf(proxy, 'client-fingerprint', query.get('fp') ?? undefined)
  if (truthy(query.get('allowInsecure')) || truthy(query.get('insecure'))) proxy['skip-cert-verify'] = true
  const publicKey = query.get('pbk')
  if (publicKey) {
    const reality: Record<string, unknown> = { 'public-key': publicKey }
    setIf(reality, 'short-id', query.get('sid') ?? undefined)
    proxy['reality-opts'] = reality
  }
}

function parseSs(link: string): ImportedProxy {
  const url = new URL(link)
  const name = nameOf(url, 'Shadowsocks')
  let cipher: string
  let password: string
  let server: string
  let port: number
  if (url.username && !url.password && url.hostname) {
    // SIP002: ss://base64(method:password)@host:port
    const userinfo = decodeURIComponent(url.username)
    const decoded = userinfo.includes(':') ? userinfo : decodeBase64(userinfo)
    const index = decoded.indexOf(':')
    cipher = decoded.slice(0, index)
    password = decoded.slice(index + 1)
    server = hostOf(url)
    port = portOf(url.port)
  } else if (url.username && url.password) {
    cipher = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
    server = hostOf(url)
    port = portOf(url.port)
  } else {
    // Legacy: ss://base64(method:password@host:port)#name
    const body = link.slice('ss://'.length).split('#')[0]!.split('?')[0]!
    const decoded = decodeBase64(decodeURIComponent(body))
    const match = /^([^:]+):(.*)@(.+):(\d+)$/.exec(decoded)
    if (!match) throw new Error('无法解析 ss:// 链接')
    cipher = match[1]!
    password = match[2]!
    server = match[3]!.replace(/^\[|\]$/g, '')
    port = portOf(match[4])
  }
  const proxy: ImportedProxy = { name, type: 'ss', server, port, cipher, password, udp: true }
  const pluginText = url.searchParams.get('plugin')
  if (pluginText) {
    const [pluginName, ...parts] = pluginText.split(';')
    const options: Record<string, string> = {}
    for (const part of parts) {
      const [key, ...rest] = part.split('=')
      if (key) options[key] = rest.join('=')
    }
    if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
      proxy.plugin = 'obfs'
      proxy['plugin-opts'] = { mode: options.obfs ?? 'http', ...(options['obfs-host'] ? { host: options['obfs-host'] } : {}) }
    } else if (pluginName === 'v2ray-plugin') {
      const opts: Record<string, unknown> = { mode: options.mode ?? 'websocket' }
      setIf(opts, 'host', options.host)
      setIf(opts, 'path', options.path)
      if ('tls' in options) opts.tls = true
      proxy.plugin = 'v2ray-plugin'
      proxy['plugin-opts'] = opts
    } else if (pluginName === 'shadow-tls') {
      proxy.plugin = 'shadow-tls'
      proxy['plugin-opts'] = { host: options.host ?? '', password: options.password ?? '', version: Number(options.version ?? 3) }
    }
  }
  return proxy
}

function parseVmess(link: string): ImportedProxy {
  const body = link.slice('vmess://'.length).split('#')[0]!
  let json: Record<string, unknown>
  try {
    json = JSON.parse(decodeBase64(body)) as Record<string, unknown>
  } catch {
    throw new Error('无法解析 vmess:// 链接（应为 base64 JSON）')
  }
  const str = (key: string): string => (json[key] === undefined || json[key] === null ? '' : String(json[key]))
  const proxy: ImportedProxy = {
    name: str('ps') || 'VMess',
    type: 'vmess',
    server: str('add'),
    port: portOf(str('port')),
    uuid: str('id'),
    alterId: Number(str('aid') || 0) || 0,
    cipher: str('scy') || 'auto',
    udp: true
  }
  const query = new URLSearchParams()
  query.set('type', str('net') || 'tcp')
  if (str('type')) query.set('headerType', str('type'))
  if (str('host')) query.set('host', str('host'))
  if (str('path')) query.set('path', str('path'))
  if (str('net') === 'grpc') query.set('serviceName', str('path'))
  if (str('sni')) query.set('sni', str('sni'))
  if (str('alpn')) query.set('alpn', str('alpn'))
  if (str('fp')) query.set('fp', str('fp'))
  applyV2rayQuery(proxy, query, 'servername')
  if (str('tls') === 'tls') proxy.tls = true
  if (!proxy.servername && proxy.tls && str('host') && str('net') !== 'ws') proxy.servername = str('host')
  return proxy
}

function parseVless(link: string): ImportedProxy {
  const url = new URL(link)
  const query = url.searchParams
  const proxy: ImportedProxy = { name: nameOf(url, 'VLESS'), type: 'vless', server: hostOf(url), port: portOf(url.port), uuid: decodeURIComponent(url.username), udp: true }
  const security = query.get('security') ?? 'none'
  if (security === 'tls' || security === 'reality') proxy.tls = true
  setIf(proxy, 'flow', query.get('flow') ?? undefined)
  applyV2rayQuery(proxy, query, 'servername')
  const encryption = query.get('encryption')
  if (encryption && encryption !== 'none') proxy.encryption = encryption
  return proxy
}

function parseTrojan(link: string): ImportedProxy {
  const url = new URL(link)
  const proxy: ImportedProxy = { name: nameOf(url, 'Trojan'), type: 'trojan', server: hostOf(url), port: portOf(url.port || 443), password: decodeURIComponent(url.username), udp: true }
  applyV2rayQuery(proxy, url.searchParams, 'sni')
  return proxy
}

function parseHysteria2(link: string): ImportedProxy {
  const url = new URL(link.replace(/^hy2:\/\//, 'hysteria2://'))
  const query = url.searchParams
  const auth = url.password ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : decodeURIComponent(url.username)
  const proxy: ImportedProxy = { name: nameOf(url, 'Hysteria 2'), type: 'hysteria2', server: hostOf(url), port: portOf(url.port || 443), password: auth }
  setIf(proxy, 'ports', query.get('mport') ?? undefined)
  setIf(proxy, 'sni', query.get('sni') ?? undefined)
  setIf(proxy, 'obfs', query.get('obfs') ?? undefined)
  setIf(proxy, 'obfs-password', query.get('obfs-password') ?? undefined)
  setIf(proxy, 'alpn', splitList(query.get('alpn')))
  setIf(proxy, 'fingerprint', query.get('pinSHA256') ?? undefined)
  if (truthy(query.get('insecure'))) proxy['skip-cert-verify'] = true
  return proxy
}

function parseTuic(link: string): ImportedProxy {
  const url = new URL(link)
  const query = url.searchParams
  const proxy: ImportedProxy = {
    name: nameOf(url, 'TUIC'),
    type: 'tuic',
    server: hostOf(url),
    port: portOf(url.port),
    uuid: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    alpn: splitList(query.get('alpn')).length ? splitList(query.get('alpn')) : ['h3']
  }
  setIf(proxy, 'sni', query.get('sni') ?? undefined)
  setIf(proxy, 'congestion-controller', query.get('congestion_control') ?? undefined)
  setIf(proxy, 'udp-relay-mode', query.get('udp_relay_mode') ?? undefined)
  if (truthy(query.get('allow_insecure')) || truthy(query.get('insecure'))) proxy['skip-cert-verify'] = true
  if (truthy(query.get('disable_sni'))) proxy['disable-sni'] = true
  return proxy
}

function parseAnyTls(link: string): ImportedProxy {
  const url = new URL(link)
  const query = url.searchParams
  const proxy: ImportedProxy = { name: nameOf(url, 'AnyTLS'), type: 'anytls', server: hostOf(url), port: portOf(url.port || 443), password: decodeURIComponent(url.username), udp: true }
  setIf(proxy, 'sni', query.get('sni') ?? undefined)
  setIf(proxy, 'client-fingerprint', query.get('fp') ?? undefined)
  if (truthy(query.get('insecure')) || truthy(query.get('allowInsecure'))) proxy['skip-cert-verify'] = true
  return proxy
}

function parseUserPass(link: string, type: 'http' | 'socks5', tls: boolean): ImportedProxy {
  const url = new URL(link)
  const proxy: ImportedProxy = { name: nameOf(url, type === 'http' ? (tls ? 'HTTPS' : 'HTTP') : 'SOCKS5'), type, server: hostOf(url), port: portOf(url.port || (tls ? 443 : type === 'http' ? 80 : 1080)) }
  let user = decodeURIComponent(url.username)
  let pass = decodeURIComponent(url.password)
  // Some clients base64 the whole userinfo.
  if (user && !pass) {
    try {
      const decoded = decodeBase64(user)
      if (decoded.includes(':')) [user, pass] = [decoded.slice(0, decoded.indexOf(':')), decoded.slice(decoded.indexOf(':') + 1)]
    } catch {
      // Plain user name.
    }
  }
  setIf(proxy, 'username', user)
  setIf(proxy, 'password', pass)
  if (tls) proxy.tls = true
  if (type === 'socks5') proxy.udp = true
  return proxy
}

export function parseShareLink(line: string): ImportedProxy {
  const link = line.trim()
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase()
  switch (scheme) {
    case 'ss':
      return parseSs(link)
    case 'vmess':
      return parseVmess(link)
    case 'vless':
      return parseVless(link)
    case 'trojan':
      return parseTrojan(link)
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(link)
    case 'tuic':
      return parseTuic(link)
    case 'anytls':
      return parseAnyTls(link)
    case 'socks':
    case 'socks5':
      return parseUserPass(link.replace(/^socks:\/\//i, 'socks5://'), 'socks5', false)
    case 'socks5-tls':
      return parseUserPass(link, 'socks5', true)
    case 'http':
      return parseUserPass(link, 'http', false)
    case 'https':
      return parseUserPass(link, 'http', true)
    default:
      throw new Error(`不支持的链接类型：${scheme || link.slice(0, 12)}`)
  }
}

// ------------------------------------------------------------------ Surge

/** Split on commas outside double quotes. */
function splitSurge(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current.trim())
  return parts
}

const unquote = (value: string): string => value.replace(/^"(.*)"$/, '$1')

export function isSurgeProxyLine(line: string): boolean {
  return /^[^=#;/][^=]*=\s*[a-z0-9-]+\s*,/i.test(line.trim())
}

/** One Surge `[Proxy]` line, e.g. `HK = snell, 1.2.3.4, 443, psk=x, version=4`. */
export function parseSurgeLine(line: string): ImportedProxy {
  const eq = line.indexOf('=')
  const name = line.slice(0, eq).trim()
  const fields = splitSurge(line.slice(eq + 1))
  const kind = (fields[0] ?? '').toLowerCase()
  const positional: string[] = []
  const params: Record<string, string> = {}
  for (const field of fields.slice(1)) {
    const index = field.indexOf('=')
    if (index > 0) params[field.slice(0, index).trim().toLowerCase()] = unquote(field.slice(index + 1).trim())
    else positional.push(unquote(field))
  }
  const server = positional[0] ?? ''
  const port = portOf(positional[1], `「${name}」的端口`)
  const proxy: ImportedProxy = { name, type: kind, server, port }
  const tlsCommon = (sniKey: 'sni' | 'servername'): void => {
    if (params.sni && params.sni !== 'off') proxy[sniKey] = params.sni
    if (truthy(params['skip-cert-verify'])) proxy['skip-cert-verify'] = true
    if (params['server-cert-fingerprint-sha256']) proxy.fingerprint = params['server-cert-fingerprint-sha256']
  }
  const wsCommon = (): void => {
    if (!truthy(params.ws)) return
    proxy.network = 'ws'
    const ws: Record<string, unknown> = { path: params['ws-path'] || '/' }
    const headers: Record<string, string> = {}
    for (const pair of (params['ws-headers'] ?? '').split('|')) {
      const index = pair.indexOf(':')
      if (index > 0) headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
    }
    if (Object.keys(headers).length) ws.headers = headers
    proxy['ws-opts'] = ws
  }
  switch (kind) {
    case 'http':
    case 'https':
      proxy.type = 'http'
      setIf(proxy, 'username', positional[2] ?? params.username)
      setIf(proxy, 'password', positional[3] ?? params.password)
      if (kind === 'https') {
        proxy.tls = true
        tlsCommon('sni')
      }
      break
    case 'socks5':
    case 'socks5-tls':
      proxy.type = 'socks5'
      setIf(proxy, 'username', positional[2] ?? params.username)
      setIf(proxy, 'password', positional[3] ?? params.password)
      if (kind === 'socks5-tls') {
        proxy.tls = true
        tlsCommon('sni')
        delete proxy.sni
      }
      proxy.udp = true
      break
    case 'ss':
    case 'shadowsocks':
      proxy.type = 'ss'
      proxy.cipher = params['encrypt-method'] ?? 'aes-128-gcm'
      proxy.password = params.password ?? ''
      if (params.obfs) proxy.plugin = 'obfs'
      if (params.obfs) proxy['plugin-opts'] = { mode: params.obfs, ...(params['obfs-host'] ? { host: params['obfs-host'] } : {}) }
      proxy.udp = truthy(params['udp-relay']) || params['udp-relay'] === undefined
      break
    case 'snell': {
      proxy.psk = params.psk ?? ''
      const version = Number(params.version ?? 1)
      if (version > 3) throw new Error(`「${name}」是 Snell v${version}，当前内核只支持 v1-v3`)
      proxy.version = version
      if (params.obfs) proxy['obfs-opts'] = { mode: params.obfs, ...(params['obfs-host'] ? { host: params['obfs-host'] } : {}) }
      if (version >= 3) proxy.udp = true
      break
    }
    case 'vmess':
      proxy.uuid = params.username ?? ''
      proxy.alterId = truthy(params['vmess-aead']) || params['vmess-aead'] === undefined ? 0 : 1
      proxy.cipher = params.encryption ?? 'auto'
      if (truthy(params.tls)) proxy.tls = true
      tlsCommon('servername')
      wsCommon()
      proxy.udp = true
      break
    case 'trojan':
      proxy.password = params.password ?? ''
      tlsCommon('sni')
      wsCommon()
      proxy.udp = true
      break
    case 'tuic':
    case 'tuic-v5':
      proxy.type = 'tuic'
      proxy.uuid = params.uuid ?? ''
      proxy.password = params.password ?? params.token ?? ''
      proxy.alpn = splitList(params.alpn).length ? splitList(params.alpn) : ['h3']
      tlsCommon('sni')
      break
    case 'hysteria2':
      proxy.password = params.password ?? ''
      setIf(proxy, 'down', params['download-bandwidth'] ? `${params['download-bandwidth']} Mbps` : undefined)
      setIf(proxy, 'ports', params['port-hopping']?.replace(/;/g, ','))
      setIf(proxy, 'hop-interval', params['port-hopping-interval'] ? Number(params['port-hopping-interval']) : undefined)
      tlsCommon('sni')
      break
    case 'anytls':
      proxy.password = params.password ?? ''
      tlsCommon('sni')
      proxy.udp = true
      break
    case 'wireguard':
      throw new Error(`「${name}」是 WireGuard，请连同 [WireGuard ${params['section-name'] ?? '…'}] 段落一起粘贴`)
    default:
      throw new Error(`「${name}」的类型 ${kind} 暂不支持`)
  }
  if (truthy(params.tfo)) proxy.tfo = true
  if (params.interface) proxy['interface-name'] = params.interface
  if (params['underlying-proxy']) proxy['dialer-proxy'] = params['underlying-proxy']
  const ipVersion = params['ip-version']
  if (ipVersion) proxy['ip-version'] = ({ v4: 'ipv4', v6: 'ipv6', 'v4-only': 'ipv4', 'v6-only': 'ipv6', prefer: 'dual', 'prefer-v4': 'ipv4-prefer', 'prefer-v6': 'ipv6-prefer' } as Record<string, string>)[ipVersion] ?? 'dual'
  return proxy
}

/**
 * Parse every line that is a share link or a Surge proxy line. Returns null
 * when no line looks like either, so the caller can try YAML instead.
 */
export function parseProxyLines(text: string): ImportedProxy[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//') && !/^\[.*\]$/.test(line))
  if (!lines.length) return null
  const isLink = (line: string): boolean => /^[a-z0-9-]+:\/\//i.test(line)
  if (!lines.every((line) => isLink(line) || isSurgeProxyLine(line))) {
    // A single base64 blob of links (subscription body).
    if (lines.length === 1 && /^[A-Za-z0-9+/=_-]{16,}$/.test(lines[0]!)) {
      try {
        const decoded = decodeBase64(lines[0]!)
        if (/^[a-z0-9-]+:\/\//im.test(decoded)) return parseProxyLines(decoded)
      } catch {
        return null
      }
    }
    return null
  }
  return lines.map((line) => (isLink(line) ? parseShareLink(line) : parseSurgeLine(line)))
}
