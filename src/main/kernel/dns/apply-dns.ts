import { parseDocument, stringify, isMap } from 'yaml'
import type { DnsEnhancement } from '@shared/dns'
import { buildDnsBlock } from '@shared/dns'

/**
 * Apply the typed DNS enhancement to a profile document.
 *
 * When the enhancement is enabled its generated `dns:` block is merged into the
 * document: the model wins for every key it owns, while any profile `dns` keys
 * the model does not know about (e.g. `fallback-filter`) are preserved. When it
 * is disabled, or the base document is unparseable, the base text is returned
 * verbatim with a diagnostic so a bad enhancement can never break a kernel
 * start. The caller re-runs the profile-config safety pass afterwards, which
 * still strips `dns.listen` and keeps the loopback-only invariant.
 */

export interface ApplyDnsResult {
  text: string
  warnings: string[]
}

export function applyDnsEnhancementToDocument(base: string, enhancement: DnsEnhancement): ApplyDnsResult {
  if (!enhancement.enabled) return { text: base, warnings: [] }

  const doc = parseDocument(base, { merge: true, uniqueKeys: true })
  if (doc.errors.length > 0) {
    return { text: base, warnings: ['基础配置文件无法解析，已跳过 DNS 增强'] }
  }
  if (!isMap(doc.contents)) {
    return { text: base, warnings: ['基础配置文件顶层不是映射，已跳过 DNS 增强'] }
  }

  let data: unknown
  try {
    data = doc.toJS()
  } catch {
    return { text: base, warnings: ['基础配置文件解析失败，已跳过 DNS 增强'] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { text: base, warnings: ['基础配置文件顶层不是映射，已跳过 DNS 增强'] }
  }

  const config = data as Record<string, unknown>
  const existing =
    config.dns && typeof config.dns === 'object' && !Array.isArray(config.dns)
      ? (config.dns as Record<string, unknown>)
      : {}
  config.dns = { ...existing, ...buildDnsBlock(enhancement) }
  return { text: stringify(config), warnings: [] }
}
