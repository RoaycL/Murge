import type { KernelGateway } from '@shared/gateways'
import type { KernelStatus } from '@shared/runtime'
import type { TunCoordinator } from '../tun/coordinator'
import type { TunPhase } from '@shared/tun'
import type { KernelStopPrecondition } from '../system-proxy/ordered-kernel-gateway'

/**
 * Presents the main kernel and the elevated TUN child as ONE logical kernel.
 *
 * The single-kernel model runs exactly one mihomo at a time against a single
 * controller + mixed port + secret (the production ports). That host is the
 * unprivileged main kernel when TUN is off and the elevated TUN child when TUN
 * is on; both bind the SAME ports, so the data plane (already bound to the
 * production controller) and the owned system proxy (already aimed at the
 * production mixed port) keep working no matter which host is live.
 *
 * This gateway does two things the plain/ordered gateways cannot:
 *  - it reports `running` (and the unified controller URL) whenever EITHER host
 *    is live, so the renderer's kernel.status.phase is true in TUN mode too; and
 *  - it carries the mode-switch hooks (`prepareTunEnable` / `resumeAfterTun`)
 *    that stop/start the unprivileged main kernel WITHOUT restoring the system
 *    proxy, because the proxy target (the unified mixed port) is rebound by the
 *    other host rather than going dead.
 */
export class SingleKernelGateway implements KernelGateway {
  constructor(
    /**
     * The user-facing main-kernel path. `start()` waits for the authenticated
     * controller; `stop()` restores the owned system proxy before the main kernel
     * goes down (the full-stop path, not a mode switch).
     */
    private readonly main: KernelGateway,
    /**
     * The raw unprivileged kernel supervisor, used to stop/start it WITHOUT the
     * proxy-restore precondition — only safe because a mode switch rebinds the
     * same ports instead of leaving them dead.
     */
    private readonly rawMain: KernelGateway,
    private readonly tun: TunCoordinator,
    private readonly systemProxy: KernelStopPrecondition,
    private readonly controllerUrl: string | null
  ) {}

  private servingPhase(phase: TunPhase): boolean {
    return phase === 'active' || phase === 'starting' || phase === 'restoring'
  }

  private isTunServing(): boolean {
    return this.servingPhase(this.tun.getStatus().phase)
  }

  getStatus(): KernelStatus | Promise<KernelStatus> {
    const tunStatus = this.tun.getStatus()
    if (this.servingPhase(tunStatus.phase)) {
      return {
        phase: 'running',
        pid: null,
        version: null,
        controllerUrl: this.controllerUrl,
        startedAt: null,
        lastError: tunStatus.errorMessage ?? null
      }
    }
    return this.main.getStatus()
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    const emit = (): void => {
      void Promise.resolve(this.getStatus()).then((status) => listener(status))
    }
    const unsubMain = this.main.onStatus(() => emit())
    const unsubTun = this.tun.onStatus(() => emit())
    emit()
    return () => {
      unsubMain()
      unsubTun()
    }
  }

  async start(): Promise<KernelStatus> {
    // When TUN is live the logical kernel is already running (as the elevated
    // child); starting it is a no-op rather than a conflicting spawn on the
    // same unified ports.
    if (this.isTunServing()) return this.getStatus()
    return this.main.start()
  }

  async stop(): Promise<KernelStatus> {
    if (this.isTunServing()) {
      // TUN owns the data plane / proxy right now. Stopping the (logical) kernel
      // means turning TUN off too; restore the proxy first so the registry never
      // aims at the port the child is about to release.
      await this.systemProxy.restoreBeforeKernelUnavailable()
      await this.tun.emergencyDisable()
      return this.getStatus()
    }
    return this.main.stop()
  }

  /**
   * Mode switch to TUN: stop the unprivileged main kernel WITHOUT restoring the
   * system proxy. The unified mixed port is rebound by the elevated child, so
   * the proxy target stays valid (a transient connection drop during the
   * restart is expected, not a permanent dead-aim).
   */
  async prepareTunEnable(): Promise<void> {
    if (this.isTunServing()) return
    const status = await this.rawMain.getStatus()
    if (status.phase !== 'stopped') {
      await this.rawMain.stop()
    }
  }

  /**
   * Mode switch out of TUN: restart the unprivileged main kernel so the unified
   * ports keep serving the data plane + the owned system proxy. Called after the
   * child is stopped; no-op when another host is already serving.
   */
  async resumeAfterTun(): Promise<void> {
    if (this.isTunServing()) return
    const status = await this.rawMain.getStatus()
    if (status.phase !== 'stopped') return
    await this.main.start()
  }
}
