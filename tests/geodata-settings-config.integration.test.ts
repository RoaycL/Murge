import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { buildProfileKernelConfig } from '../src/main/kernel/profile-kernel-config'
import type { GeodataSettings } from '../src/shared/geodata'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'

const SECRET = 'a'.repeat(64)

/** A profile that deliberately sets its own geodata keys, to prove conflict handling. */
const PROFILE = [
  'mixed-port: 7890',
  'geodata-mode: false',
  'geoip-mode: standard',
  'geo-auto-update: true',
  'geo-update-interval: 48',
  'geo-x-url: https://profile.example.com/geodata',
  'allow-lan: true',
  'external-controller: 0.0.0.0:9090',
  'proxies:',
  '  - name: P1',
  '    type: ss',
  '    server: 1.2.3.4',
  '    port: 443',
  '    cipher: aes-256-gcm',
  '    password: secret',
  'rules:',
  '  - MATCH,DIRECT',
  ''
].join('\n')

const ENABLED: GeodataSettings = {
  ...EMPTY_GEODATA_SETTINGS,
  enabled: true,
  geodataMode: true,
  geoipMode: 'memconservative',
  autoUpdate: false,
  updateIntervalHours: 12,
  geoxUrl: 'https://controlled.example.com/geodata'
}

function build(geodata?: GeodataSettings): Record<string, unknown> {
  return parse(buildProfileKernelConfig(PROFILE, { mixedPort: 2080, controllerPort: 2090, secret: SECRET, geodata }))
}

describe('controlled geodata settings config integration', () => {
  it('read-back: an enabled model is authoritative in the runtime config', () => {
    const out = build(ENABLED)
    expect(out['geodata-mode']).toBe(true)
    expect(out['geodata-loader']).toBe('memconservative')
    expect(out['geo-auto-update']).toBe(false)
    expect(out['geo-update-interval']).toBe(12)
    expect(out['geox-url']).toEqual(ENABLED.geoxUrls)
  })

  it('conflict handling: an enabled model overrides the profile own keys', () => {
    const out = build(ENABLED)
    expect(out['geodata-mode']).not.toBe(false)
    expect(out['geodata-loader']).not.toBe('standard')
    expect(out['geo-auto-update']).not.toBe(true)
    expect(out['geo-update-interval']).not.toBe(48)
  })

  it('disabled / absent model preserves the profile own geodata keys', () => {
    const disabled = build({ ...EMPTY_GEODATA_SETTINGS, enabled: false, geodataMode: true, autoUpdate: true })
    expect(disabled['geodata-mode']).toBe(false)
    expect(disabled['geoip-mode']).toBe('standard')
    expect(disabled['geo-auto-update']).toBe(true)
    expect(disabled['geo-update-interval']).toBe(48)

    const absent = build()
    expect(absent['geodata-mode']).toBe(false)
    expect(absent['geo-x-url']).toBe('https://profile.example.com/geodata')
  })

  it('writes the controlled geox-url database map', () => {
    const out = build({ ...ENABLED, geoxUrl: '' })
    expect(out['geox-url']).toEqual(ENABLED.geoxUrls)
    // The always-owned keys still reflect the model.
    expect(out['geodata-mode']).toBe(true)
  })

  it('still enforces the main-kernel safety boundary alongside geodata settings', () => {
    const out = build(ENABLED)
    expect(out['allow-lan']).toBe(false)
    expect(out['bind-address']).toBe('127.0.0.1')
    expect(out['external-controller']).toBe('127.0.0.1:2090')
    expect(out['mixed-port']).toBe(2080)
    expect(out.tun).toBeUndefined()
  })
})
