import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoDelayMap,
  MihomoDelayResult,
  MihomoProxiesResponse,
  MihomoProxyProvidersResponse,
  MihomoRuleProvidersResponse,
  MihomoRulesResponse,
  MihomoVersion
} from '@shared/mihomo-api'
import {
  parseMihomoConfig,
  parseMihomoConnections,
  parseMihomoDelayMap,
  parseMihomoDelayResult,
  parseMihomoProxies,
  parseMihomoProxyProviders,
  parseMihomoRuleProviders,
  parseMihomoRules,
  parseMihomoVersion
} from '@shared/schemas/mihomo'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

/** Default connectivity probe used when the caller does not supply a URL. */
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204'

export interface MihomoClientOptions {
  /** Abort a request that does not complete within this many milliseconds. */
  timeoutMs?: number
}

export interface MihomoRequestOptions {
  /** An external cancellation signal; aborting it cancels the in-flight request. */
  signal?: AbortSignal
  /** Request-specific timeout override (ms). */
  timeoutMs?: number
}

/** Options for a node or group delay test. */
export interface DelayTestOptions {
  /** Probe URL. Defaults to a benign connectivity check. */
  url?: string
  /** Per-node timeout in ms. Defaults to 5000. */
  timeout?: number
  /** An external cancellation signal. */
  signal?: AbortSignal
}

export class MihomoClient {
  private readonly timeoutMs: number | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    options: MihomoClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs
  }

  /**
   * Perform a request against the controller and map every failure mode to a
   * typed `ProtocolError` so the renderer always receives a stable error code:
   *
   * - transport failure        -> UPSTREAM_UNREACHABLE
   * - caller aborted           -> UPSTREAM_UNREACHABLE (reason `aborted`)
   * - request exceeded timeout -> UPSTREAM_TIMEOUT
   * - HTTP 401                 -> UNAUTHORIZED
   * - any other non-2xx        -> UPSTREAM_HTTP_ERROR
   * - invalid JSON in a 2xx    -> INVALID_UPSTREAM
   */
  private async request(
    path: string,
    init: RequestInit = {},
    options: MihomoRequestOptions = {}
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    let timedOut = false

    // The timer must live until the ENTIRE request completes (fetch + body
    // parse). Aborting the controller also aborts a pending `response.text()` /
    // `response.json()` body read, so a server that returns headers and then
    // stalls its body will still surface as UPSTREAM_TIMEOUT rather than
    // hanging forever.
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs) : null

    // Distinguish caller cancellation from our own timeout. The external
    // listener must be a named function so it can be removed in `finally`;
    // otherwise reusing the same AbortSignal across requests would accumulate
    // listeners.
    const onExternalAbort = () => controller.abort()
    const external = options.signal
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    const throwTimeout = (): never => {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_TIMEOUT,
        `mihomo controller timed out after ${timeoutMs}ms`,
        { path, reason: `timeout-after-${timeoutMs}ms` }
      )
    }
    const throwAborted = (): never => {
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_UNREACHABLE,
        `mihomo request to ${path} was aborted`,
        { path, reason: 'aborted' }
      )
    }

    try {
      let response: Response
      try {
        response = await fetch(new URL(path, this.baseUrl), {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.secret}`,
            'Content-Type': 'application/json',
            ...init.headers
          }
        })
      } catch (error) {
        if (timedOut) throwTimeout()
        if (external?.aborted) throwAborted()
        const message = error instanceof Error ? error.message : 'network failure'
        throw new ProtocolError(
          ProtocolErrorCode.UPSTREAM_UNREACHABLE,
          `mihomo controller unreachable: ${message}`,
          { path, reason: 'connection-failed' }
        )
      }

      if (!response.ok) {
        let body = ''
        try {
          body = await response.text()
        } catch (error) {
          if (timedOut) throwTimeout()
          if (external?.aborted) throwAborted()
          throw error
        }
        const reason = body ? `${response.status}: ${body}` : String(response.status)
        if (response.status === 401) {
          throw new ProtocolError(ProtocolErrorCode.UNAUTHORIZED, 'controller secret mismatch', { path, reason })
        }
        // mihomo signals a node/group delay timeout with 504 and an upstream
        // test failure with 408. Classify both as a typed timeout so the
        // renderer can show a distinct "timeout" state rather than a generic
        // HTTP error.
        if (response.status === 504 || response.status === 408) {
          throw new ProtocolError(
            ProtocolErrorCode.UPSTREAM_TIMEOUT,
            `mihomo delay test failed with HTTP ${response.status}`,
            { path, reason }
          )
        }
        throw new ProtocolError(
          ProtocolErrorCode.UPSTREAM_HTTP_ERROR,
          `mihomo request failed with HTTP ${response.status}`,
          { path, reason }
        )
      }

      if (response.status === 204) return undefined

      let raw: unknown
      try {
        raw = await response.json()
      } catch (error) {
        if (timedOut) throwTimeout()
        if (external?.aborted) throwAborted()
        const message = error instanceof Error ? error.message : 'invalid JSON'
        throw new ProtocolError(ProtocolErrorCode.INVALID_UPSTREAM, `mihomo returned invalid JSON: ${message}`, {
          path,
          reason: 'invalid-json'
        })
      }
      if (raw === undefined || raw === null) return raw
      return raw
    } finally {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    }
  }

  getVersion(signal?: AbortSignal): Promise<MihomoVersion> {
    return this.request('/version', {}, { signal }).then(parseMihomoVersion)
  }

  getConfig(signal?: AbortSignal): Promise<MihomoConfigSnapshot> {
    return this.request('/configs', {}, { signal }).then(parseMihomoConfig)
  }

  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> {
    return this.request('/configs', { method: 'PATCH', body: JSON.stringify(patch) }).then(() => undefined)
  }

  getProxies(signal?: AbortSignal): Promise<MihomoProxiesResponse> {
    return this.request('/proxies', {}, { signal }).then(parseMihomoProxies)
  }

  selectProxy(group: string, name: string): Promise<void> {
    return this.request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    }).then(() => undefined)
  }

  getRules(signal?: AbortSignal): Promise<MihomoRulesResponse> {
    return this.request('/rules', {}, { signal }).then(parseMihomoRules)
  }

  getProxyProviders(signal?: AbortSignal): Promise<MihomoProxyProvidersResponse> {
    return this.request('/providers/proxies', {}, { signal }).then(parseMihomoProxyProviders)
  }

  refreshProxyProvider(name: string): Promise<void> {
    return this.request(`/providers/proxies/${encodeURIComponent(name)}`, { method: 'PUT' }).then(() => undefined)
  }

  healthCheckProxyProvider(name: string, signal?: AbortSignal): Promise<MihomoDelayMap> {
    return this.request(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, {}, { signal }).then(parseMihomoDelayMap)
  }

  getRuleProviders(signal?: AbortSignal): Promise<MihomoRuleProvidersResponse> {
    return this.request('/providers/rules', {}, { signal }).then(parseMihomoRuleProviders)
  }

  refreshRuleProvider(name: string): Promise<void> {
    return this.request(`/providers/rules/${encodeURIComponent(name)}`, { method: 'PUT' }).then(() => undefined)
  }

  delayTest(name: string, opts: DelayTestOptions = {}): Promise<MihomoDelayResult> {
    const url = opts.url ?? DEFAULT_TEST_URL
    const timeout = opts.timeout ?? 5000
    const query = `?timeout=${encodeURIComponent(String(timeout))}&url=${encodeURIComponent(url)}`
    return this.request(`/proxies/${encodeURIComponent(name)}/delay${query}`, {}, { signal: opts.signal }).then(parseMihomoDelayResult)
  }

  groupDelayTest(name: string, opts: DelayTestOptions = {}): Promise<MihomoDelayMap> {
    const url = opts.url ?? DEFAULT_TEST_URL
    const timeout = opts.timeout ?? 5000
    const query = `?timeout=${encodeURIComponent(String(timeout))}&url=${encodeURIComponent(url)}`
    return this.request(`/group/${encodeURIComponent(name)}/delay${query}`, {}, { signal: opts.signal }).then(parseMihomoDelayMap)
  }

  getConnections(signal?: AbortSignal): Promise<MihomoConnectionsSnapshot> {
    return this.request('/connections', {}, { signal }).then(parseMihomoConnections)
  }

  closeConnection(id: string): Promise<void> {
    return this.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined)
  }
}
