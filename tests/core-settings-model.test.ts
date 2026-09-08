import { describe, expect, it } from 'vitest'
import {
  buildCoreSettingsBlock,
  coerceCoreSettings,
  EMPTY_CORE_SETTINGS,
  FIND_PROCESS_MODES,
  MIHOMO_LOG_LEVELS
} from '../src/shared/core-settings'

describe('core-settings model', () => {
  it('coerces undefined / corrupt input to the safe default', () => {
    expect(coerceCoreSettings(undefined)).toEqual(EMPTY_CORE_SETTINGS)
    expect(coerceCoreSettings(null)).toEqual(EMPTY_CORE_SETTINGS)
    expect(coerceCoreSettings('not-an-object')).toEqual(EMPTY_CORE_SETTINGS)
    expect(coerceCoreSettings([])).toEqual(EMPTY_CORE_SETTINGS)
  })

  it('coerces a complete model and preserves every field', () => {
    const out = coerceCoreSettings({
      enabled: true,
      logLevel: 'warning',
      ipv6: true,
      tcpConcurrent: false,
      unifiedDelay: true,
      storeSelected: true,
      storeFakeIp: true,
      findProcessMode: 'strict',
      interfaceName: 'Ethernet',
      mixedPort: 7890,
      socksPort: 7891,
      httpPort: 7892,
      controllerHost: '0.0.0.0',
      controllerPort: 9090,
      controllerSecret: 'a'.repeat(64),
      controllerPanel: true,
      allowLan: true
    })
    expect(out).toEqual({
      enabled: true,
      logLevel: 'warning',
      ipv6: true,
      tcpConcurrent: false,
      unifiedDelay: true,
      storeSelected: true,
      storeFakeIp: true,
      findProcessMode: 'strict',
      interfaceName: 'Ethernet',
      mixedPort: 7890,
      socksPort: 7891,
      httpPort: 7892,
      controllerHost: '0.0.0.0',
      controllerPort: 9090,
      controllerSecret: 'a'.repeat(64),
      controllerPanel: true,
      allowLan: true
    })
  })

  it('falls back per-field on a bad enum value', () => {
    const out = coerceCoreSettings({
      enabled: true,
      logLevel: 'loud',
      findProcessMode: 'always2'
    })
    expect(out.logLevel).toBe('info')
    expect(out.findProcessMode).toBe('off')
    expect(out.enabled).toBe(true)
  })

  it('exposes the mihomo-accurate value sets', () => {
    expect(MIHOMO_LOG_LEVELS).toEqual(['silent', 'error', 'warning', 'info', 'debug'])
    expect(FIND_PROCESS_MODES).toEqual(['off', 'strict', 'always'])
  })

  it('builds the mihomo core keys from the model', () => {
    const block = buildCoreSettingsBlock({
      ...EMPTY_CORE_SETTINGS,
      enabled: true,
      logLevel: 'error',
      ipv6: false,
      tcpConcurrent: true,
      unifiedDelay: true,
      findProcessMode: 'always',
      interfaceName: 'Ethernet'
    })
    expect(block).toEqual({
      'log-level': 'error',
      ipv6: false,
      'tcp-concurrent': true,
      'unified-delay': true,
      profile: { 'store-selected': true, 'store-fake-ip': true },
      'find-process-mode': 'always',
      'interface-name': 'Ethernet'
    })
  })

  it('repairs duplicate listener ports as one safe default block', () => {
    expect(coerceCoreSettings({ mixedPort: 7890, socksPort: 7890, controllerPort: 9090 })).toMatchObject({
      mixedPort: 7890,
      socksPort: 7891,
      httpPort: 7892,
      controllerPort: 9090
    })
  })
})
