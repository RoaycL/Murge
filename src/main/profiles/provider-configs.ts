import { parseDocument, isMap, isScalar } from 'yaml'
import type { Document, YAMLMap } from 'yaml'
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
  const content = doc.contents
  if (!isMap(content)) return { proxy: [], rule: [] }
  return {
    proxy: parseProviderSection(content, 'proxy-providers', 'proxy'),
    rule: parseProviderSection(content, 'rule-providers', 'rule')
  }
}

function parseProviderSection(content: YAMLMap, key: string, kind: 'proxy' | 'rule'): ProfileProviderConfig[] {
  const section = content.get(key, true)
  if (!isMap(section)) return []
  const out: ProfileProviderConfig[] = []
  for (const pair of section.items) {
    const nameNode = pair.key
    const configNode = pair.value
    const name = isScalar(nameNode) && typeof nameNode.value === 'string' ? nameNode.value : null
    if (!name || !isMap(configNode)) continue
    const config: ProfileProviderConfig = { name, kind }
    const url = scalarString(configNode.get('url', true))
    if (url) config.url = url
    const path = scalarString(configNode.get('path', true))
    if (path) config.path = path
    const interval = scalarNumber(configNode.get('interval', true))
    if (interval !== null) config.interval = interval
    const behavior = scalarString(configNode.get('behavior', true))
    if (behavior) config.behavior = behavior
    const format = scalarString(configNode.get('format', true))
    if (format) config.format = format
    const health = configNode.get('health-check', true)
    const testUrl = isMap(health) ? scalarString(health.get('url', true)) : null
    if (testUrl) config.testUrl = testUrl
    out.push(config)
  }
  return out
}

function scalarString(value: unknown): string | null {
  return isScalar(value) && typeof value.value === 'string' && value.value.length > 0 ? value.value : null
}

function scalarNumber(value: unknown): number | null {
  if (!isScalar(value) || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
  return value.value
}
