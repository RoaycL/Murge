import { EventEmitter } from 'node:events'
import type { KernelStatus } from '@shared/runtime'

const initialStatus: KernelStatus = {
  phase: 'stopped',
  pid: null,
  version: null,
  controllerUrl: null,
  startedAt: null,
  lastError: null
}

/**
 * Process lifecycle boundary only. An implementation agent should add:
 * binary verification, config materialization, random controller secret,
 * spawn/health-check/stop semantics, log rotation, crash backoff and updates.
 */
export class KernelSupervisor extends EventEmitter {
  private status: KernelStatus = { ...initialStatus }

  getStatus(): KernelStatus {
    return { ...this.status }
  }

  async start(): Promise<KernelStatus> {
    throw new Error('KernelSupervisor.start is intentionally not implemented in the framework milestone.')
  }

  async stop(): Promise<KernelStatus> {
    throw new Error('KernelSupervisor.stop is intentionally not implemented in the framework milestone.')
  }
}
