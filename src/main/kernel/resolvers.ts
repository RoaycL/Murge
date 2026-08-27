import { join } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import {
  MIHOMO_VERSION,
  mihomoBinaryName,
  resolveMihomo,
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
  /** Pre-resolved binary path (skips download/extract). */
  binaryPath?: string
  /** Version surfaced when binaryPath is supplied directly. */
  version?: string
  /** Workspace where the pinned binary is resolved/extracted. */
  workspaceDir: string
  /** Download/extract overrides (tests). */
  request?: MihomoDownloadRequest
  extractArchive?: MihomoExtractArchive
  /** Override the pinned-resolution function (tests). Defaults to `resolveMihomo`. */
  resolveMihomo?: (platform: string, arch: string, opts: { workspaceDir: string }) => Promise<ResolvedMihomoBinary>
}

/**
 * Resolves the pinned official mihomo binary for the real-kernel milestone.
 *
 * It refuses to run unless explicitly enabled via `allowReal`, so the default
 * dev/prod build still only ever resolves the fixture. When enabled, it
 * downloads + verifies the pinned build into `workspaceDir` and returns the
 * reproducible executable; the config store appends `-f <config>` at start.
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
    const workspaceDir = this.options.workspaceDir
    if (this.options.binaryPath) {
      return {
        command: this.options.binaryPath,
        args: [],
        version: this.options.version ?? MIHOMO_VERSION.replace(/^v/, ''),
        env: { ...(this.options.platform ? { MIHOMO_PLATFORM: this.options.platform } : {}) }
      }
    }
    const platform = this.options.platform ?? process.platform
    const arch = this.options.arch ?? process.arch
    const bin = this.options.resolveMihomo
      ? await this.options.resolveMihomo(platform, arch, { workspaceDir })
      : await resolveMihomo(platform, arch, {
          workspaceDir,
          request: this.options.request,
          extractArchive: this.options.extractArchive
        })
    return {
      command: bin.path,
      args: [],
      version: bin.version,
      env: { MIHOMO_PLATFORM: platform, MIHOMO_ARCH: arch }
    }
  }
}

/** Convenience: the expected executable basename for a given platform. */
export function mihomoExecutableName(platform: string): string {
  return mihomoBinaryName(platform)
}
