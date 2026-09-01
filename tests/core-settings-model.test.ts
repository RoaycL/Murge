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
      findProcessMode: 'strict'
    })
    expect(out).toEqual({
      enabled: true,
      logLevel: 'warning',
      ipv6: true,
      tcpConcurrent: false,
      unifiedDelay: true,
      findProcessMode: 'strict'
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
      enabled: true,
      logLevel: 'error',
      ipv6: false,
      tcpConcurrent: true,
      unifiedDelay: true,
      findProcessMode: 'always'
    })
    expect(block).toEqual({
      'log-level': 'error',
      ipv6: false,
      'tcp-concurrent': true,
      'unified-delay': true,
      'find-process-mode': 'always'
    })
  })
})
