import { Resolver } from 'node:dns'
import { measureGatewayRtt, type GatewayRttResult } from './route-latency-service'
import type { MihomoGateway } from '@shared/gateways'

/**
 * One INTERNET-latency sample for the activity card:
 *
 *  - `gateway` — first-hop RTT (TCP handshake to the default gateway; the
 *    mihomo kernel does not own this path, so it is probed directly).
 *  - `dns` — the kernel's DNS resolver answering a real A query, timed
 *    end-to-end around the controller call.
 *  - `proxy` — the delay the controller itself reports for the node the user's
 *    selector currently points at (the `now` member of the first selectable
 *    group, i.e. exactly the path new connections take). This already IS the
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
const SELECTABLE_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])

export interface LatencyServiceOptions {
  mihomo: Pick<MihomoGateway, 'getProxies' | 'delayTest' | 'dnsQuery'>
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

  constructor(options: LatencyServiceOptions) {
    this.mihomo = options.mihomo
    this.gatewayFn = options.measureGatewayRttFn ?? measureGatewayRtt
    this.nowFn = options.nowFn ?? Date.now
    this.systemDnsProbeFn = options.systemDnsProbeFn ?? systemDnsNsProbe
  }

  /**
   * True when the proxy slot is meaningful: a selector exists and currently
   * points at a concrete node (not DIRECT/REJECT placeholders).
   */
  private resolveProxyNode(proxies: Awaited<ReturnType<MihomoGateway['getProxies']>>['proxies']): string | null {
    for (const proxy of Object.values(proxies)) {
      if (!SELECTABLE_GROUP_TYPES.has(proxy.type)) continue
      if (proxy.name.toUpperCase() === 'GLOBAL') continue
      const now = proxy.now
      if (typeof now === 'string' && now.length > 0 && now !== 'DIRECT' && now !== 'REJECT') return now
    }
    return null
  }

  /** Collect one sample. Never throws; each slot degrades independently. */
  async sample(): Promise<InternetLatencySample> {
    const [gateway, kernelPaths] = await Promise.all([
      this.gatewayFn().catch(() => ({ gateway: null, rttMs: null }) satisfies GatewayRttResult),
      this.sampleKernelPaths().catch(() => ({ dnsMs: null, proxyMs: null, proxyNode: null }))
    ])
    return {
      gatewayMs: gateway.rttMs,
      ...kernelPaths
    }
  }

  private async sampleKernelPaths(): Promise<{ dnsMs: number | null; proxyMs: number | null; proxyNode: string | null }> {
    const proxies = (await this.mihomo.getProxies()).proxies
    const proxyNode = this.resolveProxyNode(proxies)

    // The kernel's resolver answers when its DNS module is enabled; a disabled
    // module returns a message body the zod schema rejects, so the fallback
    // (a fresh system resolver + a random label, timed the same way) keeps the
    // slot meaningful — the OS resolve path IS what the machine uses then.
    const dnsStarted = this.nowFn()
    const label = `murge-latency-${dnsStarted.toString(36)}.example.com`
    const dnsPromise = this.mihomo
      .dnsQuery(label, 'NS')
      .then(() => this.nowFn() - dnsStarted)
      .catch(async () => {
        const answered = await this.systemDnsProbeFn(label).catch(() => 'failed' as const)
        return answered === 'answered' ? this.nowFn() - dnsStarted : null
      })

    const proxyPromise = proxyNode
      ? this.mihomo
          .delayTest(proxyNode)
          .then((result) => result.delay)
          .catch(() => null)
      : Promise.resolve(null)

    const [dnsMs, proxyMs] = await Promise.all([dnsPromise, proxyPromise])
    return { dnsMs, proxyMs, proxyNode }
  }
}
