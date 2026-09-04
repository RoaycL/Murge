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
  init?: { signal?: AbortSignal; redirect?: 'manual' | 'follow' }
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
const TRUSTED_FAKE_IP_HOSTS = new Set(['gist.githubusercontent.com', 'raw.githubusercontent.com'])

/** Check if an IP address is private/internal (SSRF protection). */
function isPrivateOrInternalHost(host: string): boolean {
  // Handle IPv6 addresses in bracket notation
  const normalizedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  // Check for localhost variants
  if (normalizedHost === 'localhost' || normalizedHost === '127.0.0.1' || normalizedHost === '::1') {
    return true
  }

  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x or ::ffff:a.b.c.d where d is hex)
  const ipv4MappedMatch = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(normalizedHost)
  if (ipv4MappedMatch) {
    const [, a, b, c, d] = ipv4MappedMatch.map(Number)
    // Apply same IPv4 private range checks
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 0 && b === 0 && c === 0 && d === 0) return true
    if (a === 169 && b === 254) return true
  }
  
  // Also check hex-encoded IPv4 in IPv6 (e.g., ::ffff:7f00:1 for 127.0.0.1)
  const hexIpv4Match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalizedHost)
  if (hexIpv4Match) {
    const high = parseInt(hexIpv4Match[1], 16)
    const low = parseInt(hexIpv4Match[2], 16)
    // Combine to get full 32-bit address
    const addr = (high << 16) | low
    const a = (addr >> 24) & 0xFF
    const b = (addr >> 16) & 0xFF
    const c = (addr >> 8) & 0xFF
    const d = addr & 0xFF
    
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 0 && b === 0 && c === 0 && d === 0) return true
    if (a === 169 && b === 254) return true
  }

  // IPv6 private ranges
  // ULA: fc00::/7 (fc00:: to fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalizedHost)) return true
  
  // Link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(normalizedHost)) return true
  
  // Unspecified address
  if (normalizedHost === '::' || normalizedHost === '::ffff:') return true

  // IPv4 private ranges (for direct IPv4)
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalizedHost)
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number)
    // 10.0.0.0/8
    if (a === 10) return true
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true
    // 127.0.0.0/8
    if (a === 127) return true
    // 0.0.0.0
    if (a === 0 && b === 0 && c === 0 && d === 0) return true
    // Link-local 169.254.0.0/16
    if (a === 169 && b === 254) return true
  }

  return false
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isPrivateOrInternalHost(normalized)) return false
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    const [a, b] = parts
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && (b === 0 || b === 168)) return false
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
    if (a === 203 && b === 0) return false
    return true
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1') return false
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized)) return false
    if (/^2001:db8(?::|$)/.test(normalized)) return false
    return true
  }
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
 * Replace any remaining `user:password@host` sequence, wherever it sits in the
 * string. Credentials can end up outside the authority component when a
 * malformed redirect target is resolved against a base URL.
 */
function stripInlineUserinfo(value: string): string {
  return value.replace(/[^\s/:@]+:[^\s/@]+@/g, '[redacted]@')
}

/** Longest auto-derived profile name; anything longer is a URL/abuse, not a name. */
export const MAX_SUGGESTED_NAME_LENGTH = 48

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
  const extended = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/)
  if (extended) {
    try {
      candidate = decodeURIComponent(extended[1].trim())
    } catch {
      candidate = extended[1].trim()
    }
  }
  if (!candidate) {
    const plain = header.match(/filename\s*=\s*"?([^";]+)"?/)
    if (plain) candidate = plain[1].trim()
  }
  if (!candidate) return null
  // Strip a config extension so the profile reads as a name, not a file.
  candidate = candidate.replace(/\.(?:ya?ml|txt|conf)$/i, '').trim()
  // Quotes, control characters and newlines never belong in a display name.
  candidate = candidate.replace(/^["']|["']$/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!candidate) return null
  return candidate.length > MAX_SUGGESTED_NAME_LENGTH ? candidate.slice(0, MAX_SUGGESTED_NAME_LENGTH) : candidate
}

/**
 * Derive a safe fallback profile name from the subscription URL: the URL host.
 * Deliberately NOT the URL path — a path segment can be a 32-hex token (gist
 * raw URLs), which is both unreadable and close to a credential. Returns
 * `null` for URLs without a parseable host.
 */
export function deriveFallbackSubscriptionName(url: string): string | null {
  try {
    const host = new URL(url).hostname
    if (!host) return null
    return host.length > MAX_SUGGESTED_NAME_LENGTH ? host.slice(0, MAX_SUGGESTED_NAME_LENGTH) : host
  } catch {
    return null
  }
}

export class SubscriptionFetcher {
  private readonly fetchFn: FetchFn
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
      (async (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' | 'follow' }) => {
        const res = await fetch(url, {
          signal: init?.signal,
          redirect: init?.redirect ?? 'manual'
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
      
      // Reject private/internal hosts
      if (isPrivateOrInternalHost(parsed.hostname)) {
        throw new ProtocolError(
          ProtocolErrorCode.INVALID_ARGUMENT,
          `禁止访问内部地址：${redactCredentials(url)}`
        )
      }
      // A harmless-looking hostname can still resolve to loopback/private
      // space. Resolve every redirect hop immediately before requesting it and
      // reject the hop unless every returned address is globally routable.
      // Literal IPs are already normalized by WHATWG URL and checked above.
      if (isIP(parsed.hostname) === 0) {
        const addresses = await this.resolveHost(parsed.hostname)
        // Surge/mihomo fake-ip DNS intentionally maps public hosts into
        // 198.18.0.0/15. Only permit that result for exact HTTPS GitHub raw
        // hosts; all other private/non-public answers remain rejected.
        const trustedFakeIpHost = parsed.protocol === 'https:' && TRUSTED_FAKE_IP_HOSTS.has(parsed.hostname.toLowerCase())
        const fakeIpOnly = addresses.length > 0 && addresses.every((address) => /^198\.(?:18|19)\./.test(address))
        if (addresses.length === 0 || (addresses.some((address) => !isPublicAddress(address)) && !(trustedFakeIpHost && fakeIpOnly))) {
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
   */
  async fetch(url: string): Promise<FetchSubscriptionResult> {
    const { signal, cancel } = this.createTimeoutSignal()
    let currentUrl = url
    let redirectCount = 0
    let response: FetchResponseLike | undefined
    
    try {
      while (true) {
        // Validate current URL before each request
        await this.validateUrl(currentUrl)
        
        // Use manual redirect mode to detect 3xx responses
        response = await this.fetchFn(currentUrl, { signal, redirect: 'manual' })
        
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
