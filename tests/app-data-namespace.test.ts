import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, rm, stat, readFile, copyFile } from 'node:fs/promises'
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
  hasLegacyNamespace,
  readMigrationState,
  writeMigrationState,
  MIGRATION_STATE_VERSION
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
    await expect(migrateLegacyAppData(base)).resolves.toEqual({ imported: [], conflicts: [] })
  })

  it('imports data from the legacy product-name namespace, leaving the source intact', async () => {
    const legacy = join(base, brand.productName)
    const profiles = join(legacy, PROFILES_SUBDIR)
    await mkdir(profiles, { recursive: true })
    await writeFile(join(profiles, 'profile.yaml'), 'token: abc\n')
    await writeFile(join(legacy, 'settings.json'), '{"theme":"dark"}\n')

    const { imported, conflicts } = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    expect(conflicts).toEqual([])
    // Destination populated.
    const destProfiles = join(base, brand.appId, PROFILES_SUBDIR)
    expect((await readdir(destProfiles)).sort()).toEqual(['profile.yaml'])
    // Source preserved for rollback.
    expect((await readdir(profiles)).sort()).toEqual(['profile.yaml'])
    expect(await readdir(join(base, brand.appId))).toContain('settings.json')
  })

  it('merges legacy data without overwriting an existing newer profile', async () => {
    // Destination already holds a newer profile of the same name.
    const dest = join(base, brand.appId)
    await mkdir(join(dest, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(dest, PROFILES_SUBDIR, 'profile.yaml'), 'newer: true\n')

    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'stale: true\n')
    await writeFile(join(legacy, PROFILES_SUBDIR, 'additional.yaml'), 'extra: true\n')

    const { imported, conflicts } = await migrateLegacyAppData(base)

    // The legacy namespace is not silently skipped: it is reported as imported,
    // the existing (newer) profile is kept, and the collision is recorded.
    expect(imported).toContain(brand.productName)
    expect(conflicts).toContain(`${PROFILES_SUBDIR}/profile.yaml`)
    expect(await readFileText(join(dest, PROFILES_SUBDIR, 'profile.yaml'))).toBe('newer: true\n')
    // Non-conflicting legacy data still came across.
    expect((await readdir(join(dest, PROFILES_SUBDIR))).sort()).toEqual(['additional.yaml', 'profile.yaml'])
  })

  it('imports legacy profiles even when Chromium runtime files already populate the destination', async () => {
    // Electron creates these under the pinned userData path before app.whenReady
    // fires. A filename whitelist cannot reliably treat them as "not user data",
    // so the migration marker — not a "does the dir look empty" heuristic — must
    // decide whether to import.
    const dest = join(base, brand.appId)
    await mkdir(join(dest, 'GPUCache'), { recursive: true })
    await mkdir(join(dest, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(dest, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001\n')
    await mkdir(join(dest, 'Preferences'), { recursive: true })
    await writeFile(join(dest, 'Local State'), '{"foo":1}')
    await writeFile(join(dest, 'Cookies'), '')

    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')

    const { imported, conflicts } = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    expect(conflicts).toEqual([])
    expect((await readdir(join(dest, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
    // Runtime files are preserved, never wiped.
    expect(await readdir(dest)).toContain('GPUCache')
    expect(await readdir(dest)).toContain('Preferences')
    expect(await readdir(dest)).toContain('Local State')
    expect(await readdir(dest)).toContain('Local Storage')
  })

  it('skips missing and empty legacy namespaces', async () => {
    // Only an empty legacy dir.
    const legacy = join(base, brand.productName)
    await mkdir(legacy, { recursive: true })
    await expect(migrateLegacyAppData(base)).resolves.toEqual({ imported: [], conflicts: [] })
  })

  it('copies arbitrarily deep legacy trees, preserving nested structure', async () => {
    const legacy = join(base, brand.productName)
    const deep = join(legacy, PROFILES_SUBDIR, 'group', 'nested', 'deep')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'profile.yaml'), 'token: abc\n')

    const { imported } = await migrateLegacyAppData(base)

    expect(imported).toContain(brand.productName)
    const destDeep = join(base, brand.appId, PROFILES_SUBDIR, 'group', 'nested', 'deep')
    expect((await readdir(destDeep)).sort()).toEqual(['profile.yaml'])
  })

  it('recovers on the next launch after a partial staging copy failure', async () => {
    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')
    await writeFile(join(legacy, 'settings.json'), '{"theme":"dark"}\n')

    let calls = 0
    const faultyCopy = async (_src: string, dest: string) => {
      calls += 1
      // Simulate partial progress inside the staging dir the copy is handed,
      // then fail — the real target namespace must remain untouched.
      await mkdir(join(dest, PROFILES_SUBDIR), { recursive: true })
      await writeFile(join(dest, PROFILES_SUBDIR, 'partial.yaml'), 'partial\n')
      throw new Error('injected staging copy failure')
    }

    const first = await migrateLegacyAppData(base, { copy: faultyCopy })

    // A partial staging copy is NOT reported as an import.
    expect(first.imported).toEqual([])
    expect(calls).toBe(1)
    // The real target was never polluted by the partial copy.
    await expect(stat(join(base, brand.appId, PROFILES_SUBDIR))).rejects.toThrow()
    // No staging directory was left behind after the failure.
    const leftovers = (await readdir(base)).filter((name) => name.includes('.migration-'))
    expect(leftovers).toEqual([])

    // A second launch retries from the preserved source and succeeds.
    const second = await migrateLegacyAppData(base)
    expect(second.imported).toContain(brand.productName)
    expect(second.conflicts).toEqual([])
    expect((await readdir(join(base, brand.appId, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
    expect((await readdir(join(base, brand.appId))).sort()).toContain('settings.json')
  })

  it('reports a namespace as imported only after the commit fully succeeds', async () => {
    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')
    await writeFile(join(legacy, PROFILES_SUBDIR, 'other.yaml'), 'other\n')

    let commits = 0
    const faultyCommit = async (staging: string, target: string) => {
      commits += 1
      // Move one real source file (present in staging) into the target, then fail.
      await mkdir(join(target, PROFILES_SUBDIR), { recursive: true })
      await copyFile(join(staging, PROFILES_SUBDIR, 'profile.yaml'), join(target, PROFILES_SUBDIR, 'profile.yaml'))
      throw new Error('injected commit failure')
    }

    const first = await migrateLegacyAppData(base, { commit: faultyCommit })

    // Only a fully committed namespace is reported as imported.
    expect(first.imported).toEqual([])
    expect(commits).toBe(1)
    // The marker reflects a retryable failure, not a completed migration.
    const state = await readMigrationState(base)
    expect(state.sources[brand.productName]).toBe('failed')

    // A subsequent launch with the real commit converges and keeps the profile
    // that was already placed in the target (never overwritten).
    const second = await migrateLegacyAppData(base)
    expect(second.imported).toContain(brand.productName)
    expect(second.conflicts).toContain(`${PROFILES_SUBDIR}/profile.yaml`)
    expect((await readdir(join(base, brand.appId, PROFILES_SUBDIR))).sort()).toEqual(['other.yaml', 'profile.yaml'])
  })

  it('does not re-import a namespace whose marker is already completed', async () => {
    const legacy = join(base, brand.productName)
    await mkdir(join(legacy, PROFILES_SUBDIR), { recursive: true })
    await writeFile(join(legacy, PROFILES_SUBDIR, 'profile.yaml'), 'token: abc\n')

    const first = await migrateLegacyAppData(base)
    expect(first.imported).toContain(brand.productName)

    // A newly-written file under the preserved source must not be picked up: the
    // migration is a one-time import governed by the completed marker.
    await writeFile(join(legacy, PROFILES_SUBDIR, 'later.yaml'), 'later\n')
    const second = await migrateLegacyAppData(base)
    expect(second.imported).toEqual([])
    expect((await readdir(join(base, brand.appId, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
  })

  it('writes and reads back the migration marker atomically', async () => {
    await writeMigrationState(base, {
      version: MIGRATION_STATE_VERSION,
      sources: { [brand.productName]: 'completed' },
      updatedAt: ''
    })
    const state = await readMigrationState(base)
    expect(state.version).toBe(MIGRATION_STATE_VERSION)
    expect(state.sources[brand.productName]).toBe('completed')
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
    const { imported } = await migrateLegacyAppData(base, { migrationMap: renamedMap })

    expect(imported).toContain(brand.productName)
    expect((await readdir(join(base, brand.appId, PROFILES_SUBDIR))).sort()).toEqual(['profile.yaml'])
  })
})

async function readFileText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
