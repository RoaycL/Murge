/**
 * Text helpers for the 本地节点 editor: YAML round-trips, pasted-content
 * import and the one-line node summary. The form itself is lib/proxy-schema.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ProxyConfig } from '@shared/local'
import { parseProxyLines } from '@shared/proxy-import'
import { parseWireGuardText } from '@shared/wireguard-conf'

/** How the editor opens: the form for a protocol, or the text view. */
export type NodeEditorStart = { mode: 'form'; protocol: string } | { mode: 'text' }

export function configToYaml(config: Record<string, unknown>): string {
  return stringifyYaml(config, { lineWidth: 0 }).trimEnd() + '\n'
}

function asProxy(value: unknown, index: number): ProxyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`第 ${index + 1} 个节点不是键值对象`)
  const config = value as Record<string, unknown>
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error(`第 ${index + 1} 个节点缺少 name`)
  if (typeof config.type !== 'string' || !config.type.trim()) throw new Error(`节点「${config.name}」缺少 type`)
  return { ...config, name: config.name.trim(), type: config.type.trim() } as ProxyConfig
}

/**
 * Parse pasted mihomo YAML: one proxy map, a list of them, or a document
 * with a `proxies:` list.
 */
export function parseProxiesYaml(text: string): ProxyConfig[] {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    throw new Error(`YAML 格式错误：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { proxies?: unknown }).proxies)) {
    value = (value as { proxies: unknown[] }).proxies
  }
  const items = Array.isArray(value) ? value : [value]
  if (!items.length) throw new Error('没有找到节点')
  return items.map(asProxy)
}

/** One-line summary for the node list. */
export function nodeSummary(config: Record<string, unknown>): string {
  const type = String(config.type ?? '').toLowerCase()
  if (type === 'tailscale') {
    const control = typeof config['control-url'] === 'string' && config['control-url'] ? String(config['control-url']).replace(/^https?:\/\//, '') : 'Tailscale 官方控制服务器'
    const exit = config['exit-node'] ? ` · 出口节点 ${String(config['exit-node'])}` : ''
    return `${control}${exit}`
  }
  if (Array.isArray(config.peers)) return `${config.peers.length} 个 Peer`
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
export function parseNodeText(text: string, fallbackName = '新节点'): ParsedNodes {
  if (!text.trim()) throw new Error('内容为空')
  if (/^\s*\[(Interface|WireGuard\s[^\]]+)\]/im.test(text)) {
    const result = parseWireGuardText(text, fallbackName)
    return { configs: [result.config as ProxyConfig], warnings: result.warnings }
  }
  const lines = parseProxyLines(text)
  if (lines) return { configs: lines as ProxyConfig[], warnings: [] }
  return { configs: parseProxiesYaml(text), warnings: [] }
}
