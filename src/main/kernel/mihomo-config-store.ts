import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type { KernelBinary, KernelConfig, KernelConfigStore } from './types'
import type { CoreSettings } from '@shared/core-settings'
import { generateMihomoConfig, validateMihomoConfigYaml, SECRET_PATTERN } from './mihomo-config'
import { buildProfileKernelConfig, profileKernelConfigErrors } from './profile-kernel-config'

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
  /**
   * Resolve the active profile's raw YAML document. When it returns a document
   * the kernel runs the profile's proxies/groups/rules (with only the app-critical
   * listener/auth keys forced); when it returns null the store falls back to the
   * strict loopback-only direct config. Omitted entirely, this store never leaves
   * the strict Phase-7 behavior (preserving the legacy milestone).
   */
  resolveActiveDocument?: () => Promise<string | null>
  /**
   * Resolve the controlled mihomo core settings to fold into the profile-backed
   * runtime config. When it returns an `enabled` model, the allowlisted core keys
   * become authoritative (read-back) and override the profile's own values
   * (conflict handling); when `disabled` the profile is preserved. Omitted
   * entirely, the store never applies controlled core settings.
   */
  resolveCore?: () => Promise<CoreSettings>
}

/**
 * Materializes the runtime mihomo config into an isolated temp workspace and
 * cleans it up afterwards.
 *
 * When `resolveActiveDocument` is provided and returns an active profile, the
 * written document is the profile's proxies/groups/rules transformed by
 * {@link buildProfileKernelConfig}: content is preserved while the main-kernel
 * safety invariants are enforced (mixed-port only on the allocated non-privileged
 * port, allow-lan:false, external-controller on 127.0.0.1, no TUN, no public
 * listeners/DNS, caller's secret). When no active profile exists the strict
 * loopback-only direct config (tun.enable:false, dns.enable:false, MATCH,DIRECT)
 * is written instead. Cleanup deletes exactly the per-run child the store created
 * and refuses to touch any other path, including the caller-provided parent. The
 * strict fallback pins mode:direct; the profile path pins mode:rule so the
 * profile's rules actually take effect.
 */
export class MihomoKernelConfigStore implements KernelConfigStore {
  /** The exact directory this store created; unknown until materialize runs. */
  private ownedDir: string | null = null

  constructor(private readonly options: MihomoConfigStoreOptions) {}

  async materialize(_binary: KernelBinary, secret: string): Promise<KernelConfig> {
    // (1) Run EVERY filesystem-independent validation FIRST. The secret, the
    // generated config and the YAML schema are all validated before any
    // directory is created, so an invalid secret or config never leaves a
    // stale `mihomo-workspace-*` child behind on failure. This matters because
    // a failed materialize returns no KernelConfig, so the supervisor can never
    // call cleanup(config) to remove the just-created directory.
    //
    // The secret is the shared auth contract between the supervisor, the config
    // document and the controller client. It is generated exactly once at the
    // composition root and must arrive here as a valid 64-hex token: an absent or
    // malformed secret is a programming error and must fail closed, not be
    // silently replaced with a secret the caller never sees (which would split
    // the config auth from the client auth and break /version + WS auth).
    if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        'Mihomo controller secret must be a 64-character lowercase hex string'
      )
    }
    const built = await this.buildConfigText(secret)
    // Fail closed before writing: never persist a config that leaks a listener
    // beyond loopback or mutates the system network.
    if (built.fromProfile) {
      const profileErrors = profileKernelConfigErrors(built.text)
      if (profileErrors.length > 0) {
        throw new ProtocolError(
          ProtocolErrorCode.INVALID_ARGUMENT,
          `配置文件构建失败：${profileErrors.join('；')}`
        )
      }
    } else {
      validateMihomoConfigYaml(built.text)
    }

    // (2) Only now create the exclusive child. `workspaceDir` (if given) is a
    // parent; the caller's own files under it must survive a later cleanup.
    const parent = this.options.workspaceDir
      ? await mkdir(this.options.workspaceDir, { recursive: true }).then(() => this.options.workspaceDir!)
      : tmpdir()
    const rootDir = await mkdtemp(join(parent, 'mihomo-workspace-'))
    this.ownedDir = rootDir
    const configPath = join(rootDir, 'config.yaml')

    // (3) Anything that can fail AFTER the child exists (the config write) must
    // remove exactly that child before rethrowing the original error. The
    // caller-provided parent — and any pre-existing file inside it — is never
    // touched.
    try {
      await writeFile(configPath, built.text, 'utf8')
    } catch (error) {
      await this.removeOwnedDir()
      throw error
    }
    return {
      configPath,
      rootDir,
      args: ['-f', configPath, '-d', rootDir],
      env: { MIHOMO_PLATFORM: process.platform, MIHOMO_ARCH: process.arch }
    }
  }

  /**
   * Build the config document to write. When an active-profile resolver is
   * configured and returns a document, the profile's proxies/groups/rules are
   * used with only the app-critical listener/auth keys forced (fromProfile=true).
   * Otherwise the strict loopback-only direct config is generated (fromProfile=false).
   */
  private async buildConfigText(secret: string): Promise<{ text: string; fromProfile: boolean }> {
    const resolve = this.options.resolveActiveDocument
    if (resolve) {
      const document = await resolve()
      if (document) {
        const core = this.options.resolveCore ? await this.options.resolveCore() : undefined
        return {
          text: buildProfileKernelConfig(document, {
            mixedPort: this.options.mixedPort,
            controllerPort: this.options.controllerPort,
            secret,
            core
          }),
          fromProfile: true
        }
      }
    }
    return {
      text: generateMihomoConfig({
        mixedPort: this.options.mixedPort,
        controllerPort: this.options.controllerPort,
        secret
      }),
      fromProfile: false
    }
  }

  /**
   * Delete the exact per-run child this store created and clear the ownership
   * marker. Used only when materialize() fails AFTER creating the child but
   * BEFORE returning a KernelConfig (so the supervisor has nothing to hand to
   * cleanup()). Best-effort; never touches the caller-provided parent.
   */
  private async removeOwnedDir(): Promise<void> {
    const dir = this.ownedDir
    this.ownedDir = null
    if (!dir) return
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best effort — the original materialize() error is what propagates.
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
