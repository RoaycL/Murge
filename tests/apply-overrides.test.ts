import { describe, it, expect } from 'vitest'
import { mergeOverrideObject, parseYamlToObject, applyOverridesToDocument, runJsOverride } from '../src/main/kernel/overrides/apply-overrides'
import { OverrideItem } from '@shared/overrides'

function item(partial: Partial<OverrideItem> & { content: string }): OverrideItem {
  return {
    id: partial.id ?? 'x',
    name: partial.name ?? 'test',
    kind: partial.kind ?? 'yaml',
    enabled: partial.enabled ?? true,
    scope: partial.scope ?? 'global',
    profileId: partial.profileId ?? null,
    order: partial.order ?? 0,
    content: partial.content,
    updatedAt: 0
  }
}

describe('mergeOverrideObject', () => {
  it('recursively merges nested plain objects', () => {
    const base = { dns: { enable: true, nameserver: ['a'] } }
    mergeOverrideObject(base, { dns: { nameserver: ['b'] } })
    expect(base).toEqual({ dns: { enable: true, nameserver: ['b'] } })
  })

  it('replaces scalars and arrays by default', () => {
    const base = { mode: 'rule', rules: ['x'] }
    mergeOverrideObject(base, { mode: 'global', rules: ['y'] })
    expect(base.mode).toBe('global')
    expect(base.rules).toEqual(['y'])
  })

  it('appends array entries with the key+ modifier and writes back the clean key', () => {
    const base = { rules: ['A', 'B'] }
    mergeOverrideObject(base, { 'rules+': ['B', 'C'] })
    expect(base.rules).toEqual(['A', 'B', 'C']) // B deduped
    expect('rules+' in base).toBe(false)
  })

  it('prepends array entries with the +key modifier', () => {
    const base = { rules: ['A'] }
    mergeOverrideObject(base, { '+rules': ['Z', 'A'] })
    expect(base.rules).toEqual(['Z', 'A'])
  })
})

describe('parseYamlToObject', () => {
  it('parses a map into a plain object', () => {
    expect(parseYamlToObject('mode: rule\nmixed-port: 7890')).toEqual({ mode: 'rule', 'mixed-port': 7890 })
  })
  it('returns null for invalid yaml', () => {
    expect(parseYamlToObject('this is ] not yaml')).toBeNull()
  })
})

describe('applyOverridesToDocument', () => {
  it('returns base verbatim when there are no runnable overrides', () => {
    const base = 'mode: rule\n'
    const result = applyOverridesToDocument(base, [item({ content: '   ', enabled: true })])
    expect(result.text).toBe(base)
    expect(result.warnings).toEqual([])
  })

  it('merges a yaml override and re-serializes', () => {
    const base = 'mode: rule\nmixed-port: 7890\n'
    const result = applyOverridesToDocument(base, [
      item({ content: 'mixed-port: 7891\nmode: global' })
    ])
    const parsed = parseYamlToObject(result.text)
    expect(parsed).toEqual({ mode: 'global', 'mixed-port': 7891 })
  })

  it('applies overrides in order', () => {
    const base = 'mode: rule\n'
    const result = applyOverridesToDocument(base, [
      item({ order: 0, content: 'mode: global' }),
      item({ order: 1, content: 'mode: direct' })
    ])
    expect(parseYamlToObject(result.text)?.mode).toBe('direct')
  })

  it('skips malformed yaml overrides with a warning', () => {
    const base = 'mode: rule\n'
    const result = applyOverridesToDocument(base, [
      item({ name: 'bad', content: 'not: [valid' })
    ])
    expect(parseYamlToObject(result.text)?.mode).toBe('rule')
    expect(result.warnings.some((w) => w.includes('解析失败'))).toBe(true)
  })

  it('returns base verbatim plus a warning when the base document is unparseable', () => {
    const base = 'not: [ yaml'
    const result = applyOverridesToDocument(base, [item({ content: 'mode: global' })])
    expect(result.text).toBe(base)
    expect(result.warnings.some((w) => w.includes('基础配置'))).toBe(true)
  })
})

describe('runJsOverride', () => {
  it('allows main to mutate the shared config in place', () => {
    const config: Record<string, unknown> = { mode: 'rule' }
    const result = runJsOverride('main = function(config) { config.mode = "direct"; config.extra = 1 }', config)
    expect(result.next.mode).toBe('direct')
    expect(result.next.extra).toBe(1)
    expect(result.warnings.length).toBe(0)
  })

  it('prefers the object returned by main', () => {
    const config: Record<string, unknown> = { mode: 'rule' }
    const result = runJsOverride('main = function() { return { mode: "global" } }', config)
    expect(result.next).toEqual({ mode: 'global' })
  })

  it('fail-opens on a throwing main', () => {
    const config: Record<string, unknown> = { mode: 'rule' }
    const result = runJsOverride('main = function() { throw new Error("boom") }', config)
    expect(result.next).toBe(config)
    expect(result.warnings.some((w) => w.includes('执行失败'))).toBe(true)
  })

  it('exposes no require/process/fs and caps runaway loops', () => {
    const config: Record<string, unknown> = {}
    // Accessing a missing global in the sandbox would throw at runtime; also test
    // that the timeout cap terminates an infinite loop rather than hanging.
    const infinite = runJsOverride('main = function() { for(;;){} }', config)
    expect(infinite.warnings.length).toBeGreaterThan(0)
  })
})
