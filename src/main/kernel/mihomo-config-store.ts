import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { KernelBinary, KernelConfig, KernelConfigStore } from './types'
import { generateMihomoConfig, randomSecret, validateMihomoConfigYaml, SECRET_PATTERN } from './mihomo-config'

export interface MihomoConfigStoreOptions {
  mixedPort: number
  controllerPort: number
  /**
   * Pin the parent that owns the per-run workspace (e.g. for tests). It is
   * treated strictly as a parent directory: the store creates an exclusive
   * `mihomo-workspace-*` child beneath it and only ever deletes that exact
   * child. The parent is never removed. Defaults to the OS temp dir.
   */
  workspaceDir?: string
}

/**
 * Materializes the strict, loopback-only mihomo config into an isolated temp
 * workspace and cleans it up afterwards.
 *
 * Safety: the written document always satisfies the Phase-7 invariants
 * (mixed-port only, allow-lan:false, mode:direct, external-controller on
 * 127.0.0.1, tun.enable:false, dns.enable:false, rules MATCH,DIRECT). Cleanup
 * deletes exactly the per-run child the store created and refuses to touch any
 * other path, including the caller-provided parent.
 */
export class MihomoKernelConfigStore implements KernelConfigStore {
  /** The exact directory this store created; unknown until materialize runs. */
  private ownedDir: string | null = null

  constructor(private readonly options: MihomoConfigStoreOptions) {}

  async materialize(_binary: KernelBinary, secret?: string): Promise<KernelConfig> {
    // Always materialize into an exclusive child. `workspaceDir` (if given) is a
    // parent; the caller's own files under it must survive a later cleanup.
    const parent = this.options.workspaceDir
      ? await mkdir(this.options.workspaceDir, { recursive: true }).then(() => this.options.workspaceDir!)
      : tmpdir()
    const rootDir = await mkdtemp(join(parent, 'mihomo-workspace-'))
    this.ownedDir = rootDir
    const configPath = join(rootDir, 'config.yaml')
    // Prefer a passed secret only when it is already a valid 64-hex token;
    // otherwise mint a fresh high-entropy one so a caller can never inject a
    // malformed or non-conforming bearer token.
    const effectiveSecret = secret && SECRET_PATTERN.test(secret) ? secret : randomSecret(32)
    const configText = generateMihomoConfig({
      mixedPort: this.options.mixedPort,
      controllerPort: this.options.controllerPort,
      secret: effectiveSecret
    })
    // Fail closed before writing: never persist a config that leaks a listener
    // beyond loopback or mutates the system network.
    validateMihomoConfigYaml(configText)
    await writeFile(configPath, configText, 'utf8')
    return {
      configPath,
      rootDir,
      args: ['-f', configPath, '-d', rootDir],
      env: { MIHOMO_PLATFORM: process.platform, MIHOMO_ARCH: process.arch }
    }
  }

  async cleanup(config: KernelConfig): Promise<void> {
    // Only ever delete the exact child this store created. Anything else (the
    // parent passed in, a config the store did not materialize, or a path
    // outside the workspace) is left untouched.
    if (!this.ownedDir) return
    const owned = resolve(this.ownedDir)
    const root = resolve(config.rootDir)
    if (root !== owned) return
    const child = resolve(config.configPath)
    if (child !== owned && !child.startsWith(owned + sep)) return
    await rm(owned, { recursive: true, force: true })
    this.ownedDir = null
  }
}

/**
 * Reserve and return a free loopback TCP port, so a caller can bind mihomo's
 * mixed port and external controller without colliding with an in-use port.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}
