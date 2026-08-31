import { isAbsolute, join } from 'node:path'
import { createReadStream } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import {
  mihomoBinaryName,
  mihomoAssetFor,
  resolveMihomo,
  sha256File,
  type MihomoDownloadRequest,
  type MihomoExtractArchive,
  type ResolvedMihomoBinary
} from './mihomo-artifact'
import type { KernelBinary, KernelBinaryResolver, KernelResolveOptions } from './types'

export interface FixtureKernelResolverOptions {
  /** Absolute path of the harmless fixture script to launch with Node. */
  fixturePath: string
  /** Extra fixed arguments passed to the fixture (e.g. --stdout-ms). */
  extraArgs?: string[]
  /** Version surfaced in KernelStatus.version; null when unknown. */
  version?: string
}

/**
 * Resolves the harmonious fixture process used during the fixture milestone and
 * in development builds. It is a plain Node script that opens NO socket, so
 * lifecycle behaviour can be proven without ever executing a real kernel.
 */
export class FixtureKernelResolver implements KernelBinaryResolver {
  private readonly options: FixtureKernelResolverOptions

  constructor(options: FixtureKernelResolverOptions) {
    this.options = options
  }

  resolve(_options?: KernelResolveOptions): Promise<KernelBinary> {
    return Promise.resolve({
      command: process.execPath,
      args: [this.options.fixturePath, ...(this.options.extraArgs ?? [])],
      version: this.options.version ?? null
    })
  }
}

/**
 * Safety net for builds where kernel execution is not permitted. It never
 * resolves a real binary and always fails loudly with UNSUPPORTED.
 */
export class DisabledKernelResolver implements KernelBinaryResolver {
  async resolve(_options?: KernelResolveOptions): Promise<KernelBinary> {
    throw new ProtocolError(
      ProtocolErrorCode.UNSUPPORTED,
      'Kernel execution is disabled in this build; no real kernel is started.'
    )
  }
}

export type KernelResolverMode = 'fixture' | 'disabled'

/**
 * Builds the resolver to use for a given build mode. The fixture milestone
 * (and any development build) must only ever use the fixture resolver.
 */
export function createKernelResolver(options: {
  appPath: string
  mode: KernelResolverMode
  extraArgs?: string[]
}): KernelBinaryResolver {
  if (options.mode === 'fixture') {
    return new FixtureKernelResolver({
      fixturePath: join(options.appPath, 'src', 'main', 'testing', 'kernel-fixture.mjs'),
      extraArgs: options.extraArgs
    })
  }
  return new DisabledKernelResolver()
}

export interface MihomoKernelResolverOptions {
  /** When false (the default), resolve() throws UNSUPPORTED and never probes a
   * real binary, so the app's default lifecycle cannot accidentally execute one. */
  allowReal: boolean
  /** Node platform/arch to resolve; defaults to process.platform/process.arch. */
  platform?: string
  arch?: string
  /**
   * Absolute path of a local, pre-verified binary. `expectedSha256` is
   * mandatory whenever this is set: a bare path without a digest is refused,
   * so a user-supplied binary can never bypass the pinned verification. Only a
   * real, regular, non-symlink file whose bytes hash to `expectedSha256` is
   * accepted.
   */
  binaryPath?: string
  /** SHA-256 of the local `binaryPath` bytes; required with `binaryPath`. */
  expectedSha256?: string
  /** Version surfaced for a local `binaryPath`; defaults to null when unknown. */
  version?: string
  /** Workspace where the pinned binary is resolved/extracted. */
  workspaceDir: string
  /** Directory containing the installer-bundled, checksum-pinned archive. */
  bundledArchiveDir?: string
  /** Download/extract overrides (tests). */
  request?: MihomoDownloadRequest
  extractArchive?: MihomoExtractArchive
  /**
   * Test-only override of the pinned-resolution function. It exists purely so
   * unit tests can supply a fabricated `ResolvedMihomoBinary`; it is not wired
   * to any production config, IPC message or environment variable, so it can
   * never be triggered by an end user.
   */
  resolveMihomoOverride?: (
    platform: string,
    arch: string,
    opts: { workspaceDir: string }
  ) => Promise<ResolvedMihomoBinary>
  /**
   * Whether the kernel is enabled. When it resolves to false, resolve() throws
   * an UNSUPPORTED error so a disabled kernel never starts. Defaults to enabled.
   */
  kernelEnabled?: () => Promise<boolean>
  /**
   * The current kernel version selection. A `specific` channel with a selected
   * version routes the resolve through `ensureSpecificBinary`; otherwise the
   * pinned stable build is used. Defaults to `{ channel: 'stable' }`.
   */
  versionSelection?: () => Promise<{ channel: 'stable' | 'specific'; specificVersion: string | null }>
  /**
   * Resolve (download + verify + reuse) a specific mihomo version into its own
   * workspace. Called by the resolver only when the selected channel is
   * `specific`. Every path ends in the same byte-level archive verification.
   */
  ensureSpecificBinary?: (version: string) => Promise<ResolvedMihomoBinary>
}

/**
 * Resolves the pinned official mihomo binary for the real-kernel milestone.
 *
 * It refuses to run unless explicitly enabled via `allowReal`, so the default
 * dev/prod build still only ever resolves the fixture. When enabled, it
 * downloads + verifies the pinned build into `workspaceDir` and returns the
 * reproducible executable; the config store appends `-f <config>` at start. A
 * local `binaryPath` is only honoured when its `expectedSha256` is verified.
 */
export class MihomoKernelResolver implements KernelBinaryResolver {
  private readonly options: MihomoKernelResolverOptions

  constructor(options: MihomoKernelResolverOptions) {
    this.options = options
  }

  async resolve(_options?: KernelResolveOptions): Promise<KernelBinary> {
    if (!this.options.allowReal) {
      throw new ProtocolError(
        ProtocolErrorCode.UNSUPPORTED,
        'Real kernel execution is disabled; refusing to resolve a mihomo binary.'
      )
    }
    if (this.options.binaryPath) {
      return this.resolveLocalBinary()
    }
    const platform = this.options.platform ?? process.platform
    const arch = this.options.arch ?? process.arch
    if (this.options.kernelEnabled) {
      const enabled = await this.options.kernelEnabled()
      if (!enabled) {
        throw new ProtocolError(
          ProtocolErrorCode.UNSUPPORTED,
          '内核已停用：请在「通用」的「内核管理」中启用「启用 Smart 内核」。'
        )
      }
    }
    if (this.options.versionSelection) {
      const selection = await this.options.versionSelection()
      if (
        selection.channel === 'specific' &&
        selection.specificVersion &&
        this.options.ensureSpecificBinary
      ) {
        const bin = await this.options.ensureSpecificBinary(selection.specificVersion)
        return {
          command: bin.path,
          args: [],
          version: bin.version,
          env: { MIHOMO_PLATFORM: platform, MIHOMO_ARCH: arch }
        }
      }
    }
    const bundledRequest = await this.bundledRequest(platform, arch)
    const bin = this.options.resolveMihomoOverride
      ? await this.options.resolveMihomoOverride(platform, arch, { workspaceDir: this.options.workspaceDir })
      : await resolveMihomo(platform, arch, {
          workspaceDir: this.options.workspaceDir,
          request: this.options.request ?? bundledRequest,
          extractArchive: this.options.extractArchive
        })
    return {
      command: bin.path,
      args: [],
      version: bin.version,
      env: { MIHOMO_PLATFORM: platform, MIHOMO_ARCH: arch }
    }
  }

  private async bundledRequest(platform: string, arch: string): Promise<MihomoDownloadRequest | undefined> {
    if (!this.options.bundledArchiveDir) return undefined
    const asset = mihomoAssetFor(platform, arch)
    if (!asset) return undefined
    const archivePath = join(this.options.bundledArchiveDir, asset.filename)
    try {
      await access(archivePath)
    } catch {
      throw new ProtocolError(
        ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
        `Bundled mihomo archive is missing: ${asset.filename}`
      )
    }
    // resolveMihomo still streams, size-checks and hashes every byte before it
    // extracts anything. The installer archive is therefore not trusted merely
    // because it exists on disk.
    return async () => createReadStream(archivePath)
  }

  private async resolveLocalBinary(): Promise<KernelBinary> {
    const binPath = this.options.binaryPath as string
    const expectedSha256 = this.options.expectedSha256
    if (!expectedSha256) {
      // No digest supplied => this path is unverifiable and must be refused so a
      // local file can never bypass the pinned-verification boundary.
      throw new ProtocolError(
        ProtocolErrorCode.UNSUPPORTED,
        'binaryPath requires expectedSha256; refusing an unverified local binary'
      )
    }
    if (!isAbsolute(binPath)) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        'binaryPath must be an absolute path'
      )
    }
    let st
    try {
      st = await lstat(binPath)
    } catch {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        `binaryPath does not exist: ${binPath}`
      )
    }
    if (st.isSymbolicLink()) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        'binaryPath must not be a symlink or reparse point'
      )
    }
    if (!st.isFile()) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        'binaryPath must be a regular file'
      )
    }
    const actual = await sha256File(binPath)
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new ProtocolError(
        ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
        `binaryPath SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`
      )
    }
    const platform = this.options.platform ?? process.platform
    const arch = this.options.arch ?? process.arch
    return {
      command: binPath,
      args: [],
      version: this.options.version ?? null,
      env: { MIHOMO_PLATFORM: platform, MIHOMO_ARCH: arch }
    }
  }
}

/** Convenience: the expected executable basename for a given platform. */
export function mihomoExecutableName(platform: string): string {
  return mihomoBinaryName(platform)
}
