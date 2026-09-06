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
    private readonly readyTimeoutMs = 20_000
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
    const next = {
      ...previous,
      ...buildTunBlock({ ...model, device, stack: model.stack ?? intent.stack }),
      enable: true
    }
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
      void this.readiness.waitUntilReady({
          controllerPort: runtime.controllerPort,
          secret: runtime.secret,
          signal: controller.signal
        }).catch(() => undefined).finally(() => clearTimeout(timer))
      return { outcome: 'active' }
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
