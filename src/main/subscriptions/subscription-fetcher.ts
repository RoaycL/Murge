import type { ProfileSubscription } from '../../shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Subscription fetch abstraction.
 *
 * A subscription is a remote YAML config fetched over HTTP(S). This module
 * centralizes the transport so tests can inject a stub `fetch` and so no
 * credential material ever reaches logs: URLs are redacted in every message and
 * errors are formatted against the redacted form.
 */

export interface FetchResponseLike {
  ok: boolean
  status: number
  /**
   * The FINAL url after redirects, when the transport follows redirects
   * internally (e.g. a Chromium-based proxy transport). When present and
   * different from the requested url, the fetcher validates and adopts it.
   */
  url?: string
  headers?: { has(name: string): boolean; get(name: string): string | null }
  text(): Promise<string>
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
    }
  }
}

/**
 * Injectable transport. `init` carries the abort signal and the redirect policy
 * the fetcher depends on: it drives per-hop redirect validation and the request
 * timeout, so a real implementation MUST forward both to the underlying fetch.
 */
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'manual' | 'follow'; headers?: Record<string, string> }
) => Promise<FetchResponseLike>

export interface FetchSubscriptionResult {
  document: string
  source: ProfileSubscription
  /**
   * Display name suggested by the subscription response itself (the
   * `Content-Disposition` attachment filename, as popularized by community
   * clients). `null` when the response carries no usable filename — the caller
   * then falls back to the URL host. Never derived from the raw URL path, so a
   * token-bearing URL can never become a user-visible profile name.
   */
  suggestedName: string | null
}

export interface SubscriptionFetcherOptions {
  /** Injectable transport; defaults to the global fetch implementation. */
  fetchFn?: FetchFn
  /**
   * Optional fallback transport used after the direct one fails at the
   * transport level. Production wires Chromium's net.fetch here, which —
   * unlike Node's fetch — honors the system proxy (the app's own mixed port
   * when the system proxy is enabled), so tunnel-only hosts are reachable.
   */
  proxyFetchFn?: FetchFn
  /** Maximum accepted document size in bytes. */
  maxBytes?: number
  /** Optional strict URL validation (default: true). Rejects non-http(s) and internal IPs. */
  strictUrlValidation?: boolean
  /** Maximum number of redirects to follow (default: 5). */
  maxRedirects?: number
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number
  /** DNS resolver used to reject hostnames that resolve into private space. */
  resolveHost?: (hostname: string) => Promise<string[]>
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30000
const SUBSCRIPTION_REQUEST_HEADERS = {
  'User-Agent': 'ClashforWindows/0.20.39',
  Accept: 'application/x-yaml,text/yaml,text/plain,application/octet-stream,*/*'
} as const

/** Convert a canonical dotted-quad IPv4 literal to a 32-bit integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const num = Number(part)
    if (num < 0 || num > 255) return null
    value = value * 256 + num
  }
  return value
}

/** [start, end] inclusive 32-bit range for an IPv4 CIDR block. */
function ipv4CidrRange(base: string, prefix: number): readonly [number, number] {
  const start = ipv4ToInt(base)
  if (start === null) throw new Error(`invalid IPv4 base: ${base}`)
  const size = 2 ** (32 - prefix)
  return [start, start + size - 1]
}

/**
 * IPv4 blocks that are never a legitimate subscription target: private,
 * loopback, link-local, CGNAT, benchmarking, TEST-NET, multicast and reserved
 * space. This is the allow-list's reject table — an address is "public" only
 * when it falls in none of these ranges.
 */
const IPV4_NON_PUBLIC_RANGES: ReadonlyArray<readonly [number, number]> = [
  ipv4CidrRange('0.0.0.0', 8),       // "this" network
  ipv4CidrRange('10.0.0.0', 8),      // private
  ipv4CidrRange('100.64.0.0', 10),   // CGNAT shared address space
  ipv4CidrRange('127.0.0.0', 8),     // loopback
  ipv4CidrRange('169.254.0.0', 16),  // link-local
  ipv4CidrRange('172.16.0.0', 12),   // private
  ipv4CidrRange('192.0.0.0', 24),    // IETF protocol assignments
  ipv4CidrRange('192.0.2.0', 24),    // TEST-NET-1
  ipv4CidrRange('192.31.196.0', 24), // AS112-v4
  ipv4CidrRange('192.52.193.0', 24), // AMT
  ipv4CidrRange('192.88.99.0', 24),  // deprecated 6to4 relay anycast
  ipv4CidrRange('192.168.0.0', 16),  // private
  ipv4CidrRange('192.175.48.0', 24), // AS112
  ipv4CidrRange('198.18.0.0', 15),   // benchmarking (also Surge/mihomo fake-ip)
  ipv4CidrRange('198.51.100.0', 24), // TEST-NET-2
  ipv4CidrRange('203.0.113.0', 24),  // TEST-NET-3
  ipv4CidrRange('224.0.0.0', 4),     // multicast
  ipv4CidrRange('240.0.0.0', 4)      // reserved (incl. broadcast)
]

function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  for (const [start, end] of IPV4_NON_PUBLIC_RANGES) {
    if (value >= start && value <= end) return false
  }
  return true
}

/**
 * Expand a canonical IPv6 literal to its 8 hextets (0..0xffff), handling `::`
 * compression and an embedded IPv4 tail. Returns null when unparseable.
 */
function expandIpv6(address: string): number[] | null {
  let text = address
  // Embedded IPv4 in the final two hextets (e.g. ::ffff:127.0.0.1 or
  // 2001:db8::192.0.2.1): convert it to two hextets first.
  const colon = text.lastIndexOf(':')
  if (colon !== -1 && text.slice(colon + 1).includes('.')) {
    const ipv4 = ipv4ToInt(text.slice(colon + 1))
    if (ipv4 === null) return null
    text = `${text.slice(0, colon + 1)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }
  const parts: string[] = []
  const split = text.split('::')
  if (split.length > 2) return null
  if (split.length === 2) {
    const left = split[0] === '' ? [] : split[0].split(':')
    const right = split[1] === '' ? [] : split[1].split(':')
    if (left.length + right.length > 7) return null
    parts.push(...left)
    for (let i = 0; i < 8 - left.length - right.length; i += 1) parts.push('0')
    parts.push(...right)
  } else {
    parts.push(...text.split(':'))
  }
  if (parts.length !== 8) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    out.push(parseInt(part, 16))
  }
  return out
}

const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i
const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i

function isPublicIpv6(address: string): boolean {
  // IPv4-mapped forms are judged by their embedded IPv4, not the IPv6 prefix.
  const mapped = IPV4_MAPPED_DOTTED.exec(address)
  if (mapped) return isPublicIpv4(mapped[1])
  const hexMapped = IPV4_MAPPED_HEX.exec(address)
  if (hexMapped) {
    const int = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16)
    return isPublicIpv4(`${(int >>> 24) & 0xff}.${(int >>> 16) & 0xff}.${(int >>> 8) & 0xff}.${int & 0xff}`)
  }
  const hextets = expandIpv6(address)
  if (!hextets) return false
  const a = hextets[0]
  const b = hextets[1]
  if (a === 0) return false                               // 0000::/8 (unspecified, loopback, reserved)
  if (a === 0x0064 && b === 0xff9b) return false          // 64:ff9b::/96 NAT64 well-known
  if (a === 0x0100 && b === 0x0000) return false          // 100::/64 discard-only
  if (a === 0x2001 && (b & 0xfe00) === 0) return false    // 2001::/23 (Teredo, ORCHID, IETF)
  if (a === 0x2001 && b === 0x0db8) return false          // 2001:db8::/32 documentation
  if (a === 0x2002) return false                          // 2002::/16 6to4
  if ((a & 0xfe00) === 0xfc00) return false               // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return false               // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return false               // ff00::/8 multicast
  return true
}

/**
 * SSRF allow-list: is `address` a globally routable unicast IP?
 *
 * Both literal subscription hosts and every DNS answer flow through this single
 * check, so the literal-IP and resolved-IP verdicts can never diverge again.
 *
 * The community references (mihomo-party, clash-verge-rev, sparkle) fetch the
 * subscription URL directly with no private-IP filtering at all; this project
 * keeps a stricter DNS-rebinding defence as deliberate hardening. The only
 * carve-out is applied by the caller: Surge/mihomo fake-ip DNS maps public hosts
 * into 198.18.0.0/15, which is otherwise rejected here.
 */
export function isPublicAddress(address: string): boolean {
  let normalized = address.trim().toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1)
  normalized = normalized.split('%')[0]
  if (isIP(normalized) === 4) return isPublicIpv4(normalized)
  if (isIP(normalized) === 6) return isPublicIpv6(normalized)
  return false
}

/**
 * Strip sensitive credential material so it never appears in logs, error
 * messages or persisted metadata. Handles both a bare URL and free-form text
 * that merely CONTAINS a URL — undici embeds the request URL in transport error
 * messages — covering:
 * - userinfo (`user:password@`)
 * - query parameters whose names suggest secrets (token, uuid, secret, key, auth, etc.)
 * - long hex/UUID-like segments in path components
 */
export function redactCredentials(url: string): string {
  // Free-form text: redact each embedded URL individually instead of letting the
  // whole string fail to parse and fall through to the weaker regex path.
  if (/\s/.test(url.trim())) {
    return url.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, (match) => redactCredentials(match))
  }
  try {
    const parsed = new URL(url)

    // 1. Strip userinfo
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted'
      parsed.password = ''
    }

    // 2. Redact suspicious query parameters
    const secretParamNames = [
      'token', 'uuid', 'secret', 'key', 'auth', 'password', 'sub',
      'access_token', 'apikey', 'api_key', 'bearer', 'ticket',
      'session', 'sid', 'sess', 'cid', 'client_id', 'client_secret'
    ]
    const searchParams = parsed.searchParams
    for (const [name] of searchParams.entries()) {
      const lowerName = name.toLowerCase()
      if (secretParamNames.some(secret => lowerName.includes(secret))) {
        searchParams.set(name, '***REDACTED***')
      }
    }

    // 3. Redact long hex/UUID-like path segments (20+ chars hex)
    const pathSegments = parsed.pathname.split('/').filter(Boolean)
    const uuidRegex = /^[0-9a-f]{20,}$/i
    for (let i = 0; i < pathSegments.length; i++) {
      if (uuidRegex.test(pathSegments[i])) {
        pathSegments[i] = '[UUID_REDACTED]'
      }
    }
    parsed.pathname = '/' + pathSegments.join('/')

    // A malformed target (e.g. `ht!tp://user:pass@host`) can resolve into the
    // PATH rather than the authority, so `username`/`password` stay empty while
    // the credentials survive inside the path. Strip any leftover `user:pass@`.
    return stripInlineUserinfo(parsed.toString())
  } catch {
    // Not a parseable URL; fall back to regex-based redaction.
    let result = url.replace(/:\/\/([^@/]+)@/g, '://[redacted]@')
    // Also mask common query parameter patterns
    result = result.replace(/(\?|&)([^=&]+)=([^&]*)/g, (match, prefix, paramName, value) => {
      const lowerName = paramName.toLowerCase()
      const isSecret = /token|uuid|secret|key|auth|password|sub|access_token|apikey|bearer/i.test(lowerName)
      if (isSecret) {
        return `${prefix}${paramName}=***REDACTED***`
      }
      return match
    })
    // Mask long hex in paths
    result = result.replace(/\/([0-9a-f]{20,})/gi, '/[UUID_REDACTED]')
    return stripInlineUserinfo(result)
  }
}

/**
 * True when a URL is a REDACTION ARTIFACT rather than a fetchable address —
 * i.e. the output of {@link redactCredentials} on a credential-bearing URL.
 * Persisted metadata stores redacted URLs for display; fetching them can only
 * fail, so callers must surface a clear error instead of attempting it.
 */
export function isRedactedUrl(url: string): boolean {
  return url.includes('[UUID_REDACTED]') || url.includes('***REDACTED***') || /:\/\/(?:\[?redacted\]?):?[^/\s]*@/.test(url)
}

/**
 * True when a fetch failure is TRANSPORT-level (DNS, TLS, connect, abort) —
 * the class of failure a kernel-proxy retry can plausibly fix. HTTP error
 * statuses and validation failures are excluded on purpose: retrying them
 * through the proxy would only double the round-trips.
 */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof ProtocolError)) return false
  return error.code === ProtocolErrorCode.UPSTREAM_UNREACHABLE
}

/**
 * Replace any remaining `user:password@host` sequence, wherever it sits in the
 * string. Credentials can end up outside the authority component when a
 * malformed redirect target is resolved against a base URL.
 */
function stripInlineUserinfo(value: string): string {
  return value.replace(/[^\s/:@]+:[^\s/@]+@/g, '[redacted]@')
}

/** Longest auto-derived profile name; anything longer is a URL/abuse, not a name. */
export const MAX_SUGGESTED_NAME_LENGTH = 48

function sanitizeSuggestedName(value: string): string | null {
  let candidate = value.split(/[\\/]/).pop() ?? ''
  candidate = candidate.replace(/\.(?:ya?ml|txt|conf|json)$/i, '').trim()
  candidate = candidate.replace(/^["']|["']$/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!candidate) return null
  return candidate.length > MAX_SUGGESTED_NAME_LENGTH ? candidate.slice(0, MAX_SUGGESTED_NAME_LENGTH) : candidate
}

/**
 * Extract a human-friendly display filename from a `Content-Disposition`
 * header, as community clients (e.g. Clash Party) do for remote subscriptions:
 * prefer the RFC 5987 extended form (`filename*=UTF-8''…`, percent-decoded),
 * fall back to the plain `filename=` form, strip a config extension, and
 * sanitize (quotes, control characters, hard length cap). Returns `null` when
 * nothing usable remains — the caller then falls back to the URL host.
 */
export function parseDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null
  let candidate: string | null = null
  const extended = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)
  if (extended) {
    try {
      candidate = decodeURIComponent(extended[1].trim())
    } catch {
      candidate = extended[1].trim()
    }
  }
  if (!candidate) {
    const plain = header.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i)
    if (plain) candidate = (plain[1] ?? plain[2] ?? '').trim()
  }
  if (!candidate) return null
  return sanitizeSuggestedName(candidate)
}

/**
 * Match Clash Verge Rev's fallback: prefer a decoded final URL filename, then
 * the host. Token-like and generic route segments are rejected so credentials
 * never become profile names.
 */
export function deriveFallbackSubscriptionName(url: string): string | null {
  try {
    const parsed = new URL(url)
    const rawSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    let decoded = rawSegment
    try { decoded = decodeURIComponent(rawSegment) } catch { /* keep raw segment */ }
    const unsafe = /^(?:raw|sub|subscribe|subscription|config|clash|api|v\d+)$/i.test(decoded) || /^[0-9a-f-]{20,}$/i.test(decoded)
    if (!unsafe) {
      const filename = sanitizeSuggestedName(decoded)
      if (filename) return filename
    }
    const host = parsed.hostname
    if (!host) return null
    return host.length > MAX_SUGGESTED_NAME_LENGTH ? host.slice(0, MAX_SUGGESTED_NAME_LENGTH) : host
  } catch {
    return null
  }
}

/** Options for a single fetch sweep. */
export interface FetchOptions {
  /**
   * Route this sweep through the fallback transport instead of the direct
   * one. Used as a retry when the direct transport fails.
   */
  viaProxy?: boolean
}

export class SubscriptionFetcher {
  private readonly fetchFn: FetchFn
  private readonly proxyFetchFn?: FetchFn
  private readonly maxBytes: number
  private readonly strictUrlValidation: boolean
  private readonly maxRedirects: number
  private readonly timeoutMs: number
  private readonly resolveHost: (hostname: string) => Promise<string[]>

  constructor(options: SubscriptionFetcherOptions = {}) {
    // The default transport MUST forward `signal` (so the timeout can actually
    // abort an in-flight request) and `redirect` (so 3xx responses surface to the
    // per-hop validation loop instead of being followed silently, which would
    // bypass the SSRF checks entirely).
    this.fetchFn =
      options.fetchFn ??
      (async (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' | 'follow'; headers?: Record<string, string> }) => {
        const res = await fetch(url, {
          signal: init?.signal,
          redirect: init?.redirect ?? 'manual',
          headers: init?.headers
        })
        return {
          ok: res.ok,
          status: res.status,
          headers: {
            has: (name: string) => res.headers.has(name),
            get: (name: string) => res.headers.get(name)
          },
          text: () => res.text(),
          body: res.body
            ? {
                getReader: () => res.body!.getReader()
              }
            : undefined
        }
      })
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.proxyFetchFn = options.proxyFetchFn
    this.strictUrlValidation = options.strictUrlValidation !== false // default to true
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveHost = options.resolveHost ?? (options.fetchFn
      // An injected transport may not use DNS at all. Tests that exercise DNS
      // policy inject resolveHost explicitly; production's default transport
      // always performs the real lookup below.
      ? async () => ['93.184.216.34']
      : async (hostname) => {
          const records = await lookup(hostname, { all: true, verbatim: true })
          return records.map((record) => record.address)
        })
  }

  /**
   * Create an abort signal plus its cleanup handle. The timer MUST be cleared in
   * a `finally`, otherwise every fetch keeps a pending timer alive for the full
   * timeout window and can hold the process awake.
   */
  private createTimeoutSignal(): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    return { signal: controller.signal, cancel: () => clearTimeout(timer) }
  }

  /** Validate a URL against SSRF protections. */
  private async validateUrl(url: string): Promise<void> {
    if (!this.strictUrlValidation) return
    
    try {
      const parsed = new URL(url)
      
      // Only allow http and https schemes
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ProtocolError(
          ProtocolErrorCode.INVALID_ARGUMENT,
          `订阅 URL 必须使用 http 或 https 协议：${redactCredentials(url)}`
        )
      }
      
      const hostname = parsed.hostname
      // WHATWG URL keeps IPv6 literals in bracket notation; strip them so the
      // literal check and the allow-list predicate see the bare address.
      const bareHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
      const isLiteral = isIP(bareHost) !== 0 || bareHost.toLowerCase() === 'localhost'
      // A literal IP (or the localhost alias) is checked directly against the
      // public-unicast allow-list. A hostname is resolved and every returned
      // address must be globally routable, so both verdicts share one predicate.
      if (isLiteral) {
        if (!isPublicAddress(bareHost)) {
          throw new ProtocolError(
            ProtocolErrorCode.INVALID_ARGUMENT,
            `禁止访问内部地址：${redactCredentials(url)}`
          )
        }
      } else {
        const addresses = await this.resolveHost(hostname)
        // Surge/mihomo fake-ip DNS intentionally maps arbitrary public hosts
        // into 198.18.0.0/15, so a host allow-list cannot solve this for real
        // subscription providers. Permit an all-fake-IP answer only for HTTPS:
        // TLS still authenticates the requested hostname and redirects are
        // validated again hop-by-hop. Mixed/private answers remain rejected.
        const trustedFakeIpAnswer = parsed.protocol === 'https:'
        const fakeIpOnly = addresses.length > 0 && addresses.every((address) => /^198\.(?:18|19)\./.test(address))
        if (addresses.length === 0 || (addresses.some((address) => !isPublicAddress(address)) && !(trustedFakeIpAnswer && fakeIpOnly))) {
          throw new ProtocolError(
            ProtocolErrorCode.INVALID_ARGUMENT,
            `订阅域名解析到非公网地址：${redactCredentials(url)}`
          )
        }
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      // NEVER interpolate the raw URL here: an unparseable URL can still carry
      // userinfo or a token, and this message reaches the renderer.
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        `无效的订阅 URL：${redactCredentials(url)}`
      )
    }
  }

  /**
   * Fetch a subscription config with SSRF protection, redirect tracking, and streaming size limit.
   * `viaProxy` routes the sweep through the fallback transport (which must
   * have been configured via `proxyFetchFn`).
   */
  async fetch(url: string, opts?: FetchOptions): Promise<FetchSubscriptionResult> {
    const transport: FetchFn = opts?.viaProxy && this.proxyFetchFn ? this.proxyFetchFn : this.fetchFn
    const { signal, cancel } = this.createTimeoutSignal()
    let currentUrl = url
    let redirectCount = 0
    let response: FetchResponseLike | undefined
    
    try {
      while (true) {
        // Validate current URL before each request
        await this.validateUrl(currentUrl)

        // Use manual redirect mode to detect 3xx responses
        response = await transport(currentUrl, {
          signal,
          redirect: 'manual',
          headers: SUBSCRIPTION_REQUEST_HEADERS
        })

        // A transport that follows redirects internally (the kernel-proxy path)
        // surfaces its final url here: validate where we actually landed and
        // adopt it so the stored source and error messages reflect reality.
        if (response.url && response.url !== currentUrl) {
          await this.validateUrl(response.url)
          currentUrl = response.url
        }

        // Handle redirects manually with validation
        if (response.status >= 300 && response.status < 400 && response.headers?.has('location')) {
          redirectCount++
          if (redirectCount > this.maxRedirects) {
            throw new ProtocolError(
              ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
              `重定向次数过多（超过 ${this.maxRedirects}）：${redactCredentials(currentUrl)}`
            )
          }
          
          const location = response.headers.get('location')!
          // Resolve relative URLs
          let nextUrl: string
          try {
            nextUrl = new URL(location, currentUrl).href
          } catch {
            // A redirect target is attacker-controlled and may embed credentials.
            throw new ProtocolError(
              ProtocolErrorCode.INVALID_ARGUMENT,
              `无效的重定向地址：${redactCredentials(location)}`
            )
          }
          
          // Validate the redirect target
          await this.validateUrl(nextUrl)
          currentUrl = nextUrl
          continue
        }
        
        // Not a redirect, proceed with normal processing
        break
      }
      
      // Now process the actual response with streaming size check
      const redactedUrl = redactCredentials(currentUrl)
      let document = ''
      let totalBytes = 0
      
      if (!response.ok) {
        throw new ProtocolError(
          ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
          `订阅获取失败：${redactedUrl}（HTTP ${response.status}）`
        )
      }
      
      // Stream the response body with size checking
      if (response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          
          if (value) {
            const chunkStr = decoder.decode(value, { stream: true })
            document += chunkStr
            totalBytes += value.length
            
            // Check size limit during streaming
            if (totalBytes > this.maxBytes) {
              reader.cancel()
              throw new ProtocolError(
                ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
                `订阅配置过大：${totalBytes} 字节超过上限 ${this.maxBytes}`
              )
            }
          }
        }
        // Flush any bytes the streaming decoder is holding back: a multibyte
        // UTF-8 character split across the final chunk boundary would otherwise
        // be dropped, silently corrupting the tail of the document.
        document += decoder.decode()
      } else {
        // Fallback for responses without body
        document = await response.text()
        totalBytes = Buffer.byteLength(document, 'utf8')
        if (totalBytes > this.maxBytes) {
          throw new ProtocolError(
            ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
            `订阅配置过大：${totalBytes} 字节超过上限 ${this.maxBytes}`
          )
        }
      }
      
      return {
        document,
        source: {
          type: 'url',
          url: redactedUrl, // Only store redacted URL for security
          expire: null,
          usage: null
        },
        suggestedName:
          parseDispositionFilename(response.headers?.get('content-disposition')) ??
          deriveFallbackSubscriptionName(redactedUrl)
      }
    } catch (error) {
      // Handle timeout specifically
      if (signal.aborted) {
        throw new ProtocolError(
          ProtocolErrorCode.UPSTREAM_UNREACHABLE,
          `订阅获取超时（${this.timeoutMs}ms）：${redactCredentials(url)}`
        )
      }
      if (error instanceof ProtocolError) throw error
      // Wrap every other failure as a typed error so the renderer can classify it.
      // The underlying message is redacted too: undici embeds the request URL in
      // transport errors, so interpolating it verbatim would leak credentials.
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_UNREACHABLE,
        `订阅获取失败：${redactCredentials(url)}（${redactCredentials(describeError(error))}）`
      )
    } finally {
      cancel()
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
