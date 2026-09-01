import { describe, expect, it } from 'vitest'
import { parseGeodataSettings } from '../src/shared/schemas/ipc'
import { ProtocolError } from '../src/shared/protocol-errors'

const valid = {
  enabled: true,
  geodataMode: true,
  geoipMode: 'memconservative',
  autoUpdate: true,
  updateIntervalHours: 12,
  geoxUrl: 'https://example.com/geodata'
}

describe('geodata-settings schema', () => {
  it('accepts a complete valid model', () => {
    expect(parseGeodataSettings(valid)).toEqual(valid)
  })

  it('accepts an empty source URL', () => {
    expect(parseGeodataSettings({ ...valid, geoxUrl: '' }).geoxUrl).toBe('')
  })

  it('rejects an unknown key (strict)', () => {
    expect(() => parseGeodataSettings({ ...valid, extra: 1 })).toThrowError(ProtocolError)
  })

  it('rejects an invalid geoip mode', () => {
    expect(() => parseGeodataSettings({ ...valid, geoipMode: 'bogus' })).toThrowError(ProtocolError)
  })

  it('rejects an out-of-range / fractional update interval', () => {
    expect(() => parseGeodataSettings({ ...valid, updateIntervalHours: 0 })).toThrowError(ProtocolError)
    expect(() => parseGeodataSettings({ ...valid, updateIntervalHours: 999 })).toThrowError(ProtocolError)
    expect(() => parseGeodataSettings({ ...valid, updateIntervalHours: 8.5 })).toThrowError(ProtocolError)
  })

  it('rejects a non-http(s) source URL', () => {
    expect(() => parseGeodataSettings({ ...valid, geoxUrl: 'ftp://evil' })).toThrowError(ProtocolError)
    expect(() => parseGeodataSettings({ ...valid, geoxUrl: 'not-a-url' })).toThrowError(ProtocolError)
  })

  it('rejects a non-object', () => {
    expect(() => parseGeodataSettings('nope')).toThrowError(ProtocolError)
    expect(() => parseGeodataSettings([])).toThrowError(ProtocolError)
  })
})
