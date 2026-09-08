import { describe, it, expect } from 'vitest'
import { parseProviderCatalog } from '../src/main/profiles/provider-configs'

const DOC = `
proxies: []
proxy-groups: []
proxy-providers:
  机场 A:
    type: http
    url: "https://sub.example.com/a"
    interval: 86400
    path: ./providers/a.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
  机场 B:
    type: file
    path: ./providers/b.yaml
rule-providers:
  规则集 A:
    type: http
    behavior: classical
    format: text
    url: "https://rules.example.com/a.txt"
    interval: 43200
  本地规则:
    type: file
    behavior: domain
`
describe('parseProviderCatalog', () => {
  it('extracts proxy/rule provider declarations with url, interval, path, behavior, format and health-check url', () => {
    const catalog = parseProviderCatalog(DOC)
    expect(catalog.proxy).toEqual([
      {
        name: '机场 A',
        kind: 'proxy',
        url: 'https://sub.example.com/a',
        path: './providers/a.yaml',
        interval: 86400,
        testUrl: 'https://www.gstatic.com/generate_204'
      },
      { name: '机场 B', kind: 'proxy', path: './providers/b.yaml' }
    ])
    expect(catalog.rule).toEqual([
      {
        name: '规则集 A',
        kind: 'rule',
        url: 'https://rules.example.com/a.txt',
        interval: 43200,
        behavior: 'classical',
        format: 'text'
      },
      { name: '本地规则', kind: 'rule', behavior: 'domain' }
    ])
  })

  it('returns an empty catalog for empty, section-less or malformed documents', () => {
    expect(parseProviderCatalog('')).toEqual({ proxy: [], rule: [] })
    expect(parseProviderCatalog('proxies: []')).toEqual({ proxy: [], rule: [] })
    expect(parseProviderCatalog('proxy-providers: [broken')).toEqual({ proxy: [], rule: [] })
  })

  it('skips entries without a scalar name but keeps the well-formed siblings', () => {
    const doc = `
proxy-providers:
  ? [complex, key]
  : type: http
  ok:
    type: http
    url: "https://x.example.com"
`
    const catalog = parseProviderCatalog(doc)
    expect(catalog.proxy.map((entry) => entry.name)).toEqual(['ok'])
  })

  it('ignores unknown keys instead of failing the whole section', () => {
    const doc = `
rule-providers:
  r1:
    type: http
    behavior: domain
    url: "https://x"
    future-field: whatever
`
    expect(parseProviderCatalog(doc).rule).toEqual([
      { name: 'r1', kind: 'rule', url: 'https://x', behavior: 'domain' }
    ])
  })

  it('resolves YAML merge-key fields exactly like the runtime builder', () => {
    const doc = `
proxy-base: &proxy-base
  type: http
  interval: 3600
  health-check:
    enable: true
    url: https://example.com/ping
rule-base: &rule-base
  type: http
  behavior: classical
  format: yaml
  interval: 7200
proxy-providers:
  airport:
    <<: *proxy-base
    url: https://example.com/sub
rule-providers:
  rules:
    <<: *rule-base
    url: https://example.com/rules
`
    expect(parseProviderCatalog(doc)).toEqual({
      proxy: [{ name: 'airport', kind: 'proxy', url: 'https://example.com/sub', interval: 3600, testUrl: 'https://example.com/ping' }],
      rule: [{ name: 'rules', kind: 'rule', url: 'https://example.com/rules', interval: 7200, behavior: 'classical', format: 'yaml' }]
    })
  })
})
