import { join } from 'node:path'
import type { UpdateChannel } from '@shared/app-settings'
import type { UpdateProduct } from '@shared/updates'
import { verifyMinisign } from './minisign'
import type { UpdaterDriver, UpdaterDriverEvent } from './updater-driver'

/**
 * {@link UpdaterDriver} for the signed release-channel manifests
 * (`latest.json`, Tauri updater format). Each channel is a fixed GitHub
 * release whose manifest the release workflows rewrite: `stable` announces
 * the Electron build, `experimental` the Tauri build. The driver finds the
 * setup exe for this architecture, downloads it through the same
 * direct-or-mirror source the manifest came from, and accepts it only when
 * its minisign signature verifies against the pinned release key AND names
 * the announced version and file. Mirrors therefore carry bytes but cannot
 * substitute or roll back an installer (review item S1).
 *
 * An installer of the running build must be newer; an installer of the other
 * build is a channel switch and is taken whatever its version. Which build an
 * installer belongs to follows from its (signed) file name.
 *
 * The verified installer is launched from {@link dispose}, which the ordered
 * quit flow calls after it has restored the system proxy and stopped the
 * kernel — electron-updater's `autoInstallOnAppQuit` timing. Either installer
 * takes over the other build's installation (keeps service and data).
 *
 * Electron-free: every side effect is an injected dependency, so the whole
 * flow is unit-tested with fakes.
 */

export const MANIFEST_NAME = 'latest.json'
/** Per-source manifest probe timeout (same as the electron-updater driver). */
const FEED_PROBE_TIMEOUT_MS = 5000
/** Upper bound for one installer download attempt. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000
/** Hard cap on the installer size; the whole file is verified in memory. */
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024
/** Fixed GitHub release tag that carries each channel's manifest. */
export const CHANNEL_TAGS: Readonly<Record<UpdateChannel, string>> = {
  stable: 'channel-stable',
  experimental: 'channel-experimental'
}
/**
 * The build each channel delivers. A manifest naming the other build is
 * refused: manifests are unsigned, so a stale or hostile mirror could
 * otherwise serve an old, validly signed installer of the other build, which
 * would be taken as a channel switch at any version. Moving the stable
 * channel to Tauri later takes a client release that changes this mapping.
 */
export const CHANNEL_PRODUCTS: Readonly<Record<UpdateChannel, UpdateProduct>> = {
  stable: 'electron',
  experimental: 'tauri'
}
/** Installer names GitHub serves unchanged and that are safe as a file name. */
export const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/

/** The updater's `{{target}}-{{arch}}` platform keys. */
const PLATFORM_KEYS: Readonly<Record<string, string>> = { x64: 'windows-x86_64', arm64: 'windows-aarch64' }

export interface SignedManifestDeps {
  currentVersion: string
  supported: boolean
  /** `process.arch` of the running build. */
  arch: string
  /** Pinned release public key (base64 minisign `.pub`). */
  publicKey: string
  /** The build this driver runs in. */
  product: UpdateProduct
  /** `https://github.com/<owner>/<repo>`. */
  repositoryUrl: string
  /** Mirror prefixes tried alongside direct GitHub, e.g. `https://ghfast.top`. */
  mirrors: readonly string[]
  /** Channel followed at start; {@link SignedManifestUpdaterDriver.setChannel} changes it. */
  channel: UpdateChannel
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  /** Directory the verified installer is written to. */
  downloadDir: string
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  /** Synchronous read of the staged installer, re-verified right before launch. */
  readFile: (path: string) => Uint8Array
  /** Start the installer detached (it elevates itself). */
  launchInstaller: (path: string, args: readonly string[]) => void
  /** Begin the app's ordered quit flow. */
  requestQuit: () => void
  notify?: (title: string, body: string) => void
}

interface ManifestPlatform {
  url: string
  signature: string
}

interface Manifest {
  version: string
  notes: string | null
  platforms: Record<string, ManifestPlatform>
}

class FeedNotFound extends Error {}

/** Strict `x.y.z` (no prerelease) → numeric triple, or null. */
export function parseStableVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseStableVersion(candidate)
  const now = parseStableVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index]! !== now[index]!) return next[index]! > now[index]!
  }
  return false
}

export function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object') throw new Error('update manifest is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string') throw new Error('update manifest has no version')
  const platforms: Record<string, ManifestPlatform> = {}
  if (record.platforms && typeof record.platforms === 'object') {
    for (const [key, raw] of Object.entries(record.platforms as Record<string, unknown>)) {
      const entry = raw as Record<string, unknown> | null
      if (entry && typeof entry.url === 'string' && typeof entry.signature === 'string') {
        platforms[key] = { url: entry.url, signature: entry.signature }
      }
    }
  }
  return { version: record.version, notes: typeof record.notes === 'string' ? record.notes : null, platforms }
}

/** Direct GitHub download base of a channel's manifest release. */
export function channelFeedBase(repositoryUrl: string, channel: UpdateChannel): string {
  return `${repositoryUrl.replace(/\/+$/, '')}/releases/download/${CHANNEL_TAGS[channel]}`
}

/**
 * The build an installer belongs to, from its file name: the Tauri bundler
 * writes `<product>_<version>_<arch>-setup.exe`, electron-builder
 * `<product>-Setup-<version>-<arch>.exe`.
 */
export function installerProduct(fileName: string): UpdateProduct | null {
  if (/_\d+\.\d+\.\d+_(?:x64|arm64)-setup\.exe$/.test(fileName)) return 'tauri'
  if (/-Setup-\d+\.\d+\.\d+-(?:x64|arm64)\.exe$/.test(fileName)) return 'electron'
  return null
}

/**
 * Command line for an installer: unattended, and relaunching the app
 * afterwards only for "重启并安装" (`restart`), not for an install on quit.
 */
export function installerArgs(target: UpdateProduct, running: UpdateProduct, restart: boolean): readonly string[] {
  // Tauri NSIS: passive progress UI, /R relaunches. Its own updates add
  // /UPDATE (keeps shortcuts); a switch from Electron takes over instead.
  if (target === 'tauri') return [...(running === 'tauri' ? ['/P', '/UPDATE'] : ['/P']), ...(restart ? ['/R'] : [])]
  // electron-builder NSIS: silent, --force-run relaunches; --updated marks an
  // in-place upgrade of the same build.
  return [...(running === 'electron' ? ['--updated', '/S'] : ['/S']), ...(restart ? ['--force-run'] : [])]
}

/** True when `downloadUrl` is one of this repository's release assets. */
export function isReleaseAsset(downloadUrl: string, repositoryUrl: string): boolean {
  const repository = repositoryUrl.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(downloadUrl)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname === 'github.com' && url.port === '' && url.search === '' &&
    url.href.startsWith(`${repository}/releases/download/`)
}

/** A GitHub asset URL routed through the mirror prefix of `feedBase`, if any. */
export function routeDownloadUrl(downloadUrl: string, feedBase: string, directBase: string): string {
  if (!feedBase.endsWith(directBase)) return downloadUrl
  const prefix = feedBase.slice(0, feedBase.length - directBase.length).replace(/\/+$/, '')
  if (!prefix || !downloadUrl.startsWith('https://github.com/')) return downloadUrl
  return `${prefix}/${downloadUrl}`
}

const PRODUCT_LABELS: Readonly<Record<UpdateProduct, string>> = { electron: '稳定版', tauri: '实验版' }

function platformFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    return ''
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SignedManifestUpdaterDriver implements UpdaterDriver {
  readonly currentVersion: string
  readonly supported: boolean
  private readonly listeners = new Set<(event: UpdaterDriverEvent) => void>()
  private lastGoodBase: string | null = null
  readonly product: UpdateProduct
  private channel: UpdateChannel
  /** Bumped on a channel switch; work started before it is discarded. */
  private generation = 0
  private available: { manifest: Manifest; platform: ManifestPlatform; base: string; product: UpdateProduct } | null = null
  /** The verified installer awaiting quit, with what it was verified as. */
  private readyInstaller: { path: string; version: string; fileName: string; signature: string; product: UpdateProduct } | null = null
  private busy = false
  /** Set by "重启并安装": relaunch once the installer finishes. */
  private restartAfterInstall = false

  constructor(private readonly deps: SignedManifestDeps) {
    this.currentVersion = deps.currentVersion
    this.product = deps.product
    this.channel = deps.channel
    this.supported = deps.supported && deps.publicKey.trim().length > 0 && Boolean(PLATFORM_KEYS[deps.arch])
  }

  configure(): void {}

  setChannel(channel: UpdateChannel): void {
    if (channel === this.channel) return
    this.channel = channel
    this.generation += 1
    this.available = null
    this.readyInstaller = null
    this.lastGoodBase = null
    // A check or download of the old channel may still be running; its
    // results are dropped by generation, so let the new check start now.
    this.busy = false
  }

  check(): void {
    if (!this.supported || this.busy) return
    this.run(() => this.runCheck())
  }

  download(): void {
    if (!this.supported || this.busy || !this.available) return
    this.run(() => this.runDownload())
  }

  /** Run one check or download; only the current channel's work frees `busy`. */
  private run(work: () => Promise<void>): void {
    const generation = this.generation
    this.busy = true
    void work()
      .catch((error) => { if (generation === this.generation) this.emit({ kind: 'error', message: message(error) }) })
      .finally(() => { if (generation === this.generation) this.busy = false })
  }

  quitAndInstall(): void {
    if (!this.supported || !this.readyInstaller) return
    this.restartAfterInstall = true
    this.deps.requestQuit()
  }

  onEvent(listener: (event: UpdaterDriverEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called by the quit flow after proxy restore + kernel stop. */
  dispose(): void {
    const installer = this.readyInstaller
    this.readyInstaller = null
    this.listeners.clear()
    if (!installer) return
    try {
      // The staged file sits in a user-writable directory: verify the bytes
      // on disk again immediately before handing them to Windows, so a file
      // swapped after download can never reach the UAC prompt.
      const fields = verifyMinisign(this.deps.readFile(installer.path), installer.signature, this.deps.publicKey)
      if (fields.version !== installer.version || fields.file !== installer.fileName) {
        throw new Error('staged installer no longer matches its signature')
      }
      const args = installerArgs(installer.product, this.product, this.restartAfterInstall)
      console.info(`[updates] launching ${installer.fileName} ${args.join(' ')}`)
      this.deps.launchInstaller(installer.path, args)
    } catch (error) {
      console.error('[updates] failed to launch the installer:', error)
    }
  }

  private emit(event: UpdaterDriverEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private directBase(): string {
    return channelFeedBase(this.deps.repositoryUrl, this.channel)
  }

  private candidates(): string[] {
    const direct = this.directBase()
    const feeds = [direct, ...this.deps.mirrors.map((mirror) => `${mirror.replace(/\/+$/, '')}/${direct}`)]
    return [...new Set([...(this.lastGoodBase ? [this.lastGoodBase] : []), ...feeds])]
  }

  private async fetchManifest(base: string, signal: AbortSignal): Promise<{ base: string; manifest: Manifest }> {
    const response = await this.deps.fetch(`${base}/${MANIFEST_NAME}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(FEED_PROBE_TIMEOUT_MS)])
    })
    if (response.status === 404) throw new FeedNotFound(`no ${MANIFEST_NAME} at ${base}`)
    if (!response.ok) throw new Error(`update feed returned HTTP ${response.status}`)
    return { base, manifest: parseManifest(await response.json()) }
  }

  /**
   * One source's answer: an offer when it announces a newer build for this
   * architecture, null when it answered without one (including 404).
   */
  private async probe(
    base: string,
    signal: AbortSignal
  ): Promise<{ manifest: Manifest; platform: ManifestPlatform; product: UpdateProduct } | null> {
    let manifest: Manifest
    try {
      manifest = (await this.fetchManifest(base, signal)).manifest
    } catch (error) {
      if (error instanceof FeedNotFound) return null
      throw error
    }
    const platform = manifest.platforms[PLATFORM_KEYS[this.deps.arch]!]
    if (!platform || !parseStableVersion(manifest.version)) return null
    // The manifest is unsigned: never let it point the client at anything
    // but this repository's release assets.
    if (!isReleaseAsset(platform.url, this.deps.repositoryUrl)) {
      throw new Error(`update manifest points outside the release: ${platform.url}`)
    }
    const product = installerProduct(platformFileName(platform.url))
    if (!product) throw new Error(`update manifest names an unexpected installer: ${platform.url}`)
    if (product !== CHANNEL_PRODUCTS[this.channel]) {
      throw new Error(`update manifest of the ${this.channel} channel names the other build: ${platform.url}`)
    }
    // Same build: only a newer release. Other build: a channel switch.
    if (product === this.product && !isNewerVersion(manifest.version, this.currentVersion)) return null
    // Already downloaded and waiting for quit: nothing new to fetch.
    if (this.readyInstaller && this.readyInstaller.product === product &&
        !isNewerVersion(manifest.version, this.readyInstaller.version)) return null
    return { manifest, platform, product }
  }

  private async runCheck(): Promise<void> {
    const generation = this.generation
    this.emit({ kind: 'checking' })
    const bases = this.candidates()
    const controller = new AbortController()
    type Outcome =
      | { kind: 'offer'; base: string; manifest: Manifest; platform: ManifestPlatform; product: UpdateProduct }
      | { kind: 'none'; base: string }
      | { kind: 'failed'; errors: unknown[] }
    // Every source is heard out (each probe is time-limited) and the newest
    // offer wins: manifests are unsigned, so a stale or replaying mirror that
    // answers first must not pin the client to an older release, and "no
    // update" is only concluded when no source announced one.
    const outcome = await new Promise<Outcome>((resolve) => {
      let remaining = bases.length
      let answered: string | null = null
      let best: Extract<Outcome, { kind: 'offer' }> | null = null
      const errors: unknown[] = []
      const settle = (): void => {
        remaining -= 1
        if (remaining > 0) return
        resolve(best ?? (answered ? { kind: 'none', base: answered } : { kind: 'failed', errors }))
      }
      if (remaining === 0) resolve({ kind: 'failed', errors })
      for (const base of bases) {
        this.probe(base, controller.signal).then(
          (offer) => {
            if (offer && (!best || isNewerVersion(offer.manifest.version, best.manifest.version))) {
              best = { kind: 'offer', base, ...offer }
            } else if (!offer) {
              answered ??= base
            }
            settle()
          },
          (error) => {
            errors.push(error)
            settle()
          }
        )
      }
    })
    controller.abort()
    if (generation !== this.generation) return
    if (outcome.kind === 'failed') {
      this.lastGoodBase = null
      this.emit({
        kind: 'error',
        message: `无法连接更新源，请检查网络或稍后重试（${outcome.errors.map(message).join('; ')}）`
      })
      return
    }
    this.lastGoodBase = outcome.base
    if (outcome.kind === 'none') {
      this.available = null
      this.emit({ kind: 'not-available' })
      return
    }
    const selected = outcome
    const platform = outcome.platform
    console.info(`[updates] ${this.channel} channel offers ${selected.product} ${selected.manifest.version} (from ${selected.base})`)
    // A newer release supersedes the staged installer: what runs on quit must
    // match what the UI reports, even if this download then fails.
    this.readyInstaller = null
    this.available = { manifest: selected.manifest, platform, base: selected.base, product: selected.product }
    const version = selected.manifest.version.replace(/^v/, '')
    this.emit({ kind: 'available', version, releaseNotes: selected.manifest.notes, product: selected.product })
    this.deps.notify?.(
      selected.product === this.product ? `发现新版本 v${version}` : `正在切换到${PRODUCT_LABELS[selected.product]} v${version}`,
      '正在后台下载，退出应用时自动安装。'
    )
    // electron-updater autoDownload parity.
    await this.runDownload()
  }

  private async runDownload(): Promise<void> {
    const available = this.available
    if (!available) return
    const generation = this.generation
    const fileName = platformFileName(available.platform.url)
    if (!SAFE_FILE_NAME.test(fileName)) throw new Error(`update manifest names an unexpected installer: ${fileName}`)
    const sources = [...new Set([available.base, ...this.candidates()])]
    let lastError: unknown = null
    let signatureFailed = false
    for (const source of sources) {
      if (generation !== this.generation) return
      let data: Uint8Array
      try {
        data = await this.fetchInstaller(routeDownloadUrl(available.platform.url, source, this.directBase()), generation)
      } catch (error) {
        console.warn(`[updates] installer download from ${source} failed:`, message(error))
        lastError = error
        continue
      }
      let fields: Record<string, string>
      try {
        fields = verifyMinisign(data, available.platform.signature, this.deps.publicKey)
      } catch (error) {
        // Bytes that fail verification may come from a broken or hostile
        // mirror: discard them and try the next source.
        console.warn(`[updates] installer from ${source} failed verification:`, message(error))
        lastError = error
        signatureFailed = true
        continue
      }
      const expected = available.manifest.version.replace(/^v/, '')
      if (fields.version !== expected || fields.file !== fileName) {
        // The signature itself names another build: wrong on every source.
        this.emit({
          kind: 'error',
          message: `更新包签名校验失败，已丢弃（signature is bound to ${fields.file ?? '(none)'} ${fields.version ?? '(none)'}, manifest says ${fileName} ${expected}）`
        })
        return
      }
      if (generation !== this.generation) return
      const path = join(this.deps.downloadDir, fileName)
      await this.deps.writeFile(path, data)
      if (generation !== this.generation) return
      console.info(`[updates] verified ${fileName} ${expected}, staged at ${path}`)
      this.readyInstaller = { path, version: expected, fileName, signature: available.platform.signature, product: available.product }
      this.emit({ kind: 'downloaded' })
      this.deps.notify?.(`新版本 v${available.manifest.version.replace(/^v/, '')} 已就绪`, '退出应用时自动安装，或点击“重启并安装”立即更新。')
      return
    }
    if (generation !== this.generation) return
    this.emit({
      kind: 'error',
      message: signatureFailed
        ? `更新包签名校验失败，已丢弃（${message(lastError)}）`
        : `下载更新失败，请检查网络或稍后重试（${message(lastError)}）`
    })
  }

  private async fetchInstaller(url: string, generation: number): Promise<Uint8Array> {
    const response = await this.deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok || !response.body) throw new Error(`installer download returned HTTP ${response.status}`)
    const header = Number(response.headers.get('content-length'))
    const total = Number.isFinite(header) && header > 0 ? header : null
    if (total !== null && total > MAX_INSTALLER_BYTES) throw new Error('installer is larger than allowed')
    const chunks: Uint8Array[] = []
    let transferred = 0
    let lastEmit = 0
    const started = Date.now()
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (generation !== this.generation) {
        // The channel changed mid-download: stop, and report nothing.
        await reader.cancel()
        throw new Error('download superseded by a channel switch')
      }
      transferred += value.byteLength
      if (transferred > MAX_INSTALLER_BYTES) {
        await reader.cancel()
        throw new Error('installer is larger than allowed')
      }
      chunks.push(value)
      const now = Date.now()
      if (now - lastEmit >= 250 || (total !== null && transferred >= total)) {
        lastEmit = now
        this.emit({
          kind: 'download-progress',
          percent: total ? Math.min(100, (transferred / total) * 100) : 0,
          bytesPerSecond: Math.round(transferred / Math.max(0.001, (now - started) / 1000)),
          transferred,
          total
        })
      }
    }
    // A connection that ends early is a network failure, not a bad signature.
    if (total !== null && transferred !== total) {
      throw new Error(`installer download ended after ${transferred} of ${total} bytes`)
    }
    return Buffer.concat(chunks)
  }
}
