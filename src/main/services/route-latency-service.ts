import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'

/**
 * Default-gateway RTT probe — the "路由" slot of the INTERNET 延迟 card.
 *
 * Node has no ICMP API, so the RTT is measured as a TCP connect handshake to
 * the gateway itself (its DNS proxy on :53 first, then the admin UI on :80).
 * That is a genuine first-hop liveness/latency signal — exactly what
 * distinguishes a LAN/Wi-Fi hiccup from an upstream outage — without ever
 * sending raw packets or mutating the host network.
 *
 * The probe is READ-ONLY with respect to the system: one loopback command to
 * read the routing table (or /proc/net/route) and outbound TCP connects to the
 * gateway the machine already uses. No listeners, no config changes.
 */

export interface GatewayRttResult {
  /** Dotted gateway address, when the platform's routing table exposed one. */
  gateway: string | null
  /** Connect-handshake RTT in ms, null when unreachable or undetectable. */
  rttMs: number | null
}

type ExecFn = (file: string, args: string[]) => Promise<string>
type ConnectFn = (options: { host: string; port: number; timeout?: number }) => Promise<number>

const PROBE_PORTS = [53, 80]
const PROBE_TIMEOUT_MS = 1200

/** `route -n get default` → `   gateway: 192.168.1.1` */
export function parseDarwinDefaultGateway(stdout: string): string | null {
  const match = stdout.match(/^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m)
  return match ? match[1] : null
}

/** /proc/net/route → the destination-00000000 row's little-endian hex gateway. */
export function parseLinuxProcRoute(text: string): string | null {
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[1] !== '00000000') continue
    const hex = columns[2]
    if (!hex || !/^[0-9A-Fa-f]{8}$/.test(hex)) continue
    const bytes = hex.match(/.{2}/g) ?? []
    // /proc/net/route stores the address little-endian.
    return bytes.reverse().map((byte) => parseInt(byte, 16)).join('.')
  }
  return null
}

/**
 * `route print 0.0.0.0` → the active IPv4 route row whose network destination
 * and mask are both 0.0.0.0; the gateway is the third column. Multiple default
 * routes are listed by metric order, so the first match is the active one.
 */
export function parseWindowsRoutePrint(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s{2,}/)
    if (columns[0] !== '0.0.0.0' || columns[1] !== '0.0.0.0') continue
    const gateway = columns[2]
    if (gateway && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) return gateway
  }
  return null
}

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * TCP connect to `host:port`, resolving with the handshake RTT in ms. Ports
 * typically open on a home gateway (DNS proxy, admin UI); a refused port falls
 * through to the next candidate, a timeout swallows into null.
 */
function gatewayConnectRtt(connectFn: ConnectFn, host: string): Promise<number | null> {
  const attempt = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      connectFn({ host, port, timeout: PROBE_TIMEOUT_MS })
        .then(resolve)
        .catch(reject)
    })
  return (async () => {
    for (const port of PROBE_PORTS) {
      try {
        return await attempt(port)
      } catch {
        // try the next candidate port
      }
    }
    return null
  })()
}

export interface RouteLatencyDeps {
  platform?: NodeJS.Platform
  runCommandFn?: ExecFn
  readFileFn?: (path: string) => Promise<string>
  connectFn?: ConnectFn
}

/** Default ConnectFn: a real TCP handshake that resolves with the RTT in ms. */
function defaultConnect(options: { host: string; port: number; timeout?: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = connect(options)
    socket.once('connect', () => {
      const rtt = Date.now() - started
      socket.destroy()
      resolve(rtt)
    })
    socket.once('error', reject)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('gateway connect timeout'))
    })
  })
}

/**
 * Resolve the default gateway for the current platform and time a TCP
 * handshake against it. Never throws: every detection/connect failure degrades
 * to nulls, which the UI renders as an em dash.
 */
export async function measureGatewayRtt(deps: RouteLatencyDeps = {}): Promise<GatewayRttResult> {
  const platform = deps.platform ?? process.platform
  const run = deps.runCommandFn ?? runCommand
  const read = deps.readFileFn ?? ((path: string) => readFile(path, 'utf8'))
  const connectFn: ConnectFn = deps.connectFn ?? defaultConnect

  let gateway: string | null = null
  try {
    if (platform === 'darwin') {
      gateway = parseDarwinDefaultGateway(await run('route', ['-n', 'get', 'default']))
    } else if (platform === 'linux') {
      gateway = parseLinuxProcRoute(await read('/proc/net/route'))
    } else if (platform === 'win32') {
      gateway = parseWindowsRoutePrint(await run('route', ['print', '0.0.0.0']))
    }
  } catch {
    gateway = null
  }
  if (!gateway) return { gateway: null, rttMs: null }

  try {
    return { gateway, rttMs: await gatewayConnectRtt(connectFn, gateway) }
  } catch {
    return { gateway, rttMs: null }
  }
}
