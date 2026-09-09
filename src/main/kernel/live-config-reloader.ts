import type { KernelGateway, MihomoGateway } from '@shared/gateways'
import type { CoreSettings } from '@shared/core-settings'
import type { GeodataSettings } from '@shared/geodata'
import { buildGeodataBlock } from '@shared/geodata'
import type { SnifferEnhancement } from '@shared/sniffer'
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
  /** Active profile after ordinary overrides, before DNS/sniffer enhancement. */
  readBaseDocument?(): Promise<string | null>
  readTunConfig(): Promise<TunConfigModel>
  readCore(): Promise<CoreSettings>
  readGeodata(): Promise<GeodataSettings>
}

export type LiveConfigSection = 'dns' | 'sniffer' | 'geodata'

const GEODATA_KEYS = [
  'geodata-mode', 'geodata-loader', 'geo-auto-update', 'geo-update-interval', 'geox-url'
] as const

/**
 * Rebuild and hot-apply the exact complete runtime document used at startup.
 * Mihomo's PATCH /configs endpoint silently ignores nested DNS and sniffer
 * blocks. DNS and changed sniffer rules therefore use the payload endpoint;
 * an unchanged, already-loaded sniffer dispatcher can use the runtime gate.
 */
export class LiveConfigReloader {
  /** Signature of a loaded enhancement dispatcher temporarily muted by PATCH. */
  private suspendedSnifferSignature: string | null = null

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
    this.suspendedSnifferSignature = null
    return true
  }

  /**
   * Apply controlled sections through the lightest endpoint that actually owns
   * them. DNS/sniffer require an in-process payload reload; geodata supports the
   * partial config endpoint.
   */
  async applySectionsIfRunning(sections: readonly LiveConfigSection[]): Promise<boolean> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running' && status.phase !== 'starting') return false

    const current = await this.mihomo.getConfig()
    const payload = await this.buildPayload(current)

    if (sections.includes('dns') || sections.includes('sniffer')) {
      await this.mihomo.reloadConfig(payload)
      this.suspendedSnifferSignature = null
      if (sections.includes('dns')) {
        // A changed fake-IP range must not keep mappings from the previous DNS
        // model. Cache cleanup is best-effort because the reload succeeded.
        await Promise.allSettled([
          this.mihomo.flushDnsCache(),
          this.mihomo.flushFakeIpCache()
        ])
      }
      return true
    }

    const data = parse(payload) as Record<string, unknown>
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

    await this.mihomo.patchConfig(patch)
    return true
  }

  /**
   * Toggle an already-loaded sniffer dispatcher through mihomo's lightweight
   * legacy `sniffing` runtime flag. A full payload reload remains the safe
   * fallback when the underlying dispatcher/config must change.
   */
  async applySnifferTransitionIfRunning(
    previous: SnifferEnhancement,
    next: SnifferEnhancement
  ): Promise<boolean> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running' && status.phase !== 'starting') return false

    const signature = this.snifferSignature(next)
    const enabledOnly = previous.enabled !== next.enabled &&
      this.snifferSignature(previous) === signature
    const baseHasEnabledSniffer = await this.baseDocumentSnifferEnabled()

    if (enabledOnly && !baseHasEnabledSniffer) {
      if (!next.enabled) {
        await this.mihomo.patchConfig({ sniffing: false })
        if ((await this.mihomo.getConfig()).sniffing === false) {
          this.suspendedSnifferSignature = signature
          return true
        }
      } else if (this.suspendedSnifferSignature === signature) {
        await this.mihomo.patchConfig({ sniffing: true })
        if ((await this.mihomo.getConfig()).sniffing === true) {
          this.suspendedSnifferSignature = null
          return true
        }
      }
    }

    this.suspendedSnifferSignature = null
    return this.applySectionsIfRunning(['sniffer'])
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

  private snifferSignature(value: SnifferEnhancement): string {
    return JSON.stringify({ ...value, enabled: true })
  }

  private async baseDocumentSnifferEnabled(): Promise<boolean> {
    const text = await this.sources.readBaseDocument?.()
    if (!text) return false
    try {
      const data = parse(text) as Record<string, unknown>
      const sniffer = data?.sniffer
      return typeof sniffer === 'object' && sniffer !== null && !Array.isArray(sniffer) &&
        (sniffer as Record<string, unknown>).enable === true
    } catch {
      // An invalid base document cannot safely use the shortcut; the full path
      // will preserve the existing validation/rollback behavior.
      return true
    }
  }
}
