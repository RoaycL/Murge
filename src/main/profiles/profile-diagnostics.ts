import { LineCounter, isMap, parseDocument } from 'yaml'
import type { ValidationIssue } from '@shared/profiles'

const OBSOLETE_TOP_LEVEL_KEYS: Record<string, string> = {
  'global-client-fingerprint':
    'global-client-fingerprint 已被当前 mihomo 移除，不会生效；如有需要，请在具体代理节点中设置 client-fingerprint。',
  udp:
    '顶层 udp 不是当前 mihomo 的有效全局设置，不会生效；UDP 能力由具体代理节点与 TUN 配置决定。'
}

/** Non-blocking compatibility diagnostics. Warnings never mutate or reject a profile. */
export function profileCompatibilityDiagnostics(document: string): ValidationIssue[] {
  const lineCounter = new LineCounter()
  const doc = parseDocument(document, { merge: true, uniqueKeys: true, lineCounter })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return []
  const issues: ValidationIssue[] = []
  for (const pair of doc.contents.items) {
    const key = pair.key && typeof pair.key === 'object' && 'value' in pair.key
      ? (pair.key as { value?: unknown; range?: [number, number, number] })
      : null
    if (typeof key?.value !== 'string') continue
    const message = OBSOLETE_TOP_LEVEL_KEYS[key.value]
    if (!message) continue
    issues.push({
      severity: 'warning',
      message,
      line: key.range ? lineCounter.linePos(key.range[0]).line : undefined
    })
  }
  return issues
}
