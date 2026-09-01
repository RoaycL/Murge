/**
 * Shared proxy-bypass policy contract.
 *
 * The app owns the Windows manual system proxy and, while enabled, writes the
 * `ProxyOverride` registry value. `ProxyBypassPolicy` is the *controlled* model
 * for that value: when `enabled` the app is authoritative for the user-authored
 * custom bypass list (`customEntries`), which is merged with an always-present
 * mandatory local/private bypass set. When disabled the app falls back to
 * preserving whatever bypass list already lives in the OS (it never drops a
 * user's existing entries). The original `ProxyOverride` is always restored
 * verbatim on disable regardless of how often the policy is edited while
 * enabled — that is the exact-restore guarantee.
 */

/**
 * Mandatory local/private destinations that are never proxied. These are always
 * present in the written `ProxyOverride`, exactly as a conventional system proxy
 * keeps localhost and RFC1918 traffic un-proxied.
 */
export const DEFAULT_LOCAL_BYPASS_ENTRIES = [
  '<local>',
  'localhost',
  '127.*',
  '10.*',
  '172.16.*',
  '192.168.*'
] as const

/** Hard cap on user-authored bypass entries, to stop a runaway list. */
export const MAX_CUSTOM_BYPASS_ENTRIES = 200

/** Hard cap on a single bypass token length. */
export const MAX_CUSTOM_BYPASS_ENTRY_LENGTH = 255

export interface ProxyBypassPolicy {
  /**
   * Whether the model is authoritative for the custom bypass list. When true the
   * written `ProxyOverride` is `DEFAULT_LOCAL_BYPASS_ENTRIES + customEntries`;
   * when false the app preserves the OS's existing `ProxyOverride` (local
   * entries + whatever was already there) instead of overriding it.
   */
  enabled: boolean
  /** User-authored bypass tokens, e.g. `*.example.com`, `10.*`. */
  customEntries: string[]
}

export const EMPTY_PROXY_BYPASS_POLICY: ProxyBypassPolicy = Object.freeze({
  enabled: false,
  customEntries: []
})

/** Trim a single entry and keep it only if it is non-empty and within bounds. */
function normalizeEntry(entry: string): string | null {
  const trimmed = entry.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_CUSTOM_BYPASS_ENTRY_LENGTH) return null
  return trimmed
}

/** Normalize a customEntries input into a clean, de-duplicated, bounded list. */
function normalizeEntries(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const entry = normalizeEntry(item)
    if (entry === null) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
    if (out.length >= MAX_CUSTOM_BYPASS_ENTRIES) break
  }
  return out
}

/**
 * Coerce arbitrary input (IPC payloads, a read-back from disk) into a valid
 * `ProxyBypassPolicy`. Every field falls back independently, so a corrupt or
 * partial value never throws — callers that need to *reject* an invalid shape
 * should use the stricter `parseProxyBypassPolicy` schema instead.
 */
export function coerceProxyBypassPolicy(input: unknown): ProxyBypassPolicy {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return { ...EMPTY_PROXY_BYPASS_POLICY }
  }
  const record = input as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    customEntries: normalizeEntries(record.customEntries)
  }
}
