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

  constructor(private readonly driver: UpdaterDriver) {
    this.state = { ...DEFAULT_UPDATE_STATE, currentVersion: driver.currentVersion }
  }

  /** Attach the driver and subscribe to its events. Call once after construction. */
  start(): void {
    if (this.started) return
    this.started = true
    this.driver.configure()
    this.unsubscribe = this.driver.onEvent((event) => this.handle(event))
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
    this.driver.check()
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
