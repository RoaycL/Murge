import { stringify } from 'yaml'
import type { OverrideInput } from './overrides'

export type ProcessRuleMatch = 'name' | 'path'

export interface ProcessRuleDraft {
  processName: string
  processPath: string
  match: ProcessRuleMatch
  target: string
}

/** Build a single highest-priority Mihomo rule without interpolating YAML syntax. */
export function buildProcessRuleOverride(draft: ProcessRuleDraft): OverrideInput & { rule: string } {
  const process = (draft.match === 'path' ? draft.processPath : draft.processName).trim()
  const target = draft.target.trim()
  if (!process || /[\r\n,]/.test(process)) throw new Error('进程名称或路径不能留空，也不能包含逗号或换行')
  if (!target || /[\r\n,]/.test(target)) throw new Error('请选择有效的策略组')
  const rule = `${draft.match === 'path' ? 'PROCESS-PATH' : 'PROCESS-NAME'},${process},${target}`
  return {
    name: `进程分流 · ${draft.processName.trim() || process}`,
    kind: 'yaml', scope: 'global', profileId: null,
    content: stringify({ '+rules': [rule] }), rule
  }
}
