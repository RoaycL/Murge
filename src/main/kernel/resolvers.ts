import { join } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
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
