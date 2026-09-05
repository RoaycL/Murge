import type { AppSettings } from '@shared/app-settings'
import type { AppSettingsGateway } from '@shared/gateways'
import {
  restoreRuntimeIntent,
  type RuntimeIntentRestoreDeps,
  type RuntimeIntentRestoreResult
} from './runtime-intent'

export interface ObservableAppSettings extends Pick<AppSettingsGateway, 'get'> {
  onChange?(listener: (settings: AppSettings) => void): () => void
}

export interface RuntimeIntentRecoveryOptions {
  settings: ObservableAppSettings
  restore: RuntimeIntentRestoreDeps
  /** Six retries over exactly two minutes after the fast startup pass. */
  backoffMs?: readonly number[]
  now?: () => number
  log?: (message: string, error?: unknown) => void
}

const DEFAULT_BACKGROUND_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 25_000] as const

/**
 * Bounded post-startup self-healing for a slow Windows network/TUN service.
 *
 * Each timer performs only one reconciliation attempt; the existing mode queue
 * remains the sole owner of host transitions. Settings are re-read before every
 * attempt, and a settings change invalidates the in-flight generation, so a
 * user's later OFF request can never be followed by a stale background ON.
 */
export class RuntimeIntentRecoveryCoordinator {
  private readonly backoff: readonly number[]
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private started = false
  private running = false
  private wakePending = false
  private generation = 0
  private nextDelay = 0
  private deadline = 0
  private lastSettings: AppSettings | null = null

  constructor(private readonly options: RuntimeIntentRecoveryOptions) {
    this.backoff = options.backoffMs ?? DEFAULT_BACKGROUND_BACKOFF_MS
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.resetWindow()
    this.unsubscribe = this.options.settings.onChange?.((settings) => this.handleSettingsChange(settings)) ?? null
    this.scheduleNext()
  }

  /** Immediately retry after a confirmed network-up/resume signal. */
  wake(): void {
    if (!this.started) return
    if (this.running) {
      this.wakePending = true
      return
    }
    this.clearTimer()
    this.schedule(0)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.generation += 1
    this.wakePending = false
    this.clearTimer()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private handleSettingsChange(settings: AppSettings): void {
    if (this.lastSettings && !runtimeIntentChanged(this.lastSettings, settings)) return
    this.lastSettings = { ...settings }
    // Invalidates cancellation fences in an active attempt before the IPC
    // handler proceeds from its durable settings write to the live operation.
    this.generation += 1
    this.clearTimer()
    this.resetWindow()
    if (!settings.kernelEnabled || (!settings.tunDesired && !settings.systemProxyDesired)) {
      this.wakePending = false
      return
    }
    if (this.running) {
      this.wakePending = true
      return
    }
    this.scheduleNext()
  }

  private resetWindow(): void {
    this.nextDelay = 0
    this.deadline = this.now() + this.backoff.reduce((total, delay) => total + delay, 0)
  }

  private scheduleNext(): void {
    if (!this.started || this.nextDelay >= this.backoff.length) return
    const delay = this.backoff[this.nextDelay++]!
    if (this.now() + delay > this.deadline) return
    this.schedule(delay)
  }

  private schedule(delay: number): void {
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick(generation)
    }, delay)
  }

  private async tick(generation: number): Promise<void> {
    if (!this.started || this.running || generation !== this.generation) return
    this.running = true
    try {
      const settings = await this.options.settings.get()
      this.lastSettings = { ...settings }
      if (generation !== this.generation) return
      // This coordinator owns takeover recovery, not the user's explicit
      // kernel stop. `autoStartKernel` is handled by the one initial fast pass;
      // with both network intents off, a later resume must not restart it.
      if (!settings.kernelEnabled || (!settings.tunDesired && !settings.systemProxyDesired)) return

      const result = await restoreRuntimeIntent(settings, {
        ...this.options.restore,
        // One attempt per background interval; retries belong to this outer
        // backoff and therefore remain cancellable and observable.
        retryDelaysMs: [],
        shouldContinue: () => this.started && generation === this.generation
      })
      if (generation !== this.generation) return

      if (needsAnotherAttempt(settings, result)) {
        this.options.log?.(
          `[startup-recovery] intent still pending (kernel=${result.kernel.phase}, tun=${result.tun.phase}, proxy=${result.systemProxy.phase})`
        )
        this.scheduleNext()
      } else {
        this.clearTimer()
      }
    } catch (error) {
      this.options.log?.('[startup-recovery] background reconciliation failed', error)
      if (generation === this.generation) this.scheduleNext()
    } finally {
      this.running = false
      if (this.wakePending && this.started) {
        this.wakePending = false
        this.clearTimer()
        this.schedule(0)
      }
    }
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

function runtimeIntentChanged(before: AppSettings, after: AppSettings): boolean {
  return before.autoStartKernel !== after.autoStartKernel ||
    before.kernelEnabled !== after.kernelEnabled ||
    before.tunDesired !== after.tunDesired ||
    before.systemProxyDesired !== after.systemProxyDesired
}

function needsAnotherAttempt(settings: AppSettings, result: RuntimeIntentRestoreResult): boolean {
  if (!settings.kernelEnabled) return false
  const hostDesired = settings.tunDesired || settings.systemProxyDesired
  if (hostDesired && result.kernel.phase !== 'running') return true

  if (
    settings.tunDesired &&
    result.tun.supported &&
    result.tun.phase !== 'active' &&
    result.tun.phase !== 'conflict' &&
    result.tun.phase !== 'unsupported'
  ) return true

  return settings.systemProxyDesired &&
    result.systemProxy.supported &&
    result.systemProxy.phase !== 'enabled' &&
    result.systemProxy.phase !== 'conflict' &&
    result.systemProxy.phase !== 'unsupported'
}
