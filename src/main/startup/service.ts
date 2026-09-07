import type { StartupStatus } from '@shared/startup'

export interface StartupAdapter {
  readonly supported: boolean
  read(): Promise<boolean>
  write(enabled: boolean): Promise<void>
  /** Rewrites argument-sensitive registration when it already exists. */
  rewriteIfEnabled?(): Promise<void>
  /**
   * Existence check regardless of registered arguments. Optional; when absent
   * `read()` doubles as the existence check. Argument-sensitive reads cannot
   * see a registration written with a stale `--hidden` value, which would skip
   * migration/rewrite — so this exists for those paths.
   */
  readRegistered?(): Promise<boolean>
}

/** Serial, read-after-write ownership boundary for OS login-item state. */
export class StartupService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly adapter: StartupAdapter) {}

  getStatus(): Promise<StartupStatus> {
    return this.serial(async () => this.readStatus())
  }

  setEnabled(enabled: boolean): Promise<StartupStatus> {
    return this.serial(async () => {
      if (!this.adapter.supported) return this.unsupported()
      try {
        await this.adapter.write(enabled)
        const confirmed = await this.adapter.read()
        if (confirmed !== enabled) {
          return { supported: true, enabled: confirmed, phase: 'error', errorMessage: '系统未确认开机启动设置' }
        }
        return { supported: true, enabled: confirmed, phase: 'idle', errorMessage: null }
      } catch (error) {
        const current = await this.adapter.read().catch(() => false)
        return { supported: true, enabled: current, phase: 'error', errorMessage: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /** Keep an existing login item enabled while replacing its launch arguments. */
  refreshRegistration(): Promise<StartupStatus> {
    return this.serial(async () => {
      if (!this.adapter.supported) return this.unsupported()
      try {
        await this.adapter.rewriteIfEnabled?.()
        return this.readStatus()
      } catch (error) {
        const current = await this.adapter.read().catch(() => false)
        return { supported: true, enabled: current, phase: 'error', errorMessage: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  private async readStatus(): Promise<StartupStatus> {
    if (!this.adapter.supported) return this.unsupported()
    try {
      return { supported: true, enabled: await this.adapter.read(), phase: 'idle', errorMessage: null }
    } catch (error) {
      return { supported: true, enabled: false, phase: 'error', errorMessage: error instanceof Error ? error.message : String(error) }
    }
  }

  private unsupported(): StartupStatus {
    return { supported: false, enabled: false, phase: 'unsupported', errorMessage: null }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
