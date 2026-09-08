import { parseDocument } from 'yaml'
import type { Document } from 'yaml'
import type { ProfileProviderConfig, ProfileProviderCatalog } from '@shared/profiles'

/**
 * `proxy-providers` / `rule-providers` declarations from a raw profile document.
 *
 * The external controller CANNOT answer "what URL/interval does this provider
 * use": `GET /providers/proxies` exposes runtime state (vehicle type, member
 * proxies, last update) but never the declared remote address. The app owns
 * the active profile document, so THIS is the source of truth for the 外部资源
 * page's 集合配置 viewer.
 *
 * Both sections are mihomo MAPS (provider name → config), so the YAML key is
 * the provider name itself — there is no `name:` field to read. Tolerant by
 * design: a missing/empty/invalid section yields an empty catalog and the UI
 * falls back to controller-only metadata; unknown keys are ignored.
 */
export function parseProviderCatalog(document: string): ProfileProviderCatalog {
  if (!document.trim()) return { proxy: [], rule: [] }
  let doc: Document
  try {
    doc = parseDocument(document, { merge: true })
  } catch {
    return { proxy: [], rule: [] }
  }
  if (doc.errors.length > 0) return { proxy: [], rule: [] }
  // Node.get() does not project YAML `<<` merge keys onto the target map.
  // Convert once through toJS(), which resolves anchors exactly like the
  // runtime config builder, so inherited interval/type/health-check fields are
  // visible in the 外部资源 detail panel too.
  let content: unknown
  try {
    content = doc.toJS({ mapAsMap: true })
  } catch {
    return { proxy: [], rule: [] }
  }
  if (!(content instanceof Map)) return { proxy: [], rule: [] }
  return {
    proxy: parseProviderSection(content, 'proxy-providers', 'proxy'),
    rule: parseProviderSection(content, 'rule-providers', 'rule')
  }
}

function parseProviderSection(content: Map<unknown, unknown>, key: string, kind: 'proxy' | 'rule'): ProfileProviderConfig[] {
  const section = content.get(key)
  if (!(section instanceof Map)) return []
  const out: ProfileProviderConfig[] = []
  for (const [name, configNode] of section.entries()) {
    if (typeof name !== 'string' || !name || !(configNode instanceof Map)) continue
    const config: ProfileProviderConfig = { name, kind }
    const url = scalarString(configNode.get('url'))
    if (url) config.url = url
    const path = scalarString(configNode.get('path'))
    if (path) config.path = path
    const interval = scalarNumber(configNode.get('interval'))
    if (interval !== null) config.interval = interval
    const behavior = scalarString(configNode.get('behavior'))
    if (behavior) config.behavior = behavior
    const format = scalarString(configNode.get('format'))
    if (format) config.format = format
    const health = configNode.get('health-check')
    const testUrl = health instanceof Map ? scalarString(health.get('url')) : null
    if (testUrl) config.testUrl = testUrl
    out.push(config)
  }
  return out
}

function scalarString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function scalarNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
