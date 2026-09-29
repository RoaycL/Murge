import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildProcessRuleOverride } from '../src/shared/process-rule'
import { mergeOverrideObject } from '../src/main/kernel/overrides/apply-overrides'

describe('process rule override', () => {
  it('prepends an exact executable-path rule without touching the subscription', () => {
    const draft = buildProcessRuleOverride({ processName: 'game.exe', processPath: 'C:\\Games\\game.exe', match: 'path', target: '游戏策略' })
    expect(draft.scope).toBe('global')
    expect(draft.rule).toBe('PROCESS-PATH,C:\\Games\\game.exe,游戏策略')
    expect(parse(draft.content)).toEqual({ '+rules': [draft.rule] })
    const runtime = { rules: ['MATCH,DIRECT'] }
    mergeOverrideObject(runtime, parse(draft.content))
    expect(runtime.rules).toEqual([draft.rule, 'MATCH,DIRECT'])
  })

  it('rejects commas and newlines that would add unexpected rule fields', () => {
    expect(() => buildProcessRuleOverride({ processName: 'a,b.exe', processPath: '', match: 'name', target: 'DIRECT' })).toThrow()
    expect(() => buildProcessRuleOverride({ processName: 'app.exe', processPath: '', match: 'name', target: 'Group\nInjected' })).toThrow()
  })
})
