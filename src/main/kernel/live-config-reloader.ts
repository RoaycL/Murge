import type { KernelGateway, MihomoGateway } from '@shared/gateways'
import type { CoreSettings } from '@shared/core-settings'
import type { GeodataSettings } from '@shared/geodata'
import { buildGeodataBlock } from '@shared/geodata'
import type { TunConfigModel } from '@shared/tun-config'
import { parse, stringify } from 'yaml'
import { generateMihomoConfig } from './mihomo-config'
import { buildProfileKernelConfig } from './profile-kernel-config'
import { generateMihomoTunConfig, generateProxiedTunConfig } from '../tun/mihomo-tun-config'

export interface LiveConfigRuntime {
  mixedPort: number
  httpPort?: number
  socksPort?: number
  controllerPort: number
  controllerHost?: '127.0.0.1' | '0.0.0.0'
  allowLan?: boolean
  controllerPanel?: boolean
  secret: string
  device: string
}

export interface LiveConfigSources {
  readActiveDocument(): Promise<string | null>
  readTunConfig(): Promise<TunConfigModel>
  readCore(): Promise<CoreSettings>
  readGeodata(): Promise<GeodataSettings>
}

export type LiveConfigSection = 'dns' | 'sniffer' | 'geodata'

const GEODATA_KEYS = [
  'geodata-mode', 'geodata-loader', 'geo-auto-update', 'geo-update-interval', 'geox-url'
] as const

function sameStringList(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Rebuild and hot-apply the exact complete runtime document used at startup.
 * DNS, sniffer and geodata mutations use the partial endpoint below; callers
 * that replace the complete profile can still use the full-document reload.
 */
export class LiveConfigReloader {
  constructor(
    private readonly kernel: Pick<KernelGateway, 'getStatus'>,
    private readonly mihomo: Pick<MihomoGateway,
      'getConfig' | 'patchConfig' | 'reloadConfig' | 'flushDnsCache' | 'flushFakeIpCache'>,
    private readonly runtime: LiveConfigRuntime,
    private readonly sources: LiveConfigSources
  ) {}

  /** Returns false when no running core exists and the persisted change is deferred. */
  async reloadIfRunning(): Promise<boolean> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running' && status.phase !== 'starting') return false

    const current = await this.mihomo.getConfig()
    const payload = await this.buildPayload(current)
    await this.mihomo.reloadConfig(payload)
    return true
  }

  /**
   * Apply controlled sections through mihomo's partial config endpoint. Unlike
   * a full PUT this does not recreate providers, listeners or the TUN route.
   */
  async patchSectionsIfRunning(sections: readonly LiveConfigSection[]): Promise<boolean> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running' && status.phase !== 'starting') return false

    const current = await this.mihomo.getConfig()
    const data = parse(await this.buildPayload(current)) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const section of sections) {
      if (section === 'geodata') {
        const fallback = buildGeodataBlock(await this.sources.readGeodata())
        for (const key of GEODATA_KEYS) patch[key] = data[key] ?? fallback[key]
        continue
      }
      const value = data[section]
      patch[section] = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : { enable: false }
    }

    // DNS control and TUN DNS hijacking are one contract. Patch TUN only when
    // that list actually changes; sending an unchanged TUN block can recreate
    // the Windows adapter and briefly interrupt the route.
    if (sections.includes('dns') && current.tun?.enable === true) {
      const desiredTun = data.tun as Record<string, unknown> | undefined
      const desiredHijack = desiredTun?.['dns-hijack']
      const currentHijack = current.tun['dns-hijack']
      if (!sameStringList(currentHijack, desiredHijack)) {
        patch.tun = { ...current.tun, 'dns-hijack': Array.isArray(desiredHijack) ? desiredHijack : [] }
      }
    }

    await this.mihomo.patchConfig(patch)
    if (sections.includes('dns')) {
      // A changed fake-IP range must not keep mappings from the previous DNS
      // model. Cache cleanup is best-effort because the patch itself succeeded.
      await Promise.allSettled([
        this.mihomo.flushDnsCache(),
        this.mihomo.flushFakeIpCache()
      ])
    }
    return true
  }

  private async buildPayload(current: Awaited<ReturnType<MihomoGateway['getConfig']>>): Promise<string> {
    const tunEnabled = current.tun?.enable === true
    const [document, tunConfig, core, geodata] = await Promise.all([
      this.sources.readActiveDocument(),
      this.sources.readTunConfig(),
      this.sources.readCore(),
      this.sources.readGeodata()
    ])

    const common = { ...this.runtime, tunConfig, tunEnabled }
    let payload = document
      ? tunEnabled
        ? generateProxiedTunConfig({ ...common, document, core, geodata })
        : buildProfileKernelConfig(document, { ...this.runtime, core, geodata })
      : tunEnabled
        ? generateMihomoTunConfig(common)
        : generateMihomoConfig(this.runtime)

    // The safety builder intentionally normalizes profile startup mode to rule.
    // A live Direct/Global choice is runtime intent, so fold it into the SAME
    // atomic reload rather than issuing a second PATCH that could fail after the
    // new DNS/sniffer document was already committed.
    if (document && (current.mode === 'direct' || current.mode === 'global')) {
      const data = parse(payload) as Record<string, unknown>
      data.mode = current.mode
      payload = stringify(data)
    }
    return payload
  }
}
