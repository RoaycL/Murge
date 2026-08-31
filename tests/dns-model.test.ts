import { describe, it, expect } from 'vitest'
import {
  isIpv4,
  isIpv6,
  isValidIp,
  isValidCidr,
  isValidDomainOrRule,
  isValidNameserver,
  redactServer,
  buildDnsBlock,
  redactDnsEnhancement,
  coerceDnsEnhancement,
  coerceDnsSnapshot,
  EMPTY_DNS_ENHANCEMENT
} from '@shared/dns'

describe('IP validators', () => {
  it('detects valid IPv4', () => {
    expect(isIpv4('1.2.3.4')).toBe(true)
    expect(isIpv4('192.168.0.1')).toBe(true)
    expect(isIpv4('0.0.0.0')).toBe(true)
  })
  it('rejects malformed IPv4', () => {
    expect(isIpv4('256.1.1.1')).toBe(false)
    expect(isIpv4('01.2.3.4')).toBe(false)
    expect(isIpv4('1.2.3')).toBe(false)
    expect(isIpv4('1.2.3.4.5')).toBe(false)
    expect(isIpv4('a.b.c.d')).toBe(false)
  })
  it('detects valid IPv6 including compressed forms', () => {
    expect(isIpv6('::1')).toBe(true)
    expect(isIpv6('2001:db8::1')).toBe(true)
    expect(isIpv6('fe80::')).toBe(true)
    expect(isIpv6('2001:db8:0:0:0:0:0:1')).toBe(true)
  })
  it('rejects malformed IPv6', () => {
    expect(isIpv6(':::1')).toBe(false)
    expect(isIpv6('g::1')).toBe(false)
    expect(isIpv6('2001:db8::1::2')).toBe(false)
    expect(isIpv6('2001:db8')).toBe(false)
    expect(isIpv6('1.2.3.4')).toBe(false)
  })
  it('accepts bracketed IPv6 through isValidIp', () => {
    expect(isValidIp('[::1]')).toBe(true)
    expect(isValidIp('192.168.1.1')).toBe(true)
    expect(isValidIp('[2001:db8::1]')).toBe(true)
  })
})

describe('CIDR validator', () => {
  it('accepts valid IPv4 and IPv6 CIDRs', () => {
    expect(isValidCidr('198.18.0.1/16')).toBe(true)
    expect(isValidCidr('10.0.0.0/8')).toBe(true)
    expect(isValidCidr('2001:db8::/32')).toBe(true)
  })
  it('rejects out-of-range or malformed CIDRs', () => {
    expect(isValidCidr('192.168.1.1/33')).toBe(false)
    expect(isValidCidr('192.168.1.1/-1')).toBe(false)
    expect(isValidCidr('abc')).toBe(false)
    expect(isValidCidr('2001:db8::/129')).toBe(false)
  })
})

describe('domain / rule pattern validator', () => {
  it('accepts hostnames, wildcards and geo rules', () => {
    expect(isValidDomainOrRule('example.com')).toBe(true)
    expect(isValidDomainOrRule('*.example.com')).toBe(true)
    expect(isValidDomainOrRule('*.lan')).toBe(true)
    expect(isValidDomainOrRule('geosite:cn')).toBe(true)
    expect(isValidDomainOrRule('geoip:private')).toBe(true)
  })
  it('rejects invalid patterns', () => {
    expect(isValidDomainOrRule('geosite:')).toBe(false)
    expect(isValidDomainOrRule('*.')).toBe(false)
    expect(isValidDomainOrRule('a_b.com')).toBe(false)
  })
})

describe('nameserver validator', () => {
  it('accepts keywords and allowed schemes', () => {
    expect(isValidNameserver('system')).toBe(true)
    expect(isValidNameserver('default')).toBe(true)
    expect(isValidNameserver('1.1.1.1')).toBe(true)
    expect(isValidNameserver('https://1.1.1.1/dns-query')).toBe(true)
    expect(isValidNameserver('tls://8.8.8.8:853')).toBe(true)
    expect(isValidNameserver('udp://1.1.1.1:53')).toBe(true)
    expect(isValidNameserver('dhcp://lan')).toBe(true)
  })
  it('rejects disallowed or malformed servers', () => {
    expect(isValidNameserver('http://1.1.1.1')).toBe(false)
    expect(isValidNameserver('ftp://x')).toBe(false)
    expect(isValidNameserver('user:pass@tls://8.8.8.8:853')).toBe(false)
    expect(isValidNameserver('')).toBe(false)
    expect(isValidNameserver('https://')).toBe(false)
  })
})

describe('redactServer', () => {
  it('hides userinfo while keeping the scheme and host', () => {
    expect(redactServer('https://user:pass@1.1.1.1/dns-query')).toBe('https://***@1.1.1.1/dns-query')
  })
  it('leaves a plain server untouched', () => {
    expect(redactServer('tls://8.8.8.8:853')).toBe('tls://8.8.8.8:853')
    expect(redactServer('1.1.1.1')).toBe('1.1.1.1')
  })
})

describe('buildDnsBlock', () => {
  it('emits owned scalar keys always and skips empty lists', () => {
    const block = buildDnsBlock({ ...EMPTY_DNS_ENHANCEMENT, enabled: true })
    expect(block.enable).toBe(true)
    expect(block['enhanced-mode']).toBe('fake-ip')
    expect(block.ipv6).toBe(false)
    expect(block['respect-rules']).toBe(false)
    expect(block['fake-ip-range']).toBe('198.18.0.1/16')
    expect(block['fake-ip-filter-mode']).toBe('blacklist')
    expect(block['use-hosts']).toBe(true)
    // Non-empty lists are emitted.
    expect(block['fake-ip-filter']).toEqual(['*.lan', '*.local', 'local'])
    expect(block['default-nameserver']).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(block.nameserver).toEqual(['https://1.1.1.1/dns-query'])
    expect(block.fallback).toEqual(['tls://8.8.8.8:853'])
    // Empty lists are omitted entirely.
    expect(block.hosts).toBeUndefined()
    expect(block['proxy-server-nameserver']).toBeUndefined()
    expect(block['direct-nameserver']).toBeUndefined()
    expect(block['nameserver-policy']).toBeUndefined()
  })

  it('emits hosts and policy as mappings when populated', () => {
    const block = buildDnsBlock({
      ...EMPTY_DNS_ENHANCEMENT,
      enabled: true,
      hosts: [{ domain: 'example.com', address: '1.2.3.4' }],
      nameserverPolicy: [{ domain: 'geosite:cn', server: '1.1.1.1' }]
    })
    expect(block.hosts).toEqual({ 'example.com': '1.2.3.4' })
    expect(block['nameserver-policy']).toEqual({ 'geosite:cn': '1.1.1.1' })
  })
})

describe('coercion', () => {
  it('fills defaults for missing fields', () => {
    const out = coerceDnsEnhancement({ enabled: true })
    expect(out.enabled).toBe(true)
    expect(out.enhancedMode).toBe('fake-ip')
    expect(out.fakeIpRange).toBe('198.18.0.1/16')
    expect(Array.isArray(out.hosts)).toBe(true)
  })
  it('returns the default model for non-object input', () => {
    expect(coerceDnsEnhancement('nope')).toEqual(EMPTY_DNS_ENHANCEMENT)
    expect(coerceDnsEnhancement(null)).toEqual(EMPTY_DNS_ENHANCEMENT)
  })
  it('coerces a snapshot and never throws on garbage', () => {
    expect(coerceDnsSnapshot({ enhancement: { enabled: true } }).enhancement.enabled).toBe(true)
    expect(coerceDnsSnapshot(undefined).enhancement).toEqual(EMPTY_DNS_ENHANCEMENT)
  })
})

describe('redactDnsEnhancement', () => {
  it('redacts every server group but never mutates the input', () => {
    const input = {
      ...EMPTY_DNS_ENHANCEMENT,
      nameserver: ['https://user:pass@1.1.1.1/dns-query'],
      fallback: ['tls://u:p@8.8.8.8:853']
    }
    const redacted = redactDnsEnhancement(input)
    expect(redacted.nameserver[0]).toBe('https://***@1.1.1.1/dns-query')
    expect(redacted.fallback[0]).toBe('tls://***@8.8.8.8:853')
    expect(input.nameserver[0]).toBe('https://user:pass@1.1.1.1/dns-query')
  })
})
