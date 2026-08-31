import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsService } from '../src/main/app-settings/service'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/app-settings'
import type { AppSettings } from '../src/shared/app-settings'

describe('parseAppSettings', () => {
  it('returns the default when no value is present', () => {
    expect(parseAppSettings(null)).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
    expect(parseAppSettings('')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
  })

  it('returns the default for malformed JSON', () => {
    expect(parseAppSettings('{ not json')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
  })

  it('coerces an unknown autoStartKernel to the default', () => {
    expect(parseAppSettings('{"autoStartKernel":"yes"}')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
    expect(parseAppSettings('{}')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
  })

  it('reads a persisted boolean', () => {
    expect(parseAppSettings('{"autoStartKernel":false}')).toEqual({ autoStartKernel: false, autoCheckUpdate: true })
  })

  it('coerces an unknown autoCheckUpdate to the default', () => {
    expect(parseAppSettings('{"autoCheckUpdate":"yes"}')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
    expect(parseAppSettings('{"autoCheckUpdate":null}')).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
  })

  it('reads a persisted autoCheckUpdate boolean', () => {
    expect(parseAppSettings('{"autoCheckUpdate":false}')).toEqual({ autoStartKernel: true, autoCheckUpdate: false })
    expect(parseAppSettings('{"autoStartKernel":false,"autoCheckUpdate":false}')).toEqual({ autoStartKernel: false, autoCheckUpdate: false })
  })
})

describe('AppSettingsService', () => {
  let base: string
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('defaults autoStartKernel and autoCheckUpdate to true when the file is absent', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual({ autoStartKernel: true, autoCheckUpdate: true })
  })

  it('persists and reloads a change atomically', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    expect(await service.get()).toEqual({ autoStartKernel: false, autoCheckUpdate: true })

    // A fresh instance over the same directory reads the persisted value.
    const second = new AppSettingsService(base)
    expect(await second.get()).toEqual({ autoStartKernel: false, autoCheckUpdate: true })

    const onDisk = await readFile(join(base, 'app-settings.json'), 'utf8')
    expect(JSON.parse(onDisk)).toEqual({ autoStartKernel: false, autoCheckUpdate: true })
  })

  it('persists autoCheckUpdate independently of autoStartKernel', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoCheckUpdate: false })
    expect(await service.get()).toEqual({ autoStartKernel: true, autoCheckUpdate: false })

    await service.set({ autoStartKernel: false })
    expect(await service.get()).toEqual({ autoStartKernel: false, autoCheckUpdate: false })
  })

  it('ignores unknown keys in a patch and keeps the remainder', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    const patch = { autoStartKernel: false, unknown: 1 } as unknown as Partial<AppSettings>
    await service.set(patch)
    expect(await service.get()).toEqual({ autoStartKernel: false, autoCheckUpdate: true })
  })

  it('falls back to the default for a garbage on-disk file', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    await writeFile(join(base, 'app-settings.json'), 'not-json', 'utf8')
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual({
      autoStartKernel: DEFAULT_APP_SETTINGS.autoStartKernel,
      autoCheckUpdate: DEFAULT_APP_SETTINGS.autoCheckUpdate
    })
  })

  it('does not leave a temp file behind after a write', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    const leftovers = (await readdir(base)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
