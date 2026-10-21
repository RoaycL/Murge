import { stringify } from 'yaml'
import type { OverrideInput } from './overrides'

export type DomainRuleMatch = 'exact' | 'suffix'

/** A host observed on a connection is an untrusted hint, never a ready-made rule. */
export function normalizeRuleDomain(value: string): string | null {
  const domain = value.trim().replace(/\.$/, '').toLowerCase()
  if (!domain || domain.length > 253 || /[\s,/:\\]/.test(domain)) return null
  if (/^\d+(?:\.\d+){3}$/.test(domain)) return null
  if (!domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  return domain
}

export function buildDomainRuleOverride(input: { host: string; match: DomainRuleMatch; target: string }): OverrideInput & { rule: string } {
  const domain = normalizeRuleDomain(input.host)
  if (!domain) throw new Error('这条连接没有可用的域名')
  const target = input.target.trim()
  if (!target || /[\r\n,]/.test(target)) throw new Error('请选择有效的策略组')
  const rule = `${input.match === 'suffix' ? 'DOMAIN-SUFFIX' : 'DOMAIN'},${domain},${target}`
  return {
    name: `域名分流 · ${domain}`,
    kind: 'yaml', scope: 'global', profileId: null,
    content: stringify({ '+rules': [rule] }), rule
  }
}
