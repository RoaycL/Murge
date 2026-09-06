import { join } from 'node:path'
import { mkdir, rm, writeFile, rename, readFile, access } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { AppSettingsGateway } from '@shared/gateways'
import {
  SUB_STORE_BACKEND_DEFAULT_TAG,
  SUB_STORE_FRONTEND_DEFAULT_TAG,
  SUB_STORE_PORT_BASE,
  SUB_STORE_START_TIMEOUT_MS,
  SUB_STORE_FETCH_TIMEOUT_MS,
  SUB_STORE_BACKEND_LATEST_API,
  SUB_STORE_FRONTEND_LATEST_API,
  subStoreBackendDownloadUrl,
  subStoreFrontendDownloadUrl,
  isValidSubStoreTag,
  type SubStoreState,
  type SubStoreAssetVersions
} from '@shared/substore'

const BACKEND_BUNDLE_FILE = 'sub-store.bundle.cjs'
const FRONTEND_DIR_NAME = 'sub-store-frontend'
const FRONTEND_INDEX_REL = `${FRONTEND_DIR_NAME}/index.html`
const VERSIONS_FILE = 'versions.json'
const USER_AGENT = 'substore-kernel-manager'

/** Lazy default opener so this module stays unit-testable without Electron. */
async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
const HEALTH_POLL_MS = 300

interface GithubRelease {
  tag_name?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The worker handle the service owns. `worker_threads.Worker` behind a narrow
 * interface so tests can inject a recording fake instead of spawning threads.
 */
export interface SubStoreWorkerHandle {
  terminate(): Promise<number>
  /** Fires when the worker dies on its own (crash / early exit), not on stop(). */
  onUnexpectedExit(callback: (error: Error) => void): void
}

export interface SubStoreDeps {
  /**
   * Base directory holding the Sub-Store assets (bundle, frontend, versions
   * marker and the backend's own data). Everything the feature writes lives
   * under here so uninstall/removal is a single directory delete.
   */
  baseDir: string
  /** Runtime brand value passed to the backend for display + local-origin CORS. */
  brandName: string
  /**
   * Resolves the kernel mixed-port for the worker's proxy env when
   * `subStoreUseProxy` is on. Null (or a falsey port) means direct egress.
   */
  getMixedPort: () => number | null
  /** Injectable for tests; defaults to Node's worker_threads Worker. */
  createWorker?: (bundlePath: string, env: Record<string, string>) => SubStoreWorkerHandle
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Injectable port probe for tests. */
  findFreePort?: (base: number) => Promise<number>
  /** Injectable clock step for tests. */
  delay?: (ms: number) => Promise<void>
  /** Persisted preferences (subStoreEnabled / subStoreUseProxy mirrors). */
  appSettings: AppSettingsGateway
  /** OS-level browser opener; defaults to Electron shell.openExternal. */
  openExternal?: (url: string) => Promise<void>
}

/**
 * Sub-Store lifecycle owner (初步接入).
 *
 * Flow: on demand the service downloads the official backend bundle and
 * frontend distribution from the pinned GitHub releases into `baseDir`, then
 * runs the backend in a worker thread with SUB_STORE_BACKEND_MERGE=1 so ONE
 * loopback port serves both the static frontend and the API (same origin —
 * no CORS, no second server). The renderer embeds it in an iframe.
 *
 * Lifecycle rules:
 * - Started only on demand (外部资源 opened while enabled) — never at boot.
 * - Single-flight ensure: concurrent calls share one start attempt.
 * - Worker env is fully constructed (never inherits the main process env).
 * - All state changes flow through this class; the renderer sees snapshots.
 */
export class SubStoreService {
  private worker: SubStoreWorkerHandle | null = null
  private unexpectedExitError: Error | null = null
  private port: number | null = null
  private phase: SubStoreState['phase'] = 'idle'
  private error: string | null = null
  private starting: Promise<void> | null = null
  private disposed = false
  // Synchronous-mirror caches, hydrated by refreshCaches() (settings onChange,
  // snapshot) so the fast IPC path never lies about enabled/useProxy/assets.
  private settingsCache = { enabled: false, useProxy: false }
  private versionsCache: SubStoreAssetVersions | null = null
  private assetsCache = false

  private readonly createWorker: NonNullable<SubStoreDeps['createWorker']>
  private readonly fetchFn: typeof fetch
  private readonly findFreePort: NonNullable<SubStoreDeps['findFreePort']>
  private readonly delay: NonNullable<SubStoreDeps['delay']>

  constructor(private readonly deps: SubStoreDeps) {
    this.createWorker =
      deps.createWorker ??
      ((bundlePath, env) => {
        const worker = new Worker(bundlePath, { env })
        let graceful = false
        const handle: SubStoreWorkerHandle = {
          terminate: () => {
            graceful = true
            return worker.terminate()
          },
          onUnexpectedExit: (callback) => {
            worker.on('error', (error) => {
              if (!graceful) callback(error instanceof Error ? error : new Error(String(error)))
            })
            worker.on('exit', (code) => {
              if (!graceful) callback(new Error(`Sub-Store 进程意外退出（代码 ${code}）`))
            })
          }
        }
        return handle
      })
    this.fetchFn = deps.fetchFn ?? fetch
    this.findFreePort =
      deps.findFreePort ??
      (async (base) => {
        const { createServer } = await import('node:net')
        for (let candidate = base; candidate < base + 50; candidate++) {
          const free = await new Promise<number>((resolvePromise) => {
            const probe = createServer()
            probe.once('error', () => resolvePromise(0))
            probe.listen(candidate, '127.0.0.1', () => {
              const address = probe.address()
              const bound = typeof address === 'object' && address ? address.port : candidate
              probe.close(() => resolvePromise(bound))
            })
          })
          if (free) return free
        }
        throw new Error('没有可用的本地端口')
      })
    this.delay =
      deps.delay ??
      ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
  }

  private backendBundlePath(): string {
    return join(this.deps.baseDir, BACKEND_BUNDLE_FILE)
  }

  private frontendIndexPath(): string {
    return join(this.deps.baseDir, FRONTEND_INDEX_REL)
  }

  private versionsPath(): string {
    return join(this.deps.baseDir, VERSIONS_FILE)
  }

  private async readVersions(): Promise<SubStoreAssetVersions | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.versionsPath(), 'utf8'))
      if (
        isRecord(parsed) &&
        isValidSubStoreTag(parsed.backend) &&
        isValidSubStoreTag(parsed.frontend)
      ) {
        return { backend: parsed.backend, frontend: parsed.frontend }
      }
    } catch {
      // Absent or corrupt marker: assets will be re-resolved on demand.
    }
    return null
  }

  private async writeVersions(versions: SubStoreAssetVersions): Promise<void> {
    await mkdir(this.deps.baseDir, { recursive: true })
    const tmp = join(this.deps.baseDir, `.${VERSIONS_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(versions, null, 2)}\n`, 'utf8')
    await rename(tmp, this.versionsPath())
  }

  private async githubLatestTag(apiUrl: string): Promise<string> {
    const response = await this.fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw new Error(`GitHub 请求失败：${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok) throw new Error(`GitHub 请求失败：HTTP ${response.status}`)
    const parsed: unknown = await response.json()
    if (!isRecord(parsed) || !isValidSubStoreTag(parsed.tag_name)) {
      throw new Error('GitHub 响应格式异常')
    }
    return parsed.tag_name
  }

  private async downloadTo(url: string, dest: string): Promise<void> {
    const response = await this.fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw new Error(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    await mkdir(this.deps.baseDir, { recursive: true })
    const tmp = `${dest}.${randomUUID()}.tmp`
    await pipeline(response.body, createWriteStream(tmp))
    await rename(tmp, dest)
  }

  /** Synchronous mirror snapshot (no disk reads) for fast IPC. */
  getState(): SubStoreState {
    return {
      enabled: this.settingsCache.enabled,
      useProxy: this.settingsCache.useProxy,
      phase: this.phase,
      port: this.port,
      version: this.versionsCache,
      assetsReady: this.assetsCache,
      error: this.error
    }
  }

  /** Refresh the synchronous-mirror caches from the persisted facts. */
  private async refreshCaches(): Promise<void> {
    const [settings, versions] = await Promise.all([this.deps.appSettings.get(), this.readVersions()])
    this.settingsCache = { enabled: settings.subStoreEnabled, useProxy: settings.subStoreUseProxy }
    this.versionsCache = versions
    const [backendOk, frontendOk] = await Promise.all([
      pathExists(this.backendBundlePath()),
      pathExists(this.frontendIndexPath())
    ])
    this.assetsCache = Boolean(backendOk && frontendOk)
  }

  /** Full snapshot the IPC surface serves: settings mirror + disk facts. */
  async snapshot(): Promise<SubStoreState> {
    await this.refreshCaches()
    return this.getState()
  }

  /** React to persisted setting changes driven by the renderer (or defaults). */
  async onSettings(settings: {
    subStoreEnabled: boolean
    subStoreUseProxy: boolean
  }): Promise<void> {
    if (this.disposed) return
    // Keep the synchronous mirror in step with the persisted truth even before
    // the first snapshot read reaches the IPC path.
    this.settingsCache = { enabled: settings.subStoreEnabled, useProxy: settings.subStoreUseProxy }
    if (!settings.subStoreEnabled) {
      if (this.phase === 'running' || this.phase === 'starting' || this.phase === 'error') {
        await this.stop()
      }
      return
    }
    if (this.phase === 'idle' || this.phase === 'error') {
      await this.ensureRunning().catch(() => {})
    } else if (this.phase === 'running' && this.port !== null) {
      // useProxy changed → restart the worker with the new env.
      await this.restart()
    }
  }

  /**
   * Ensure the assets exist (downloading pinned defaults when missing) and the
   * worker is healthy. Idempotent and single-flight.
   */
  async ensureRunning(): Promise<SubStoreState> {
    if (this.disposed) return this.snapshot()
    if (this.phase === 'running') return this.snapshot()
    if (this.starting) {
      await this.starting
      return this.snapshot()
    }
    this.starting = (async () => {
      try {
        let versions = await this.readVersions()
        const [backendOk, frontendOk] = await Promise.all([
          pathExists(this.backendBundlePath()),
          pathExists(this.frontendIndexPath())
        ])
        if (!backendOk || !frontendOk || !versions) {
          this.phase = 'downloading'
          this.error = null
          versions = await this.downloadAssets(
            versions ?? {
              backend: SUB_STORE_BACKEND_DEFAULT_TAG,
              frontend: SUB_STORE_FRONTEND_DEFAULT_TAG
            },
            { backend: !backendOk, frontend: !frontendOk, force: !versions }
          )
        }
        await this.spawnWorker()
      } catch (error) {
        this.phase = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        await this.stopWorker()
      } finally {
        this.starting = null
      }
    })()
    await this.starting
    return this.snapshot()
  }

  private async downloadAssets(
    versions: SubStoreAssetVersions,
    plan: { backend: boolean; frontend: boolean; force: boolean }
  ): Promise<SubStoreAssetVersions> {
    await mkdir(this.deps.baseDir, { recursive: true })
    let backendTag = versions.backend
    let frontendTag = versions.frontend
    if (plan.backend) {
      await this.downloadTo(subStoreBackendDownloadUrl(backendTag), this.backendBundlePath())
    }
    if (plan.frontend) {
      const zipPath = join(this.deps.baseDir, 'frontend-dist.zip')
      await this.downloadTo(subStoreFrontendDownloadUrl(frontendTag), zipPath)
      const { extractZipToDir } = await import('./substore-zip')
      const staging = join(this.deps.baseDir, `frontend-staging-${randomUUID()}`)
      try {
        await extractZipToDir(zipPath, staging)
        if (!(await pathExists(join(staging, 'index.html')))) {
          throw new Error('前端压缩包缺少 index.html')
        }
        await rm(join(this.deps.baseDir, FRONTEND_DIR_NAME), { recursive: true, force: true })
        await rename(staging, join(this.deps.baseDir, FRONTEND_DIR_NAME))
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        await rm(zipPath, { force: true }).catch(() => {})
      }
    }
    const next: SubStoreAssetVersions = { backend: backendTag, frontend: frontendTag }
    if (plan.force || plan.backend || plan.frontend) await this.writeVersions(next)
    return next
  }

  private workerEnv(port: number, useProxy: boolean): Record<string, string> {
    const env: Record<string, string> = {
      SUB_STORE_BACKEND_API_PORT: String(port),
      SUB_STORE_BACKEND_API_HOST: '127.0.0.1',
      // MERGE mode: the same express app serves the static frontend on every
      // non-API route of this port, so the embedded UI is same-origin. The
      // backend path MUST be '/' — a deeper prefix (e.g. /api/) strips the
      // first segment off API routes and 404s them (verified against the real
      // release): `/api/subs` would become `/subs`.
      SUB_STORE_BACKEND_MERGE: '1',
      SUB_STORE_FRONTEND_BACKEND_PATH: '/',
      SUB_STORE_FRONTEND_PATH: join(this.deps.baseDir, FRONTEND_DIR_NAME),
      SUB_STORE_DATA_BASE_PATH: join(this.deps.baseDir, 'data'),
      // Setting a custom backend name flips the backend's default Node CORS
      // policy to allow local origins (upstream behavior; merge mode makes it
      // moot, but it also names the backend after the app in the UI).
      SUB_STORE_BACKEND_CUSTOM_NAME: this.deps.brandName
    }
    if (useProxy) {
      const mixedPort = this.deps.getMixedPort()
      if (mixedPort) {
        const proxy = `http://127.0.0.1:${mixedPort}`
        env.HTTP_PROXY = proxy
        env.HTTPS_PROXY = proxy
        env.ALL_PROXY = proxy
      }
    }
    return env
  }

  private async spawnWorker(): Promise<void> {
    const settings = await this.deps.appSettings.get()
    // The bundle writes its root.json at startup WITHOUT creating the data
    // directory — verified against the real 2.38.2 release — so pre-create it.
    await mkdir(join(this.deps.baseDir, 'data'), { recursive: true })
    const port = await this.findFreePort(SUB_STORE_PORT_BASE)
    this.phase = 'starting'
    this.error = null
    const worker = this.createWorker(
      this.backendBundlePath(),
      this.workerEnv(port, settings.subStoreUseProxy)
    )
    this.unexpectedExitError = null
    worker.onUnexpectedExit((error) => {
      this.unexpectedExitError = error
      if (this.phase === 'running') {
        // A crash after a healthy start: surface it instead of leaving the
        // renderer pointed at a dead port.
        this.phase = 'error'
        this.error = error.message
        this.port = null
      }
    })
    this.worker = worker
    this.port = port
    try {
      await this.waitUntilHealthy(port)
      this.phase = 'running'
    } catch (error) {
      await this.stopWorker()
      this.phase = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async waitUntilHealthy(port: number): Promise<void> {
    const deadline = Date.now() + SUB_STORE_START_TIMEOUT_MS
    const url = `http://127.0.0.1:${port}/`
    for (;;) {
      if (this.unexpectedExitError) throw this.unexpectedExitError
      if (Date.now() > deadline) throw new Error('Sub-Store 启动超时')
      const ok = await this.fetchFn(url, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.ok)
        .catch(() => false)
      if (ok) return
      await this.delay(HEALTH_POLL_MS)
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker) {
      await worker.terminate().catch(() => {})
    }
    this.port = null
  }

  /** Stop the worker; keeps downloaded assets and the enabled setting. */
  async stop(): Promise<SubStoreState> {
    this.starting = null
    await this.stopWorker()
    if (this.phase !== 'idle') this.phase = 'idle'
    this.error = null
    return this.snapshot()
  }

  private async restart(): Promise<void> {
    await this.stop()
    await this.ensureRunning()
  }

  /**
   * Fetch the latest release tags; re-download any asset whose tag changed and
   * restart the worker when it was running. Assets keep working offline if the
   * update check fails — the error only surfaces in state.
   */
  async checkUpdate(): Promise<SubStoreState> {
    if (this.disposed) return this.snapshot()
    const wasRunning = this.phase === 'running'
    try {
      const [backendTag, frontendTag] = await Promise.all([
        this.githubLatestTag(SUB_STORE_BACKEND_LATEST_API),
        this.githubLatestTag(SUB_STORE_FRONTEND_LATEST_API)
      ])
      const current = (await this.readVersions()) ?? {
        backend: SUB_STORE_BACKEND_DEFAULT_TAG,
        frontend: SUB_STORE_FRONTEND_DEFAULT_TAG
      }
      const plan = {
        backend: backendTag !== current.backend,
        frontend: frontendTag !== current.frontend,
        force: false
      }
      if (plan.backend || plan.frontend) {
        this.phase = 'downloading'
        await this.downloadAssets({ backend: backendTag, frontend: frontendTag }, plan)
        await this.stop()
        if (wasRunning) await this.ensureRunning()
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      // A failed update check must not leave the phase stuck on 'downloading':
      // the worker was never stopped on this path, so restore the truthful
      // phase (running → still serving; otherwise idle).
      this.phase = wasRunning && this.worker ? 'running' : 'idle'
    }
    return this.snapshot()
  }

  /** Open the merged (or any validated http(s)) URL in the user's browser. */
  async openExternal(url: string): Promise<void> {
    await (this.deps.openExternal ?? defaultOpenExternal)(url)
  }

  /** Terminate the worker during app shutdown; assets persist. */
  dispose(): void {
    this.disposed = true
    this.starting = null
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate().catch(() => {})
    this.port = null
    this.phase = 'idle'
  }
}
