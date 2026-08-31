import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import {
  buildMihomoAssetFromRelease,
  MIHOMO_VERSION,
  resolveMihomoAsset,
  type MihomoAsset,
  type MihomoReleaseAsset,
  type ResolvedMihomoBinary
} from './mihomo-artifact'
import type { AppSettingsGateway, KernelManagerGateway } from '@shared/gateways'
import { coerceKernelManagerState, type KernelManagerState } from '@shared/kernel-manager'

const MIHOMO_OWNER = 'MetaCubeX'
const MIHOMO_REPO = 'mihomo'
const GITHUB_API_BASE = 'https://api.github.com/repos'
const ASSET_FILENAME = '.mihomo-asset.json'
const VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/

/** GitHub release metadata subset relevant to a mihomo asset. */
export interface GithubRelease {
  tag_name: string
  assets: Array<{
    name: string
    digest?: string | null
    size?: number
    browser_download_url: string
  }>
}

export interface KernelManagerServiceDeps {
  /** Persisted durable choices (enabled / channel / specific version). */
  settings: AppSettingsGateway
  /** Directory that owns the `versions/<version>` workspaces. */
  workspaceRoot: string
  /** Target platform/arch; default to process.{platform,arch}. */
  platform?: string
  arch?: string
  /** The built-in stable version. Defaults to the pinned manifest version. */
  stableVersion?: string
  /** Fetch published version tags. Defaults to the live GitHub releases API. */
  fetchVersions?: () => Promise<string[]>
  /** Fetch one release's asset metadata. Defaults to the live GitHub API. */
  fetchReleaseAssets?: (version: string) => Promise<MihomoReleaseAsset[]>
  /** Resolve (download + verify + reuse) an asset into a per-version workspace. */
  resolveAsset?: (asset: MihomoAsset, workspaceDir: string) => Promise<ResolvedMihomoBinary>
}

interface TransientState {
  versions: string[]
  versionsLoading: boolean
  installing: string | null
  error: string | null
}

/**
 * Main-process kernel manager. It owns the durable kernel choices through the
 * settings gateway and the transient version/install state (published to the
 * renderer over `kernel-manager:state-event`).
 *
 * Version safety: every specific-version install goes through the same
 * byte-level archive verification as the stable build. The SHA-256 + size used
 * are what the upstream release publishes for the asset, so a selected version
 * can never ship an unverified payload.
 */
export class KernelManagerService implements KernelManagerGateway {
  private readonly deps: KernelManagerServiceDeps
  private readonly state: TransientState = {
    versions: [],
    versionsLoading: false,
    installing: null,
    error: null
  }
  private readonly listeners = new Set<(state: KernelManagerState) => void>()

  constructor(deps: KernelManagerServiceDeps) {
    this.deps = deps
  }

  async getState(): Promise<KernelManagerState> {
    return this.buildState()
  }

  async setEnabled(enabled: boolean): Promise<KernelManagerState> {
    await this.deps.settings.set({ kernelEnabled: enabled })
    return this.commit()
  }

  async setChannel(channel: 'stable' | 'specific'): Promise<KernelManagerState> {
    await this.deps.settings.set({ kernelChannel: channel })
    return this.commit()
  }

  async listVersions(): Promise<KernelManagerState> {
    this.state.versionsLoading = true
    this.state.error = null
    this.emit(await this.buildState())
    try {
      const versions = await this.fetchVersions()
      this.state.versions = versions
    } catch (error) {
      this.state.error = this.errorMessage(error, '获取版本列表失败')
    } finally {
      this.state.versionsLoading = false
    }
    return this.commit()
  }

  async install(version: string): Promise<KernelManagerState> {
    if (!VERSION_TAG_RE.test(version)) {
      this.state.error = `无效的版本号：${version}`
      return this.commit()
    }
    this.state.installing = version
    this.state.error = null
    this.emit(await this.buildState())
    try {
      const asset = await this.resolveVersionAsset(version)
      await this.resolveAsset(asset, this.versionWorkspaceDir(version))
      await this.deps.settings.set({ kernelChannel: 'specific', kernelSpecificVersion: version })
    } catch (error) {
      this.state.error = this.errorMessage(error, `安装 ${version} 失败`)
    } finally {
      this.state.installing = null
    }
    return this.commit()
  }

  onState(listener: (state: KernelManagerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Resolve a specific version's binary (download + verify + reuse). This is the
   * callback the kernel resolver uses at start time so a selected specific build
   * is resolved the same way as the stable one — never trusting an on-disk file.
   */
  async ensureVersionBinary(version: string): Promise<ResolvedMihomoBinary> {
    const asset = await this.resolveVersionAsset(version)
    return this.resolveAsset(asset, this.versionWorkspaceDir(version))
  }

  /** The gate consulted by the kernel resolver before it resolves/start. */
  async isEnabled(): Promise<boolean> {
    const settings = await this.deps.settings.get()
    return settings.kernelEnabled
  }

  /** The version selection consulted by the kernel resolver. */
  async getVersionSelection(): Promise<{ channel: 'stable' | 'specific'; specificVersion: string | null }> {
    const settings = await this.deps.settings.get()
    const specificVersion =
      settings.kernelSpecificVersion && settings.kernelSpecificVersion.trim()
        ? settings.kernelSpecificVersion
        : null
    return { channel: settings.kernelChannel, specificVersion }
  }

  private versionWorkspaceDir(version: string): string {
    return join(this.deps.workspaceRoot, 'versions', version.replace(/^v/, ''))
  }

  private async buildState(): Promise<KernelManagerState> {
    const settings = await this.deps.settings.get()
    const stableVersion = this.deps.stableVersion ?? MIHOMO_VERSION
    const specificVersion =
      settings.kernelSpecificVersion && settings.kernelSpecificVersion.trim()
        ? settings.kernelSpecificVersion
        : null
    const channel = settings.kernelChannel
    const effectiveVersion =
      channel === 'specific' && specificVersion ? specificVersion : stableVersion
    const state: KernelManagerState = {
      enabled: settings.kernelEnabled,
      channel,
      stableVersion,
      specificVersion,
      effectiveVersion,
      versions: this.state.versions,
      versionsLoading: this.state.versionsLoading,
      installing: this.state.installing,
      error: this.state.error
    }
    return coerceKernelManagerState(state)
  }

  private async commit(): Promise<KernelManagerState> {
    const state = await this.buildState()
    this.emit(state)
    return state
  }

  private emit(state: KernelManagerState): void {
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        // A stale listener must never take the service down.
      }
    }
  }

  /**
   * Return the asset spec for a version. On first use it fetches the release
   * metadata and caches the spec as a sidecar next to the version workspace so a
   * later start (or the resolver) can reuse the same verified digest offline.
   */
  private async resolveVersionAsset(version: string): Promise<MihomoAsset> {
    const workspaceDir = this.versionWorkspaceDir(version)
    const sidecarPath = join(workspaceDir, ASSET_FILENAME)
    try {
      const cached = JSON.parse(await readFile(sidecarPath, 'utf8')) as MihomoAsset
      if (
        cached &&
        typeof cached.filename === 'string' &&
        typeof cached.sha256 === 'string' &&
        cached.sha256.length === 64
      ) {
        return { ...cached, version }
      }
    } catch {
      // No cached spec yet; fall through to fetch.
    }
    const platform = this.deps.platform ?? process.platform
    const arch = this.deps.arch ?? process.arch
    const assets = await this.fetchReleaseAssets(version)
    let asset: MihomoAsset | null = null
    for (const releaseAsset of assets) {
      asset = buildMihomoAssetFromRelease(version, platform, arch, releaseAsset)
      if (asset) break
    }
    if (!asset) {
      throw new ProtocolError(
        ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
        `未找到 ${platform}/${arch} 的 mihomo ${version} 资产`
      )
    }
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(sidecarPath, JSON.stringify(asset), 'utf8')
    return asset
  }

  private async resolveAsset(asset: MihomoAsset, workspaceDir: string): Promise<ResolvedMihomoBinary> {
    if (this.deps.resolveAsset) return this.deps.resolveAsset(asset, workspaceDir)
    return resolveMihomoAsset(asset, { workspaceDir })
  }

  private fetchVersions(): Promise<string[]> {
    if (this.deps.fetchVersions) return this.deps.fetchVersions()
    return this.fetchGithubVersions()
  }

  private fetchReleaseAssets(version: string): Promise<MihomoReleaseAsset[]> {
    if (this.deps.fetchReleaseAssets) return this.deps.fetchReleaseAssets(version)
    return this.fetchGithubReleaseAssets(version)
  }

  private async fetchGithubVersions(): Promise<string[]> {
    const url = `${GITHUB_API_BASE}/${MIHOMO_OWNER}/${MIHOMO_REPO}/releases?per_page=50`
    const releases = (await this.githubRequest(url)) as GithubRelease[]
    const tags = releases.map((release) => release.tag_name).filter((tag) => VERSION_TAG_RE.test(tag))
    return tags
  }

  private async fetchGithubReleaseAssets(version: string): Promise<MihomoReleaseAsset[]> {
    const url = `${GITHUB_API_BASE}/${MIHOMO_OWNER}/${MIHOMO_REPO}/releases/tags/${version}`
    const release = (await this.githubRequest(url)) as GithubRelease
    return release.assets.map((asset) => ({
      name: asset.name,
      digest: asset.digest ?? null,
      size: typeof asset.size === 'number' ? asset.size : undefined,
      browser_download_url: asset.browser_download_url
    }))
  }

  private async githubRequest(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'mihomo-kernel-manager'
      }
    })
    if (!response.ok) {
      throw new ProtocolError(ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED, `GitHub 请求失败：${response.status}`)
    }
    return response.json()
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ProtocolError) return error.message
    if (error instanceof Error) return error.message || fallback
    return fallback
  }
}
