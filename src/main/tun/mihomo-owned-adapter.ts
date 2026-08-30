import type { MihomoOwnedTunIntent } from '../../shared/tun'
import type { TunEnableResult, TunMutationAdapter, TunRestoreResult } from './coordinator'
import { generateMihomoTunConfig } from './mihomo-tun-config'
import type { TunServiceClient } from './service-client'

export interface TunProfileRuntime {
  mixedPort: number
  controllerPort: number
  secret: string
}

export interface TunControllerReadiness {
  waitUntilReady(input: { controllerPort: number; secret: string; signal: AbortSignal }): Promise<void>
}

/**
 * Phase 9B lifecycle adapter. The only privileged action is delegated to the
 * fixed service protocol; network setup/teardown is entirely mihomo-owned.
 */
export class MihomoOwnedTunAdapter implements TunMutationAdapter {
  private activeRuntime: TunProfileRuntime | null = null

  constructor(
    private readonly client: TunServiceClient,
    private readonly runtimeFactory: () => TunProfileRuntime,
    private readonly readiness: TunControllerReadiness,
    private readonly readyTimeoutMs = 10_000
  ) {}

  async recoveryRequired(): Promise<boolean> {
    const response = await this.client.reconcile()
    return response.outcome === 'running' || response.outcome === 'starting' || response.outcome === 'stopping'
  }

  async enable(intent: MihomoOwnedTunIntent): Promise<TunEnableResult> {
    const runtime = this.runtimeFactory()
    const profile = generateMihomoTunConfig({ ...runtime, device: intent.device, stack: intent.stack })
    await this.client.start(profile)
    this.activeRuntime = runtime
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.readyTimeoutMs)
    try {
      await this.readiness.waitUntilReady({
        controllerPort: runtime.controllerPort,
        secret: runtime.secret,
        signal: controller.signal
      })
      return { outcome: 'active' }
    } catch (error) {
      try {
        await this.client.stop()
        this.activeRuntime = null
      } catch {
        return { outcome: 'rollback-required', errorMessage: 'TUN_START_FAILED_STOP_UNCONFIRMED' }
      }
      return { outcome: 'rollback-required', errorMessage: machineMessage(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async restore(): Promise<TunRestoreResult> {
    try {
      await this.client.stop()
      this.activeRuntime = null
      return { outcome: 'restored' }
    } catch (error) {
      return { outcome: 'restore-failed', errorMessage: machineMessage(error) }
    }
  }
}

function machineMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'TUN_OPERATION_FAILED'
}
