import { parseDocument, isSeq, isMap, isScalar } from 'yaml'

/**
 * Ordered `proxy-groups` names from a raw profile document.
 *
 * The mihomo external controller CANNOT supply this order: `GET /proxies` is a
 * Go map (JSON-marshaled with sorted keys) and `GET /group` iterates the same
 * map (Go map range order — randomized per request; verified against a real
 * kernel, where both endpoints shuffle non-ASCII group names). The app owns the
 * active profile document, so THIS is the source of truth for the owner's
 * "groups render in config-file order" contract.
 *
 * Tolerant by design: a missing/empty/invalid `proxy-groups` section yields []
 * and the UI falls back to the controller's map order. Only well-formed
 * sequence entries with scalar names are returned, in document order.
 */
export function parseProxyGroupOrder(document: string): string[] {
  if (!document.trim()) return []
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(document, { merge: true })
  } catch {
    return []
  }
  if (doc.errors.length > 0) return []
  const content = doc.contents
  if (!isMap(content)) return []
  const groups = content.get('proxy-groups', true)
  if (!isSeq(groups)) return []
  const names: string[] = []
  for (const entry of groups.items) {
    if (!isMap(entry)) continue
    const name = entry.get('name', true)
    if (isScalar(name) && typeof name.value === 'string' && name.value.length > 0) {
      names.push(name.value)
    }
  }
  return names
}
