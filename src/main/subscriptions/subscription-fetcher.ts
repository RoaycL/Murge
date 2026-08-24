import type { ProfileSubscription } from '../../shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

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
  text(): Promise<string>
}

export type FetchFn = (url: string) => Promise<FetchResponseLike>

export interface FetchSubscriptionResult {
  document: string
  source: ProfileSubscription
}

export interface SubscriptionFetcherOptions {
  /** Injectable transport; defaults to the global fetch implementation. */
  fetchFn?: FetchFn
  /** Maximum accepted document size in bytes. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Strip userinfo (`user:password@`) from an HTTP(S) URL so credentials never
 * appear in logs or error messages.
 */
export function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    // Not a parseable URL; fall back to hiding any userinfo we can find.
    return url.replace(/:\/\/([^@/]+)@/g, '://[redacted]@')
  }
}

export class SubscriptionFetcher {
  private readonly fetchFn: FetchFn
  private readonly maxBytes: number

  constructor(options: SubscriptionFetcherOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((url) => fetch(url))
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Fetch a subscription config. The returned `source` carries only the redacted
   * URL, so callers persist exactly the non-secret form.
   */
  async fetch(url: string): Promise<FetchSubscriptionResult> {
    const redactedUrl = redactCredentials(url)
    let response: FetchResponseLike
    try {
      response = await this.fetchFn(url)
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_UNREACHABLE,
        `订阅获取失败：${redactedUrl}（${describeError(error)}）`
      )
    }
    if (!response.ok) {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
        `订阅获取失败：${redactedUrl}（HTTP ${response.status}）`
      )
    }
    let document: string
    try {
      document = await response.text()
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
        `订阅响应读取失败：${redactedUrl}（${describeError(error)}）`
      )
    }
    if (Buffer.byteLength(document, 'utf8') > this.maxBytes) {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
        `订阅配置过大：${Buffer.byteLength(document, 'utf8')} 字节超过上限 ${this.maxBytes}`
      )
    }
    return {
      document,
      source: {
        type: 'url',
        url: redactedUrl,
        expire: null,
        usage: null
      }
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
