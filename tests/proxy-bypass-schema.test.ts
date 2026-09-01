import { describe, expect, it } from 'vitest'
import { parseProxyBypassPolicy } from '../src/shared/schemas/ipc'
import { ProtocolError } from '../src/shared/protocol-errors'
import { MAX_CUSTOM_BYPASS_ENTRIES, MAX_CUSTOM_BYPASS_ENTRY_LENGTH } from '../src/shared/proxy-bypass'

const valid = {
  enabled: true,
  customEntries: ['*.example.com', '10.*', 'localhost']
}

describe('proxy-bypass schema', () => {
  it('accepts a complete valid model and trims entries', () => {
    const out = parseProxyBypassPolicy({ ...valid, customEntries: [' *.example.com ', '10.*'] })
    expect(out).toEqual({ enabled: true, customEntries: ['*.example.com', '10.*'] })
  })

  it('accepts a disabled empty model', () => {
    expect(parseProxyBypassPolicy({ enabled: false, customEntries: [] })).toEqual({ enabled: false, customEntries: [] })
  })

  it('rejects an unknown key (strict)', () => {
    expect(() => parseProxyBypassPolicy({ ...valid, extra: 1 })).toThrowError(ProtocolError)
  })

  it('rejects a blank entry (empty after trim)', () => {
    expect(() => parseProxyBypassPolicy({ ...valid, customEntries: ['   '] })).toThrowError(ProtocolError)
    expect(() => parseProxyBypassPolicy({ ...valid, customEntries: [''] })).toThrowError(ProtocolError)
  })

  it('rejects an over-long entry', () => {
    expect(() =>
      parseProxyBypassPolicy({ ...valid, customEntries: ['x'.repeat(MAX_CUSTOM_BYPASS_ENTRY_LENGTH + 1)] })
    ).toThrowError(ProtocolError)
  })

  it('rejects too many entries', () => {
    const entries = Array.from({ length: MAX_CUSTOM_BYPASS_ENTRIES + 1 }, (_, i) => `e${i}.com`)
    expect(() => parseProxyBypassPolicy({ ...valid, customEntries: entries })).toThrowError(ProtocolError)
  })

  it('rejects a non-boolean enabled', () => {
    expect(() => parseProxyBypassPolicy({ ...valid, enabled: 'yes' })).toThrowError(ProtocolError)
  })

  it('rejects missing customEntries', () => {
    expect(() => parseProxyBypassPolicy({ enabled: true })).toThrowError(ProtocolError)
  })

  it('rejects a non-object', () => {
    expect(() => parseProxyBypassPolicy('nope')).toThrowError(ProtocolError)
    expect(() => parseProxyBypassPolicy([])).toThrowError(ProtocolError)
    expect(() => parseProxyBypassPolicy(null)).toThrowError(ProtocolError)
  })
})
