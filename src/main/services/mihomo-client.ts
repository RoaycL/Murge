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

export class MihomoHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`mihomo request failed with HTTP ${status}`)
  }
}

export class MihomoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string
  ) {}

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
        ProtocolErrorCode.INTERNAL,
        `mihomo controller unreachable: ${message}`,
        { path, reason: 'connection-failed' }
      )
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new ProtocolError(
          ProtocolErrorCode.UNSUPPORTED,
          'controller secret mismatch',
          { path, reason: String(response.status) }
        )
      }
      throw new MihomoHttpError(response.status, await response.text())
    }

    if (response.status === 204) return undefined
    const raw = await response.json()
    if (raw === undefined || raw === null) return raw
    return raw as unknown
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
