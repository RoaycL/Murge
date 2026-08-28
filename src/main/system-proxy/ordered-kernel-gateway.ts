import type { KernelGateway } from '../../shared/gateways'
import type { KernelStatus } from '../../shared/runtime'

export interface KernelStopPrecondition {
  /** Restore the owned system proxy before the kernel becomes unavailable. */
  restoreBeforeKernelUnavailable(): Promise<void>
}

/**
 * Wraps the real kernel gateway so that a proxy is always restored before the
 * kernel is stopped.
 *
 * The restore step throws on a true restore failure, which means `stop()` aborts
 * and the kernel keeps running — leaving the proxy pointed at a still-live
 * controller rather than a dead port. A conflict (proxy no longer ours) is
 * treated as safe, so the kernel may be stopped without touching another
 * process' proxy state.
 */
export class SystemProxyOrderedKernelGateway implements KernelGateway {
  constructor(
    private readonly inner: KernelGateway,
    private readonly precondition: KernelStopPrecondition
  ) {}

  getStatus(): KernelStatus | Promise<KernelStatus> {
    return this.inner.getStatus()
  }

  start(): Promise<KernelStatus> {
    return this.inner.start()
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    return this.inner.onStatus(listener)
  }

  async stop(): Promise<KernelStatus> {
    await this.precondition.restoreBeforeKernelUnavailable()
    return this.inner.stop()
  }
}
