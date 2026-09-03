/**
 * PHASE 9 LEGACY (superseded by Phase 9B): elevation COM flow — kept only as
 * reviewed audit-trail code and unit-tested evidence of the reviewed design
 * (see docs/phase9b-mihomo-owned-tun.md). NO production path imports this
 * module; do not wire it without a new reviewed design change.
 */
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { TunBinaryIntegrityEvidence, TunBinaryManifestEntry } from './binary-integrity'

export type TunElevationPhase =
  | 'idle'
  | 'verifying'
  | 'prompting'
  | 'connected'
  | 'closing'
  | 'denied'
  | 'failed'
  | 'unsupported'

export interface TunElevationStatus {
  phase: TunElevationPhase
  errorCode: string | null
}

export interface TunIntegrityGate {
  verifyAll(entries: readonly TunBinaryManifestEntry[]): Promise<TunBinaryIntegrityEvidence[]>
}

/** Opaque main-process handle. It exposes no command or renderer surface yet. */
export interface PrivilegedHelperSession {
  close(): Promise<void>
  isAlive(): Promise<boolean>
}

export type TunElevationActivationResult =
  | { outcome: 'connected'; session: PrivilegedHelperSession }
  | { outcome: 'denied' }

export interface TunElevationActivator {
  activate(): Promise<TunElevationActivationResult>
}

/** No native elevation call exists until the Windows implementation gate passes. */
export class GatedTunElevationActivator implements TunElevationActivator {
  async activate(): Promise<TunElevationActivationResult> {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_IMPLEMENTATION_GATED,
      'COM elevation is gated pending G1 and helper design approval'
    )
  }
}

/**
 * Orders read-only integrity verification before an explicit elevation prompt,
 * owns at most one helper session, and confirms it is dead before disconnecting.
 */
export class TunElevationFlow {
  private status: TunElevationStatus
  private session: PrivilegedHelperSession | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(status: TunElevationStatus) => void>()

  constructor(
    private readonly integrity: TunIntegrityGate,
    private readonly activator: TunElevationActivator,
    private readonly manifest: readonly TunBinaryManifestEntry[],
    supported: boolean
  ) {
    this.status = { phase: supported ? 'idle' : 'unsupported', errorCode: null }
  }

  getStatus(): TunElevationStatus {
    return { ...this.status }
  }

  onStatus(listener: (status: TunElevationStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Must be called only after an explicit user enable intent in main process. */
  connect(): Promise<TunElevationStatus> {
    return this.serialize(async () => {
      if (this.status.phase === 'unsupported' || this.session) return
      this.update('verifying')
      try {
        await this.integrity.verifyAll(this.manifest)
        this.update('prompting')
        const result = await this.activator.activate()
        if (result.outcome === 'denied') {
          this.update('denied', 'TUN_ELEVATION_DENIED')
          return
        }
        this.session = result.session
        if (!(await result.session.isAlive())) {
          this.session = null
          this.update('failed', 'TUN_HELPER_NOT_ALIVE')
          return
        }
        this.update('connected')
      } catch (error) {
        this.update('failed', machineCode(error))
      }
    })
  }

  /** Renderer-independent teardown; a still-live helper remains owned for retry. */
  disconnect(): Promise<TunElevationStatus> {
    return this.serialize(async () => {
      if (!this.session) {
        if (this.status.phase !== 'unsupported') this.update('idle')
        return
      }
      const owned = this.session
      this.update('closing')
      try {
        await owned.close()
        if (await owned.isAlive()) {
          this.update('failed', 'TUN_HELPER_STILL_ALIVE')
          return
        }
        this.session = null
        this.update('idle')
      } catch (error) {
        this.update('failed', machineCode(error))
      }
    })
  }

  private update(phase: TunElevationPhase, errorCode: string | null = null): void {
    this.status = { phase, errorCode }
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // UI failure cannot interrupt helper ownership or teardown.
      }
    }
  }

  private serialize(task: () => Promise<void>): Promise<TunElevationStatus> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run.then(() => this.getStatus())
  }
}

function machineCode(error: unknown): string {
  return error instanceof ProtocolError ? error.code : 'TUN_ELEVATION_FAILED'
}
