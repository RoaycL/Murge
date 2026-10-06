import type { KernelStatus } from '../../shared/runtime'

/**
 * Abnormal-exit monitor for the ONE service-owned mihomo process.
 *
 * The monitor is keyed on the KERNEL phase only, never on the TUN phase: TUN is
 * a hot-switched mode of that same process, so a crash in ANY TUN phase —
 * `active`/`starting` as well as `restoring`/`restore-failed`/`conflict` — must
 * reset the TUN lifecycle, restore an owned system proxy and replay the user's
 * durable intent. Gating on the TUN phase is exactly the gap BUG-REVIEW #5
 * described: a crash mid-restore left networking unrecovered.
 */
export interface PrivilegedExitMonitorDeps {
  kernel: {
    getStatus(): KernelStatus
    /** `false` once the service confirms the supervised child is gone. */
    reconcileLiveness(): Promise<boolean>
  }
  /** Reset the TUN lifecycle: no adapter or route can outlive the process. */
  handleHostExit(): Promise<unknown>
  /** Restore the owned system proxy before it keeps aiming at a dead port. */
  restoreSystemProxy(): Promise<void>
  readSettings(): Promise<{ autoStartKernel: boolean; tunDesired: boolean; systemProxyDesired: boolean }>
  /** Plain kernel restart when nothing beyond the kernel itself is desired. */
  startKernel(): Promise<unknown>
  /** Wake the durable-intent recovery loop (TUN and/or proxy replay). */
  wakeIntentRecovery(): void
  onError?(error: unknown, step: string): void
}

/**
 * Recover after the service confirms the core exited. Each step is isolated:
 * a failing TUN reset or proxy restore never prevents the intent replay.
 */
export async function recoverPrivilegedCoreExit(deps: PrivilegedExitMonitorDeps): Promise<void> {
  await deps.handleHostExit().catch((error) => report(deps, error, 'tun-reset'))
  await deps.restoreSystemProxy().catch((error) => report(deps, error, 'system-proxy-restore'))
  const settings = await deps.readSettings()
  if (settings.autoStartKernel && !settings.tunDesired && !settings.systemProxyDesired) {
    await deps.startKernel().catch((error) => report(deps, error, 'kernel-restart'))
  } else {
    deps.wakeIntentRecovery()
  }
}

/** One monitor tick. Overlapping ticks are skipped while a probe is in flight. */
export function createPrivilegedExitMonitorTick(deps: PrivilegedExitMonitorDeps): () => Promise<void> {
  let probing = false
  return async () => {
    if (probing) return
    const phase = deps.kernel.getStatus().phase
    if (phase !== 'running' && phase !== 'starting') return
    probing = true
    try {
      if (await deps.kernel.reconcileLiveness()) return
      await recoverPrivilegedCoreExit(deps)
    } catch (error) {
      report(deps, error, 'liveness-probe')
    } finally {
      probing = false
    }
  }
}

function report(deps: PrivilegedExitMonitorDeps, error: unknown, step: string): void {
  if (deps.onError) deps.onError(error, step)
  else console.error(`[kernel] privileged core exit ${step} failed:`, error)
}
