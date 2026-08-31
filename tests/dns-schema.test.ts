import { describe, it, expect } from 'vitest'
import { parseDnsEnhancement } from '@shared/schemas/ipc'
import { ProtocolError } from '@shared/protocol-errors'
import { EMPTY_DNS_ENHANCEMENT } from '@shared/dns'

function complete(): typeof EMPTY_DNS_ENHANCEMENT {
  return { ...EMPTY_DNS_ENHANCEMENT, enabled: true }
}

describe('parseDnsEnhancement', () => {
  it('accepts a complete valid model', () => {
    expect(parseDnsEnhancement(complete())).toEqual(complete())
  })

  it('rejects an invalid CIDR for fakeIpRange', () => {
    expect(() => parseDnsEnhancement({ ...complete(), fakeIpRange: 'not-a-cidr' })).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement({ ...complete(), fakeIpRange: '192.168.1.1/99' })).toThrowError(ProtocolError)
  })

  it('rejects an invalid nameserver', () => {
    expect(() => parseDnsEnhancement({ ...complete(), nameserver: ['http://1.1.1.1'] })).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement({ ...complete(), nameserver: ['ftp://evil'] })).toThrowError(ProtocolError)
  })

  it('rejects a bad domain pattern in fakeIpFilter or policy', () => {
    expect(() => parseDnsEnhancement({ ...complete(), fakeIpFilter: ['a_b.com'] })).toThrowError(ProtocolError)
    expect(() =>
      parseDnsEnhancement({ ...complete(), nameserverPolicy: [{ domain: 'geosite:', server: '1.1.1.1' }] })
    ).toThrowError(ProtocolError)
  })

  it('rejects unknown keys and non-objects', () => {
    expect(() => parseDnsEnhancement({ ...complete(), surprise: true })).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement('nope')).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement(null)).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement(['enabled'])).toThrowError(ProtocolError)
  })

  it('rejects a bad enum value', () => {
    expect(() => parseDnsEnhancement({ ...complete(), enhancedMode: 'bogus' })).toThrowError(ProtocolError)
    expect(() => parseDnsEnhancement({ ...complete(), fakeIpFilterMode: 'bogus' })).toThrowError(ProtocolError)
  })
})
