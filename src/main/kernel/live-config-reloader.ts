import type { KernelGateway, MihomoGateway } from '@shared/gateways'
import type { CoreSettings } from '@shared/core-settings'
import type { GeodataSettings } from '@shared/geodata'
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
  secret: string
  device: string
}

export interface LiveConfigSources {
  readActiveDocument(): Promise<string | null>
  readTunConfig(): Promise<TunConfigModel>
  readCore(): Promise<CoreSettings>
  readGeodata(): Promise<GeodataSettings>
}

/**
 * Rebuild and hot-apply the exact complete runtime document used at startup.
 * Full-document reload is required for DNS/sniffer blocks: mihomo's PATCH
 * `/configs` schema exposes only a small set of general runtime fields.
 */
export class LiveConfigReloader {
  constructor(
    private readonly kernel: Pick<KernelGateway, 'getStatus'>,
    private readonly mihomo: Pick<MihomoGateway, 'getConfig' | 'reloadConfig'>,
    private readonly runtime: LiveConfigRuntime,
    private readonly sources: LiveConfigSources
  ) {}

  /** Returns false when no running core exists and the persisted change is deferred. */
  async reloadIfRunning(): Promise<boolean> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running' && status.phase !== 'starting') return false

    const current = await this.mihomo.getConfig()
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
    await this.mihomo.reloadConfig(payload)
    return true
  }
}
