import { dirname, join } from 'node:path'
import { mkdir, rm, writeFile, rename, readFile, access, cp } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { createHash, randomUUID } from 'node:crypto'
import type { AppSettingsGateway } from '@shared/gateways'
import {
  SUB_STORE_BACKEND_DEFAULT_TAG,
  SUB_STORE_FRONTEND_DEFAULT_TAG,
  SUB_STORE_BACKEND_DEFAULT_DIGEST,
  SUB_STORE_FRONTEND_DEFAULT_DIGEST,
  SUB_STORE_PORT_BASE,
  SUB_STORE_START_TIMEOUT_MS,
  SUB_STORE_FETCH_TIMEOUT_MS,
  SUB_STORE_BACKEND_LATEST_API,
  SUB_STORE_FRONTEND_LATEST_API,
  SUB_STORE_BACKEND_ASSET,
  SUB_STORE_FRONTEND_ASSET,
  subStoreBackendReleaseApi,
  subStoreFrontendReleaseApi,
  subStoreBackendDownloadUrl,
  subStoreFrontendDownloadUrl,
  isValidSubStoreTag,
  type SubStoreState,
  type SubStoreAssetVersions
} from '@shared/substore'

const BACKEND_BUNDLE_FILE = 'sub-store.bundle.cjs'
const ASSETS_DIR_NAME = 'assets'
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
const BACKEND_MAX_BYTES = 16 * 1024 * 1024
const FRONTEND_ZIP_MAX_BYTES = 32 * 1024 * 1024

interface ResolvedAsset {
  tag: string
  url: string
  size: number
  digest: string
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
  /** Test seam; production always uses the digests pinned in shared/substore. */
  pinnedDigests?: { backend: string; frontend: string }
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
  private updating: Promise<void> | null = null
  private operationGeneration = 0
  private operationAbort: AbortController | null = null
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
  private readonly pinnedDigests: { backend: string; frontend: string }

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
    this.pinnedDigests = deps.pinnedDigests ?? {
      backend: SUB_STORE_BACKEND_DEFAULT_DIGEST,
      frontend: SUB_STORE_FRONTEND_DEFAULT_DIGEST
    }
  }

  private beginOperation(): { generation: number; controller: AbortController } {
    this.operationAbort?.abort()
    const controller = new AbortController()
    this.operationAbort = controller
    return { generation: ++this.operationGeneration, controller }
  }

  private operationIsCurrent(generation: number, controller: AbortController): boolean {
    return !this.disposed && !controller.signal.aborted && generation === this.operationGeneration
  }

  private assertCurrentOperation(generation: number, controller: AbortController): void {
    if (!this.operationIsCurrent(generation, controller)) {
      throw controller.signal.reason ?? new Error('Sub-Store 操作已取消')
    }
  }

  private assetsDir(): string {
    return join(this.deps.baseDir, ASSETS_DIR_NAME)
  }

  private backendBundlePath(root = this.assetsDir()): string {
    return join(root, BACKEND_BUNDLE_FILE)
  }

  private frontendIndexPath(root = this.assetsDir()): string {
    return join(root, FRONTEND_INDEX_REL)
  }

  private versionsPath(root = this.assetsDir()): string {
    return join(root, VERSIONS_FILE)
  }

  private async readVersions(root = this.assetsDir()): Promise<SubStoreAssetVersions | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.versionsPath(root), 'utf8'))
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

  private async writeVersions(versions: SubStoreAssetVersions, root = this.assetsDir()): Promise<void> {
    await mkdir(root, { recursive: true })
    const tmp = join(root, `.${VERSIONS_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(versions, null, 2)}\n`, 'utf8')
    await rename(tmp, this.versionsPath(root))
  }

  private async resolveReleaseAsset(
    apiUrl: string,
    expectedAssetName: string,
    expectedDownloadUrl: (tag: string) => string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<ResolvedAsset> {
    const response = await this.fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw new Error(`GitHub 请求失败：${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok) throw new Error(`GitHub 请求失败：HTTP ${response.status}`)
    const parsed: unknown = await response.json()
    if (!isRecord(parsed) || !isValidSubStoreTag(parsed.tag_name) || !Array.isArray(parsed.assets)) {
      throw new Error('GitHub 响应格式异常')
    }
    const matches = parsed.assets.filter(
      (asset): asset is Record<string, unknown> => isRecord(asset) && asset.name === expectedAssetName
    )
    if (matches.length !== 1) throw new Error(`GitHub Release 缺少唯一资源：${expectedAssetName}`)
    const asset = matches[0]
    const expectedUrl = expectedDownloadUrl(parsed.tag_name)
    if (
      asset.browser_download_url !== expectedUrl ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > maxBytes ||
      typeof asset.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)
    ) {
      throw new Error(`GitHub Release 资源元数据无效：${expectedAssetName}`)
    }
    return {
      tag: parsed.tag_name,
      url: expectedUrl,
      size: asset.size,
      digest: asset.digest.toLowerCase()
    }
  }

  private async downloadTo(asset: ResolvedAsset, dest: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(SUB_STORE_FETCH_TIMEOUT_MS)
    const response = await this.fetchFn(asset.url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: combinedSignal
    }).catch((error: unknown) => {
      throw new Error(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error('下载失败：资源超过大小上限')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    try {
      for (;;) {
        if (combinedSignal.aborted) throw combinedSignal.reason
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxBytes || received > asset.size) {
          await reader.cancel().catch(() => {})
          throw new Error('下载失败：资源超过声明大小或安全上限')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks, received)
    if (bytes.length !== asset.size) {
      throw new Error(`下载失败：资源大小不匹配（预期 ${asset.size}，实际 ${bytes.length}）`)
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (digest !== asset.digest) throw new Error('下载失败：SHA-256 校验不匹配')
    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, bytes)
      await rename(tmp, dest)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
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
    const previous = this.settingsCache
    const enabledChanged = settings.subStoreEnabled !== previous.enabled
    const proxyChanged = settings.subStoreUseProxy !== previous.useProxy
    this.settingsCache = { enabled: settings.subStoreEnabled, useProxy: settings.subStoreUseProxy }
    if (!settings.subStoreEnabled) {
      if (enabledChanged || this.phase !== 'idle' || this.starting) {
        await this.stop()
      }
      return
    }
    // Enabling remains page-driven/on-demand. Only an actual proxy-mode change
    // requires a live worker restart; unrelated app settings are ignored.
    if (proxyChanged && this.phase === 'running' && this.port !== null) {
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
    const { generation, controller } = this.beginOperation()
    let task!: Promise<void>
    task = (async () => {
      try {
        let versions = await this.readVersions()
        const [backendOk, frontendOk] = await Promise.all([
          pathExists(this.backendBundlePath()),
          pathExists(this.frontendIndexPath())
        ])
        if (!backendOk || !frontendOk || !versions) {
          this.phase = 'downloading'
          this.error = null
          const staging = await this.stageAssets(
            versions ?? {
              backend: SUB_STORE_BACKEND_DEFAULT_TAG,
              frontend: SUB_STORE_FRONTEND_DEFAULT_TAG
            },
            { backend: !backendOk, frontend: !frontendOk, force: !versions },
            controller.signal
          )
          this.assertCurrentOperation(generation, controller)
          await this.commitStagedAssets(staging)
          versions = await this.readVersions()
        }
        this.assertCurrentOperation(generation, controller)
        await this.spawnWorker(generation, controller)
      } catch (error) {
        if (!this.operationIsCurrent(generation, controller)) return
        this.phase = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        await this.stopWorker()
      } finally {
        if (this.starting === task) this.starting = null
        if (this.operationAbort === controller) this.operationAbort = null
      }
    })()
    this.starting = task
    await this.starting
    return this.snapshot()
  }

  private async stageAssets(
    versions: SubStoreAssetVersions,
    plan: { backend: boolean; frontend: boolean; force: boolean },
    signal?: AbortSignal
  ): Promise<string> {
    await mkdir(this.deps.baseDir, { recursive: true })
    const staging = join(this.deps.baseDir, `.assets-stage-${randomUUID()}`)
    const replaceBackend = plan.force || plan.backend
    const replaceFrontend = plan.force || plan.frontend
    try {
      if (!plan.force && await pathExists(this.assetsDir())) {
        await cp(this.assetsDir(), staging, { recursive: true })
      } else {
        await mkdir(staging, { recursive: true })
      }
      if (replaceBackend) {
        const asset = await this.resolveReleaseAsset(
          subStoreBackendReleaseApi(versions.backend),
          SUB_STORE_BACKEND_ASSET,
          subStoreBackendDownloadUrl,
          BACKEND_MAX_BYTES,
          signal
        )
        if (asset.tag !== versions.backend) throw new Error('Sub-Store 后端版本响应不匹配')
        if (versions.backend === SUB_STORE_BACKEND_DEFAULT_TAG && asset.digest !== this.pinnedDigests.backend) {
          throw new Error('Sub-Store 后端默认版本摘要与应用内置值不匹配')
        }
        await this.downloadTo(asset, this.backendBundlePath(staging), BACKEND_MAX_BYTES, signal)
      }
      if (replaceFrontend) {
        const asset = await this.resolveReleaseAsset(
          subStoreFrontendReleaseApi(versions.frontend),
          SUB_STORE_FRONTEND_ASSET,
          subStoreFrontendDownloadUrl,
          FRONTEND_ZIP_MAX_BYTES,
          signal
        )
        if (asset.tag !== versions.frontend) throw new Error('Sub-Store 前端版本响应不匹配')
        if (versions.frontend === SUB_STORE_FRONTEND_DEFAULT_TAG && asset.digest !== this.pinnedDigests.frontend) {
          throw new Error('Sub-Store 前端默认版本摘要与应用内置值不匹配')
        }
        const zipPath = join(staging, 'frontend-dist.zip')
        await this.downloadTo(asset, zipPath, FRONTEND_ZIP_MAX_BYTES, signal)
        const { extractZipToDir } = await import('./substore-zip')
        const frontendStaging = join(staging, `frontend-staging-${randomUUID()}`)
        await extractZipToDir(zipPath, frontendStaging)
        if (!(await pathExists(join(frontendStaging, 'index.html')))) {
          throw new Error('前端压缩包缺少 index.html')
        }
        await rm(join(staging, FRONTEND_DIR_NAME), { recursive: true, force: true })
        await rename(frontendStaging, join(staging, FRONTEND_DIR_NAME))
        await rm(zipPath, { force: true }).catch(() => {})
      }
      if (!(await pathExists(this.backendBundlePath(staging))) || !(await pathExists(this.frontendIndexPath(staging)))) {
        throw new Error('Sub-Store 暂存资源不完整')
      }
      await this.writeVersions(versions, staging)
      return staging
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /** Replace backend, frontend and their version marker as one rollback-safe set. */
  private async commitStagedAssets(staging: string): Promise<void> {
    const current = this.assetsDir()
    const backup = join(this.deps.baseDir, `.assets-backup-${randomUUID()}`)
    const hadCurrent = await pathExists(current)
    try {
      if (hadCurrent) await rename(current, backup)
      await rename(staging, current)
      await rm(backup, { recursive: true, force: true }).catch(() => {})
      // v0.8.0 stored executable assets directly under baseDir. Once the new
      // atomic asset set is committed, remove only those exact legacy paths;
      // the persistent `data/` directory is deliberately untouched.
      await Promise.all([
        rm(join(this.deps.baseDir, BACKEND_BUNDLE_FILE), { force: true }),
        rm(join(this.deps.baseDir, FRONTEND_DIR_NAME), { recursive: true, force: true }),
        rm(join(this.deps.baseDir, VERSIONS_FILE), { force: true })
      ]).catch(() => {})
    } catch (error) {
      await rm(current, { recursive: true, force: true }).catch(() => {})
      if (hadCurrent && await pathExists(backup)) await rename(backup, current).catch(() => {})
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
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
      SUB_STORE_FRONTEND_PATH: join(this.assetsDir(), FRONTEND_DIR_NAME),
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

  private async spawnWorker(generation: number, controller: AbortController): Promise<void> {
    this.assertCurrentOperation(generation, controller)
    const settings = await this.deps.appSettings.get()
    // The bundle writes its root.json at startup WITHOUT creating the data
    // directory — verified against the real 2.38.2 release — so pre-create it.
    await mkdir(join(this.deps.baseDir, 'data'), { recursive: true })
    const port = await this.findFreePort(SUB_STORE_PORT_BASE)
    this.assertCurrentOperation(generation, controller)
    this.phase = 'starting'
    this.error = null
    const worker = this.createWorker(
      this.backendBundlePath(),
      this.workerEnv(port, settings.subStoreUseProxy)
    )
    this.unexpectedExitError = null
    worker.onUnexpectedExit((error) => {
      if (this.worker !== worker) return
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
      await this.waitUntilHealthy(port, generation, controller)
      this.assertCurrentOperation(generation, controller)
      this.phase = 'running'
    } catch (error) {
      await this.stopWorker()
      if (this.operationIsCurrent(generation, controller)) {
        this.phase = 'error'
        this.error = error instanceof Error ? error.message : String(error)
      }
      throw error
    }
  }

  private async waitUntilHealthy(port: number, generation: number, controller: AbortController): Promise<void> {
    const deadline = Date.now() + SUB_STORE_START_TIMEOUT_MS
    const url = `http://127.0.0.1:${port}/`
    for (;;) {
      this.assertCurrentOperation(generation, controller)
      if (this.unexpectedExitError) throw this.unexpectedExitError
      if (Date.now() > deadline) throw new Error('Sub-Store 启动超时')
      const ok = await this.fetchFn(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)])
      })
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
    ++this.operationGeneration
    this.operationAbort?.abort(new Error('Sub-Store 操作已取消'))
    this.operationAbort = null
    const pending = Promise.all(
      [this.starting, this.updating].filter((task): task is Promise<void> => task !== null)
    )
    await this.stopWorker()
    if (this.phase !== 'idle') this.phase = 'idle'
    this.error = null
    await pending.catch(() => {})
    this.starting = null
    this.updating = null
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
    if (this.updating) {
      await this.updating
      return this.snapshot()
    }
    // Do not queue an update behind a start that may concurrently be cancelled
    // by the master switch; the caller can retry once the visible phase settles.
    if (this.starting) return this.snapshot()
    const wasRunning = this.phase === 'running'
    const { generation, controller } = this.beginOperation()
    let stoppedForCommit = false
    let task!: Promise<void>
    task = (async () => {
      try {
        const [backendAsset, frontendAsset] = await Promise.all([
          this.resolveReleaseAsset(
            SUB_STORE_BACKEND_LATEST_API,
            SUB_STORE_BACKEND_ASSET,
            subStoreBackendDownloadUrl,
            BACKEND_MAX_BYTES,
            controller.signal
          ),
          this.resolveReleaseAsset(
            SUB_STORE_FRONTEND_LATEST_API,
            SUB_STORE_FRONTEND_ASSET,
            subStoreFrontendDownloadUrl,
            FRONTEND_ZIP_MAX_BYTES,
            controller.signal
          )
        ])
        this.assertCurrentOperation(generation, controller)
        const current = (await this.readVersions()) ?? {
          backend: SUB_STORE_BACKEND_DEFAULT_TAG,
          frontend: SUB_STORE_FRONTEND_DEFAULT_TAG
        }
        const plan = {
          backend: backendAsset.tag !== current.backend,
          frontend: frontendAsset.tag !== current.frontend,
          force: !(await pathExists(this.assetsDir()))
        }
        if (plan.backend || plan.frontend || plan.force) {
          this.phase = 'downloading'
          const staging = await this.stageAssets(
            { backend: backendAsset.tag, frontend: frontendAsset.tag },
            plan,
            controller.signal
          )
          this.assertCurrentOperation(generation, controller)
          if (wasRunning) {
            await this.stopWorker()
            stoppedForCommit = true
          }
          await this.commitStagedAssets(staging)
          this.assertCurrentOperation(generation, controller)
          if (wasRunning) {
            await this.spawnWorker(generation, controller)
            stoppedForCommit = false
          } else {
            this.phase = 'idle'
          }
        } else {
          this.phase = wasRunning && this.worker ? 'running' : 'idle'
        }
        this.error = null
      } catch (error) {
        if (!this.operationIsCurrent(generation, controller)) return
        const message = error instanceof Error ? error.message : String(error)
        if (stoppedForCommit && wasRunning) {
          try {
            await this.spawnWorker(generation, controller)
          } catch {
            // spawnWorker already records the more actionable restart failure.
          }
        }
        this.error = message
        this.phase = wasRunning && this.worker ? 'running' : 'idle'
      } finally {
        if (this.updating === task) this.updating = null
        if (this.operationAbort === controller) this.operationAbort = null
      }
    })()
    this.updating = task
    await task
    return this.snapshot()
  }

  /** Open the merged (or any validated http(s)) URL in the user's browser. */
  async openExternal(url: string): Promise<void> {
    await (this.deps.openExternal ?? defaultOpenExternal)(url)
  }

  /** Terminate the worker during app shutdown; assets persist. */
  dispose(): void {
    this.disposed = true
    ++this.operationGeneration
    this.operationAbort?.abort(new Error('Sub-Store 已关闭'))
    this.operationAbort = null
    this.starting = null
    this.updating = null
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate().catch(() => {})
    this.port = null
    this.phase = 'idle'
  }
}
