import { join, resolve, sep } from 'node:path'
import {
  mkdir,
  readdir,
  copyFile,
  stat,
  constants,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  access,
  unlink
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { brand } from '@shared/brand'

/**
 * Stable application-data namespace.
 *
 * BRANDING conventions forbid deriving the on-disk application-data folder from
 * the *product name* (a rename would then silently separate users from their
 * data). The durable anchor for application identity is `appId` — it is stable
 * across cosmetic renames and only moves when the owner deliberately changes it,
 * in which case {@link migrateLegacyAppData} imports any prior data.
 *
 * - {@link APP_DATA_NAMESPACE} is the canonical, product-name-free folder name.
 * - {@link APP_DATA_MIGRATION_MAP} records every namespace a released build may
 *   have used before this one, so a rename never orphans users.
 */
export const APP_DATA_NAMESPACE = brand.appId

/**
 * Build the legacy-to-current namespace migration map.
 *
 * The keys are intentionally NOT derived from the current `productName` — a
 * rename would then silently drop every historical namespace and orphan the
 * users who stored data under those folders years ago. Instead the map is built
 * from the explicit, owner-curated lists in `brand.config.json`
 * (`legacyProductNames` + `legacyAppDataNamespaces`), so a rename only adds a
 * new entry and never removes an old one.
 *
 * @param legacyNamespaces folder names (under the platform app-data root) that
 *   a previously released build may have used for its application data.
 */
export function buildAppDataMigrationMap(
  legacyNamespaces: readonly string[]
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {}
  for (const name of legacyNamespaces) {
    const trimmed = name.trim()
    if (!trimmed || trimmed === APP_DATA_NAMESPACE) continue
    map[trimmed] = APP_DATA_NAMESPACE
  }
  return Object.freeze(map)
}

/**
 * Legacy namespaces mapped to the namespace they should be moved into. Electron
 * derives `userData` from the app name when no path is pinned, so the first
 * entry migrates the product-name folder the runtime previously used into the
 * stable `appId` namespace.
 *
 * Entries are intentionally keyed by the value the runtime actually wrote, not
 * by a guess. Every entry must have a real migration test.
 */
export const APP_DATA_MIGRATION_MAP: Readonly<Record<string, string>> = buildAppDataMigrationMap([
  ...brand.legacyProductNames,
  ...brand.legacyAppDataNamespaces
])

/** Sub-directory under the namespace that stores user profile documents. */
export const PROFILES_SUBDIR = 'profiles'

/**
 * Temporary-directory prefix for the development-only profile workspace. Dev
 * builds derive a fresh directory per launch so no real application data is ever
 * read or written on the host — see DEVELOPMENT_SAFETY.md.
 */
export const DEV_PROFILE_TMP_PREFIX = 'proxy-profiles-'

/** Resolve the canonical application-data directory for a platform app-data root. */
export function appDataRoot(appDataBase: string): string {
  return join(appDataBase, APP_DATA_NAMESPACE)
}

/** Resolve the directory that will hold user profiles once persistent storage lands. */
export function profilesRoot(appDataBase: string): string {
  return join(appDataRoot(appDataBase), PROFILES_SUBDIR)
}

/**
 * Resolve and create the profile workspace for the current build mode.
 *
 * - Development: an ephemeral directory under the OS temp dir, freshly `mkdtemp`'d
 *   per launch, so dev never touches a real user's data.
 * - Production: the deterministic, product-name-free namespace under the platform
 *   app-data root (created here so the first repository write is guaranteed).
 *
 * Pass the *platform* app-data root (`app.getPath('appData')`), never the already
 * pinned `userData` (which is `appDataRoot(appData)`), otherwise the namespace is
 * doubled: `io.murge.desktop/io.murge.desktop/profiles`.
 */
export async function resolveRuntimeProfileRoot(
  appDataBase: string,
  opts: { dev: boolean }
): Promise<string> {
  if (opts.dev) {
    return mkdtemp(join(tmpdir(), DEV_PROFILE_TMP_PREFIX))
  }
  const root = profilesRoot(appDataBase)
  await mkdir(root, { recursive: true })
  return root
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0
  } catch {
    return true
  }
}

/**
 * Migration-marker metadata. Whether a legacy namespace still needs to be
 * imported is decided exclusively by this file and the migration version — never
 * by inspecting what the target namespace "looks like". Electron creates runtime
 * files (`Preferences`, `Local State`, `Local Storage`, ...) under the namespace
 * before `ready`, so a filename whitelist can never reliably separate "user
 * data" from "runtime caches"; the marker can.
 */
export const MIGRATION_STATE_FILE = 'migration-state.json'
export const MIGRATION_STATE_VERSION = 1
export const MIGRATION_STATUSES = ['pending', 'completed', 'failed'] as const
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number]

export interface MigrationState {
  version: number
  /** Per-source status keyed by the legacy namespace folder name. */
  sources: Record<string, MigrationStatus>
  updatedAt: string
}

/**
 * Read the migration marker. An absent, unreadable or stale-version marker is
 * treated as "no migration decided yet", so a migration may (re)run.
 */
export async function readMigrationState(appDataBase: string): Promise<MigrationState> {
  const file = join(appDataRoot(appDataBase), MIGRATION_STATE_FILE)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { version?: unknown; sources?: unknown; updatedAt?: unknown }
      if (record.version === MIGRATION_STATE_VERSION && record.sources && typeof record.sources === 'object') {
        const sources: Record<string, MigrationStatus> = {}
        for (const [name, status] of Object.entries(record.sources as Record<string, unknown>)) {
          if ((MIGRATION_STATUSES as readonly unknown[]).includes(status)) {
            sources[name] = status as MigrationStatus
          }
        }
        return {
          version: MIGRATION_STATE_VERSION,
          sources,
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : ''
        }
      }
    }
  } catch {
    // Fall through to "empty" below.
  }
  return { version: MIGRATION_STATE_VERSION, sources: {}, updatedAt: '' }
}

/**
 * Write the migration marker atomically: the payload is written to a temp file in
 * the same directory and renamed over the marker, so a concurrent reader never
 * observes a half-written marker (atomic on a single filesystem).
 */
export async function writeMigrationState(appDataBase: string, state: MigrationState): Promise<void> {
  const dir = appDataRoot(appDataBase)
  await mkdir(dir, { recursive: true })
  const file = join(dir, MIGRATION_STATE_FILE)
  const tmp = join(dir, `.${MIGRATION_STATE_FILE}.${randomUUID()}.tmp`)
  const payload = JSON.stringify(
    { version: state.version, sources: state.sources, updatedAt: new Date().toISOString() },
    null,
    2
  ) + '\n'
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/**
 * Assert that `target` resolves inside `base` (or is `base` itself). Defends
 * the migration from a path-traversal attempt through a crafted namespace.
 */
function assertInsideBase(base: string, target: string): void {
  const root = resolve(base)
  const resolved = resolve(target)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes app-data base: ${target}`)
  }
}

type CopyFn = (src: string, dest: string) => Promise<number>

/**
 * Recursively copy `src` into `dest`, never overwriting an existing destination
 * entry. A destination file that already exists is silently kept (so a re-run
 * never clobbers newer user data), and symlinks/special files are skipped. The
 * copy is bounded to an arbitrary depth and never follows a path outside the two
 * caller-verified roots. Returns the number of files actually copied.
 *
 * Used to stage a full legacy tree into a fresh sibling directory before commit,
 * so the destination above (`dest` here) is always empty and `COPYFILE_EXCL`
 * never actually collides.
 */
async function copyTreeSafe(src: string, dest: string): Promise<number> {
  let copied = 0
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    if (entry.isSymbolicLink()) continue
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true })
      copied += await copyTreeSafe(srcPath, destPath)
    } else if (entry.isFile()) {
      try {
        await copyFile(srcPath, destPath, constants.COPYFILE_EXCL)
        copied += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
  }
  return copied
}

interface CommitResult {
  moved: number
  conflicts: string[]
}

type CommitFn = (stagingDir: string, targetDir: string) => Promise<CommitResult>

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
  } catch (error) {
    // rename is atomic on a single filesystem; across filesystems it fails with
    // EXDEV, in which case fall back to a copy+unlink.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(src, dest, constants.COPYFILE_EXCL)
    await unlink(src)
  }
}

async function commitDirectory(
  srcDir: string,
  destDir: string,
  conflicts: string[],
  rel: string
): Promise<number> {
  let moved = 0
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      moved += await commitDirectory(srcPath, destPath, conflicts, relPath)
    } else if (entry.isFile()) {
      if (await pathExists(destPath)) {
        // Never overwrite an entry that is already in the target — above all a
        // profile the user may already have written under the new namespace.
        // Record the collision so the caller can surface it.
        conflicts.push(relPath)
      } else {
        await moveFile(srcPath, destPath)
        moved += 1
      }
    }
  }
  return moved
}

/**
 * Merge a fully-staged legacy tree into the target namespace, never overwriting
 * an existing target entry. Collisions (existing target files) are collected and
 * returned, not overwritten, so a legacy namespace is never silently skipped.
 */
async function commitStaging(stagingDir: string, targetDir: string): Promise<CommitResult> {
  const conflicts: string[] = []
  const moved = await commitDirectory(stagingDir, targetDir, conflicts, '')
  return { moved, conflicts }
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Remove any stale migration staging directories left by a crashed launch. */
async function pruneStaleStaging(appDataBase: string): Promise<void> {
  const prefix = `${APP_DATA_NAMESPACE}.migration-`
  let entries: string[]
  try {
    entries = await readdir(appDataBase)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map((name) => rm(join(appDataBase, name), { recursive: true, force: true }).catch(() => {}))
  )
}

export interface MigrationResult {
  /** Legacy namespaces fully migrated in this call (committed + marker set). */
  imported: string[]
  /** Existing target entries kept over legacy data (never overwritten). */
  conflicts: string[]
}

export interface MigrateLegacyOptions {
  migrationMap?: Readonly<Record<string, string>>
  copy?: CopyFn
  commit?: CommitFn
  readState?: (base: string) => Promise<MigrationState>
  writeState?: (base: string, state: MigrationState) => Promise<void>
  stagingDir?: string
}

/**
 * Transactionally migrate any present data from each legacy namespace into the
 * current namespace.
 *
 * The migration is staged and committed in two phases so a partial failure can
 * never pollute the real target:
 *
 *  1. STAGE — copy the entire legacy subtree into a fresh sibling staging
 *     directory (`io.murge.desktop.migration-<random>`) under the same app-data
 *     root. The target namespace is not touched yet; if this copy fails the
 *     staging directory is removed and the source is kept intact.
 *  2. COMMIT — once the staging copy is complete, merge staging into the target
 *     namespace. Existing target entries are never overwritten (above all
 *     profiles the user may already have written); collisions are recorded as
 *     conflicts and reported. A failed commit is marked for retry.
 *
 * Whether a namespace still needs to be imported is decided exclusively by the
 * migration marker (`migration-state.json`) and its migration version — never by
 * inspecting which files the target already holds. Electron creates runtime
 * files like `Preferences`, `Local State` and `Local Storage` under the namespace
 * before `ready`, so a filename whitelist can never reliably distinguish "user
 * data" from "runtime caches"; the marker can. `Local Storage` / `IndexedDB` can
 * hold real app settings and are treated as ordinary data.
 *
 * The source directory is always preserved so a rollback stays possible.
 *
 * @param appDataBase platform app-data root (e.g. `app.getPath('appData')`).
 * @returns the namespaces imported and the conflicts that were kept.
 */
export async function migrateLegacyAppData(
  appDataBase: string,
  options: MigrateLegacyOptions = {}
): Promise<MigrationResult> {
  const map = options.migrationMap ?? APP_DATA_MIGRATION_MAP
  const copy = options.copy ?? copyTreeSafe
  const commit = options.commit ?? commitStaging
  const readState = options.readState ?? readMigrationState
  const writeState = options.writeState ?? writeMigrationState
  const stagingDirOverride = options.stagingDir

  await pruneStaleStaging(appDataBase)

  const imported: string[] = []
  const conflicts: string[] = []
  const state = await readState(appDataBase)

  for (const [source, target] of Object.entries(map)) {
    if (source === target) continue
    if (state.sources[source] === 'completed') continue

    const currentDir = join(appDataBase, target)
    const legacyDir = join(appDataBase, source)
    assertInsideBase(appDataBase, currentDir)
    assertInsideBase(appDataBase, legacyDir)

    // Nothing to do if the legacy namespace is absent or empty.
    if (!(await isDirectory(legacyDir))) continue
    if (await isEmptyDirectory(legacyDir)) continue

    // Announce the in-flight migration so a crash mid-way is recoverable: a
    // 'pending' status is not 'completed', so the next launch retries.
    state.sources[source] = 'pending'
    await writeState(appDataBase, state)

    const staging = stagingDirOverride ?? join(appDataBase, `${APP_DATA_NAMESPACE}.migration-${randomSuffix()}`)

    // Phase 1 — full copy into staging (the target namespace is untouched).
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await copy(legacyDir, staging)
    } catch (error) {
      state.sources[source] = 'failed'
      await writeState(appDataBase, state)
      console.warn(`[app-data] legacy migration for "${source}" failed while staging a copy:`, error)
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      continue
    }

    // Phase 2 — controlled commit into the target namespace.
    try {
      await mkdir(currentDir, { recursive: true })
      const result = await commit(staging, currentDir)
      imported.push(source)
      conflicts.push(...result.conflicts)
      if (result.conflicts.length > 0) {
        console.warn(
          `[app-data] legacy migration for "${source}" kept ${result.conflicts.length} existing file(s) over legacy data (not overwritten): ${result.conflicts
            .slice(0, 20)
            .join(', ')}`
        )
      }
      state.sources[source] = 'completed'
      await writeState(appDataBase, state)
    } catch (error) {
      // A failure while merging may have left some entries in the target. The
      // marker stays 'failed', so the next launch re-stages from the preserved
      // source; the merge skips entries already present, so it converges.
      state.sources[source] = 'failed'
      await writeState(appDataBase, state)
      console.warn(`[app-data] legacy migration for "${source}" failed while committing:`, error)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { imported, conflicts }
}

/** True when a legacy namespace exists in the map for the given source name. */
export function hasLegacyNamespace(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(APP_DATA_MIGRATION_MAP, source)
}
