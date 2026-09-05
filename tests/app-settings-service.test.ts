import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsService } from '../src/main/app-settings/service'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/app-settings'
import type { AppSettings } from '../src/shared/app-settings'

const DEFAULT_OBJ = { ...DEFAULT_APP_SETTINGS }

describe('parseAppSettings', () => {
  it('returns the default when no value is present', () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_OBJ)
    expect(parseAppSettings('')).toEqual(DEFAULT_OBJ)
  })

  it('returns the default for malformed JSON', () => {
    expect(parseAppSettings('{ not json')).toEqual(DEFAULT_OBJ)
  })

  it('coerces an unknown autoStartKernel to the default', () => {
    expect(parseAppSettings('{"autoStartKernel":"yes"}')).toEqual(DEFAULT_OBJ)
    expect(parseAppSettings('{}')).toEqual(DEFAULT_OBJ)
  })

  it('reads a persisted boolean', () => {
    expect(parseAppSettings('{"autoStartKernel":false}')).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })
  })

  it('coerces an unknown autoCheckUpdate to the default', () => {
    expect(parseAppSettings('{"autoCheckUpdate":"yes"}')).toEqual(DEFAULT_OBJ)
    expect(parseAppSettings('{"autoCheckUpdate":null}')).toEqual(DEFAULT_OBJ)
  })

  it('reads a persisted autoCheckUpdate boolean', () => {
    expect(parseAppSettings('{"autoCheckUpdate":false}')).toEqual({ ...DEFAULT_OBJ, autoCheckUpdate: false })
    expect(parseAppSettings('{"autoStartKernel":false,"autoCheckUpdate":false}')).toEqual({
      ...DEFAULT_OBJ,
      autoStartKernel: false,
      autoCheckUpdate: false
    })
  })

  it('reads durable network intent while older settings default safely off', () => {
    expect(parseAppSettings('{"systemProxyDesired":true,"tunDesired":true}')).toEqual({
      ...DEFAULT_OBJ,
      systemProxyDesired: true,
      tunDesired: true
    })
    expect(parseAppSettings('{"systemProxyDesired":"yes","tunDesired":null}')).toEqual(DEFAULT_OBJ)
  })

  it('defaults kernel management fields when absent', () => {
    expect(parseAppSettings('{"autoStartKernel":false}')).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })
  })

  it('coerces an unknown kernelEnabled to the default', () => {
    expect(parseAppSettings('{"kernelEnabled":"yes"}')).toEqual(DEFAULT_OBJ)
    expect(parseAppSettings('{"kernelEnabled":null}')).toEqual(DEFAULT_OBJ)
  })

  it('coerces an unknown kernelChannel to the default stable channel', () => {
    expect(parseAppSettings('{"kernelChannel":"other"}')).toEqual(
      { ...DEFAULT_OBJ, kernelChannel: 'stable' }
    )
  })

  it('reads persisted kernel channel and version', () => {
    expect(
      parseAppSettings('{"kernelEnabled":false,"kernelChannel":"specific","kernelSpecificVersion":"v1.19.20"}')
    ).toEqual({ ...DEFAULT_OBJ, kernelEnabled: false, kernelChannel: 'specific', kernelSpecificVersion: 'v1.19.20' })
  })
})

describe('AppSettingsService', () => {
  let base: string
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('defaults all fields when the file is absent', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual(DEFAULT_OBJ)
  })

  it('persists and reloads a change atomically', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    expect(await service.get()).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })

    // A fresh instance over the same directory reads the persisted value.
    const second = new AppSettingsService(base)
    expect(await second.get()).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })

    const onDisk = await readFile(join(base, 'app-settings.json'), 'utf8')
    expect(JSON.parse(onDisk)).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })
  })

  it('persists autoCheckUpdate independently of autoStartKernel', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoCheckUpdate: false })
    expect(await service.get()).toEqual({ ...DEFAULT_OBJ, autoCheckUpdate: false })

    await service.set({ autoStartKernel: false })
    expect(await service.get()).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false, autoCheckUpdate: false })
  })

  it('persists system proxy and TUN intent independently', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ systemProxyDesired: true })
    await service.set({ tunDesired: true })
    expect(await service.get()).toEqual({
      ...DEFAULT_OBJ,
      systemProxyDesired: true,
      tunDesired: true
    })
  })

  it('notifies observers only after a durable settings write', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    const listener = vi.fn()
    const unsubscribe = service.onChange(listener)

    await service.set({ tunDesired: true })
    expect(listener).toHaveBeenCalledWith({ ...DEFAULT_OBJ, tunDesired: true })
    expect(JSON.parse(await readFile(join(base, 'app-settings.json'), 'utf8')).tunDesired).toBe(true)

    unsubscribe()
    await service.set({ tunDesired: false })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('persists the kernel management fields independently', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ kernelEnabled: false })
    expect(await service.get()).toEqual({ ...DEFAULT_OBJ, kernelEnabled: false })

    await service.set({ kernelChannel: 'specific', kernelSpecificVersion: 'v1.19.20' })
    expect(await service.get()).toEqual({
      ...DEFAULT_OBJ,
      kernelEnabled: false,
      kernelChannel: 'specific',
      kernelSpecificVersion: 'v1.19.20'
    })
  })

  it('ignores unknown keys in a patch and keeps the remainder', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    const patch = { autoStartKernel: false, unknown: 1 } as unknown as Partial<AppSettings>
    await service.set(patch)
    expect(await service.get()).toEqual({ ...DEFAULT_OBJ, autoStartKernel: false })
  })

  it('falls back to the default for a garbage on-disk file', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    await writeFile(join(base, 'app-settings.json'), 'not-json', 'utf8')
    const service = new AppSettingsService(base)
    expect(await service.get()).toEqual(DEFAULT_OBJ)
  })

  it('does not leave a temp file behind after a write', async () => {
    base = await mkdtemp(join(tmpdir(), 'app-settings-'))
    const service = new AppSettingsService(base)
    await service.set({ autoStartKernel: false })
    const leftovers = (await readdir(base)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
