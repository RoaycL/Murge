import { describe, expect, it } from 'vitest'
import {
  defaultNetworkMetadataProviderId,
  getNetworkMetadataProvider,
  networkMetadataCopyText,
  networkMetadataDisplayText,
  networkMetadataMaskIp,
  networkMetadataProviderList,
  parseNetworkMetadataJson
} from '../src/shared/network-metadata'

const NOW = 1_700_000_000_000

describe('network-metadata model', () => {
  describe('provider registry', () => {
    it('lists the shipped privacy-explicit providers (function-free)', () => {
      const providers = networkMetadataProviderList()
      expect(providers.map((provider) => provider.id)).toEqual(['ipwhois', 'ipapi', 'ipinfo'])
      for (const provider of providers) {
        expect(provider.kind).toBe('ip-geo')
        expect(provider.endpoint).toMatch(/^http:\/\//)
        // The serialized shape must carry no function or user-data fields.
        expect(Object.keys(provider).sort()).toEqual(['description', 'endpoint', 'id', 'kind', 'label'])
      }
    })

    it('resolves a provider by id and rejects unknown ids', () => {
      expect(getNetworkMetadataProvider('ipapi')?.id).toBe('ipapi')
      expect(getNetworkMetadataProvider('nope')).toBeNull()
    })

    it('returns a default provider that is always present', () => {
      const id = defaultNetworkMetadataProviderId()
      expect(getNetworkMetadataProvider(id)).not.toBeNull()
    })
  })

  describe('parseNetworkMetadataJson', () => {
    it('parses an ipwho.is body with a numeric ASN', () => {
      const metadata = parseNetworkMetadataJson(
        {
          ip: '203.0.113.5',
          success: true,
          country: 'United States',
          city: 'New York',
          connection: { asn: 7922, isp: 'Comcast Cable' }
        },
        'ipwhois',
        NOW
      )
      expect(metadata).toMatchObject({ ip: '203.0.113.5', provider: 'ipwhois', country: 'United States', city: 'New York', asn: 'AS7922', fetchedAt: NOW })
    })

    it('parses an ip-api.com body and normalizes an AS string', () => {
      const metadata = parseNetworkMetadataJson(
        { status: 'success', query: '198.51.100.9', country: 'Japan', city: 'Tokyo', as: 'AS4134 China Telecom Backbone' },
        'ipapi',
        NOW
      )
      expect(metadata).toMatchObject({ ip: '198.51.100.9', provider: 'ipapi', country: 'Japan', city: 'Tokyo', asn: 'AS4134' })
    })

    it('parses an ipinfo.io body via the org field', () => {
      const metadata = parseNetworkMetadataJson(
        { ip: '192.0.2.44', country: 'DE', city: 'Frankfurt', org: 'AS24940 Hetzner Online GmbH' },
        'ipinfo',
        NOW
      )
      expect(metadata).toMatchObject({ ip: '192.0.2.44', country: 'DE', city: 'Frankfurt', asn: 'AS24940' })
    })

    it('returns null for an error or unusable body', () => {
      expect(parseNetworkMetadataJson({ success: false, message: 'rate limited' }, 'ipwhois', NOW)).toBeNull()
      expect(parseNetworkMetadataJson({ status: 'fail', message: 'reserved range' }, 'ipapi', NOW)).toBeNull()
      expect(parseNetworkMetadataJson('not-an-object', 'ipinfo', NOW)).toBeNull()
    })

    it('requires a resolvable IP field', () => {
      expect(parseNetworkMetadataJson({ success: true, country: 'US' }, 'ipwhois', NOW)).toBeNull()
    })

    it('returns null for an unknown provider id', () => {
      expect(parseNetworkMetadataJson({ ip: '1.2.3.4' }, 'nope', NOW)).toBeNull()
    })
  })

  describe('display and copy text', () => {
    const metadata = parseNetworkMetadataJson(
      { ip: '203.0.113.5', success: true, country: 'United States', city: 'New York', connection: { asn: 7922 } },
      'ipwhois',
      NOW
    )!

    it('renders a compact display line', () => {
      expect(networkMetadataDisplayText(metadata)).toBe('203.0.113.5 · United States · New York · AS7922')
    })

    it('renders a privacy-safe copy line', () => {
      expect(networkMetadataCopyText(metadata)).toBe('203.0.113.5 (United States, New York) AS7922')
    })
  })

  describe('masking', () => {
    it('masks the last octet of an IPv4 address', () => {
      expect(networkMetadataMaskIp('203.0.113.5')).toBe('203.0.113.•••')
    })

    it('masks the trailing hextet of an IPv6 address', () => {
      const masked = networkMetadataMaskIp('2001:db8::1')
      expect(masked.endsWith('•••')).toBe(true)
      expect(masked.startsWith('2001:db8::')).toBe(true)
    })

    it('leaves a non-network value untouched', () => {
      expect(networkMetadataMaskIp('unknown')).toBe('unknown')
    })
  })
})
