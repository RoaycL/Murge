import { t } from './i18n'
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
  if (!process || /[\r\n,]/.test(process)) throw new Error(t('rule.processInvalid'))
  if (!target || /[\r\n,]/.test(target)) throw new Error(t('rule.pickGroup'))
  const rule = `${draft.match === 'path' ? 'PROCESS-PATH' : 'PROCESS-NAME'},${process},${target}`
  return {
    name: t('rule.processRuleName', [draft.processName.trim() || process]),
    kind: 'yaml', scope: 'global', profileId: null,
    content: stringify({ '+rules': [rule] }), rule
  }
}
