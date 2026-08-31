import http from 'node:http'

/**
 * Best-effort external (egress) IP of the running proxy node.
 *
 * The kernel's mixed-port listens on loopback and behaves as a standard HTTP
 * proxy. Sending an absolute-form GET through it makes the IP-echo service see
 * the *node's* exit address (not the user's LAN), which is exactly what a proxy
 * client wants to display as 外部 IP. Every failure degrades to `null` so the
 * UI can render its `—` fallback instead of surfacing an error.
 */

const DEFAULT_IP_URL = 'http://ip.sb'
const DEFAULT_TIMEOUT_MS = 5000

/** Pull the first dotted-quad IPv4 out of an arbitrary echo response body. */
export function extractIp(text: string): string | null {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(firstLine)) return firstLine
  const match = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  return match ? match[0] : null
}

export interface FetchExternalIpOptions {
  /** Proxy host to connect to (usually 127.0.0.1). */
  host: string
  /** Proxy port to connect to (the kernel's mixed-port). */
  port: number
  /** IP-echo target. Only plain http targets are supported via absolute-form. */
  url?: string
  timeoutMs?: number
}

export function fetchExternalIpViaProxy(opts: FetchExternalIpOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(opts.url ?? DEFAULT_IP_URL)
    } catch {
      resolve(null)
      return
    }
    // https targets require a CONNECT tunnel; keep this simple and read-only so
    // the endpoint is a plain-http echo service we can reach through the proxy.
    if (target.protocol !== 'http:') {
      resolve(null)
      return
    }
    const req = http.request(
      {
        host: opts.host,
        port: opts.port,
        method: 'GET',
        // Absolute-form request line: the proxy fetches the target on our behalf.
        path: target.href,
        headers: { Host: target.host, Connection: 'close' },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(extractIp(Buffer.concat(chunks).toString('utf8'))))
        res.on('error', () => resolve(null))
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}
