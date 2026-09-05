import { describe, it, expect } from 'vitest'
import {
  isValidPortToken,
  isValidAddressOrCidr,
  isValidDomainOrRule,
  buildSnifferBlock,
  coerceSnifferEnhancement,
  coerceSnifferSnapshot,
  EMPTY_SNIFFER_ENHANCEMENT
} from '@shared/sniffer'

describe('port token validator', () => {
  it('accepts a single port, a range and the wildcard', () => {
    expect(isValidPortToken('80')).toBe(true)
    expect(isValidPortToken('443')).toBe(true)
    expect(isValidPortToken('8080-8880')).toBe(true)
    expect(isValidPortToken('1-65535')).toBe(true)
    expect(isValidPortToken('*')).toBe(true)
  })
  it('rejects out-of-range, reversed or malformed tokens', () => {
    expect(isValidPortToken('0')).toBe(false)
    expect(isValidPortToken('65536')).toBe(false)
    expect(isValidPortToken('70000-80000')).toBe(false)
    expect(isValidPortToken('8880-8080')).toBe(false)
    expect(isValidPortToken('abc')).toBe(false)
    expect(isValidPortToken('')).toBe(false)
    expect(isValidPortToken('80,443')).toBe(false)
  })
})

describe('address / CIDR validator', () => {
  it('accepts a bare IP or a CIDR', () => {
    expect(isValidAddressOrCidr('127.0.0.1/8')).toBe(true)
    expect(isValidAddressOrCidr('::1/128')).toBe(true)
    expect(isValidAddressOrCidr('192.168.1.1')).toBe(true)
  })
  it('rejects malformed values', () => {
    expect(isValidAddressOrCidr('not-an-ip')).toBe(false)
    expect(isValidAddressOrCidr('2001:db8::/129')).toBe(false)
  })
})

describe('domain pattern validator', () => {
  it('accepts hostnames, wildcards and geo rules', () => {
    expect(isValidDomainOrRule('example.com')).toBe(true)
    expect(isValidDomainOrRule('*.example.com')).toBe(true)
    expect(isValidDomainOrRule('geosite:cn')).toBe(true)
  })
  it('rejects invalid patterns', () => {
    expect(isValidDomainOrRule('geosite:')).toBe(false)
    expect(isValidDomainOrRule('a_b.com')).toBe(false)
  })
})

describe('buildSnifferBlock', () => {
  it('emits owned scalar keys always and skips empty lists', () => {
    const block = buildSnifferBlock({ ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true })
    expect(block.enable).toBe(true)
    expect(block['override-destination']).toBe(false)
    expect(block['force-dns-mapping']).toBe(true)
    expect(block['parse-pure-ip']).toBe(true)
    // Non-empty port families are emitted.
    expect((block.sniff as Record<string, unknown>).HTTP).toEqual({ ports: ['80', '8080-8880'] })
    expect((block.sniff as Record<string, unknown>).TLS).toEqual({ ports: ['443', '8443'] })
    expect((block.sniff as Record<string, unknown>).QUIC).toEqual({ ports: ['443'] })
    // Empty lists are omitted entirely.
    expect(block['skip-domain']).toBeUndefined()
    expect(block['force-domain']).toBeUndefined()
  })

  it('omits an empty port family when its list is cleared', () => {
    const block = buildSnifferBlock({
      ...EMPTY_SNIFFER_ENHANCEMENT,
      enabled: true,
      ports: { http: ['80'], tls: [], quic: [] }
    })
    const sniff = block.sniff as Record<string, unknown>
    expect(sniff.HTTP).toEqual({ ports: ['80'] })
    expect(sniff.TLS).toBeUndefined()
    expect(sniff.QUIC).toBeUndefined()
  })

  it('emits domain and address lists when populated', () => {
    const block = buildSnifferBlock({
      ...EMPTY_SNIFFER_ENHANCEMENT,
      enabled: true,
      skipDomain: ['*.local'],
      forceDomain: ['dns.alidns.com'],
      skipSrcAddress: ['127.0.0.1/8'],
      skipDstAddress: ['::1/128']
    })
    expect(block['skip-domain']).toEqual(['*.local'])
    expect(block['force-domain']).toEqual(['dns.alidns.com'])
    expect(block['skip-src-address']).toEqual(['127.0.0.1/8'])
    expect(block['skip-dst-address']).toEqual(['::1/128'])
  })
})

describe('coercion', () => {
  it('fills defaults for missing fields', () => {
    const out = coerceSnifferEnhancement({ enabled: true })
    expect(out.enabled).toBe(true)
    expect(out.overrideDestination).toBe(false)
    expect(out.ports.http).toEqual(['80', '8080-8880'])
    expect(Array.isArray(out.skipDomain)).toBe(true)
  })
  it('returns the default model for non-object input', () => {
    expect(coerceSnifferEnhancement('nope')).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
    expect(coerceSnifferEnhancement(null)).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
  })
  it('honors a present-but-empty list (intentional clear)', () => {
    const out = coerceSnifferEnhancement({ enabled: true, ports: { http: [], tls: [], quic: [] } })
    expect(out.ports.http).toEqual([])
    expect(out.ports.tls).toEqual([])
    expect(out.ports.quic).toEqual([])
  })
  it('coerces a snapshot and never throws on garbage', () => {
    expect(coerceSnifferSnapshot({ enhancement: { enabled: true } }).enhancement.enabled).toBe(true)
    expect(coerceSnifferSnapshot(undefined).enhancement).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
  })
})
