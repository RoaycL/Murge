import type { UpdatesGateway } from '@shared/gateways'
import type { UpdateState } from '@shared/updates'
import { DEFAULT_UPDATE_STATE } from '@shared/updates'
import type { UpdaterDriver, UpdaterDriverEvent } from './updater-driver'

const NOT_SUPPORTED = '当前构建不支持自动更新（仅安装版可用）'

/**
 * Owns the application-update state machine. It wraps a narrow
 * {@link UpdaterDriver} and reduces its event stream into a single
 * {@link UpdateState} snapshot that is pushed to renderer windows and returned
 * from the narrow IPC commands.
 *
 * The service is the only place electron-updater's semantics surface; it is a
 * plain class with an injected driver, so unit tests drive the whole lifecycle
 * with a fake without importing Electron or the updater package.
 */
export class UpdateService implements UpdatesGateway {
  private state: UpdateState
  private readonly listeners: Set<(state: UpdateState) => void> = new Set()
  private unsubscribe: (() => void) | null = null
  private started = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly pollIntervalMs: number

  constructor(private readonly driver: UpdaterDriver, options: { pollIntervalMs?: number } = {}) {
    this.state = { ...DEFAULT_UPDATE_STATE, currentVersion: driver.currentVersion }
    this.pollIntervalMs = options.pollIntervalMs ?? 10 * 60 * 1000
  }

  /** Attach the driver and subscribe to its events. Call once after construction. */
  start(): void {
    if (this.started) return
    this.started = true
    this.driver.configure()
    this.unsubscribe = this.driver.onEvent((event) => this.handle(event))
  }

  /**
   * Poll the feed on a fixed cadence while the app is running (the mihomo-party
   * / sparkle model), so a Release published mid-session is picked up without a
   * restart. No-op when the build cannot self-update. `check()` already refuses
   * to restart an in-flight check/download, so overlapping ticks are safe.
   */
  startPolling(): void {
    if (this.pollTimer || !this.driver.supported) return
    this.pollTimer = setInterval(() => {
      void this.check().catch(() => undefined)
    }, this.pollIntervalMs)
    // An interval that keeps the process alive would outstay the window.
    this.pollTimer.unref?.()
  }

  stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  getState(): UpdateState {
    return this.state
  }

  async check(): Promise<UpdateState> {
    if (!this.driver.supported) {
      this.transition({ ...this.state, phase: 'error', error: NOT_SUPPORTED, canInstall: false })
      return this.state
    }
    // A check is already in flight (or a download already completed) — do not
    // restart it, which would push the UI back to a transient "checking" state.
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'downloaded') {
      return this.state
    }
    this.transition({ ...this.state, phase: 'checking', error: null })
    try {
      this.driver.check()
    } catch (error) {
      // A driver may throw synchronously (a pre-flight failure) WITHOUT ever
      // emitting an 'error' event. Without this the phase would stay 'checking'
      // forever and the guard above would reject every later check. Reduce the
      // throw into the same terminal 'error' state the event path produces.
      this.set({ phase: 'error', error: error instanceof Error ? error.message : String(error), canInstall: false })
    }
    return this.state
  }

  async download(): Promise<void> {
    if (!this.driver.supported) return
    if (this.state.phase === 'downloaded' || this.state.phase === 'downloading') return
    if (this.state.phase !== 'available') return
    this.transition({ ...this.state, phase: 'downloading', error: null })
    this.driver.download()
  }

  install(): void {
    if (this.driver.supported && this.state.canInstall) {
      this.driver.quitAndInstall()
    }
  }

  onState(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.stopPolling()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.driver.dispose()
    this.listeners.clear()
  }

  private handle(event: UpdaterDriverEvent): void {
    switch (event.kind) {
      case 'checking':
        this.set({ phase: 'checking', error: null })
        break
      case 'not-available':
        this.set({ phase: 'not-available', availableVersion: null, progress: null, canInstall: false, error: null })
        break
      case 'available':
        this.set({ phase: 'available', availableVersion: event.version, progress: null, canInstall: false, error: null })
        break
      case 'download-progress':
        this.set({
          phase: 'downloading',
          progress: {
            percent: event.percent,
            bytesPerSecond: event.bytesPerSecond,
            transferred: event.transferred,
            total: event.total
          }
        })
        break
      case 'downloaded':
        this.set({ phase: 'downloaded', canInstall: true, progress: null, error: null })
        break
      case 'error':
        this.set({ phase: 'error', error: event.message, canInstall: false })
        break
    }
  }

  private set(patch: Partial<UpdateState>): void {
    this.transition({ ...this.state, ...patch })
  }

  private transition(next: UpdateState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }
}
