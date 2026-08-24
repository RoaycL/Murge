import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  MihomoConfigSnapshot,
  MihomoConnection,
  MihomoConnectionsSnapshot,
  MihomoProxiesResponse,
  MihomoRulesResponse,
  MihomoTrafficMessage,
  MihomoLogMessage
} from '@shared/mihomo-api'

/**
 * In-process, localhost-only mock mihomo controller.
 *
 * Phase 3 needs a safe stand-in for the real controller so the renderer can be
 * exercised without a real mihomo binary or any network change. It serves the
 * REST endpoints the gateway exposes and the three WebSocket streams mihomo
 * provides (`/traffic`, `/logs`, `/connections`), replaying a bounded stream of
 * mock data.
 *
 * It binds to `127.0.0.1` on an ephemeral port, so nothing outside this process
 * is reachable and no system networking is mutated. It is used in development
 * builds and in unit tests; production uses the disabled resolver and never
 * starts this server.
 */

export interface MockMihomoServerOptions {
  /** When set, HTTP requests and WebSocket upgrades must present `Bearer <secret>`. */
  secret?: string
  /** Interval between live stream emissions. Defaults to 1000 ms. */
  trafficIntervalMs?: number
  /** The version payload served by `/version`. */
  version?: { meta: boolean; version: string }
}

export interface MockMihomoServerHandle {
  /** Root REST base URL, e.g. `http://127.0.0.1:49210`. */
  baseUrl: string
  /** Root WebSocket base URL, e.g. `ws://127.0.0.1:49210`. */
  wsBaseUrl: string
  /** Stop the HTTP server, the stream timer and any open sockets. */
  close(): Promise<void>
}

const SAMPLE_CONNECTIONS: string[] = ['Browser', 'curl', 'Terminal', 'Mail', 'Desktop']

function bearerFrom(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : ''
}

class MockServer {
  private readonly httpServer: Server
  private readonly trafficWss: WebSocketServer
  private readonly logsWss: WebSocketServer
  private readonly connectionsWss: WebSocketServer
  private readonly timer: NodeJS.Timeout | null = null
  private readonly intervalMs: number
  private readonly secret: string | null
  private readonly version: { meta: boolean; version: string }

  private upTotal = 0
  private downTotal = 0
  private startedAt = Date.now()
  private readonly config: Required<Pick<MihomoConfigSnapshot, 'mode' | 'port' | 'allow-lan'>> & MihomoConfigSnapshot

  constructor(options: MockMihomoServerOptions = {}) {
    this.intervalMs = options.trafficIntervalMs ?? 1000
    this.secret = options.secret?.length ? options.secret : null
    this.version = options.version ?? { meta: true, version: '1.18.9-mock' }
    this.config = {
      port: 7890,
      'mixed-port': 7891,
      mode: 'rule',
      'log-level': 'info',
      'allow-lan': false,
      ipv6: false,
      tun: { enable: false, stack: 'system' }
    }

    this.httpServer = createServer((req, res) => this.handleHttp(req, res))
    this.trafficWss = new WebSocketServer({ noServer: true })
    this.logsWss = new WebSocketServer({ noServer: true })
    this.connectionsWss = new WebSocketServer({ noServer: true })

    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))

    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  private authorized(request: IncomingMessage): boolean {
    if (this.secret === null) return true
    return bearerFrom(request) === this.secret
  }

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    if (!this.authorized(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const url = new URL(request.url ?? '/', this.wsBaseUrlFallback())
    const wss = url.pathname === '/traffic' ? this.trafficWss
      : url.pathname === '/logs' ? this.logsWss
      : url.pathname === '/connections' ? this.connectionsWss
      : null
    if (!wss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
  }

  private wsBaseUrlFallback(): string {
    const addr = this.httpServer.address() as AddressInfo
    return `ws://127.0.0.1:${addr.port}`
  }

  private json(res: ServerResponse, status: number, body?: unknown): void {
    const payload = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    })
    res.end(payload)
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request)) {
      this.json(response, 401, { message: 'unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', this.httpBaseUrlFallback())
    const path = url.pathname
    const method = request.method ?? 'GET'

    if (path === '/version' && method === 'GET') {
      return this.json(response, 200, this.version)
    }
    if (path === '/configs' && method === 'GET') {
      return this.json(response, 200, this.config)
    }
    if (path === '/configs' && method === 'PATCH') {
      let body: Record<string, unknown> = {}
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          return this.json(response, 400, { message: 'invalid JSON' })
        }
        if (body.mode === 'rule' || body.mode === 'global' || body.mode === 'direct') this.config.mode = body.mode
        if (typeof body['allow-lan'] === 'boolean') this.config['allow-lan'] = body['allow-lan']
        if (typeof body.port === 'number') this.config.port = body.port
        this.json(response, 204)
      })
      request.resume()
      return
    }
    if (path === '/proxies' && method === 'GET') {
      return this.json(response, 200, this.proxies())
    }
    if (path.startsWith('/proxies/') && method === 'PUT') {
      request.resume()
      return this.json(response, 204)
    }
    if (path === '/rules' && method === 'GET') {
      return this.json(response, 200, this.rules())
    }
    if (path === '/connections' && method === 'GET') {
      return this.json(response, 200, this.snapshot())
    }
    if (path.startsWith('/connections/') && method === 'DELETE') {
      return this.json(response, 204)
    }
    this.json(response, 404, { message: 'not found' })
  }

  private httpBaseUrlFallback(): string {
    const addr = this.httpServer.address() as AddressInfo
    return `http://127.0.0.1:${addr.port}`
  }

  private proxies(): MihomoProxiesResponse {
    return {
      proxies: {
        '节点选择': { name: '节点选择', type: 'Selector', now: '香港 01', all: ['香港 01', '香港 02', 'DIRECT'] },
        '劫持': { name: '劫持', type: 'Direct' },
        '香港 01': { name: '香港 01', type: 'Shadowsocks', alive: true, udp: true },
        '香港 02': { name: '香港 02', type: 'Shadowsocks', alive: true, udp: true }
      }
    }
  }

  private rules(): MihomoRulesResponse {
    return {
      rules: [
        { index: 0, type: 'DOMAIN-SUFFIX', payload: 'localhost', proxy: 'DIRECT', size: 1 },
        { index: 1, type: 'MATCH', payload: '', proxy: '节点选择', size: 1 }
      ]
    }
  }

  private connections(): MihomoConnection[] {
    const now = new Date()
    return SAMPLE_CONNECTIONS.map((processName, index) => ({
      id: `mock-conn-${index}`,
      metadata: {
        network: 'tcp',
        type: 'HTTP',
        sourceIP: '192.168.1.10',
        destinationIP: '104.21.32.1',
        sourcePort: String(53000 + index),
        destinationPort: String(443),
        host: `host-${index}.example.com`,
        process: processName,
        processPath: index === 0 ? undefined : `/usr/bin/${processName.toLowerCase()}`
      },
      upload: Math.floor(this.upTotal / (index + 1)),
      download: Math.floor(this.downTotal / (index + 1)),
      start: now.toISOString(),
      chains: ['DIRECT'],
      rule: 'MATCH',
      rulePayload: `host-${index}.example.com`
    }))
  }

  private snapshot(): MihomoConnectionsSnapshot {
    return {
      downloadTotal: this.downTotal,
      uploadTotal: this.upTotal,
      memory: 42_000_000,
      connections: this.connections()
    }
  }

  /**
   * Advance the mock counters and broadcast fresh messages to every connected
   * stream. Totals grow monotonically so the renderer history is cumulative.
   */
  private tick(): void {
    this.upTotal += 3_000 + Math.floor(Math.random() * 40_000)
    this.downTotal += 5_000 + Math.floor(Math.random() * 80_000)

    const traffic: MihomoTrafficMessage = {
      up: 3_000 + Math.floor(Math.random() * 40_000),
      down: 5_000 + Math.floor(Math.random() * 80_000),
      upTotal: this.upTotal,
      downTotal: this.downTotal
    }
    this.broadcast(this.trafficWss, JSON.stringify(traffic))
    this.broadcast(this.connectionsWss, JSON.stringify(this.snapshot()))
    if (Math.random() < 0.6) {
      const log: MihomoLogMessage = {
        type: Math.random() < 0.5 ? 'info' : 'warning',
        payload: `mock: ${Math.random() < 0.5 ? 'connection established' : 'proxied request'}`,
        time: new Date().toISOString()
      }
      this.broadcast(this.logsWss, JSON.stringify(log))
    }
  }

  private broadcast(wss: WebSocketServer, message: string): void {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message)
    }
  }

  private async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.httpServer.once('error', onError)
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.httpServer.off('error', onError)
        resolve()
      })
    })
    const addr = this.httpServer.address() as AddressInfo
    return addr.port
  }

  async start(): Promise<MockMihomoServerHandle> {
    const port = await this.listen()
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      wsBaseUrl: `ws://127.0.0.1:${port}`,
      close: () => this.close()
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    for (const wss of [this.trafficWss, this.logsWss, this.connectionsWss]) {
      for (const client of wss.clients) client.terminate()
      wss.close()
    }
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))
  }
}

export async function startMockMihomoServer(options: MockMihomoServerOptions = {}): Promise<MockMihomoServerHandle> {
  return new MockServer(options).start()
}
