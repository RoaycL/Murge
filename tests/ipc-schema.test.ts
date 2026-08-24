import { describe, it, expect } from 'vitest'
import { parseConfigPatch, parseProxySelection, parseConnectionId, parseMihomoName, parseDelayOptions } from '@shared/schemas/ipc'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

describe('parseConfigPatch', () => {
  it('accepts a valid known patch', () => {
    const patch = { mode: 'rule', 'allow-lan': true }
    expect(parseConfigPatch(patch)).toEqual(patch)
  })

  it('accepts an empty patch', () => {
    expect(parseConfigPatch({})).toEqual({})
  })

  it('rejects an unknown key', () => {
    expect(() => parseConfigPatch({ mode: 'rule', unexpected: 'x' })).toThrowError(ProtocolError)
  })

  it('rejects tun: renderer must not forward arbitrary TUN config', () => {
    expect(() => parseConfigPatch({ tun: { enable: true, 'stack': 'mixed' } })).toThrowError(ProtocolError)
  })

  it('rejects a non-object', () => {
    expect(() => parseConfigPatch('nope')).toThrowError(ProtocolError)
    expect(() => parseConfigPatch(null)).toThrowError(ProtocolError)
    expect(() => parseConfigPatch(['mode'])).toThrowError(ProtocolError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseConfigPatch({ port: 70000 })).toThrowError(ProtocolError)
    expect(() => parseConfigPatch({ 'socks-port': -1 })).toThrowError(ProtocolError)
  })

  it('rejects an invalid mode value', () => {
    expect(() => parseConfigPatch({ mode: 'bogus' })).toThrowError(ProtocolError)
  })

  it('surfaces the typed code', () => {
    try {
      parseConfigPatch({ mode: 'bogus' })
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_ARGUMENT)
    }
  })
})

describe('parseProxySelection', () => {
  it('accepts a valid group and name', () => {
    expect(parseProxySelection('Proxy', 'HK-01')).toEqual({ group: 'Proxy', name: 'HK-01' })
  })

  it('rejects an empty group or name', () => {
    expect(() => parseProxySelection('', 'x')).toThrowError(ProtocolError)
    expect(() => parseProxySelection('g', '   ')).toThrowError(ProtocolError)
  })

  it('rejects non-string inputs', () => {
    expect(() => parseProxySelection(1, 'x')).toThrowError(ProtocolError)
    expect(() => parseProxySelection('x', null)).toThrowError(ProtocolError)
  })

  it('does not rewrite exact identifiers', () => {
    // Leading/trailing spaces are preserved: mihomo names are exact identifiers.
    expect(parseProxySelection(' Proxy ', ' HK-01 ')).toEqual({ group: ' Proxy ', name: ' HK-01 ' })
  })
})

describe('parseConnectionId', () => {
  it('accepts a non-empty id', () => {
    expect(parseConnectionId('conn-42')).toBe('conn-42')
  })

  it('does not rewrite the id', () => {
    expect(parseConnectionId(' conn-1 ')).toBe(' conn-1 ')
  })

  it('rejects an empty or non-string id', () => {
    expect(() => parseConnectionId('')).toThrowError(ProtocolError)
    expect(() => parseConnectionId('  ')).toThrowError(ProtocolError)
    expect(() => parseConnectionId(7)).toThrowError(ProtocolError)
  })
})

describe('parseMihomoName', () => {
  it('accepts a non-empty name preserving spaces', () => {
    expect(parseMihomoName('香港 01')).toBe('香港 01')
  })

  it('rejects empty, whitespace-only and non-string names', () => {
    expect(() => parseMihomoName('')).toThrowError(ProtocolError)
    expect(() => parseMihomoName('   ')).toThrowError(ProtocolError)
    expect(() => parseMihomoName(1)).toThrowError(ProtocolError)
  })
})

describe('parseDelayOptions', () => {
  it('accepts undefined and returns an empty object', () => {
    expect(parseDelayOptions(undefined)).toEqual({})
  })

  it('accepts a valid timeout', () => {
    expect(parseDelayOptions({ timeout: 2000 })).toEqual({ timeout: 2000 })
  })

  it('rejects a probe URL: the renderer must not control which URL mihomo fetches', () => {
    expect(() => parseDelayOptions({ timeout: 2000, url: 'https://example.com' })).toThrowError(ProtocolError)
  })

  it('rejects a timeout outside the 1000-30000ms REST window', () => {
    expect(() => parseDelayOptions({ timeout: 999 })).toThrowError(ProtocolError)
    expect(() => parseDelayOptions({ timeout: 30001 })).toThrowError(ProtocolError)
  })

  it('rejects a non-positive or non-integer timeout', () => {
    expect(() => parseDelayOptions({ timeout: 0 })).toThrowError(ProtocolError)
    expect(() => parseDelayOptions({ timeout: -1 })).toThrowError(ProtocolError)
    expect(() => parseDelayOptions({ timeout: 1.5 })).toThrowError(ProtocolError)
  })

  it('rejects unknown keys and non-objects', () => {
    expect(() => parseDelayOptions({ nope: 1 })).toThrowError(ProtocolError)
    expect(() => parseDelayOptions('x')).toThrowError(ProtocolError)
    expect(() => parseDelayOptions(null)).toThrowError(ProtocolError)
  })
})
