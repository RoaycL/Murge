import type {
  MihomoConfigSnapshot,
  MihomoConnectionsSnapshot,
  MihomoProxiesResponse,
  MihomoRulesResponse,
  MihomoVersion
} from '@shared/mihomo-api'

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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
        ...init.headers
      }
    })

    if (!response.ok) {
      throw new MihomoHttpError(response.status, await response.text())
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  getVersion(): Promise<MihomoVersion> {
    return this.request('/version')
  }

  getConfig(): Promise<MihomoConfigSnapshot> {
    return this.request('/configs')
  }

  patchConfig(patch: Partial<MihomoConfigSnapshot>): Promise<void> {
    return this.request('/configs', { method: 'PATCH', body: JSON.stringify(patch) })
  }

  getProxies(): Promise<MihomoProxiesResponse> {
    return this.request('/proxies')
  }

  selectProxy(group: string, name: string): Promise<void> {
    return this.request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    })
  }

  getRules(): Promise<MihomoRulesResponse> {
    return this.request('/rules')
  }

  getConnections(): Promise<MihomoConnectionsSnapshot> {
    return this.request('/connections')
  }

  closeConnection(id: string): Promise<void> {
    return this.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}
