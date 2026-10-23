import { join } from 'node:path'
import { verifyMinisign } from './minisign'
import type { UpdaterDriver, UpdaterDriverEvent } from './updater-driver'

/**
 * {@link UpdaterDriver} for the signed release manifest (`latest.json`) the
 * Tauri build publishes. This is the last Electron release's way across:
 * it finds the Tauri setup exe in the manifest, downloads it through the same
 * direct-or-mirror source the manifest came from, and accepts it only when
 * its minisign signature verifies against the pinned release key AND names
 * the announced version and file. Mirrors therefore carry bytes but cannot
 * substitute or roll back an installer (review item S1).
 *
 * The verified installer is launched from {@link dispose}, which the ordered
 * quit flow calls after it has restored the system proxy and stopped the
 * kernel — electron-updater's `autoInstallOnAppQuit` timing. The installer
 * takes over the Electron installation itself (keeps service and data).
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
/** Installer arguments: passive progress UI, relaunch the app afterwards. */
export const INSTALLER_ARGS: readonly string[] = ['/P', '/R']
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/

/** The updater's `{{target}}-{{arch}}` platform keys. */
const PLATFORM_KEYS: Readonly<Record<string, string>> = { x64: 'windows-x86_64', arm64: 'windows-aarch64' }

export interface SignedManifestDeps {
  currentVersion: string
  supported: boolean
  /** `process.arch` of the running build. */
  arch: string
  /** Pinned release public key (base64 minisign `.pub`). */
  publicKey: string
  /** Ordered feed bases, last-known-good handling is internal. */
  feedBases: readonly string[]
  /** Direct GitHub base, used to route asset downloads through a mirror. */
  directBase: string
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

/** A GitHub asset URL routed through the mirror prefix of `feedBase`, if any. */
/** True when `downloadUrl` is one of this repository's release assets. */
export function isReleaseAsset(downloadUrl: string, directBase: string): boolean {
  const suffix = '/releases/latest/download'
  if (!directBase.endsWith(suffix)) return false
  const repository = directBase.slice(0, -suffix.length)
  let url: URL
  try {
    url = new URL(downloadUrl)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname === 'github.com' && url.port === '' && url.search === '' &&
    url.href.startsWith(`${repository}/releases/download/`)
}

export function routeDownloadUrl(downloadUrl: string, feedBase: string, directBase: string): string {
  if (!feedBase.endsWith(directBase)) return downloadUrl
  const prefix = feedBase.slice(0, feedBase.length - directBase.length).replace(/\/+$/, '')
  if (!prefix || !downloadUrl.startsWith('https://github.com/')) return downloadUrl
  return `${prefix}/${downloadUrl}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SignedManifestUpdaterDriver implements UpdaterDriver {
  readonly currentVersion: string
  readonly supported: boolean
  private readonly listeners = new Set<(event: UpdaterDriverEvent) => void>()
  private lastGoodBase: string | null = null
  private available: { manifest: Manifest; platform: ManifestPlatform; base: string } | null = null
  /** The verified installer awaiting quit, with what it was verified as. */
  private readyInstaller: { path: string; version: string; fileName: string; signature: string } | null = null
  private busy = false

  constructor(private readonly deps: SignedManifestDeps) {
    this.currentVersion = deps.currentVersion
    this.supported = deps.supported && deps.publicKey.trim().length > 0 && Boolean(PLATFORM_KEYS[deps.arch])
  }

  configure(): void {}

  check(): void {
    if (!this.supported || this.busy) return
    this.busy = true
    void this.runCheck()
      .catch((error) => this.emit({ kind: 'error', message: message(error) }))
      .finally(() => { this.busy = false })
  }

  download(): void {
    if (!this.supported || this.busy || !this.available) return
    this.busy = true
    void this.runDownload()
      .catch((error) => this.emit({ kind: 'error', message: message(error) }))
      .finally(() => { this.busy = false })
  }

  quitAndInstall(): void {
    if (!this.supported || !this.readyInstaller) return
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
      this.deps.launchInstaller(installer.path, INSTALLER_ARGS)
    } catch (error) {
      console.error('[updates] failed to launch the installer:', error)
    }
  }

  private emit(event: UpdaterDriverEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private candidates(): string[] {
    return [...new Set([...(this.lastGoodBase ? [this.lastGoodBase] : []), ...this.deps.feedBases])]
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
  private async probe(base: string, signal: AbortSignal): Promise<{ manifest: Manifest; platform: ManifestPlatform } | null> {
    let manifest: Manifest
    try {
      manifest = (await this.fetchManifest(base, signal)).manifest
    } catch (error) {
      if (error instanceof FeedNotFound) return null
      throw error
    }
    const platform = manifest.platforms[PLATFORM_KEYS[this.deps.arch]!]
    if (!platform || !isNewerVersion(manifest.version, this.currentVersion)) return null
    // Already downloaded and waiting for quit: nothing new to fetch.
    if (this.readyInstaller && !isNewerVersion(manifest.version, this.readyInstaller.version)) return null
    // The manifest is unsigned: never let it point the client at anything
    // but this repository's release assets.
    if (!isReleaseAsset(platform.url, this.deps.directBase)) {
      throw new Error(`update manifest points outside the release: ${platform.url}`)
    }
    return { manifest, platform }
  }

  private async runCheck(): Promise<void> {
    this.emit({ kind: 'checking' })
    const bases = this.candidates()
    const controller = new AbortController()
    type Outcome =
      | { kind: 'offer'; base: string; manifest: Manifest; platform: ManifestPlatform }
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
    // A newer release supersedes the staged installer: what runs on quit must
    // match what the UI reports, even if this download then fails.
    this.readyInstaller = null
    this.available = { manifest: selected.manifest, platform, base: selected.base }
    const version = selected.manifest.version.replace(/^v/, '')
    this.emit({ kind: 'available', version, releaseNotes: selected.manifest.notes })
    this.deps.notify?.(`发现新版本 v${version}`, '正在后台下载，退出应用时自动安装。')
    // electron-updater autoDownload parity.
    await this.runDownload()
  }

  private async runDownload(): Promise<void> {
    const available = this.available
    if (!available) return
    const fileName = decodeURIComponent(new URL(available.platform.url).pathname.split('/').pop() ?? '')
    if (!SAFE_FILE_NAME.test(fileName)) throw new Error(`update manifest names an unexpected installer: ${fileName}`)
    const sources = [...new Set([available.base, ...this.candidates()])]
    let lastError: unknown = null
    let signatureFailed = false
    for (const source of sources) {
      let data: Uint8Array
      try {
        data = await this.fetchInstaller(routeDownloadUrl(available.platform.url, source, this.deps.directBase))
      } catch (error) {
        lastError = error
        continue
      }
      let fields: Record<string, string>
      try {
        fields = verifyMinisign(data, available.platform.signature, this.deps.publicKey)
      } catch (error) {
        // Bytes that fail verification may come from a broken or hostile
        // mirror: discard them and try the next source.
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
      const path = join(this.deps.downloadDir, fileName)
      await this.deps.writeFile(path, data)
      this.readyInstaller = { path, version: expected, fileName, signature: available.platform.signature }
      this.emit({ kind: 'downloaded' })
      this.deps.notify?.(`新版本 v${available.manifest.version.replace(/^v/, '')} 已就绪`, '退出应用时自动安装，或点击“重启并安装”立即更新。')
      return
    }
    this.emit({
      kind: 'error',
      message: signatureFailed
        ? `更新包签名校验失败，已丢弃（${message(lastError)}）`
        : `下载更新失败，请检查网络或稍后重试（${message(lastError)}）`
    })
  }

  private async fetchInstaller(url: string): Promise<Uint8Array> {
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
    return Buffer.concat(chunks)
  }
}
