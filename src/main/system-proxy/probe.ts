import { connect, type Socket } from 'node:net'
import { SYSTEM_PROXY_LOOPBACK_HOST, SystemProxyTarget } from '../../shared/system-proxy'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { KernelGateway } from '../../shared/gateways'
import type { MihomoConfigSnapshot } from '../../shared/mihomo-api'
import type { SystemProxyKernelProbe } from './types'

/** A probe that always returns a fixed target — used in dev and in unit tests. */
export class StaticSystemProxyProbe implements SystemProxyKernelProbe {
  constructor(private readonly target: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }) {}

  resolveTarget(): Promise<SystemProxyTarget> {
    return Promise.resolve(this.target)
  }
}

/** Minimal authenticated surface the live probe needs from the mihomo gateway. */
export interface LiveProbeMihomo {
  getVersion(): Promise<unknown>
  getConfig(): Promise<MihomoConfigSnapshot>
}

const PROBE_TIMEOUT_MS = 2500
const PROBE_HOST = SYSTEM_PROXY_LOOPBACK_HOST

/** Open a TCP connection to the candidate proxy port (fails fast on a dead port). */
export function openTcp(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: PROBE_HOST, port, timeout: timeoutMs })
    const onTimeout = () => {
      socket.destroy()
      reject(new Error(`TCP connect to ${PROBE_HOST}:${port} timed out`))
    }
    const onError = (err: Error) => {
      socket.removeListener('timeout', onTimeout)
      reject(err)
    }
    socket.once('timeout', onTimeout)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

/**
 * Probe the SOCKS5 layer: send a no-auth greeting and require `05 00` back.
 *
 * The reply is accumulated across data chunks (P2-1): a healthy mixed-port
 * commonly returns the 2 bytes `05 00` split into two segments, so we wait until
 * at least 2 bytes arrive rather than demanding them in the first chunk. The total
 * timeout is kept for the whole exchange — a partial chunk must NOT clear it. A
 * single guarded `finish` settles the promise exactly once across `data` /
 * `error` / `close` / timeout, so an immediate close after success can never
 * double-reject.
 */
export function probeSocks(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    openTcp(port, timeoutMs)
      .then((socket) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const finish = (err?: Error) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          socket.destroy()
          if (err) reject(err)
          else resolve()
        }
        timer = setTimeout(() => finish(new Error('SOCKS5 greeting timed out')), timeoutMs)
        socket.once('error', (err) => finish(err))
        // Accumulate the greeting reply — wait on <2 bytes, validate once >=2.
        let buffer = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          if (settled) return
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.length < 2) return
          if (buffer[0] === 0x05 && buffer[1] === 0x00) finish()
          else finish(new Error(`unexpected SOCKS5 greeting reply: ${buffer.subarray(0, 2).toString('hex')}`))
        })
        // A proxy that closes without a valid greeting is not speaking SOCKS5.
        socket.once('close', () => finish(new Error('SOCKS5 closed without a greeting reply')))
        // Greeting: version 5, 1 offered method (0x00 no-auth). Expect `05 00`.
        socket.write(Buffer.from([0x05, 0x01, 0x00]))
      })
      .catch(reject)
  })
}

/**
 * Probe the HTTP-proxy layer: a CONNECT must be answered with an HTTP status line.
 *
 * The target is ALWAYS the loopback literal `127.0.0.1:1` — never a public DNS
 * name — so a misbehaving proxy can never trigger a real external CONNECT (P2-2).
 * The total timeout is kept for the whole exchange (P2-1): a normal `data` chunk
 * must NOT clear it, otherwise a split status line (e.g. the first chunk is just
 * `HTT`) with no further data would leave the promise pending forever. The timer
 * is only cleared by a single `finish`, which is guarded so `data` / `error` /
 * `close` / timeout each settle the promise exactly once.
 */
export function probeHttp(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    openTcp(port, timeoutMs)
      .then((socket) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const finish = (err?: Error) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          socket.destroy()
          if (err) reject(err)
          else resolve()
        }
        timer = setTimeout(() => finish(new Error('HTTP CONNECT response timed out')), timeoutMs)
        socket.once('error', (err) => finish(err))
        let buffer = ''
        socket.on('data', (chunk) => {
          if (settled) return
          // Accumulate: the status line may arrive split across data chunks.
          buffer += chunk.toString('latin1')
          if (/^(?:HTTP\/\d(?:\.\d)?)\s+\d{3}/.test(buffer)) {
            // Any HTTP status line (2xx, or a proxy 4xx/5xx) proves the port
            // speaks HTTP proxying; a proxy that cannot route still answers 502.
            finish()
          }
        })
        // A proxy that closes without answering is not speaking HTTP for us.
        socket.once('close', () => finish(new Error('HTTP CONNECT closed without a status line')))
        socket.write(
          'CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUser-Agent: system-proxy-probe\r\n\r\n'
        )
      })
      .catch(reject)
  })
}

/**
 * Production probe: the system proxy may only be enabled once the kernel is
 * actually running, authenticated, and advertising a mixed-port. It never trusts
 * a hard-coded port — the port is read from the live `/configs` response — and it
 * socket-probes the mixed-port (TCP / HTTP CONNECT / SOCKS5) before it will let
 * the app point the registry at it, so a stale or unstarted kernel can never
 * leave the system proxy aimed at a dead port.
 */
export class LiveSystemProxyKernelProbe implements SystemProxyKernelProbe {
  constructor(
    private readonly kernel: KernelGateway,
    private readonly mihomo: LiveProbeMihomo
  ) {}

  async resolveTarget(): Promise<SystemProxyTarget> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running') {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未运行，无法启用系统代理')
    }
    try {
      await this.mihomo.getVersion()
    } catch {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核控制器未就绪，无法启用系统代理')
    }
    const config = await this.mihomo.getConfig()
    const mixedPort = config['mixed-port']
    if (typeof mixedPort !== 'number' || !Number.isInteger(mixedPort) || mixedPort <= 0 || mixedPort > 65535) {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未提供有效的混合端口，无法启用系统代理')
    }
    // Parallel HTTP + SOCKS probes; a single failure means the port is not a live
    // mixed-port listener, so we must not point the system proxy at it.
    const [httpResult, socksResult] = await Promise.allSettled([
      probeHttp(mixedPort),
      probeSocks(mixedPort)
    ])
    const probeErrors = [httpResult, socksResult]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as Error).message)
    if (probeErrors.length > 0) {
      throw new ProtocolError(
        ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED,
        `内核混合端口未就绪（${mixedPort}）：${probeErrors.join('；')}`
      )
    }
    return { host: SYSTEM_PROXY_LOOPBACK_HOST, port: mixedPort }
  }
}
