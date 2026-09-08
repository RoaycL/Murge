import type { MihomoGateway } from '../../shared/gateways'
import type { MihomoOwnedTunIntent } from '../../shared/tun'
import type { TunConfigModel } from '../../shared/tun-config'
import { EMPTY_TUN_CONFIG, buildTunBlock } from '../../shared/tun-config'
import type { TunEnableResult, TunMutationAdapter, TunRestoreResult } from './coordinator'
import type { TunControllerReadiness, TunProfileRuntime } from './mihomo-owned-adapter'

/**
 * Switches TUN on the already-running privileged mihomo process. No process is
 * stopped, no listener is rebound, and the system-proxy target never changes.
 */
export class MihomoHotSwitchTunAdapter implements TunMutationAdapter {
  private active = false

  constructor(
    private readonly mihomo: MihomoGateway,
    private readonly runtimeFactory: () => TunProfileRuntime | Promise<TunProfileRuntime>,
    private readonly readiness: TunControllerReadiness,
    private readonly readTunConfig: () => TunConfigModel | Promise<TunConfigModel>,
    private readonly readyTimeoutMs = 20_000,
    /**
     * Whether the ACTIVE profile's final config enables the DNS module. Defaults
     * to true for compatibility with callers that predate the clash-party DNS
     * takeover alignment (their profiles always carried a dns block).
     */
    private readonly readDnsEnabled: () => boolean | Promise<boolean> = async () => true,
    /**
     * Windows top-level TUN uses mihomo's fixed 28.0.0.1/30 address. If another
     * client still owns that adapter/address, applying tun.enable would make
     * the shared core exit and leave an enabled system proxy with no listener.
     */
    private readonly externalTunInUse: (device: string) => boolean | Promise<boolean> = async () => false
  ) {}

  getActiveRuntime(): TunProfileRuntime | null {
    if (!this.active) return null
    // Runtime resolution is stable for one app lifetime, but this interface is
    // synchronous. The coordinator only consumes mixedPort and the hot-switch
    // composition no longer needs it, so return null rather than cache secrets.
    return null
  }

  async recoveryRequired(): Promise<boolean> {
    try {
      const current = await this.mihomo.getConfig()
      return current.tun?.enable === true
    } catch {
      return false
    }
  }

  async enable(intent: MihomoOwnedTunIntent): Promise<TunEnableResult> {
    const runtime = await this.runtimeFactory()
    const current = await this.mihomo.getConfig()
    const previous = current.tun ?? { enable: false }
    const model = await this.readTunConfig()
    const device = model.device === EMPTY_TUN_CONFIG.device ? intent.device : model.device
    if (current.tun?.enable !== true && await this.externalTunInUse(device)) {
      return { outcome: 'conflict', conflictDetail: 'TUN_INTERFACE_IN_USE' }
    }
    const next: Record<string, unknown> = {
      ...previous,
      ...buildTunBlock({ ...model, device, stack: model.stack ?? intent.stack }),
      enable: true
    }
    // clash-party parity (`!controlDns && tun && !profile.dns?.enable`): port-53
    // hijacking only makes sense when the kernel also runs a live DNS module —
    // hijacked queries without one would blackhole every hostname. The state
    // cannot come from the controller snapshot (mihomo's GET /configs does not
    // expose the dns block), so the caller supplies the authoritative flag read
    // from the same enhanced document the kernel was materialized from.
    if ((await this.readDnsEnabled()) !== true) next['dns-hijack'] = []
    try {
      await this.mihomo.patchConfig({ tun: next })
      const confirmed = await this.mihomo.getConfig()
      if (confirmed.tun?.enable !== true) throw new Error('TUN_HOT_SWITCH_ENABLE_NOT_APPLIED')
      this.active = true

      // Route creation can trail the controller acknowledgement briefly. Probe
      // it in the background for diagnostics only: public test endpoints must
      // never turn a locally-confirmed TUN switch into a 20-second UI block or
      // a false rollback on a restricted network.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.readyTimeoutMs)
      const readiness = this.readiness.waitUntilReady({
          controllerPort: runtime.controllerPort,
          secret: runtime.secret,
          signal: controller.signal
        }).finally(() => clearTimeout(timer))
      return { outcome: 'active', readiness }
    } catch (error) {
      try {
        await this.mihomo.patchConfig({ tun: previous })
      } catch {
        return { outcome: 'rollback-required', errorMessage: 'TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED' }
      }
      return { outcome: 'rollback-required', errorMessage: machineMessage(error) }
    }
  }

  async restore(): Promise<TunRestoreResult> {
    try {
      const current = await this.mihomo.getConfig()
      await this.mihomo.patchConfig({ tun: { ...(current.tun ?? {}), enable: false } })
      const confirmed = await this.mihomo.getConfig()
      if (confirmed.tun?.enable === true) {
        return { outcome: 'restore-failed', errorMessage: 'TUN_HOT_SWITCH_DISABLE_NOT_APPLIED' }
      }
      this.active = false
      return { outcome: 'restored' }
    } catch (error) {
      return { outcome: 'restore-failed', errorMessage: machineMessage(error) }
    }
  }
}

function machineMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'TUN_OPERATION_FAILED'
}
