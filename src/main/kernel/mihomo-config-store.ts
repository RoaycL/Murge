import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type { KernelBinary, KernelConfig, KernelConfigStore } from './types'
import type { CoreSettings } from '@shared/core-settings'
import type { GeodataSettings } from '@shared/geodata'
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
  /**
   * Resolve the controlled mihomo geodata settings to fold into the profile-backed
   * runtime config. When it returns an `enabled` model, the allowlisted geodata
   * keys become authoritative (read-back) and override the profile's own values
   * (conflict handling); when `disabled` the profile is preserved. Omitted
   * entirely, the store never applies controlled geodata settings.
   */
  resolveGeodata?: () => Promise<GeodataSettings>
  /**
   * Persistent kernel home passed to mihomo as `-d`. Geodata databases and
   * provider caches resolve here and MUST survive restarts (a per-run temp
   * home forces an online geodata download on every start, which fails before
   * any proxy exists and blocks startup). When omitted, the per-run workspace
   * keeps the historical temp behavior (dev fixtures and existing tests).
   */
  kernelHomeDir?: string
  /**
   * Directory holding geodata databases shipped with the installer
   * (`geosite.dat`, `geoip.dat`, ...). When set (production), every seed file
   * found here is copied into the persistent kernel home on materialize so the
   * kernel never needs its first-run online geodata download. Omitted (tests,
   * fixtures), seeding is skipped entirely.
   */
  seedResourcesDir?: string
}

/**
 * Databases the kernel resolves from its home directory (`-d`). A profile rule
 * such as `GEOSITE,CN,DIRECT` cannot start the kernel without `geosite.dat`;
 * when the file is missing mihomo tries to download it online — which fails
 * before any proxy exists (no DNS to resolve the download host yet), turning a
 * missing file into a full startup block. Seeding these from the installer and
 * keeping them in a persistent home removes that dependency entirely.
 */
const GEODATA_SEED_FILES = ['geosite.dat', 'geoip.dat', 'geoip.metadb', 'country.mmdb', 'ASN.mmdb'] as const

/**
 * Copy installer-shipped geodata into the kernel home. Per-file best effort:
 * one unreadable seed must never block a start that could otherwise succeed;
 * the kernel's own download path remains as the fallback. Returns the names of
 * the files actually placed (used for diagnostics).
 */
export async function seedGeodataFiles(homeDir: string, resourcesDir: string): Promise<string[]> {
  const seeded: string[] = []
  let entries: string[]
  try {
    entries = await readdir(resourcesDir)
  } catch {
    // No seed dir (dev checkout, partial install): nothing to seed.
    return seeded
  }
  await mkdir(homeDir, { recursive: true })
  for (const name of GEODATA_SEED_FILES) {
    if (!entries.includes(name)) continue
    const target = join(homeDir, name)
    try {
      // Refresh when the installer carries a newer build than the kept copy. A
      // missing kept copy is the expected FIRST-RUN case, not an error.
      const [source, existing] = await Promise.all([
        stat(join(resourcesDir, name)),
        stat(target).then(
          (value) => value,
          () => null
        )
      ])
      if (existing?.isFile() && existing.mtimeMs >= source.mtimeMs) continue
      await copyFile(join(resourcesDir, name), target)
      seeded.push(name)
    } catch {
      // Best effort per file: keep whatever copy already exists.
    }
  }
  return seeded
}

/**
 * Materializes the runtime mihomo config and cleans up the per-run config
 * file afterwards.
 *
 * The kernel home (`-d`) is a STABLE directory that is never deleted: mihomo
 * resolves geodata databases and writes provider caches relative to it, and a
 * profile rule like `GEOSITE,CN,DIRECT` cannot start the kernel without
 * `geosite.dat`. A per-run temp home would force a fresh online geodata
 * download on every start — which fails before any proxy exists (no DNS to
 * resolve the download host yet) and blocks startup entirely. The stable home
 * keeps a successfully fetched or installer-seeded database forever.
 *
 * When `resolveActiveDocument` is provided and returns an active profile, the
 * written document is the profile's proxies/groups/rules transformed by
 * {@link buildProfileKernelConfig}: content is preserved while the main-kernel
 * safety invariants are enforced (mixed-port only on the allocated non-privileged
 * port, allow-lan:false, external-controller on 127.0.0.1, no TUN, no public
 * listeners/DNS, caller's secret). When no active profile exists the strict
 * loopback-only direct config (tun.enable:false, dns.enable:false, MATCH,DIRECT)
 * is written instead.
 *
 * The config document itself lives in a per-run `mihomo-workspace-*` sibling
 * (created under the same parent as the kernel home) and is deleted on
 * cleanup() exactly as before — only the disposable file the store created is
 * removed; the kernel home and every database in it are left untouched.
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

    // (2) Only now create the exclusive per-run child plus the persistent home.
    // `workspaceDir` (if given) is a parent; the caller's own files under it
    // must survive a later cleanup.
    const parent = this.options.workspaceDir
      ? await mkdir(this.options.workspaceDir, { recursive: true }).then(() => this.options.workspaceDir!)
      : tmpdir()
    const rootDir = await mkdtemp(join(parent, 'mihomo-workspace-'))
    this.ownedDir = rootDir
    const configPath = join(rootDir, 'config.yaml')
    // The kernel home is a stable sibling: it holds the geodata databases and
    // provider caches that must survive restarts, so it is NEVER cleaned up.
    // Without a configured home the per-run dir keeps the historical behavior
    // (fixture/dev runs and every existing test).
    const homeDir = this.options.kernelHomeDir
      ? await mkdir(this.options.kernelHomeDir, { recursive: true }).then(() => this.options.kernelHomeDir!)
      : rootDir
    let seeded: string[] = []
    if (this.options.seedResourcesDir) {
      // Fail-open by contract: a missing/corrupt seed never blocks a start.
      seeded = await seedGeodataFiles(homeDir, this.options.seedResourcesDir)
    }

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
      args: ['-f', configPath, '-d', homeDir],
      env: { MIHOMO_PLATFORM: process.platform, MIHOMO_ARCH: process.arch, MIHOMO_GEODATA_SEEDED: seeded.join(',') }
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
        const geodata = this.options.resolveGeodata ? await this.options.resolveGeodata() : undefined
        return {
          text: buildProfileKernelConfig(document, {
            mixedPort: this.options.mixedPort,
            controllerPort: this.options.controllerPort,
            secret,
            core,
            geodata
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
    // Only ever delete the exact per-run child this store created — NEVER the
    // stable kernel home, whose geodata databases and provider caches must
    // survive restarts (deleting it would reintroduce the first-run online
    // download and its pre-proxy DNS failure mode on every start).
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
