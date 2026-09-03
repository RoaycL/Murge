import type { KernelGateway } from '../../shared/gateways'
import type { KernelStatus } from '../../shared/runtime'
import type { TunGateway, TunPhase, TunStatus } from '../../shared/tun'

/**
 * One serialized gate for every single-kernel host transition.
 *
 * The single-kernel model runs exactly ONE mihomo host at a time over one set of
 * unified ports (controller + mixed + secret): the unprivileged main kernel when
 * TUN is off, the elevated TUN child when TUN is on. `kernel.start/stop`,
 * `tun.enable/disable` and the failure-recovery paths all re-bind those same
 * ports, so running any two of them concurrently can interleave a
 * prepare/stop/resume sequence and let the OTHER host claim the port in between.
 * This class turns every entry point into an exclusive task on ONE FIFO queue,
 * which makes the following invariants structural:
 *
 *  1. At most one mihomo host is ever bound to the unified ports.
 *  2. The owned system proxy is never left aiming at a dead port: whenever a
 *     transition cannot confirm the unified controller is reachable again, the
 *     owned proxy is restored (a conflict is safe — the proxy is no longer ours).
 *  3. A NORMAL TUN disable never restores the proxy: the proxy target (the
 *     unified mixed port) is rebound by the resumed main kernel, so the proxy
 *     config simply keeps working across the mode switch. Restore happens ONLY
 *     when the main kernel cannot resume and the unified controller is confirmed
 *     unreachable.
 *
 * Only the public entry points enqueue. The `*Inner` variants run INSIDE an
 * already-exclusive task and must never be called from outside one (public
 * methods are the only callers), so no task ever waits on itself. The TUN
 * coordinator has its own internal serialization, which is fine — it only ever
 * serializes work this queue already made exclusive.
 */

export interface ModeTransitionSystemProxy {
  /** Restore the owned proxy before the unified port can go dead. */
  restoreBeforeKernelUnavailable(): Promise<void>
}

/** The controller probe answer is a CONFIRMATION, never a fixed sleep. */
export type ControllerReadinessProbe = () => Promise<boolean>

/**
 * Liveness probe of the privileged TUN session (store read + PID Inspect on the
 * service side). `owned-live` when the service reports a supervised child,
 * `owned-gone` when it definitively reports none, `unreachable` when the answer
 * is unknown (transport failure, service down, unverifiable state).
 */
export type TunSessionProbe = 'owned-live' | 'owned-gone' | 'unreachable'

export interface ModeTransitionDeps {
  /** The unified single-kernel gateway (mode-switch hooks optional). */
  kernel: KernelGateway
  /**
   * The RAW TUN host (the coordinator-backed gateway), not a queued wrapper:
   * the coordinator itself serializes its work; this queue serializes it against
   * kernel start/stop.
   */
  tun: TunGateway
  systemProxy: ModeTransitionSystemProxy
  /**
   * Confirm the unified controller is actually reachable (production: an
   * authenticated GET /version). When omitted, the unified kernel status is used
   * (`running` whenever either host is live).
   */
  isControllerReady?: ControllerReadinessProbe
  /**
   * Probe the privileged TUN session liveness for the abnormal-exit monitor.
   * When absent, `recoverTunExit` treats the session as gone after its own
   * re-check (test/legacy kernels).
   */
  probeTunSession?(): Promise<TunSessionProbe>
  onError?(error: unknown, step: string): void
}

/** Resting TUN phases from which an enable may actually proceed. */
const ENABLE_PROCEEDS_FROM: ReadonlySet<string> = new Set(['configured', 'failed', 'restore-failed'])

/** TUN phases in which the elevated child is (or may soon be) bound to the ports. */
function servingPhase(phase: TunPhase): boolean {
  return phase === 'active' || phase === 'starting' || phase === 'restoring'
}

export class ModeTransitionController {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ModeTransitionDeps) {}

  /** Run a task exclusively against the single-kernel mode. FIFO, fail-isolated. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  startKernel(): Promise<KernelStatus> {
    return this.runExclusive(() => this.deps.kernel.start())
  }

  stopKernel(): Promise<KernelStatus> {
    // The unified gateway's stop() restores the owned proxy before the live host
    // (main kernel OR elevated child) goes down, so the registry never aims at a
    // dead port — including when TUN is serving (an explicit user "stop" intends
    // to end serving).
    return this.runExclusive(() => this.deps.kernel.stop())
  }

  /**
   * Enable TUN as a MODE SWITCH: stop the unprivileged main kernel WITHOUT
   * restoring the owned proxy (the elevated child rebinds the same ports), start
   * the child, and confirm the unified controller. If the child fails to come up,
   * resume the main kernel; only when the controller cannot be confirmed does the
   * owned proxy get restored (never leaving a dead-port aim behind).
   */
  enableTun(): Promise<TunStatus> {
    return this.runExclusive(() => this.enableTunInner())
  }

  /**
   * Disable TUN normally: stop the child, resume the main kernel on the SAME
   * unified ports, and confirm the controller. The owned system proxy is NOT
   * restored on this path — its target (the unified mixed port) stays valid
   * across the host switch.
   */
  disableTun(): Promise<TunStatus> {
    return this.runExclusive(() => this.disableTunInner())
  }

  /**
   * Recover from an ABNORMAL TUN exit (the elevated child died without a user
   * disable — detected by the exit monitor). Re-verifies with a fresh probe so
   * one transient unowned/unreachable answer never tears down a healthy session,
   * cleans the TUN lifecycle best-effort, resumes the main kernel, and keeps the
   * proxy when the unified controller is reachable again (restores it when the
   * port is confirmed dead).
   */
  recoverTunExit(): Promise<void> {
    return this.runExclusive(async () => {
      const probe = await this.safeProbe()
      // `owned-live` means the service still supervises a child — do nothing.
      // `unreachable` is UNKNOWN: tearing down on a guess could disable a healthy
      // TUN; the next successful monitor cycle retries.
      if (probe !== 'owned-gone') return
      const before = await this.deps.tun.getStatus()
      if (before.phase !== 'active' && before.phase !== 'starting') return
      try {
        await this.disableTunInner()
      } catch (error) {
        // The TUN lifecycle cleanup failing (e.g. service unreachable) must not
        // stop the main-kernel resume: the child is dead either way (the service
        // job object kills it when the service dies).
        this.report(error, 'tun-exit-disable')
      }
    })
  }

  /**
   * Re-apply the active profile to the live single kernel. Runs inside the mode
   * queue, so a profile edit can never interleave with a concurrent TUN toggle.
   *
   * When TUN is serving, the profile cannot be pushed into the elevated child
   * through the main kernel's stop/start (they are mutually exclusive hosts over
   * the same ports); the child is restarted through a full mode switch instead —
   * the new document is materialized by the adapter on the next enable and the
   * owned system proxy is preserved across the switch untouched.
   *
   * `applyWhileStopped` re-materializes and restarts the UNPRIVILEGED kernel
   * (production: {@link reloadKernelForActiveProfile}; it must use the unified
   * gateway passed to it and never enqueue mode transitions itself).
   */
  reloadProfile(applyWhileStopped: (kernel: KernelGateway) => Promise<void>): Promise<void> {
    return this.runExclusive(async () => {
      if (servingPhase((await this.deps.tun.getStatus()).phase)) {
        await this.disableTunInner()
        await this.enableTunInner()
        return
      }
      await applyWhileStopped(this.deps.kernel)
    })
  }

  /* ------------------------------------------------------------------ */
  /* Inner variants: run inside an already-exclusive queue task.         */
  /* ------------------------------------------------------------------ */

  private async enableTunInner(): Promise<TunStatus> {
    const before = await this.deps.tun.getStatus()
    if (!before.supported) return before
    // Idempotent double-click and transition guards: `conflict` needs a disable
    // (reconcile) first, and no prepare churn should happen for a call the
    // coordinator would refuse anyway.
    if (!ENABLE_PROCEEDS_FROM.has(before.phase)) return before
    // `restore-failed` already had its main kernel stopped by the mode switch
    // that led here, so only the ordinary resting phases need a prepare.
    if (before.phase !== 'restore-failed') {
      await this.prepareForTunEnable()
    }
    const status = await this.deps.tun.enable()
    if (status.phase === 'active') return status
    // The child failed (or rolled back). Bring the main kernel back on the
    // unified ports; restore the proxy only if the port stays dead.
    await this.restoreServingOrProxy('tun-enable-rollback')
    return status
  }

  private async disableTunInner(): Promise<TunStatus> {
    const before = await this.deps.tun.getStatus()
    // Nothing to switch: TUN never owned the ports, so there is no host to
    // resume and no reason to touch the system proxy.
    if (before.phase === 'configured' || before.phase === 'unsupported') return before
    const status = await this.deps.tun.disable()
    await this.restoreServingOrProxy('tun-disable-resume')
    return status
  }

  /**
   * Shared tail of every host switch: resume the main kernel on the unified
   * ports, then keep the proxy when the controller is confirmed reachable —
   * otherwise restore it. Returns whether the controller was confirmed ready.
   */
  private async restoreServingOrProxy(step: string): Promise<boolean> {
    try {
      await this.deps.kernel.resumeAfterTun?.()
    } catch (error) {
      this.report(error, `${step}:resume`)
    }
    if (await this.isControllerReady()) return true
    // The unified port is confirmed dead: restore the owned proxy so the registry
    // never keeps aiming at it. A genuine restore failure propagates so callers
    // (IPC error paths, quit guard) surface it instead of hiding a dead aim.
    await this.deps.systemProxy.restoreBeforeKernelUnavailable()
    return false
  }

  private async prepareForTunEnable(): Promise<void> {
    if (this.deps.kernel.prepareTunEnable) {
      await this.deps.kernel.prepareTunEnable()
      return
    }
    // Plain/mock kernels have no mode-switch hook: fall back to a plain stop so
    // at most one host can ever be bound to the unified ports.
    const status = await this.deps.kernel.getStatus()
    if (status.phase !== 'stopped') await this.deps.kernel.stop()
  }

  private async isControllerReady(): Promise<boolean> {
    if (this.deps.isControllerReady) return this.deps.isControllerReady()
    const status = await this.deps.kernel.getStatus()
    return status.phase === 'running'
  }

  private async safeProbe(): Promise<TunSessionProbe> {
    if (!this.deps.probeTunSession) return 'owned-gone'
    try {
      return await this.deps.probeTunSession()
    } catch {
      return 'unreachable'
    }
  }

  private report(error: unknown, step: string): void {
    if (this.deps.onError) {
      this.deps.onError(error, step)
      return
    }
    console.error(`[mode-transition] ${step} failed:`, error)
  }
}

/**
 * A {@link KernelGateway} whose start/stop are serialized through the mode
 * controller (getStatus/onStatus pass through). Wire this into IPC, the tray and
 * autostart so EVERY start/stop entry point shares the one transition queue.
 */
export function queuedKernelGateway(kernel: KernelGateway, controller: ModeTransitionController): KernelGateway {
  return {
    getStatus: () => kernel.getStatus(),
    onStatus: (listener) => kernel.onStatus(listener),
    start: () => controller.startKernel(),
    stop: () => controller.stopKernel()
  }
}

/**
 * A {@link TunGateway} whose enable/disable run through the mode controller (the
 * raw host is kept by the controller itself). Wire this into IPC so TUN toggles
 * cannot interleave with kernel start/stop or with each other.
 */
export function queuedTunGateway(tun: TunGateway, controller: ModeTransitionController): TunGateway {
  return {
    getStatus: () => tun.getStatus(),
    onStatus: (listener) => tun.onStatus(listener),
    enable: () => controller.enableTun(),
    disable: () => controller.disableTun()
  }
}
