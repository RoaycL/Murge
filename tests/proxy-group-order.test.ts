import { describe, expect, it } from 'vitest'
import { parseProxyGroupOrder, parseProxyGroupTestUrls } from '../src/main/profiles/proxy-group-order'

describe('parseProxyGroupOrder', () => {
  it('returns proxy-group names in document order', () => {
    const document = [
      'mode: rule',
      'proxies:',
      '  - name: node-a',
      '    type: socks5',
      '    server: 127.0.0.1',
      '    port: 1080',
      'proxy-groups:',
      '  - name: 最后组',
      '    type: select',
      '    proxies: [node-a]',
      '  - name: GLOBAL',
      '    type: select',
      '    proxies: [node-a]',
      '  - name: alpha-group',
      '    type: select',
      '    proxies: [node-a]',
      'rules:',
      '  - MATCH,DIRECT'
    ].join('\n')
    // Deliberately NOT alphabetical: a sort anywhere would flip the assertion.
    expect(parseProxyGroupOrder(document)).toEqual(['最后组', 'GLOBAL', 'alpha-group'])
  })

  it('ignores non-group sections and keeps only proxy-groups entries', () => {
    const document = [
      'proxies:',
      '  - name: node-a',
      '    type: socks5',
      '    server: 127.0.0.1',
      '    port: 1080',
      'proxy-groups:',
      '  - name: 真组',
      '    type: select',
      '    proxies: [node-a]',
      'rule-providers:',
      '  - name: 不是组'
    ].join('\n')
    expect(parseProxyGroupOrder(document)).toEqual(['真组'])
  })

  it('returns [] for a document without proxy-groups', () => {
    expect(parseProxyGroupOrder('mode: direct\nrules:\n  - MATCH,DIRECT\n')).toEqual([])
  })

  it('returns [] for empty input', () => {
    expect(parseProxyGroupOrder('')).toEqual([])
    expect(parseProxyGroupOrder('   \n  ')).toEqual([])
  })

  it('returns [] for malformed YAML instead of throwing', () => {
    expect(parseProxyGroupOrder('proxy-groups: [unclosed\n  bad: : : yaml')).toEqual([])
  })

  it('skips entries whose name is missing or not a scalar string', () => {
    const document = [
      'proxy-groups:',
      '  - type: select',
      '    proxies: [node-a]',
      '  - name: [not, scalar]',
      '  - name: 有效组'
    ].join('\n')
    expect(parseProxyGroupOrder(document)).toEqual(['有效组'])
  })

  it('resolves YAML anchors via merge parsing', () => {
    const document = [
      'proxy-groups:',
      '  - &base',
      '    name: 锚点组',
      '    type: select',
      '    proxies: [node-a]',
      '  - <<: *base',
      '    name: 合并组'
    ].join('\n')
    expect(parseProxyGroupOrder(document)).toEqual(['锚点组', '合并组'])
  })
})

describe('parseProxyGroupTestUrls', () => {
  it('distinguishes an omitted URL from an explicit normalized URL', () => {
    const document = [
      'proxy-groups:',
      '  - name: 手动选择',
      '    type: select',
      '    proxies: [DIRECT]',
      '  - name: 自动选择',
      '    type: url-test',
      '    url: "  https://probe.example/generate_204  "',
      '    proxies: [DIRECT]'
    ].join('\n')
    expect(parseProxyGroupTestUrls(document)).toEqual({
      手动选择: null,
      自动选择: 'https://probe.example/generate_204'
    })
  })

  it('fails closed to an empty map for malformed documents', () => {
    expect(parseProxyGroupTestUrls('proxy-groups: [broken')).toEqual({})
  })

  it('resolves a URL inherited through a YAML merge anchor', () => {
    const document = [
      'proxy-groups:',
      '  - &base',
      '    name: base',
      '    type: url-test',
      '    url: https://probe.example/204',
      '    proxies: [DIRECT]',
      '  - <<: *base',
      '    name: inherited'
    ].join('\n')
    expect(parseProxyGroupTestUrls(document)).toEqual({
      base: 'https://probe.example/204',
      inherited: 'https://probe.example/204'
    })
  })
})
