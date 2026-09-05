import { createRequire } from 'node:module'
import { app, Notification } from 'electron'
import { brand } from '@shared/brand'
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
/**
 * GitHub mirrors tried before falling back to a direct connection, in order
 * (the mihomo-party / clash-party list). In much of China a direct hit on
 * `github.com` times out, so without these the update check is effectively
 * broken there; each is prefixed onto the feed URL until one responds.
 */
const GITHUB_PROXIES: readonly string[] = [
  'https://gh-proxy.org',
  'https://ghfast.top'
]

/** Timeout for a single feed probe before moving to the next proxy/direct. */
const FEED_PROBE_TIMEOUT_MS = 5000

export class ElectronUpdaterDriver implements UpdaterDriver {
  readonly currentVersion: string
  readonly supported: boolean
  private listeners: Set<(event: UpdaterDriverEvent) => void> = new Set()
  /** The feed base URL that worked most recently; reused until it fails. */
  private resolvedFeedBase: string | null = null

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
    // electron-updater normally surfaces failures through the 'error' event, but
    // a pre-flight failure (bad feed descriptor, unparseable metadata) can reject
    // the promise WITHOUT emitting 'error'. The fallback runner below routes every
    // outcome — including a synchronous throw — into the same 'error' event so the
    // service's state machine never gets stuck in 'checking'.
    void this.checkWithProxyFallback().catch((error) => {
      this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * Try the update check against the last-known-good feed, then each GitHub
   * mirror, then a direct connection, re-pointing electron-updater's feed URL
   * at the first source that yields a usable response. Only when ALL sources
   * fail is an 'error' event emitted. This is what keeps update checks working
   * where `github.com` is unreachable (the mihomo-party proxy-fallback model).
   */
  private async checkWithProxyFallback(): Promise<void> {
    const bases = this.feedBaseCandidates()
    let lastError: unknown = null
    for (const base of bases) {
      try {
        await this.tryCheck(base)
        this.resolvedFeedBase = base
        return
      } catch (error) {
        lastError = error
        this.resolvedFeedBase = null
      }
    }
    this.emit({
      kind: 'error',
      message: lastError instanceof Error ? lastError.message : String(lastError ?? 'update check failed on all sources')
    })
  }

  /**
   * Ordered feed bases: the previously-working one first, then each mirror,
   * then direct ('' = electron-updater's baked-in github provider). De-duplicated
   * and without repeats of the resolved base.
   */
  private feedBaseCandidates(): string[] {
    const all = [this.resolvedFeedBase ?? '', ...GITHUB_PROXIES, '']
    return [...new Set(all)]
  }

  /**
   * Point electron-updater at `base` and run a single check. When `base` is a
   * mirror the baked-in GitHub provider is overridden with a generic feed whose
   * URL is `<mirror>/<github-release-url>`; when empty the original provider is
   * restored. The GitHub release layout (…/releases/latest/download/latest.yml)
   * is what both the real feed and every mirror serve.
   */
  private async tryCheck(base: string): Promise<void> {
    const { owner, repo } = this.ownerRepo()
    if (base) {
      // Mirror: serve the release layout from `<mirror>/<owner>/<repo>` via the
      // generic provider (a plain static directory holding latest.yml).
      autoUpdater.setFeedURL({ provider: 'generic', url: `${base}/${owner}/${repo}` })
    } else {
      autoUpdater.setFeedURL({ provider: 'github', owner, repo })
    }
    await this.withTimeout(autoUpdater.checkForUpdates(), FEED_PROBE_TIMEOUT_MS)
  }

  /** `{owner, repo}` parsed from the brand's repository URL (never hardcoded). */
  private ownerRepo(): { owner: string; repo: string } {
    const path = new URL(brand.repositoryUrl).pathname.replace(/^\/+|\/+$/g, '')
    const [owner = '', repo = ''] = path.split('/')
    return { owner, repo }
  }

  /** Reject after `ms` so a hung source does not stall the fallback chain. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`update feed timed out after ${ms}ms`)), ms)
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) }
      )
    })
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
