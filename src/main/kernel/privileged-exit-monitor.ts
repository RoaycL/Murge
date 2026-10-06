import type { KernelStatus } from '../../shared/runtime'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

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
    /**
     * Mark a believed-live core as lost without the service's confirmation.
     * Returns true when the gateway was still running/starting and is now failed.
     */
    declareLost?(reason: string): Promise<boolean>
  }
  /**
   * Authenticated probe of the core's own controller. Only consulted while the
   * service pipe is unreachable: the service job object kills the core when the
   * service process dies, so an unreachable service plus a dead controller means
   * the core is gone even though nobody can confirm it.
   */
  isControllerAlive?(): Promise<boolean>
  /** Reset the TUN lifecycle: no adapter or route can outlive the process. */
  handleHostExit(): Promise<unknown>
  /** Restore the owned system proxy before it keeps aiming at a dead port. */
  restoreSystemProxy(): Promise<void>
  readSettings(): Promise<{ autoStartKernel: boolean; tunDesired: boolean; systemProxyDesired: boolean }>
  /** Plain kernel restart when nothing beyond the kernel itself is desired. */
  startKernel(): Promise<unknown>
  /** Wake the durable-intent recovery loop (TUN and/or proxy replay). */
  wakeIntentRecovery(): void
  /**
   * Drop recovery attempts the intent coordinator already queued (backoff timer
   * or pending wake). Called when the crash-loop budget is exhausted, so an
   * attempt scheduled before the latest exit cannot restart the core anyway.
   */
  cancelIntentRecovery?(): void
  /** Skip every probe (application shutdown in progress). */
  isSuspended?(): boolean
  onError?(error: unknown, step: string): void
}

export interface PrivilegedExitMonitorOptions {
  /**
   * Consecutive ticks with an unreachable service AND a dead controller before
   * the core is declared lost. The SCM restarts a crashed service after 2s and
   * 10s, and a restarted service reports the exit itself, so this only fires
   * when the service stays down. Default 3 (15s at the 5s production cadence).
   */
  unreachableTicks?: number
  /** Automatic restarts allowed within {@link restartWindowMs}. Default 3. */
  maxRestarts?: number
  /** Sliding window for the restart budget. Default 10 minutes. */
  restartWindowMs?: number
  now?: () => number
}

/**
 * Recover after the service confirms the core exited. Each step is isolated:
 * a failing TUN reset or proxy restore never prevents the intent replay.
 * With `restart: false` (crash loop) the network is made safe — TUN reset,
 * proxy restored — but no new core is started.
 */
export async function recoverPrivilegedCoreExit(
  deps: PrivilegedExitMonitorDeps,
  restart = true
): Promise<void> {
  await deps.handleHostExit().catch((error) => report(deps, error, 'tun-reset'))
  await deps.restoreSystemProxy().catch((error) => report(deps, error, 'system-proxy-restore'))
  // Shutdown may have begun while the steps above were awaiting; a restart
  // queued now would run after the quit flow's own core stop.
  if (!restart || deps.isSuspended?.()) return
  const settings = await deps.readSettings()
  if (deps.isSuspended?.()) return
  if (settings.autoStartKernel && !settings.tunDesired && !settings.systemProxyDesired) {
    await deps.startKernel().catch((error) => report(deps, error, 'kernel-restart'))
  } else {
    deps.wakeIntentRecovery()
  }
}

/** One monitor tick. Overlapping ticks are skipped while a probe is in flight. */
export function createPrivilegedExitMonitorTick(
  deps: PrivilegedExitMonitorDeps,
  options: PrivilegedExitMonitorOptions = {}
): () => Promise<void> {
  const unreachableTicks = Math.max(1, options.unreachableTicks ?? 3)
  const maxRestarts = Math.max(0, options.maxRestarts ?? 3)
  const restartWindowMs = options.restartWindowMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const restarts: number[] = []
  let probing = false
  let unreachableStreak = 0
  /** An exit confirmed while suspended; recovered once the suspension lifts
   * (a cancelled quit), because the failed kernel is never probed again. */
  let deferredRecovery = false

  // A core that dies right after every restart (for example a TUN setting the
  // core cannot apply) would otherwise loop forever, re-pointing the system
  // proxy at a listener that disappears seconds later on each cycle.
  const consumeRestart = (): boolean => {
    const at = now()
    while (restarts.length > 0 && at - restarts[0]! >= restartWindowMs) restarts.shift()
    if (restarts.length >= maxRestarts) return false
    restarts.push(at)
    return true
  }

  const recover = async (): Promise<void> => {
    const restart = consumeRestart()
    if (!restart) {
      deps.cancelIntentRecovery?.()
      report(
        deps,
        new Error(`privileged core exited ${maxRestarts + 1} times within ${Math.round(restartWindowMs / 1000)}s; automatic restart paused`),
        'crash-loop'
      )
    }
    await recoverPrivilegedCoreExit(deps, restart)
  }

  return async () => {
    if (probing || deps.isSuspended?.()) return
    if (deferredRecovery) {
      deferredRecovery = false
      probing = true
      try {
        await recover()
      } catch (error) {
        report(deps, error, 'deferred-recovery')
      } finally {
        probing = false
      }
      return
    }
    const phase = deps.kernel.getStatus().phase
    if (phase !== 'running' && phase !== 'starting') {
      unreachableStreak = 0
      return
    }
    probing = true
    try {
      let live: boolean
      try {
        live = await deps.kernel.reconcileLiveness()
      } catch (error) {
        if (!(await serviceDownAndControllerDead(error))) throw error
        unreachableStreak += 1
        if (unreachableStreak < unreachableTicks) return
        unreachableStreak = 0
        if (!(await deps.kernel.declareLost!('Privileged service is unavailable and the core controller stopped responding'))) return
        live = false
      }
      unreachableStreak = 0
      if (live) return
      if (deps.isSuspended?.()) {
        deferredRecovery = true
        return
      }
      await recover()
    } catch (error) {
      unreachableStreak = 0
      report(deps, error, 'liveness-probe')
    } finally {
      probing = false
    }
  }

  async function serviceDownAndControllerDead(error: unknown): Promise<boolean> {
    if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.UPSTREAM_UNREACHABLE) return false
    if (!deps.isControllerAlive || !deps.kernel.declareLost) return false
    try {
      return !(await deps.isControllerAlive())
    } catch {
      return false
    }
  }
}

function report(deps: PrivilegedExitMonitorDeps, error: unknown, step: string): void {
  if (deps.onError) deps.onError(error, step)
  else console.error(`[kernel] privileged core exit ${step} failed:`, error)
}
