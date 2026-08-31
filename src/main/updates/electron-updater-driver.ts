import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterDriver, UpdaterDriverEvent } from './updater-driver'

/**
 * {@link UpdaterDriver} backed by electron-updater's platform `autoUpdater`.
 *
 * Only active in a packaged build, where electron-builder has baked the
 * `app-update.yml` feed descriptor into `process.resourcesPath`. In dev / an
 * unpackaged run (`app.isPackaged` false) the driver is inert: it reports
 * `supported: false` so `UpdateService` shows a clear message rather than
 * throwing on a missing feed, and it never attaches listeners or touches the
 * network.
 */
export class ElectronUpdaterDriver implements UpdaterDriver {
  readonly currentVersion: string
  readonly supported: boolean
  private listeners: Set<(event: UpdaterDriverEvent) => void> = new Set()

  constructor() {
    this.currentVersion = app.getVersion()
    this.supported = app.isPackaged
  }

  configure(): void {
    if (!this.supported) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.on('checking-for-update', () => this.emit({ kind: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.emit({ kind: 'available', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null })
    )
    autoUpdater.on('update-not-available', () => this.emit({ kind: 'not-available' }))
    autoUpdater.on('download-progress', (progress) =>
      this.emit({
        kind: 'download-progress',
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    )
    autoUpdater.on('update-downloaded', () => this.emit({ kind: 'downloaded' }))
    autoUpdater.on('error', (error) => this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  check(): void {
    if (!this.supported) return
    // The 'error' event drives the state machine; swallow the returned promise's
    // rejection so a transient network failure never becomes an unhandled one.
    void autoUpdater.checkForUpdates().catch(() => {})
  }

  download(): void {
    if (!this.supported) return
    void autoUpdater.downloadUpdate().catch(() => {})
  }

  quitAndInstall(): void {
    if (!this.supported) return
    autoUpdater.quitAndInstall()
  }

  onEvent(listener: (event: UpdaterDriverEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
  }

  private emit(event: UpdaterDriverEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
