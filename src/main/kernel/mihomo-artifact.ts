import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

const execFileAsync = promisify(execFile)

/**
 * Pinned official mihomo release.
 *
 * Phase 7 resolves a fixed, official `MetaCubeX/mihomo` build and refuses to run
 * anything whose archive digest does not match the pinned SHA-256. The version,
 * digests and sizes below are the single source of truth; a download that does
 * not match them is rejected with ARTIFACT_HASH_MISMATCH before any binary is
 * extracted or executed. Only platforms whose digest was verified against the
 * official release are listed; unsupported platforms resolve to UNSUPPORTED
 * rather than to an unverified digest.
 */
export const MIHOMO_VERSION = 'v1.19.30'
export const MIHOMO_RELEASE_BASE =
  'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30'

/** Archive sort. `gz` is a single raw gzipped binary; `zip` is a Windows zip. */
export type MihomoArtifactKind = 'zip' | 'gz'

export interface MihomoAsset {
  /** Node `process.platform` value the asset targets. */
  platform: string
  /** Node `process.arch` value the asset targets. */
  arch: string
  /** Official asset filename, e.g. `mihomo-windows-amd64-v1.19.30.zip`. */
  filename: string
  /** Full official download URL. */
  url: string
  /** Pinned SHA-256 digest of the archive bytes. */
  sha256: string
  /** Official archive size in bytes (verified against the release). */
  size: number
  /** Archive sort. */
  kind: MihomoArtifactKind
  /** Name of the executable held inside the archive before the target rename. */
  innerName: string
}

/** Normalised arch values (Node reports `arm64`/`x64`/`x86`/`arm`/`riscv64`). */
export type MihomoArch = 'x64' | 'arm64' | 'x86' | 'arm' | 'riscv64' | string

const ASSETS: MihomoAsset[] = [
  {
    platform: 'win32',
    arch: 'x64',
    filename: 'mihomo-windows-amd64-v1.19.30.zip',
    url: `${MIHOMO_RELEASE_BASE}/mihomo-windows-amd64-v1.19.30.zip`,
    sha256: '22c09fd67673895ef7cd6b1820563918275c3d316f2462b306208675118db3c0',
    size: 18499620,
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe'
  },
  {
    platform: 'win32',
    arch: 'arm64',
    filename: 'mihomo-windows-arm64-v1.19.30.zip',
    url: `${MIHOMO_RELEASE_BASE}/mihomo-windows-arm64-v1.19.30.zip`,
    sha256: 'b37c4b0259e85b020edc4215aa4c86052e21071cf520d4800364b21b4e2fc162',
    size: 16344535,
    kind: 'zip',
    innerName: 'mihomo-windows-arm64.exe'
  },
  {
    platform: 'linux',
    arch: 'arm64',
    filename: 'mihomo-linux-arm64-v1.19.30.gz',
    url: `${MIHOMO_RELEASE_BASE}/mihomo-linux-arm64-v1.19.30.gz`,
    sha256: '58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069',
    size: 16965828,
    kind: 'gz',
    innerName: 'mihomo-linux-arm64'
  }
]

/** Resolve the pinned asset for a platform/arch pair, or null when unsupported. */
export function mihomoAssetFor(platform: string, arch: string): MihomoAsset | null {
  const asset = ASSETS.find((a) => a.platform === platform && a.arch === arch)
  return asset ?? null
}

/** All supported asset specs (used for metadata tests). */
export function mihomoAssetCatalog(): readonly MihomoAsset[] {
  return ASSETS
}

/** Convenience: `MIHOMO_VERSION` without the leading `v`. */
export function mihomoVersionNoV(): string {
  return MIHOMO_VERSION.replace(/^v/, '')
}

/** A download transport, injectable for tests. */
export type MihomoDownloadRequest = (url: string) => Promise<Readable>

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
/** Safety slack above the pinned file size before we refuse to stream. */
export const DOWNLOAD_SIZE_SLACK_BYTES = 64 * 1024

/** Stream bytes into `destFile` while hashing and capping them. */
async function writeAndHash(
  stream: Readable,
  destFile: string,
  maxBytes: number
): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(new Error(`mihomo download exceeded the ${maxBytes}-byte limit`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(stream, hashing, createWriteStream(destFile))
  return { digest: hash.digest('hex'), bytes }
}

/** HTTP GET returning a Node readable of the response body, with a hard ceiling. */
async function httpGetReadable(
  url: string,
  timeoutMs: number,
  maxBytes: number
): Promise<Readable> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      `Mihomo download request failed for ${url}: ${(error as Error).message}`
    )
  }
  if (!response.ok || !response.body) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      `Mihomo download returned HTTP ${response.status} for ${url}`
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > maxBytes) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      `Mihomo archive ${url} declares content-length ${contentLength}, above the ${maxBytes}-byte limit`
    )
  }
  return Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
}

export interface MihomoDownloadOptions {
  destDir: string
  /** Override the transport (defaults to `fetch`-backed). */
  request?: MihomoDownloadRequest
  /** Total download budget; the stream is aborted past this. Default 2m. */
  timeoutMs?: number
  /** Hard byte ceiling on the streamed archive. Defaults to size + slack. */
  maxBytes?: number
}

/**
 * Download the pinned asset, stream it to disk while computing its SHA-256, and
 * reject it unless the digest and byte size exactly match the pinned values.
 * Returns the archive path. The archive is never extracted here — extraction is
 * a separate, explicit step so a bad digest can never produce an executable.
 */
export async function downloadAndVerifyMihomo(
  asset: MihomoAsset,
  options: MihomoDownloadOptions
): Promise<string> {
  await mkdir(options.destDir, { recursive: true })
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? asset.size + DOWNLOAD_SIZE_SLACK_BYTES
  const request =
    options.request ?? ((url: string) => httpGetReadable(url, timeoutMs, maxBytes))
  const archivePath = join(options.destDir, asset.filename)
  let stream: Readable
  try {
    stream = await request(asset.url)
  } catch (error) {
    throw error instanceof ProtocolError
      ? error
      : new ProtocolError(ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED, (error as Error).message)
  }
  // A stalled/hung body must not block forever even when the transport ignores
  // our timeout: destroy the stream past the budget so `pipeline` rejects.
  const timer = setTimeout(() => {
    stream.destroy(new Error(`mihomo download timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()
  let result: { digest: string; bytes: number }
  try {
    result = await writeAndHash(stream, archivePath, maxBytes)
  } catch (error) {
    await rm(archivePath, { force: true })
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      `Failed to save mihomo archive ${asset.filename}: ${(error as Error).message}`
    )
  } finally {
    clearTimeout(timer)
  }
  if (result.digest !== asset.sha256) {
    await rm(archivePath, { force: true })
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
      `SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${result.digest}`
    )
  }
  if (result.bytes !== asset.size) {
    await rm(archivePath, { force: true })
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
      `SHA-256-matched but byte-size mismatch for ${asset.filename}: expected ${asset.size}, got ${result.bytes}`
    )
  }
  return archivePath
}

/** Zip extraction, injectable so unit tests never shell out. */
export type MihomoExtractArchive = (
  asset: MihomoAsset,
  archivePath: string,
  destDir: string
) => Promise<void>

/** Default extraction: gz via zlib; zip via `unzip`/PowerShell `Expand-Archive`. */
async function defaultExtractArchive(
  asset: MihomoAsset,
  archivePath: string,
  destDir: string
): Promise<void> {
  if (asset.kind === 'gz') {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      createWriteStream(join(destDir, asset.innerName))
    )
    return
  }
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    ])
  } else {
    await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', destDir])
  }
}

export interface MihomoExtractOptions {
  destDir: string
  archivePath: string
  /** Override archive extraction (defaults to zlib / unzip / Expand-Archive). */
  extractArchive?: MihomoExtractArchive
  /** Target executable basename (defaults to `mihomo`, `mihomo.exe` on Windows). */
  binaryName?: string
}

/** Compute the SHA-256 of a file's bytes. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** Assert `path` is a real regular file (not a symlink/reparse point). */
async function assertRegularFile(path: string, label: string): Promise<void> {
  const st = await lstat(path)
  if (st.isSymbolicLink()) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_EXTRACT_FAILED,
      `Mihomo ${label} is a symlink; refusing to use it`
    )
  }
  if (!st.isFile()) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_EXTRACT_FAILED,
      `Mihomo ${label} is not a regular file`
    )
  }
}

/**
 * Extract the verified archive into `destDir` and return the absolute path of
 * the executable. Extraction refuses to believe a member path that escapes the
 * destination directory, refuses symlinks, makes the binary executable on
 * non-Windows, and renames it to a stable basename so callers never depend on
 * the archive's internal name.
 */
export async function extractMihomo(
  asset: MihomoAsset,
  options: MihomoExtractOptions
): Promise<string> {
  await mkdir(options.destDir, { recursive: true })
  const extractArchive = options.extractArchive ?? defaultExtractArchive
  try {
    await extractArchive(asset, options.archivePath, options.destDir)
  } catch (error) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_EXTRACT_FAILED,
      `Failed to extract mihomo archive ${asset.filename}: ${(error as Error).message}`
    )
  }

  const isWin = asset.platform === 'win32' || process.platform === 'win32'
  const targetName = options.binaryName ?? (isWin ? 'mihomo.exe' : 'mihomo')
  const extractedPath = join(options.destDir, asset.innerName)
  const targetPath = join(options.destDir, targetName)

  // Guard against paths inside the archive that escaped the destination dir.
  const destRoot = resolve(options.destDir)
  const resolvedExtracted = resolve(extractedPath)
  if (resolvedExtracted !== destRoot && !resolvedExtracted.startsWith(destRoot + sep)) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_EXTRACT_FAILED,
      'Mihomo archive member escaped the extraction directory'
    )
  }
  await assertRegularFile(extractedPath, 'extracted binary')

  if (resolvedExtracted !== resolve(targetPath)) {
    await rename(resolvedExtracted, targetPath)
  }
  await assertRegularFile(targetPath, 'binary')
  if (!isWin) {
    await chmod(targetPath, 0o755)
  }
  return targetPath
}

export interface ResolvedMihomoBinary {
  /** Absolute path of the reproducible executable. */
  path: string
  /** Pinned mihomo version (without leading 'v'). */
  version: string
  /** The asset spec that was verified and used. */
  asset: MihomoAsset
  /** Archive SHA-256 that was verified. */
  sha256: string
  /** Download URL that was used. */
  url: string
  /** Whether the binary was already present and verified (no re-download). */
  reused: boolean
}

/** Structured marker proving the on-disk binary is the pinned, verified one. */
export interface MihomoVerifiedMarker {
  version: string
  archiveSha256: string
  binarySha256: string
  platform: string
  arch: string
  binary: string
}

const MARKER_FILENAME = '.mihomo-verified'
const MARKER_TMP_FILENAME = '.mihomo-verified.tmp'

/** Write the marker atomically (tmp + rename) so a crash never leaves a half marker. */
export async function writeVerifiedMarker(
  dir: string,
  marker: MihomoVerifiedMarker
): Promise<void> {
  const tmp = join(dir, MARKER_TMP_FILENAME)
  const final = join(dir, MARKER_FILENAME)
  await writeFile(tmp, JSON.stringify(marker), 'utf8')
  await rename(tmp, final)
}

/** Read + shape-check the marker; returns null when absent/malformed. */
export async function readVerifiedMarker(dir: string): Promise<MihomoVerifiedMarker | null> {
  let raw: string
  try {
    raw = await readFile(join(dir, MARKER_FILENAME), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const isObj = typeof parsed === 'object' && parsed !== null
    if (!isObj) return null
    const o = parsed as Record<string, unknown>
    if (
      typeof o.version !== 'string' ||
      typeof o.archiveSha256 !== 'string' ||
      typeof o.binarySha256 !== 'string' ||
      typeof o.platform !== 'string' ||
      typeof o.arch !== 'string' ||
      typeof o.binary !== 'string'
    ) {
      return null
    }
    return o as unknown as MihomoVerifiedMarker
  } catch {
    return null
  }
}

/**
 * Resolve the pinned mihomo for the requested platform/arch into `workspaceDir`,
 * downloading + verifying + extracting only when the on-disk binary can be
 * proven to be the pinned, verified artifact. Provenance is recorded in a
 * structured marker (version, archive + binary SHA-256, platform, arch) and the
 * binary is re-hashed on every reuse; a tampered, truncated, forged or
 * cross-platform binary is quarantined and re-resolved from a fresh verified
 * archive.
 */
export async function resolveMihomo(
  platform: string,
  arch: string,
  options: {
    workspaceDir: string
    request?: MihomoDownloadRequest
    extractArchive?: MihomoExtractArchive
    timeoutMs?: number
    maxBytes?: number
  }
): Promise<ResolvedMihomoBinary> {
  const asset = mihomoAssetFor(platform, arch)
  if (!asset) {
    throw new ProtocolError(
      ProtocolErrorCode.UNSUPPORTED,
      `No pinned mihomo artifact for ${platform}/${arch} (version ${MIHOMO_VERSION})`
    )
  }
  await mkdir(options.workspaceDir, { recursive: true })
  const isWin = asset.platform === 'win32'
  const targetName = isWin ? 'mihomo.exe' : 'mihomo'
  const markerPath = join(options.workspaceDir, MARKER_FILENAME)
  const binaryPath = join(options.workspaceDir, targetName)

  const marker = await readVerifiedMarker(options.workspaceDir)
  let reusable = false
  if (
    marker &&
    marker.version === mihomoVersionNoV() &&
    marker.archiveSha256 === asset.sha256 &&
    marker.platform === asset.platform &&
    marker.arch === asset.arch &&
    marker.binary === targetName
  ) {
    try {
      await assertRegularFile(binaryPath, 'binary')
      reusable = (await sha256File(binaryPath)) === marker.binarySha256
    } catch {
      reusable = false
    }
  }

  if (!reusable) {
    // Quarantine any stale/binary payload before a fresh download so a parallel
    // caller never executes a half-verified artifact.
    await rm(binaryPath, { force: true })
    await rm(markerPath, { force: true })
    const archivePath = await downloadAndVerifyMihomo(asset, {
      destDir: options.workspaceDir,
      request: options.request,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes
    })
    const extracted = await extractMihomo(asset, {
      destDir: options.workspaceDir,
      archivePath,
      extractArchive: options.extractArchive,
      binaryName: targetName
    })
    await writeVerifiedMarker(options.workspaceDir, {
      version: mihomoVersionNoV(),
      archiveSha256: asset.sha256,
      binarySha256: await sha256File(extracted),
      platform: asset.platform,
      arch: asset.arch,
      binary: targetName
    })
    return {
      path: extracted,
      version: mihomoVersionNoV(),
      asset,
      sha256: asset.sha256,
      url: asset.url,
      reused: false
    }
  }

  return {
    path: binaryPath,
    version: mihomoVersionNoV(),
    asset,
    sha256: asset.sha256,
    url: asset.url,
    reused: true
  }
}

/** Convenience: the target executable basename for a platform/arch. */
export function mihomoBinaryName(platform: string): string {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo'
}
