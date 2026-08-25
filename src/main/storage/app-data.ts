import { join } from 'node:path'
import { mkdir, readdir, copyFile, stat } from 'node:fs/promises'
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
 * Legacy namespaces (folder names under the platform app-data root) mapped to
 * the namespace they should be moved into. Electron derives `userData` from the
 * app name when no path is pinned, so the first entry migrates the product-name
 * folder the runtime previously used into the stable `appId` namespace.
 *
 * Entries are intentionally keyed by the value the runtime actually wrote, not
 * by a guess. Every entry must have a real migration test.
 */
export const APP_DATA_MIGRATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  [brand.productName]: APP_DATA_NAMESPACE
})

/** Sub-directory under the namespace that stores user profile documents. */
export const PROFILES_SUBDIR = 'profiles'

/** Resolve the canonical application-data directory for a platform app-data root. */
export function appDataRoot(appDataBase: string): string {
  return join(appDataBase, APP_DATA_NAMESPACE)
}

/** Resolve the directory that will hold user profiles once persistent storage lands. */
export function profilesRoot(appDataBase: string): string {
  return join(appDataRoot(appDataBase), PROFILES_SUBDIR)
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
 * Copy any present data from every legacy namespace in the migration map into the
 * current namespace, leaving the legacy source untouched (the source is never
 * deleted so a rollback is always possible). The operation is a no-op when the
 * current namespace already holds data, so a re-run (or a race between two
 * instances) never overwrites newer user data.
 *
 * Returns the list of legacy namespaces that were actually imported from, so the
 * caller can log the outcome. Never throws for a missing or empty legacy dir.
 *
 * @param appDataBase platform app-data root (e.g. `app.getPath('appData')`).
 */
export async function migrateLegacyAppData(appDataBase: string): Promise<string[]> {
  const imported: string[] = []

  for (const [legacyName, migrateTo] of Object.entries(APP_DATA_MIGRATION_MAP)) {
    // Guard against a self-migration (namespace equal to its own source).
    if (legacyName === migrateTo) continue
    const currentDir = join(appDataBase, migrateTo)
    const legacyDir = join(appDataBase, legacyName)
    if (!(await isDirectory(legacyDir))) continue
    if (await isEmptyDirectory(legacyDir)) continue
    if (!(await isEmptyDirectory(currentDir))) continue

    await mkdir(currentDir, { recursive: true })
    let copied = 0
    for (const entry of await readdir(legacyDir, { withFileTypes: true })) {
      const src = join(legacyDir, entry.name)
      const dest = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await mkdir(dest, { recursive: true })
        for (const child of await readdir(src, { withFileTypes: true })) {
          const childSrc = join(src, child.name)
          if (child.isFile()) {
            await copyFile(childSrc, join(dest, child.name))
            copied += 1
          }
        }
      } else if (entry.isFile()) {
        await copyFile(src, dest)
        copied += 1
      }
    }
    if (copied > 0) imported.push(legacyName)
  }

  return imported
}

/** True when a legacy namespace exists in the map for the given source name. */
export function hasLegacyNamespace(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(APP_DATA_MIGRATION_MAP, source)
}
