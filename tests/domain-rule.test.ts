import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildDomainRuleOverride, normalizeRuleDomain } from '../src/shared/domain-rule'

describe('connection domain rule', () => {
  it('builds a previewable exact or suffix rule from a connection host', () => {
    const exact = buildDomainRuleOverride({ host: 'API.Example.COM.', match: 'exact', target: 'DIRECT' })
    expect(exact.rule).toBe('DOMAIN,api.example.com,DIRECT')
    expect(parse(exact.content)).toEqual({ '+rules': [exact.rule] })
    expect(buildDomainRuleOverride({ host: 'example.com', match: 'suffix', target: 'Proxy' }).rule)
      .toBe('DOMAIN-SUFFIX,example.com,Proxy')
  })

  it('rejects IP addresses, injected YAML and missing process metadata', () => {
    for (const host of ['', '192.0.2.1', '[::1]', 'x.com,REJECT', 'x.com\nmode: direct', 'https://x.com']) {
      expect(normalizeRuleDomain(host)).toBeNull()
    }
  })
})
