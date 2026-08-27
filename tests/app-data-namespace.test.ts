import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { brand } from '@shared/brand'
import {
  APP_DATA_NAMESPACE,
  APP_DATA_MIGRATION_MAP,
  PROFILES_SUBDIR,
  appDataRoot,
  profilesRoot,
  buildAppDataMigrationMap,
  migrateLegacyAppData,
  hasLegacyNamespace
} from '../src/main/storage/app-data'

describe('storage/app-data namespace', () => {
  it('derives the namespace from appId, never from productName', () => {
    expect(APP_DATA_NAMESPACE).toBe(brand.appId)
    // BRANDING forbids deriving the folder from the product name.
    expect(APP_DATA_NAMESPACE).not.toBe(brand.productName)
  })

  it('resolves the canonical data root and profiles subdir under a base', () => {
    const base = '/tmp/app-data-base'
    expect(appDataRoot(base)).toBe(join(base, brand.appId))
    expect(profilesRoot(base)).toBe(join(base, brand.appId, PROFILES_SUBDIR))
  })

  it('documents a migration entry for the product-name folder', () => {
    // The previous default Electron userData folder is the product name; the
    // explicit map must migrate it into the stable appId namespace.
    expect(APP_DATA_MIGRATION_MAP).toHaveProperty(brand.productName)
    expect(APP_DATA_MIGRATION_MAP[brand.productName]).toBe(brand.appId)
    expect(hasLegacyNamespace(brand.productName)).toBe(true)
    expect(hasLegacyNamespace('does-not-exist')).toBe(false)
  })

  it('is built from the explicit legacy catalogs, independent of the current product name', () => {
    // A rename must not drop a historical namespace: the map is derived from
    // legacyProductNames / legacyAppDataNamespaces, never from productName.
    for (const name of [...brand.legacyProductNames, ...brand.legacyAppDataNamespaces]) {
      expect(APP_DATA_MIGRATION_MAP).toHaveProperty(name)
      expect(APP_DATA_MIGRATION_MAP[name]).toBe(brand.appId)
    }
  })

  it('rejects an empty or self-mapping namespace when building the map', () => {
    const map = buildAppDataMigrationMap(['', '   ', brand.appId, brand.productName])
    // The appId namespace never maps onto itself, and blank entries are dropped.
    expect(Object.keys(map)).toEqual([brand.productName])
    expect(map[brand.productName]).toBe(brand.appId)
  })
})

describe('migrateLegacyAppData', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'app-data-ns-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('is a no-op and never throws when no legacy namespace exists', async () => {
    await expect(migrateLegacyAppData(base)).resolves.toEqual([])
  })

  it('imports data from the legacy product-name namespace, leaving the source intact', async () => {
    const legacy = join(base, brand.productName)
    const profiles = join(legacy, PROFILES_SUBDIR)
    await mkdir(profiles, { recursive: true })
    await writeFile(join(profiles, 'profile.yaml'), 'token: abc\n')
    await writeFile(join(legacy, 'settings.json'), '{"theme":"dark"}\n')

    const imported = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    // Destination populated.
    const destProfiles = join(base, brand.appId, PROFILES_SUBDIR)
    expect((await readdir(destProfiles)).sort()).toEqual(['profile.yaml'])
    // Source preserved for rollback.
    expect((await readdir(profiles)).sort()).toEqual(['profile.yaml'])
    expect(await readdir(join(base, brand.appId))).toContain('settings.json')
  })

  it('does not import over existing data in the destination', async () => {
    // Destination already has data.
    const dest = join(base, brand.appId)
    await mkdir(join(dest, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(dest, PROFILES_SUBDIR, 'profile.yaml'), 'newer: true\n')

    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'stale: true\n')

    await expect(migrateLegacyAppData(base)).resolves.toEqual([])
    const content = await readFileText(join(dest, PROFILES_SUBDIR, 'profile.yaml'))
    expect(content).toBe('newer: true\n')
  })

  it('still imports when Electron runtime caches already populate the destination', async () => {
    // Electron creates GPUCache/Local Storage under the pinned userData path
    // before app.whenReady fires. Those runtime artifacts must not be mistaken
    // for user data — otherwise the legacy import is suppressed forever.
    const dest = join(base, brand.appId)
    await mkdir(join(dest, 'GPUCache'), { recursive: true })
    await mkdir(join(dest, 'Local Storage'), { recursive: true })
    await writeFile(join(dest, 'Cookies'), '')

    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')

    const imported = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    expect((await readdir(join(dest, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
    // Runtime caches are preserved, not wiped.
    expect(await readdir(dest)).toContain('GPUCache')
  })

  it('skips missing and empty legacy namespaces', async () => {
    // Only an empty legacy dir.
    const legacy = join(base, brand.productName)
    await mkdir(legacy, { recursive: true })
    await expect(migrateLegacyAppData(base)).resolves.toEqual([])
  })

  it('copies arbitrarily deep legacy trees, preserving nested structure', async () => {
    const legacy = join(base, brand.productName)
    const deep = join(legacy, PROFILES_SUBDIR, 'group', 'nested', 'deep')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'profile.yaml'), 'token: abc\n')

    const imported = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    const destDeep = join(base, brand.appId, PROFILES_SUBDIR, 'group', 'nested', 'deep')
    expect((await readdir(destDeep)).sort()).toEqual(['profile.yaml'])
  })

  it('does not report a namespace as imported when the copy fails part-way', async () => {
    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')

    let calls = 0
    const copy = async () => {
      calls += 1
      // Simulate a copy that makes partial progress and then fails; the caller
      // must NOT report the namespace as imported.
      await mkdir(join(base, brand.appId, PROFILES_SUBDIR), { recursive: true })
      await writeFile(join(base, brand.appId, PROFILES_SUBDIR, 'partial.yaml'), 'partial\n')
      throw new Error('injected copy failure')
    }

    const imported = await migrateLegacyAppData(base, { copy })

    expect(imported).toEqual([])
    expect(calls).toBe(1)
  })

  it('migrates the historical namespace even when the current product name differs', async () => {
    // A user had data under the old product-name folder.
    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')

    // Simulate a later rename: the app keeps its stable appId namespace and
    // preserves old product names in the explicit legacy catalog rather than
    // re-deriving them from the (now different) current product name.
    const renamedMap = buildAppDataMigrationMap([brand.productName, 'earlier-release'])
    const imported = await migrateLegacyAppData(base, { migrationMap: renamedMap })

    expect(imported).toContain(brand.productName)
    expect((await readdir(join(base, brand.appId, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
  })
})

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
