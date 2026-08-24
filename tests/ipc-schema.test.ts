import { describe, it, expect } from 'vitest'
import { parseConfigPatch, parseProxySelection, parseConnectionId } from '@shared/schemas/ipc'
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
})

describe('parseConnectionId', () => {
  it('accepts a non-empty id', () => {
    expect(parseConnectionId('conn-42')).toBe('conn-42')
  })

  it('rejects an empty or non-string id', () => {
    expect(() => parseConnectionId('')).toThrowError(ProtocolError)
    expect(() => parseConnectionId('  ')).toThrowError(ProtocolError)
    expect(() => parseConnectionId(7)).toThrowError(ProtocolError)
  })
})
