import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeodataSettingsService, GEODATA_SETTINGS_FILE } from '../src/main/kernel/geodata-settings-service'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'geodata-settings-'))
}

describe('GeodataSettingsService', () => {
  it('returns safe defaults before anything is persisted', async () => {
    const dir = await makeDir()
    const service = new GeodataSettingsService(dir)
    expect(await service.get()).toEqual(EMPTY_GEODATA_SETTINGS)
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await makeDir()
    const service = new GeodataSettingsService(dir)
    const saved = await service.set({
      ...EMPTY_GEODATA_SETTINGS,
      enabled: true,
      geodataMode: true,
      autoUpdate: true,
      updateIntervalHours: 6
    })
    expect(saved.enabled).toBe(true)
    expect(saved.geodataMode).toBe(true)
    expect(saved.updateIntervalHours).toBe(6)

    const reloaded = new GeodataSettingsService(dir)
    const reloadedSettings = await reloaded.get()
    expect(reloadedSettings).toEqual(saved)

    const raw = await readFile(join(dir, GEODATA_SETTINGS_FILE), 'utf8')
    expect(JSON.parse(raw).enabled).toBe(true)
  })

  it('coerces a stale or hand-edited file instead of crashing', async () => {
    const dir = await makeDir()
    const service = new GeodataSettingsService(dir)
    await service.set(EMPTY_GEODATA_SETTINGS)
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(dir, GEODATA_SETTINGS_FILE), '{not json', 'utf8')
    )
    const reloaded = new GeodataSettingsService(dir)
    expect(await reloaded.get()).toEqual(EMPTY_GEODATA_SETTINGS)
  })

  it('renders a yaml preview of the mihomo geodata keys', async () => {
    const dir = await makeDir()
    const service = new GeodataSettingsService(dir)
    const preview = service.preview({
      ...EMPTY_GEODATA_SETTINGS,
      enabled: true,
      geodataMode: true,
      geoipMode: 'memconservative',
      autoUpdate: true,
      updateIntervalHours: 12,
      geoxUrl: 'https://example.com/geodata'
    })
    expect(preview).toContain('geodata-mode: true')
    expect(preview).toContain('geodata-loader: memconservative')
    expect(preview).toContain('geo-auto-update: true')
    expect(preview).toContain('geo-update-interval: 12')
    expect(preview).toContain('geox-url:')
    expect(preview).toContain('GeoLite2-ASN.mmdb')
  })
})
