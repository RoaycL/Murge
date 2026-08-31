import { describe, it, expect } from 'vitest'
import { parseSnifferEnhancement } from '@shared/schemas/ipc'
import { ProtocolError } from '@shared/protocol-errors'
import { EMPTY_SNIFFER_ENHANCEMENT } from '@shared/sniffer'

function complete(): typeof EMPTY_SNIFFER_ENHANCEMENT {
  return { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true }
}

describe('parseSnifferEnhancement', () => {
  it('accepts a complete valid model', () => {
    expect(parseSnifferEnhancement(complete())).toEqual(complete())
  })

  it('rejects an invalid port token', () => {
    expect(() => parseSnifferEnhancement({ ...complete(), ports: { http: ['abc'], tls: ['443'], quic: ['443'] } })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement({ ...complete(), ports: { http: ['0'], tls: ['443'], quic: ['443'] } })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement({ ...complete(), ports: { http: ['8880-8080'], tls: ['443'], quic: ['443'] } })).toThrowError(ProtocolError)
  })

  it('rejects a bad domain pattern', () => {
    expect(() => parseSnifferEnhancement({ ...complete(), skipDomain: ['a_b.com'] })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement({ ...complete(), forceDomain: ['geosite:'] })).toThrowError(ProtocolError)
  })

  it('rejects a bad address CIDR', () => {
    expect(() => parseSnifferEnhancement({ ...complete(), skipSrcAddress: ['not-an-ip'] })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement({ ...complete(), skipDstAddress: ['2001:db8::/129'] })).toThrowError(ProtocolError)
  })

  it('rejects unknown keys and non-objects', () => {
    expect(() => parseSnifferEnhancement({ ...complete(), surprise: true })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement('nope')).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement(null)).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement(['enabled'])).toThrowError(ProtocolError)
  })

  it('rejects a bad boolean/non-boolean flag', () => {
    expect(() => parseSnifferEnhancement({ ...complete(), parsePureIp: 'yes' })).toThrowError(ProtocolError)
    expect(() => parseSnifferEnhancement({ ...complete(), forceDnsMapping: 1 })).toThrowError(ProtocolError)
  })
})
