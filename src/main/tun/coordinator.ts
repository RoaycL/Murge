import { mihomoOwnedTunIntentSchema } from '../../shared/schemas/tun'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { MihomoOwnedTunIntent, TunStatus } from '../../shared/tun'
import { initialTunStatus, transitionTunStatus } from './state-machine'

export type TunEnableResult =
  | { outcome: 'active' }
  | { outcome: 'rollback-required'; errorMessage: string }
  | { outcome: 'conflict'; conflictDetail: string }

export type TunRestoreResult =
  | { outcome: 'restored' }
  | { outcome: 'restore-failed'; errorMessage: string }
  | { outcome: 'conflict'; conflictDetail: string }

/**
 * Privileged operations are injected here. The production implementation stays
 * gated until G1 and the helper design review are complete.
 */
export interface TunMutationAdapter {
  recoveryRequired(): Promise<boolean>
  enable(intent: MihomoOwnedTunIntent): Promise<TunEnableResult>
  restore(): Promise<TunRestoreResult>
}

/** Fail-closed production placeholder. It performs no I/O or OS mutation. */
export class GatedTunMutationAdapter implements TunMutationAdapter {
  async recoveryRequired(): Promise<boolean> {
    return false
  }

  async enable(_intent: MihomoOwnedTunIntent): Promise<TunEnableResult> {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_IMPLEMENTATION_GATED,
      'Windows TUN service transport is not available in this build'
    )
  }

  async restore(): Promise<TunRestoreResult> {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_IMPLEMENTATION_GATED,
      'Windows TUN service transport is not available in this build'
    )
  }
}

/**
 * Serial, renderer-independent lifecycle orchestration. This class never calls
 * Wintun, COM, routing or DNS APIs itself; tests inject a deterministic fake.
 */
export class TunCoordinator {
  private status: TunStatus
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(status: TunStatus) => void>()

  constructor(private readonly adapter: TunMutationAdapter, supported: boolean) {
    this.status = initialTunStatus(supported)
  }

  getStatus(): TunStatus {
    return { ...this.status }
  }

  onStatus(listener: (status: TunStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(): Promise<TunStatus> {
    return this.serialize(async () => {
      if (!this.status.supported || this.status.phase !== 'configured') return
      try {
        if (await this.adapter.recoveryRequired()) {
          this.move('enable')
          this.move('fail', { errorMessage: 'Interrupted TUN transaction requires recovery' })
          await this.restoreInternal()
        }
      } catch (error) {
        this.move('enable')
        if (error instanceof ProtocolError && error.code === ProtocolErrorCode.TUN_SERVICE_CONFLICT) {
          this.move('conflict', { conflictDetail: error.message })
        } else {
          this.move('fatal', { errorMessage: machineMessage(error) })
        }
      }
    })
  }

  enable(input: unknown): Promise<TunStatus> {
    return this.serialize(async () => {
      if (
        this.status.phase === 'active' ||
        this.status.phase === 'starting' ||
        this.status.phase === 'restoring' ||
        this.status.phase === 'restore-failed' ||
        this.status.phase === 'conflict' ||
        this.status.phase === 'unsupported'
      ) return
      const intent = mihomoOwnedTunIntentSchema.parse(input) as MihomoOwnedTunIntent
      this.move('enable')
      try {
        const result = await this.adapter.enable(intent)
        if (result.outcome === 'active') {
          this.move('enabled')
        } else if (result.outcome === 'conflict') {
          this.move('conflict', { conflictDetail: result.conflictDetail })
        } else {
          this.move('fail', { errorMessage: result.errorMessage })
          await this.restoreInternal()
        }
      } catch (error) {
        this.move('fatal', { errorMessage: machineMessage(error) })
      }
    })
  }

  /** Safe to call from before-quit or a recovery CLI without a renderer. */
  emergencyDisable(): Promise<TunStatus> {
    return this.serialize(async () => {
      if (
        this.status.phase === 'configured' ||
        this.status.phase === 'unsupported' ||
        this.status.phase === 'conflict'
      ) return
      if (this.status.phase !== 'restoring') this.move('disable')
      await this.restoreInternal()
    })
  }

  private async restoreInternal(): Promise<void> {
    try {
      const result = await this.adapter.restore()
      if (result.outcome === 'restored') {
        this.move('restored')
      } else if (result.outcome === 'conflict') {
        this.move('conflict', { conflictDetail: result.conflictDetail })
      } else {
        this.move('fail', { errorMessage: result.errorMessage })
      }
    } catch (error) {
      this.move('fail', { errorMessage: machineMessage(error) })
    }
  }

  private move(intent: Parameters<typeof transitionTunStatus>[1], detail: Parameters<typeof transitionTunStatus>[2] = {}): void {
    this.status = transitionTunStatus(this.status, intent, detail)
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A renderer/listener failure must never interrupt recovery sequencing.
      }
    }
  }

  private serialize(task: () => Promise<void>): Promise<TunStatus> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run.then(() => this.getStatus())
  }
}

function machineMessage(error: unknown): string {
  if (error instanceof ProtocolError) return error.code
  return 'TUN_OPERATION_FAILED'
}
