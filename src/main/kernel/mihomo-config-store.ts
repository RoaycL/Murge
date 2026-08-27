import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { KernelBinary, KernelConfig, KernelConfigStore } from './types'
import { generateMihomoConfig, randomSecret, validateMihomoConfigYaml } from './mihomo-config'

export interface MihomoConfigStoreOptions {
  mixedPort: number
  controllerPort: number
  /** Pin the workspace location (e.g. for tests); defaults to a fresh temp dir. */
  workspaceDir?: string
}

/**
 * Materializes the strict, loopback-only mihomo config into an isolated temp
 * workspace and cleans it up afterwards.
 *
 * Safety: the written document always satisfies the Phase-7 invariants
 * (mixed-port only, allow-lan:false, mode:direct, external-controller on
 * 127.0.0.1, tun.enable:false, dns.enable:false, rules MATCH,DIRECT). Cleanup
 * refuses to delete any path outside the workspace this store created.
 */
export class MihomoKernelConfigStore implements KernelConfigStore {
  constructor(private readonly options: MihomoConfigStoreOptions) {}

  async materialize(_binary: KernelBinary, secret?: string): Promise<KernelConfig> {
    const rootDir = this.options.workspaceDir
      ? await mkdir(this.options.workspaceDir, { recursive: true }).then(() => this.options.workspaceDir!)
      : await mkdtemp(join(tmpdir(), 'mihomo-workspace-'))
    const configPath = join(rootDir, 'config.yaml')
    // Prefer a passed secret; fall back to a fresh high-entropy one so a caller
    // that omits it still gets a non-empty, unguessable bearer token.
    const effectiveSecret = secret && secret.length >= 16 ? secret : randomSecret(32)
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
    const root = resolve(config.rootDir)
    const child = resolve(config.configPath)
    // Never delete outside the workspace this store created.
    if (child !== root && !child.startsWith(root + sep)) return
    await rm(root, { recursive: true, force: true })
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
