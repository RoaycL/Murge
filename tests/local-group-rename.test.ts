import { describe, expect, it } from 'vitest'
import { EMPTY_LOCAL_SETTINGS, plainClone, renameLocalGroup, retargetRuleLine, type LocalSettings } from '@shared/local'

function settings(): LocalSettings {
  return {
    ...plainClone(EMPTY_LOCAL_SETTINGS),
    groups: [
      { id: 'g1', enabled: true, config: { name: '游戏', type: 'select', proxies: ['HK', 'DIRECT'], icon: 'https://a/old.png' }, includeGroups: [], providers: [] },
      { id: 'g2', enabled: true, config: { name: '外层', type: 'url-test', proxies: ['游戏', 'HK'] }, includeGroups: ['游戏'], providers: [] }
    ],
    nodes: [{ id: 'n1', enabled: true, config: { name: 'HK', type: 'ss' }, groups: ['游戏', 'Proxy'], tailnetRules: false }],
    rules: [
      { id: 'r1', enabled: true, rule: 'DOMAIN-SUFFIX,steam.com,游戏' },
      { id: 'r2', enabled: true, rule: 'IP-CIDR,10.0.0.0/8,游戏,no-resolve' },
      { id: 'r3', enabled: true, rule: 'AND,((NETWORK,UDP),(DST-PORT,443)),游戏' },
      { id: 'r4', enabled: true, rule: 'DOMAIN,游戏,Proxy' },
      { id: 'r5', enabled: true, rule: 'MATCH,游戏' }
    ],
    profileEdits: {
      p1: [
        { id: 'e1', ruleType: 'DomainSuffix', payload: 'a.com', target: 'Proxy', action: 'retarget', newTarget: '游戏' },
        { id: 'e2', ruleType: 'DomainSuffix', payload: 'b.com', target: 'Proxy', action: 'replace', replacement: 'DOMAIN,b.com,游戏' }
      ]
    }
  }
}

describe('renameLocalGroup', () => {
  it('renames the group and every local reference to it', () => {
    const source = settings()
    const next = renameLocalGroup(source, 'g1', ' 主机游戏 ', 'https://a/new.png')
    expect(next.groups[0].config).toMatchObject({ name: '主机游戏', icon: 'https://a/new.png', proxies: ['HK', 'DIRECT'] })
    expect(next.groups[1].config.proxies).toEqual(['主机游戏', 'HK'])
    expect(next.groups[1].includeGroups).toEqual(['主机游戏'])
    expect(next.nodes[0].groups).toEqual(['主机游戏', 'Proxy'])
    expect(next.rules.map((rule) => rule.rule)).toEqual([
      'DOMAIN-SUFFIX,steam.com,主机游戏',
      'IP-CIDR,10.0.0.0/8,主机游戏,no-resolve',
      'AND,((NETWORK,UDP),(DST-PORT,443)),主机游戏',
      'DOMAIN,游戏,Proxy',
      'MATCH,主机游戏'
    ])
    expect(next.profileEdits.p1[0].newTarget).toBe('主机游戏')
    expect(next.profileEdits.p1[1].replacement).toBe('DOMAIN,b.com,主机游戏')
    // The input is not mutated.
    expect(source.groups[0].config.name).toBe('游戏')
    expect(source.rules[0].rule).toBe('DOMAIN-SUFFIX,steam.com,游戏')
  })

  it('changes only the icon when the name is unchanged, and clears an empty icon', () => {
    const next = renameLocalGroup(settings(), 'g1', '游戏', '')
    expect(next.groups[0].config.name).toBe('游戏')
    expect(next.groups[0].config).not.toHaveProperty('icon')
    expect(next.rules[0].rule).toBe('DOMAIN-SUFFIX,steam.com,游戏')
  })

  it('leaves settings alone for an unknown group', () => {
    expect(renameLocalGroup(settings(), 'missing', 'X', '')).toEqual(settings())
  })

  it('retargets only the policy field of a rule line', () => {
    expect(retargetRuleLine('DOMAIN,游戏,游戏', '游戏', 'G')).toBe('DOMAIN,游戏,G')
    expect(retargetRuleLine('DOMAIN,a.com,Other', '游戏', 'G')).toBe('DOMAIN,a.com,Other')
  })
})
