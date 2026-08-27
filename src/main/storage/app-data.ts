import { join, resolve, sep } from 'node:path'
import { mkdir, readdir, copyFile, stat, constants, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
 * Names Electron may create under the userData namespace before the migration
 * runs (GPU/disk caches, Local Storage, session state). These are runtime
 * artifacts, not user data, so they must not count as "the user already has
 * data here" when deciding whether a legacy import is still safe.
 */
const RUNTIME_ONLY_ENTRIES = new Set([
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Code Cache',
  'Cache',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Cookies',
  'Cookies-journal',
  'Network',
  'Partitions',
  'blob_storage',
  'Shared Dictionary',
  'Crashpad'
])

/**
 * True when the destination namespace already holds real user data. The guard
 * ignores the runtime cache/session entries Electron creates on first launch
 * (see {@link RUNTIME_ONLY_ENTRIES}); only a non-runtime entry — above all the
 * profiles sub-directory — means the user has already written data under the
 * new namespace and the legacy import must yield to it.
 */
async function hasUserData(dir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return false
  }
  return entries.some((name) => !RUNTIME_ONLY_ENTRIES.has(name))
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

/**
 * Copy any present data from every legacy namespace in the migration map into the
 * current namespace, leaving the legacy source untouched (the source is never
 * deleted so a rollback is always possible). The operation is a no-op when the
 * current namespace already holds user data, so a re-run (or a race between two
 * instances) never overwrites newer user data. Runtime caches Electron creates
 * before this runs (GPU cache, Local Storage, ...) do not count as user data —
 * judging "already migrated" by directory emptiness would let those caches
 * silently suppress the import forever.
 *
 * Each namespace is only reported as imported after its subtree has been copied
 * without error; a copy that fails part-way is logged and skipped (never reported
 * as success) and can be retried, because the source is preserved and existing
 * destination files are never overwritten.
 *
 * Returns the list of legacy namespaces that were actually imported from, so the
 * caller can log the outcome. Never throws for a missing or empty legacy dir.
 *
 * @param appDataBase platform app-data root (e.g. `app.getPath('appData')`).
 */
export async function migrateLegacyAppData(
  appDataBase: string,
  options: { migrationMap?: Readonly<Record<string, string>>; copy?: CopyFn } = {}
): Promise<string[]> {
  const map = options.migrationMap ?? APP_DATA_MIGRATION_MAP
  const copy = options.copy ?? copyTreeSafe
  const imported: string[] = []

  for (const [legacyName, migrateTo] of Object.entries(map)) {
    // Guard against a self-migration (namespace equal to its own source).
    if (legacyName === migrateTo) continue
    const currentDir = join(appDataBase, migrateTo)
    const legacyDir = join(appDataBase, legacyName)
    assertInsideBase(appDataBase, currentDir)
    assertInsideBase(appDataBase, legacyDir)
    if (!(await isDirectory(legacyDir))) continue
    if (await isEmptyDirectory(legacyDir)) continue
    if (await hasUserData(currentDir)) continue

    await mkdir(currentDir, { recursive: true })
    try {
      const copied = await copy(legacyDir, currentDir)
      if (copied > 0) imported.push(legacyName)
    } catch (error) {
      // A partial copy must not be reported as a successful import. The source
      // is kept and existing destination files are never overwritten, so a
      // retry either converges or the namespace is left for a manual merge.
      console.warn(`[app-data] failed to import legacy namespace "${legacyName}":`, error)
    }
  }

  return imported
}

/** True when a legacy namespace exists in the map for the given source name. */
export function hasLegacyNamespace(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(APP_DATA_MIGRATION_MAP, source)
}
