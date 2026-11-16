/**
 * Text helpers for the 本地节点 editor: YAML round-trips, pasted-content
 * import and the one-line node summary. The form itself is lib/proxy-schema.
 */
import { t } from '@shared/i18n'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ProxyConfig } from '@shared/local'
import { parseProxyLines } from '@shared/proxy-import'
import { parseWireGuardText } from '@shared/wireguard-conf'

/** How the editor opens: the form for a protocol, or the text view. */
export type NodeEditorStart = { mode: 'form'; protocol: string } | { mode: 'text' }

export function configToYaml(config: Record<string, unknown>): string {
  return stringifyYaml(config, { lineWidth: 0 }).trimEnd() + '\n'
}

export interface ParseOptions {
  /** Accept a missing or empty `name` (switching a half-filled draft back to the form). */
  allowEmptyName?: boolean
}

function asProxy(value: unknown, index: number, options: ParseOptions = {}): ProxyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('nodeForm.notObject', [index + 1]))
  const config = value as Record<string, unknown>
  const name = config.name === undefined || config.name === null ? '' : String(config.name).trim()
  if (!name && !options.allowEmptyName) throw new Error(t('nodeForm.missingName', [index + 1]))
  if (typeof config.type !== 'string' || !config.type.trim()) throw new Error(t('nodeForm.missingType', [name || index + 1]))
  return { ...config, name, type: config.type.trim() } as ProxyConfig
}

/**
 * Parse pasted mihomo YAML: one proxy map, a list of them, or a document
 * with a `proxies:` list.
 */
export function parseProxiesYaml(text: string, options: ParseOptions = {}): ProxyConfig[] {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    throw new Error(t('nodeForm.yamlError', [error instanceof Error ? error.message.split('\n')[0] : String(error)]))
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { proxies?: unknown }).proxies)) {
    value = (value as { proxies: unknown[] }).proxies
  }
  const items = Array.isArray(value) ? value : [value]
  if (!items.length) throw new Error(t('nodeForm.noNodes'))
  return items.map((item, index) => asProxy(item, index, options))
}

/** One-line summary for the node list. */
export function nodeSummary(config: Record<string, unknown>): string {
  const type = String(config.type ?? '').toLowerCase()
  if (type === 'tailscale') {
    const control = typeof config['control-url'] === 'string' && config['control-url'] ? String(config['control-url']).replace(/^https?:\/\//, '') : t('nodeForm.tailscaleOfficial')
    const exit = config['exit-node'] ? t('nodeForm.exitNode', [String(config['exit-node'])]) : ''
    return `${control}${exit}`
  }
  if (Array.isArray(config.peers)) return t('nodeForm.peerCount', [config.peers.length])
  if (config.server) return `${String(config.server)}${config.port ? `:${String(config.port)}` : ''}`
  return ''
}

export interface ParsedNodes {
  configs: ProxyConfig[]
  warnings: string[]
}

/**
 * Pasted node content in any supported shape: WireGuard (wg-quick or Surge
 * [WireGuard] section), share links / Surge proxy lines, or mihomo YAML.
 */
export function parseNodeText(text: string, fallbackName = t('nodeForm.newNode'), options: ParseOptions = {}): ParsedNodes {
  if (!text.trim()) throw new Error(t('nodeForm.emptyContent'))
  if (/^\s*\[(Interface|WireGuard\s[^\]]+)\]/im.test(text)) {
    const result = parseWireGuardText(text, fallbackName)
    return { configs: [result.config as ProxyConfig], warnings: result.warnings }
  }
  const lines = parseProxyLines(text)
  if (lines) return { configs: lines as ProxyConfig[], warnings: [] }
  return { configs: parseProxiesYaml(text, options), warnings: [] }
}
