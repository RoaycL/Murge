import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { applyDnsEnhancementToDocument } from '../src/main/kernel/dns/apply-dns'
import { EMPTY_DNS_ENHANCEMENT } from '@shared/dns'

const BASE = `
port: 7890
mode: rule
dns:
  enable: false
  fallback-filter:
    geoip: true
`

describe('applyDnsEnhancementToDocument', () => {
  it('merges the generated dns block and preserves unknown dns keys', () => {
    const result = applyDnsEnhancementToDocument(BASE, { ...EMPTY_DNS_ENHANCEMENT, enabled: true })
    expect(result.warnings).toEqual([])
    const doc = parse(result.text) as Record<string, unknown>
    const dns = doc.dns as Record<string, unknown>
    expect(dns.enable).toBe(true)
    expect(dns['enhanced-mode']).toBe('fake-ip')
    // Profile key the model does not own is preserved.
    expect(dns['fallback-filter']).toEqual({ geoip: true })
    expect(doc.port).toBe(7890)
    expect(doc.mode).toBe('rule')
  })

  it('returns the base document unchanged when disabled', () => {
    const result = applyDnsEnhancementToDocument(BASE, { ...EMPTY_DNS_ENHANCEMENT, enabled: false })
    expect(result.text).toBe(BASE)
    expect(result.warnings).toEqual([])
  })

  it('sets enable:false when disabled but still owned keys present in the model input', () => {
    // A disabled enhancement must not inject a dns block beyond the base.
    const result = applyDnsEnhancementToDocument(BASE, { ...EMPTY_DNS_ENHANCEMENT })
    expect(result.text).toBe(BASE)
  })

  it('does not write an empty block after clearing a list', () => {
    const result = applyDnsEnhancementToDocument(BASE, {
      ...EMPTY_DNS_ENHANCEMENT,
      enabled: true,
      defaultNameserver: [],
      nameserver: [],
      fallback: [],
      proxyServerNameserver: [],
      directNameserver: [],
      fakeIpFilter: []
    })
    const dns = (parse(result.text) as Record<string, unknown>).dns as Record<string, unknown>
    expect(dns['default-nameserver']).toBeUndefined()
    expect(dns.nameserver).toBeUndefined()
    expect(dns.fallback).toBeUndefined()
    expect(dns['fake-ip-filter']).toBeUndefined()
    expect(dns.enable).toBe(true)
  })

  it('warns and returns the base on an unparseable document', () => {
    const result = applyDnsEnhancementToDocument('[:not: yaml', { ...EMPTY_DNS_ENHANCEMENT, enabled: true })
    expect(result.text).toBe('[:not: yaml')
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
