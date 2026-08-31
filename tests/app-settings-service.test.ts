import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsService } from '../src/main/app-settings/service'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/app-settings'
import type { AppSettings } from '../src/shared/app-settings'

describe('parseAppSettings', () => {
  it('returns the default when no value is present', () => {
    expect(parseAppSettings(null)).toEqual({ autoStartKernel: true })
    expect(parseAppSettings('')).toEqual({ autoStartKernel: true })
  })

  it('returns the default for malformed JSON', () => {
    expect(parseAppSettings('{ not json')).toEqual({ autoStartKernel: true })
  })

  it('coerces an unknown autoStartKernel to the default', () => {
    expect(parseAppSettings('{"autoStartKernel":"yes"}')).toEqual({ autoStartKernel: true })
    expect(parseAppSettings('{}')).toEqual({ autoStartKernel: true })
  })

  it('reads a persisted boolean', () => {
    expect(parseAppSettings('{"autoStartKernel":false}')).toEqual({ autoStartKernel: false })
  })
})

describe('AppSettingsService', () => {
  let base: string
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('defaults autoStartKernel to true when the file is absent', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual({ autoStartKernel: true })
  })

  it('persists and reloads a change atomically', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    expect(await service.get()).toEqual({ autoStartKernel: false })

    // A fresh instance over the same directory reads the persisted value.
    const second = new AppSettingsService(base)
    expect(await second.get()).toEqual({ autoStartKernel: false })

    const onDisk = await readFile(join(base, 'app-settings.json'), 'utf8')
    expect(JSON.parse(onDisk)).toEqual({ autoStartKernel: false })
  })

  it('ignores unknown keys in a patch and keeps the remainder', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    const patch = { autoStartKernel: false, unknown: 1 } as unknown as Partial<AppSettings>
    await service.set(patch)
    expect(await service.get()).toEqual({ autoStartKernel: false })
  })

  it('falls back to the default for a garbage on-disk file', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    await writeFile(join(base, 'app-settings.json'), 'not-json', 'utf8')
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual({ autoStartKernel: DEFAULT_APP_SETTINGS.autoStartKernel })
  })

  it('does not leave a temp file behind after a write', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    const leftovers = (await readdir(base)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
