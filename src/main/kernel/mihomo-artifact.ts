import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, rename, stat, writeFile } from 'node:fs/promises'
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
 * anything whose archive digest does not match the pinned SHA-256. The version
 * and digests below are the single source of truth; a download that does not
 * match them is rejected with ARTIFACT_HASH_MISMATCH before any binary is
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
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe'
  },
  {
    platform: 'linux',
    arch: 'arm64',
    filename: 'mihomo-linux-arm64-v1.19.30.gz',
    url: `${MIHOMO_RELEASE_BASE}/mihomo-linux-arm64-v1.19.30.gz`,
    sha256: '58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069',
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

/** A download transport, injectable for tests. */
export type MihomoDownloadRequest = (url: string) => Promise<Readable>

/** Stream bytes into `destFile` while hashing them; resolve to the hex digest. */
async function writeAndHash(stream: Readable, destFile: string): Promise<string> {
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(stream, hashing, createWriteStream(destFile))
  return hash.digest('hex')
}

/** HTTP GET returning a Node readable of the response body. */
async function httpGetReadable(url: string): Promise<Readable> {
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
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
  return Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
}

export interface MihomoDownloadOptions {
  destDir: string
  /** Override the transport (defaults to `fetch`-backed). */
  request?: MihomoDownloadRequest
}

/**
 * Download the pinned asset, stream it to disk while computing its SHA-256, and
 * reject it unless the digest exactly matches the pinned value. Returns the
 * archive path. The archive is never extracted here — extraction is a separate,
 * explicit step so a bad digest can never produce an executable.
 */
export async function downloadAndVerifyMihomo(
  asset: MihomoAsset,
  options: MihomoDownloadOptions
): Promise<string> {
  await mkdir(options.destDir, { recursive: true })
  const request = options.request ?? httpGetReadable
  const archivePath = join(options.destDir, asset.filename)
  let stream: Readable
  try {
    stream = await request(asset.url)
  } catch (error) {
    throw error instanceof ProtocolError
      ? error
      : new ProtocolError(ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED, (error as Error).message)
  }
  let actual: string
  try {
    actual = await writeAndHash(stream, archivePath)
  } catch (error) {
    await rm(archivePath, { force: true })
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      `Failed to save mihomo archive ${asset.filename}: ${(error as Error).message}`
    )
  }
  if (actual !== asset.sha256) {
    await rm(archivePath, { force: true })
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
      `SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actual}`
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
    await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(join(destDir, asset.innerName)))
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

/**
 * Extract the verified archive into `destDir` and return the absolute path of
 * the executable. Extraction refuses to believe a member path that escapes the
 * destination directory, and the executable is renamed to a stable basename so
 * callers never depend on the archive's internal name.
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

  if (resolvedExtracted !== resolve(targetPath)) {
    await rename(resolvedExtracted, targetPath)
  }
  await writeFile(join(options.destDir, '.mihomo-verified'), `${asset.sha256}\n`, 'utf8')
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

/**
 * Resolve the pinned mihomo for the requested platform/arch into `workspaceDir`,
 * downloading + verifying + extracting only when the verified marker is absent.
 * The run is idempotent: once an archive passes the pinned digest and a
 * `.mihomo-verified` marker is written, later calls reuse the extracted binary
 * instead of re-downloading.
 */
export async function resolveMihomo(
  platform: string,
  arch: string,
  options: {
    workspaceDir: string
    request?: MihomoDownloadRequest
    extractArchive?: MihomoExtractArchive
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
  const verifiedMarker = join(options.workspaceDir, '.mihomo-verified')
  const binaryPath = join(options.workspaceDir, targetName)

  let existing = false
  try {
    const marker = (await readFile(verifiedMarker, 'utf8')).trim()
    await stat(binaryPath)
    existing = marker === asset.sha256
  } catch {
    existing = false
  }

  if (!existing) {
    const archivePath = await downloadAndVerifyMihomo(asset, {
      destDir: options.workspaceDir,
      request: options.request
    })
    await extractMihomo(asset, {
      destDir: options.workspaceDir,
      archivePath,
      extractArchive: options.extractArchive,
      binaryName: targetName
    })
  }

  return {
    path: binaryPath,
    version: MIHOMO_VERSION.replace(/^v/, ''),
    asset,
    sha256: asset.sha256,
    url: asset.url,
    reused: existing
  }
}

/** Convenience: the target executable basename for a platform/arch. */
export function mihomoBinaryName(platform: string): string {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo'
}
