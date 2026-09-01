import { describe, expect, it } from 'vitest'
import {
  buildGeodataBlock,
  coerceGeodataSettings,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  EMPTY_GEODATA_SETTINGS,
  GEOIP_MODES,
  MAX_UPDATE_INTERVAL_HOURS,
  MIN_UPDATE_INTERVAL_HOURS
} from '../src/shared/geodata'

describe('geodata-settings model', () => {
  it('coerces undefined / corrupt input to the safe default', () => {
    expect(coerceGeodataSettings(undefined)).toEqual(EMPTY_GEODATA_SETTINGS)
    expect(coerceGeodataSettings(null)).toEqual(EMPTY_GEODATA_SETTINGS)
    expect(coerceGeodataSettings('not-an-object')).toEqual(EMPTY_GEODATA_SETTINGS)
    expect(coerceGeodataSettings([])).toEqual(EMPTY_GEODATA_SETTINGS)
  })

  it('coerces a complete model and preserves every field', () => {
    const out = coerceGeodataSettings({
      enabled: true,
      geodataMode: true,
      geoipMode: 'memconservative',
      autoUpdate: true,
      updateIntervalHours: 12,
      geoxUrl: 'https://example.com/geodata'
    })
    expect(out).toEqual({
      enabled: true,
      geodataMode: true,
      geoipMode: 'memconservative',
      autoUpdate: true,
      updateIntervalHours: 12,
      geoxUrl: 'https://example.com/geodata'
    })
  })

  it('clamps / falls back on an out-of-range field', () => {
    expect(coerceGeodataSettings({ enabled: true, geoipMode: 'bogus' }).geoipMode).toBe('standard')
    expect(coerceGeodataSettings({ enabled: true, updateIntervalHours: 0 }).updateIntervalHours).toBe(
      DEFAULT_UPDATE_INTERVAL_HOURS
    )
    expect(coerceGeodataSettings({ updateIntervalHours: 1000 }).updateIntervalHours).toBe(
      DEFAULT_UPDATE_INTERVAL_HOURS
    )
    expect(coerceGeodataSettings({ updateIntervalHours: 8.5 }).updateIntervalHours).toBe(
      DEFAULT_UPDATE_INTERVAL_HOURS
    )
  })

  it('drops an invalid source URL and keeps a valid one', () => {
    expect(coerceGeodataSettings({ geoxUrl: 'not-a-url' }).geoxUrl).toBe('')
    expect(coerceGeodataSettings({ geoxUrl: 'ftp://evil' }).geoxUrl).toBe('')
    expect(coerceGeodataSettings({ geoxUrl: 'https://example.com/geodata' }).geoxUrl).toBe(
      'https://example.com/geodata'
    )
  })

  it('exposes the bounded interval and geoip mode values', () => {
    expect(GEOIP_MODES).toEqual(['memconservative', 'standard'])
    expect(MIN_UPDATE_INTERVAL_HOURS).toBe(1)
    expect(MAX_UPDATE_INTERVAL_HOURS).toBe(168)
    expect(DEFAULT_UPDATE_INTERVAL_HOURS).toBe(24)
  })

  it('builds the mihomo geodata keys (omitting an unset source URL)', () => {
    const block = buildGeodataBlock({
      enabled: true,
      geodataMode: true,
      geoipMode: 'memconservative',
      autoUpdate: true,
      updateIntervalHours: 12,
      geoxUrl: 'https://example.com/geodata'
    })
    expect(block).toEqual({
      'geodata-mode': true,
      'geoip-mode': 'memconservative',
      'geo-auto-update': true,
      'geo-update-interval': 12,
      'geo-x-url': 'https://example.com/geodata'
    })
  })

  it('omits geo-x-url when no source URL was set', () => {
    const block = buildGeodataBlock({ ...EMPTY_GEODATA_SETTINGS, enabled: true, geodataMode: true })
    expect(block['geo-x-url']).toBeUndefined()
    expect(block['geodata-mode']).toBe(true)
  })
})
