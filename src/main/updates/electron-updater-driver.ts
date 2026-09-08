import { createRequire } from 'node:module'
import { app, net, Notification } from 'electron'
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
  /** The complete generic feed URL that worked most recently; reused first. */
  private resolvedFeedBase: string | null = null
  /** Per-source failures are internal to fallback; publish only the final result. */
  private checkingWithFallback = false
  private checkInFlight = false
  private readonly notifications = new Set<Notification>()

  constructor(private readonly onNotificationClick: () => void = () => undefined) {
    this.currentVersion = app.getVersion()
    this.supported = app.isPackaged
  }

  configure(): void {
    if (!this.supported) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.disableWebInstaller = true
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
    autoUpdater.on('error', (error) => {
      if (this.checkingWithFallback) return
      this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Show a native OS notification, guarded so it is a no-op where unsupported. */
  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      this.notifications.add(notification)
      const release = (): void => { this.notifications.delete(notification) }
      notification.once('click', () => {
        release()
        this.onNotificationClick()
      })
      notification.once('close', release)
      notification.show()
    } catch {
      // A failing notification must never take down the updater event stream.
    }
  }

  check(): void {
    if (!this.supported || this.checkInFlight) return
    // electron-updater normally surfaces failures through the 'error' event, but
    // a pre-flight failure (bad feed descriptor, unparseable metadata) can reject
    // the promise WITHOUT emitting 'error'. The fallback runner below routes every
    // outcome — including a synchronous throw — into the same 'error' event so the
    // service's state machine never gets stuck in 'checking'.
    this.checkInFlight = true
    void this.checkWithProxyFallback()
      .catch((error) => {
        this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => { this.checkInFlight = false })
  }

  /**
   * Probe metadata with cancellable HTTP requests, then invoke electron-updater
   * exactly once against the selected source. Timing out checkForUpdates itself
   * cannot cancel its internal request; starting another check after that races
   * two updater requests and produces ERR_CONNECTION_ABORTED/CLOSED.
   */
  private async checkWithProxyFallback(): Promise<void> {
    const bases = this.feedBaseCandidates()
    let lastError: unknown = null
    this.checkingWithFallback = true
    try {
      // Metadata probes are independent and cancellable, so race them instead
      // of making an unreachable source add five seconds before every fallback.
      const selectedBase = await this.selectFeedBase(bases)
      this.resolvedFeedBase = selectedBase
      autoUpdater.setFeedURL({ provider: 'generic', url: selectedBase })
      await autoUpdater.checkForUpdates()
      return
    } catch (error) {
      this.resolvedFeedBase = null
      lastError = error
    } finally {
      this.checkingWithFallback = false
    }
    this.emit({
      kind: 'error',
      message: `无法连接更新源，请检查网络或稍后重试（${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')}）`
    })
  }

  /**
   * Ordered complete feed URLs: last-known-good first, direct GitHub next (so
   * Windows/system proxy handling remains native), then prefix mirrors.
   */
  private feedBaseCandidates(): string[] {
    const { owner, repo } = this.ownerRepo()
    const direct = `https://github.com/${owner}/${repo}/releases/latest/download`
    const mirrors = GITHUB_PROXIES.map((proxy) => `${proxy}/${direct}`)
    const all = [this.resolvedFeedBase ?? direct, direct, ...mirrors]
    return [...new Set(all)]
  }

  /**
   * A real, cancellable metadata request. The response body is deliberately
   * consumed so connection failures are observed before selecting the source.
   */
  private async selectFeedBase(bases: readonly string[]): Promise<string> {
    const controllers = bases.map(() => new AbortController())
    try {
      return await Promise.any(bases.map(async (base, index) => {
        await this.probeFeed(base, controllers[index]!.signal)
        return base
      }))
    } finally {
      for (const controller of controllers) controller.abort()
    }
  }

  private async probeFeed(base: string, signal: AbortSignal): Promise<void> {
    const response = await net.fetch(`${base}/latest.yml`, {
      method: 'GET',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FEED_PROBE_TIMEOUT_MS)]),
      cache: 'no-store'
    })
    if (!response.ok) throw new Error(`update feed returned HTTP ${response.status}`)
    const body = await response.text()
    if (!/^(version|path|files):/m.test(body)) throw new Error('update feed returned invalid metadata')
  }

  /** `{owner, repo}` parsed from the brand's repository URL (never hardcoded). */
  private ownerRepo(): { owner: string; repo: string } {
    const path = new URL(brand.repositoryUrl).pathname.replace(/^\/+|\/+$/g, '')
    const [owner = '', repo = ''] = path.split('/')
    return { owner, repo }
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
    this.notifications.clear()
    this.listeners.clear()
  }

  private emit(event: UpdaterDriverEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
