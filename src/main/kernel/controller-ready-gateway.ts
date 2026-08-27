import type { KernelGateway } from '@shared/gateways'
import type { KernelStatus } from '@shared/runtime'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type { MihomoClient } from '../services/mihomo-client'

export interface ControllerReadyGatewayOptions {
  timeoutMs?: number
  retryMs?: number
}

/**
 * Makes the user-facing start action wait for the loopback controller's
 * authenticated /version response. Process spawn alone is not readiness.
 */
export class ControllerReadyKernelGateway implements KernelGateway {
  private readonly timeoutMs: number
  private readonly retryMs: number

  constructor(
    private readonly kernel: KernelGateway,
    private readonly client: MihomoClient,
    options: ControllerReadyGatewayOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retryMs = options.retryMs ?? 100
  }

  getStatus(): KernelStatus | Promise<KernelStatus> {
    return this.kernel.getStatus()
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    return this.kernel.onStatus(listener)
  }

  async start(): Promise<KernelStatus> {
    const status = await this.kernel.start()
    if (status.phase !== 'running') return status

    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.client.getVersion()
        return await this.kernel.getStatus()
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryMs))
      }
    }

    try {
      await this.kernel.stop()
    } catch {
      // The typed readiness failure remains the primary error. KernelSupervisor
      // retains any process that survives termination, so this cannot permit a
      // duplicate start or erase its live config.
    }
    throw new ProtocolError(
      ProtocolErrorCode.KERNEL_START_TIMEOUT,
      'mihomo process started but its authenticated loopback controller did not become ready.'
    )
  }

  stop(): Promise<KernelStatus> {
    return this.kernel.stop()
  }
}
