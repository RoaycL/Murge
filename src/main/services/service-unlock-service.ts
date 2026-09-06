import { net, session } from 'electron'
import type { ServiceUnlockResult, UnlockServiceName } from '@shared/unlock'
import type { ServiceUnlockSampler } from '@shared/gateways'
import { detectService, SERVICE_DETECTORS } from './service-detectors'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

/**
 * Common-service unlock probes for the 网络诊断 drawer (参考 clash-verge-rev
 * 的解锁测试页): each preset service (AI → streaming → others) is measured
 * through the kernel's mixed port exactly like clash-verge-rev does — one
 * dedicated `net` session with `setProxy('http://127.0.0.1:<mixed-port>')` —
 * so the verdict is about the SELECTED NODE's egress, independent of whether
 * the system proxy is on.
 *
 * The per-service detection logic lives in `service-detectors.ts` (pure);
 * this file owns the Electron transport: redirect-following requests with a
 * bounded per-request timeout, a Chrome UA, and a session-scoped cookie jar
 * (the Disney+ device→token→graphql flow needs it).
 */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 8_000
const PROBE_PARTITION = 'unlock-probe'

interface ProbeOutcome {
  status: number | null
  body: string
  headers: Record<string, string | string[]>
}

export interface ServiceUnlockOptions {
  /**
   * Resolve the kernel's LIVE mixed port for proxying probes; `null` (kernel
   * down / port unknown) fails closed: a direct/system-proxy probe cannot be
   * represented as the selected node's egress.
   */
  resolveMixedPort?: () => Promise<number | null>
}

export class ServiceUnlockService implements ServiceUnlockSampler {
  private readonly resolveMixedPort: () => Promise<number | null>
  private probeSession: Electron.Session | null = null
  private proxyRules: string | null = null

  constructor(options: ServiceUnlockOptions = {}) {
    this.resolveMixedPort = options.resolveMixedPort ?? (async () => null)
  }

  /** Test every preset service concurrently (a fixed handful — no cap needed). */
  async sample(): Promise<ServiceUnlockResult[]> {
    return Promise.all(SERVICE_DETECTORS.map((detector) => this.testOne(detector.name)))
  }

  /** Re-test one preset service; unknown names resolve as an error row. */
  async testOne(name: UnlockServiceName): Promise<ServiceUnlockResult> {
    await this.ensureSession()
    const probe = (step: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) =>
      this.probe(step)
    return detectService(name, probe)
  }

  private async ensureSession(): Promise<void> {
    const port = await this.resolveMixedPort().catch(() => null)
    if (!port || port <= 0) {
      throw new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, '内核未运行，无法通过当前节点执行解锁测试。')
    }
    const rules = `127.0.0.1:${port}`
    if (!this.probeSession) {
      this.probeSession = session.fromPartition(PROBE_PARTITION, { cache: false })
    }
    if (rules !== this.proxyRules) {
      await this.probeSession.setProxy({ proxyRules: rules })
      this.proxyRules = rules
    }
  }

  /** One redirect-following HTTP request on the probe session, degraded to a body/status pair. */
  private probe(step: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<ProbeOutcome> {
    return new Promise((resolve) => {
      if (!this.probeSession) {
        resolve({ status: null, body: '', headers: {} })
        return
      }
      let request: Electron.ClientRequest | null = null
      let settled = false
      const finish = (outcome: ProbeOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        try {
          request?.abort()
        } catch {
          /* already gone */
        }
        finish({ status: null, body: '', headers: {} })
      }, REQUEST_TIMEOUT_MS)
      try {
        request = net.request({
          method: step.method ?? 'GET',
          url: step.url,
          session: this.probeSession,
          useSessionCookies: true,
          redirect: 'follow'
        })
      } catch {
        finish({ status: null, body: '', headers: {} })
        return
      }
      request.setHeader('user-agent', USER_AGENT)
      for (const [key, value] of Object.entries(step.headers ?? {})) {
        try {
          request.setHeader(key, value)
        } catch {
          /* invalid header value: skip rather than fail the probe */
        }
      }
      request.on('response', (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= 1_000_000) chunks.push(chunk)
        })
        response.on('end', () => {
          const headerEntries: Record<string, string | string[]> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headerEntries[key] = value
            else if (Array.isArray(value) && value.length > 0) headerEntries[key] = value.length === 1 ? value[0] : value
          }
          finish({ status: response.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8'), headers: headerEntries })
        })
        response.on('error', () => finish({ status: null, body: '', headers: {} }))
      })
      request.on('error', () => finish({ status: null, body: '', headers: {} }))
      if (step.body !== undefined) request.write(step.body)
      request.end()
    })
  }
}
