import { createRequire } from 'node:module'
import { app, Notification } from 'electron'
import type { UpdaterDriver, UpdaterDriverEvent } from './updater-driver'

// `electron-updater` is a CommonJS module. The bundled main process runs as ESM
// (`"type": "module"`), and a bare `import { autoUpdater } from 'electron-updater'`
// fails at runtime because Node's ESM/CJS interop cannot synthesize the named
// export — the packaged app crashes on launch with
// `SyntaxError: Named export 'autoUpdater' not found`. Loading it through a real
// CJS `require` (createRequire) sidesteps interop entirely and preserves the
// `AppUpdater` type via the cast.
const nativeRequire = createRequire(import.meta.url)
const { autoUpdater } = nativeRequire('electron-updater') as typeof import('electron-updater')

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
    autoUpdater.on('update-available', (info) => {
      const version = info.version
      this.emit({ kind: 'available', version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null })
      this.notify(`发现新版本 v${version}`, '正在后台下载，退出应用时自动安装。')
    })
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
    autoUpdater.on('update-downloaded', (info) => {
      this.emit({ kind: 'downloaded' })
      this.notify(`新版本 v${info.version} 已就绪`, '退出应用时自动安装，或点击“重启并安装”立即更新。')
    })
    autoUpdater.on('error', (error) => this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  /** Show a native OS notification, guarded so it is a no-op where unsupported. */
  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    } catch {
      // A failing notification must never take down the updater event stream.
    }
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
