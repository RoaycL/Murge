import type { MihomoOwnedTunIntent } from '../../shared/tun'
import type { TunEnableResult, TunMutationAdapter, TunRestoreResult } from './coordinator'
import { generateMihomoTunConfig } from './mihomo-tun-config'
import type { TunServiceClient } from './service-client'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { TunConfigModel } from '../../shared/tun-config'
import { EMPTY_TUN_CONFIG } from '../../shared/tun-config'

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
    private readonly runtimeFactory: () => TunProfileRuntime | Promise<TunProfileRuntime>,
    private readonly readiness: TunControllerReadiness,
    private readonly readyTimeoutMs = 10_000,
    /** Read the persisted typed TUN config model (falls back to the safe default). */
    private readonly readTunConfig: () => TunConfigModel | Promise<TunConfigModel> = async () => EMPTY_TUN_CONFIG
  ) {}

  async recoveryRequired(): Promise<boolean> {
    const response = await this.client.reconcile()
    return response.outcome === 'running' || response.outcome === 'starting' || response.outcome === 'stopping'
  }

  async enable(intent: MihomoOwnedTunIntent): Promise<TunEnableResult> {
    const runtime = await this.runtimeFactory()
    const tunConfig = await this.readTunConfig()
    const profile = generateMihomoTunConfig({ ...runtime, device: intent.device, stack: intent.stack, tunConfig })
    try {
      await this.client.start(profile)
    } catch (error) {
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.TUN_SERVICE_CONFLICT) {
        return { outcome: 'conflict', conflictDetail: error.message }
      }
      throw error
    }
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
      // Never trust only the in-memory client handle: after an app restart or a
      // transport failure the service may still own a live elevated child.
      // Reconcile first so "no local session" cannot become a false restored.
      await this.client.reconcile()
      await this.client.stop()
      this.activeRuntime = null
      return { outcome: 'restored' }
    } catch (error) {
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.TUN_SERVICE_CONFLICT) {
        return { outcome: 'conflict', conflictDetail: error.message }
      }
      return { outcome: 'restore-failed', errorMessage: machineMessage(error) }
    }
  }
}

function machineMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'TUN_OPERATION_FAILED'
}
