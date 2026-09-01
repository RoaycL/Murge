import { describe, expect, it } from 'vitest'
import { parseNetworkMetadataProviderId } from '../src/shared/schemas/ipc'
import { ProtocolError } from '../src/shared/protocol-errors'

describe('network-metadata schema', () => {
  describe('parseNetworkMetadataProviderId', () => {
    it('accepts each shipped provider id', () => {
      expect(parseNetworkMetadataProviderId('ipwhois')).toBe('ipwhois')
      expect(parseNetworkMetadataProviderId('ipapi')).toBe('ipapi')
      expect(parseNetworkMetadataProviderId('ipinfo')).toBe('ipinfo')
    })

    it('rejects an unknown or malformed provider id', () => {
      expect(() => parseNetworkMetadataProviderId('nope')).toThrowError(ProtocolError)
      expect(() => parseNetworkMetadataProviderId('')).toThrowError(ProtocolError)
      expect(() => parseNetworkMetadataProviderId(1)).toThrowError(ProtocolError)
      expect(() => parseNetworkMetadataProviderId(null)).toThrowError(ProtocolError)
      expect(() => parseNetworkMetadataProviderId({})).toThrowError(ProtocolError)
    })
  })
})
