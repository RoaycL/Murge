import { Resolver } from 'node:dns'
import { measureGatewayRtt, type GatewayRttResult } from './route-latency-service'
import type { MihomoGateway } from '@shared/gateways'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

/**
 * One INTERNET-latency sample for the activity card:
 *
 *  - `gateway` — first-hop RTT (TCP handshake to the default gateway; the
 *    mihomo kernel does not own this path, so it is probed directly).
 *  - `dns` — the kernel's DNS resolver answering a real NS query, timed
 *    end-to-end around the controller call.
 *  - `proxy` — the delay the controller itself reports for the node selected by
 *    the first selectable group in the active profile's declared order. This
 *    avoids treating the unordered `/proxies` map as configuration order. It IS the
 *    full INTERNET RTT through the proxy chain, so it is surfaced as the big
 *    headline number and needs no client-side arithmetic.
 *
 * Every slot fails independently to `null` — a degraded path renders as an em
 * dash, never as a fake number and never as a card-wide error.
 */
export interface InternetLatencySample {
  gatewayMs: number | null
  dnsMs: number | null
  proxyMs: number | null
  /** The selector's current node the proxy delay was measured against. */
  proxyNode: string | null
}

/**
 * System-resolver fallback: a FRESH Resolver instance per probe (no process
 * cache), asking an NS record for a random label under a busy TLD. An ANSWER
 * OR a definitive negative reply (ENODATA "no records", ENOTFOUND "NXDOMAIN")
 * proves the upstream round trip completed — only timeouts/network errors
 * mean the measurement is unusable.
 */
async function systemDnsNsProbe(label: string): Promise<'answered' | 'failed'> {
  const resolver = new Resolver({ timeout: 1200, tries: 1 })
  try {
    await new Promise<void>((resolve, reject) => {
      resolver.resolveNs(label, (error) => (error ? reject(error) : resolve()))
    })
    return 'answered'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENODATA' || code === 'ENOTFOUND' ? 'answered' : 'failed'
  } finally {
    resolver.cancel()
  }
}

/** First selectable group type whose `now` member represents the default path. */
const SELECTABLE_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback'])

export interface LatencyServiceOptions {
  mihomo: Pick<MihomoGateway, 'getProxies' | 'delayTest' | 'dnsQuery'>
  /** Ordered group names parsed from the active profile document. */
  resolveGroupOrder: () => Promise<string[]>
  measureGatewayRttFn?: () => Promise<GatewayRttResult>
  nowFn?: () => number
  /**
   * System-resolver fallback for when the kernel's DNS module is disabled
   * (`GET /dns/query` answers "DNS section is disabled" then). Returns whether
   * the upstream ANSWERED — NXDOMAIN counts; only timeouts/network errors fail.
   */
  systemDnsProbeFn?: (label: string) => Promise<'answered' | 'failed'>
}

export class InternetLatencyService {
  private readonly mihomo: LatencyServiceOptions['mihomo']
  private readonly gatewayFn: () => Promise<GatewayRttResult>
  private readonly nowFn: () => number
  private readonly systemDnsProbeFn: (label: string) => Promise<'answered' | 'failed'>
  private readonly resolveGroupOrder: () => Promise<string[]>

  constructor(options: LatencyServiceOptions) {
    this.mihomo = options.mihomo
    this.gatewayFn = options.measureGatewayRttFn ?? measureGatewayRtt
    this.nowFn = options.nowFn ?? Date.now
    this.systemDnsProbeFn = options.systemDnsProbeFn ?? systemDnsNsProbe
    this.resolveGroupOrder = options.resolveGroupOrder
  }

  /**
   * True when the proxy slot is meaningful: a selector exists and currently
   * points at a concrete node (not DIRECT/REJECT placeholders).
   */
  private resolveProxyNode(
    proxies: Awaited<ReturnType<MihomoGateway['getProxies']>>['proxies'],
    groupOrder: string[]
  ): string | null {
    for (const groupName of groupOrder) {
      const proxy = proxies[groupName]
      if (!proxy) continue
      if (!SELECTABLE_GROUP_TYPES.has(proxy.type)) continue
      if (proxy.name.toUpperCase() === 'GLOBAL') continue
      const now = proxy.now
      if (typeof now === 'string' && now.length > 0 && now !== 'DIRECT' && now !== 'REJECT') return now
    }
    return null
  }

  /** Collect one sample. Never throws; each slot degrades independently. */
  async sample(): Promise<InternetLatencySample> {
    const [gateway, dnsMs, proxy] = await Promise.all([
      this.gatewayFn().catch(() => ({ gateway: null, rttMs: null }) satisfies GatewayRttResult),
      this.sampleDns(),
      this.sampleProxy()
    ])
    return {
      gatewayMs: gateway.rttMs,
      dnsMs,
      ...proxy
    }
  }

  private async sampleDns(): Promise<number | null> {
    // The kernel's resolver answers when its DNS module is enabled. Only its
    // explicit "DNS section is disabled" response permits a system-resolver
    // fallback; controller/auth/timeout failures must remain visibly unavailable.
    const kernelStarted = this.nowFn()
    const label = `murge-latency-${kernelStarted.toString(36)}.example.com`
    try {
      await this.mihomo.dnsQuery(label, 'NS')
      return this.nowFn() - kernelStarted
    } catch (error) {
      if (!this.isDnsDisabled(error)) return null
      const systemStarted = this.nowFn()
      const answered = await this.systemDnsProbeFn(label).catch(() => 'failed' as const)
      return answered === 'answered' ? this.nowFn() - systemStarted : null
    }
  }

  private isDnsDisabled(error: unknown): boolean {
    if (error instanceof ProtocolError) {
      return error.code === ProtocolErrorCode.UPSTREAM_HTTP_ERROR &&
        /dns section is disabled/i.test(error.details?.reason ?? error.message)
    }
    return error instanceof Error && /dns section is disabled/i.test(error.message)
  }

  private async sampleProxy(): Promise<{ proxyMs: number | null; proxyNode: string | null }> {
    try {
      const [response, groupOrder] = await Promise.all([
        this.mihomo.getProxies(),
        this.resolveGroupOrder()
      ])
      const proxyNode = this.resolveProxyNode(response.proxies, groupOrder)
      if (!proxyNode) return { proxyMs: null, proxyNode: null }
      const proxyMs = await this.mihomo.delayTest(proxyNode).then((result) => result.delay).catch(() => null)
      return { proxyMs, proxyNode }
    } catch {
      return { proxyMs: null, proxyNode: null }
    }
  }
}
