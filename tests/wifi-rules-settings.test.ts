import { describe, expect, it } from 'vitest'
import { parseAppSettings, parseSsidList, parseWifiProfileRules } from '../src/shared/app-settings'
import { parseAppSettingsPatch } from '../src/shared/schemas/ipc'

describe('Wi-Fi rule settings', () => {
  it('cleans SSID lists like the Rust store', () => {
    expect(parseSsidList([' Office ', '', 'Office', 3, 'x'.repeat(33), 'Cafe'])).toEqual(['Office', 'Cafe'])
    expect(parseSsidList('bad')).toEqual([])
  })

  it('keeps one complete rule per SSID', () => {
    expect(parseWifiProfileRules([
      { ssid: 'Office', profileId: 'p1' },
      { ssid: 'Office', profileId: 'p2' },
      { ssid: 'Home' },
      { ssid: 'Lab', profileId: 'p3' }
    ])).toEqual([{ ssid: 'Office', profileId: 'p1' }, { ssid: 'Lab', profileId: 'p3' }])
  })

  it('defaults to no rules and auto-close on', () => {
    const settings = parseAppSettings('{}')
    expect(settings.wifiDirectSsids).toEqual([])
    expect(settings.wifiProfileRules).toEqual([])
    expect(settings.autoCloseConnections).toBe(true)
    expect(settings.wifiRulesEnabled).toBe(true)
  })

  it('validates the patch shape', () => {
    expect(parseAppSettingsPatch({ wifiDirectSsids: ['Office', 'Office'] })).toEqual({ wifiDirectSsids: ['Office'] })
    expect(() => parseAppSettingsPatch({ wifiDirectSsids: 'Office' })).toThrow()
  })
})
