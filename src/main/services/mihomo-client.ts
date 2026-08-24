import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoProxiesResponse,
  MihomoRulesResponse,
  MihomoVersion
} from '@shared/mihomo-api'
import {
  parseMihomoConfig,
  parseMihomoConnections,
  parseMihomoProxies,
  parseMihomoRules,
  parseMihomoVersion
} from '@shared/schemas/mihomo'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

export class MihomoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string
  ) {}

  /**
   * Perform a request against the controller and map every failure mode to a
   * typed `ProtocolError` so the renderer always receives a stable error code:
   *
   * - transport failure        -> UPSTREAM_UNREACHABLE
   * - HTTP 401                 -> UNAUTHORIZED
   * - any other non-2xx        -> UPSTREAM_HTTP_ERROR
   * - invalid JSON in a 2xx    -> INVALID_UPSTREAM
   */
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
          ...init.headers
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network failure'
      throw new ProtocolError(
        ProtocolErrorCode.UPSTREAM_UNREACHABLE,
        `mihomo controller unreachable: ${message}`,
        { path, reason: 'connection-failed' }
      )
    }

    if (!response.ok) {
      const body = await response.text()
      const reason = body ? `${response.status}: ${body}` : String(response.status)
      if (response.status === 401) {
        throw new ProtocolError(ProtocolErrorCode.UNAUTHORIZED, 'controller secret mismatch', { path, reason })
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
      const message = error instanceof Error ? error.message : 'invalid JSON'
      throw new ProtocolError(ProtocolErrorCode.INVALID_UPSTREAM, `mihomo returned invalid JSON: ${message}`, {
        path,
        reason: 'invalid-json'
      })
    }
    if (raw === undefined || raw === null) return raw
    return raw
  }

  getVersion(): Promise<MihomoVersion> {
    return this.request('/version').then(parseMihomoVersion)
  }

  getConfig(): Promise<MihomoConfigSnapshot> {
    return this.request('/configs').then(parseMihomoConfig)
  }

  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> {
    return this.request('/configs', { method: 'PATCH', body: JSON.stringify(patch) }).then(() => undefined)
  }

  getProxies(): Promise<MihomoProxiesResponse> {
    return this.request('/proxies').then(parseMihomoProxies)
  }

  selectProxy(group: string, name: string): Promise<void> {
    return this.request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    }).then(() => undefined)
  }

  getRules(): Promise<MihomoRulesResponse> {
    return this.request('/rules').then(parseMihomoRules)
  }

  getConnections(): Promise<MihomoConnectionsSnapshot> {
    return this.request('/connections').then(parseMihomoConnections)
  }

  closeConnection(id: string): Promise<void> {
    return this.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined)
  }
}
