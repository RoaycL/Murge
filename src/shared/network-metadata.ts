/**
 * Read-only network (egress) metadata model and pure parsing helpers.
 *
 * The main process resolves the running proxy node's public exit address through
 * the kernel's mixed-port proxy and, from a privacy-explicit provider, derives
 * geographic metadata (country / city / ASN). Only a single bounded in-memory
 * cache of aggregate metadata is kept — nothing about the user's machine, their
 * hosts or their profile is ever persisted or transmitted. Every read in the
 * renderer flows through an explicit state (`idle` / `fetching` / `ready` /
 * `error`) so a provider or kernel failure is surfaced, not silently blanked.
 */

/** The privacy-explicit providers this build ships. */
export type NetworkMetadataProviderId = 'ipwhois' | 'ipapi' | 'ipinfo'

/** The serializable description of one provider (no function fields). */
export interface NetworkMetadataProvider {
  id: string
  label: string
  description: string
  /** Plain-http JSON endpoint reached as an absolute-form request via the proxy. */
  endpoint: string
  kind: 'ip-geo'
}

/** One resolved egress metadata record. `asn` and geo fields may be absent. */
export interface NetworkMetadata {
  ip: string
  provider: string
  country: string | null
  city: string | null
  asn: string | null
  /** Epoch ms at which this record was resolved. */
  fetchedAt: number
}

export type NetworkMetadataPhase = 'idle' | 'fetching' | 'ready' | 'error'

/** The renderer-facing network-metadata state snapshot. */
export interface NetworkMetadataState {
  phase: NetworkMetadataPhase
  provider: string
  metadata: NetworkMetadata | null
  error: string | null
}

/** One provider's outcome inside a whole-set resolve. */
export interface NetworkMetadataProviderResult {
  providerId: string
  /** Human-facing provider label (e.g. `ipwho.is`), resolved in the main process. */
  label: string
  state: NetworkMetadataState
}

/**
 * A whole-set resolve snapshot: every shipped provider resolved once, in
 * display order, so the panel can show all sources side by side without the
 * user switching between them.
 */
export interface NetworkMetadataSnapshot {
  results: NetworkMetadataProviderResult[]
  /** Epoch ms at which this whole-set snapshot was assembled. */
  fetchedAt: number
}

const DEFAULT_PROVIDER: NetworkMetadataProviderId = 'ipwhois'

/**
 * Internal provider definitions. `parse` maps a provider's JSON body into the
 * normalized fields; it is intentionally kept out of the serially-sent
 * {@link NetworkMetadataProvider} shape.
 */
interface ProviderDef extends NetworkMetadataProvider {
  parse: (body: unknown) => { ip: string | null; country: string | null; city: string | null; asn: string | null } | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Normalize a provider-specific `as`/`asn` value into an `ASxxxx` prefix. */
function normalizeAsn(value: unknown): string | null {
  const raw = typeof value === 'number' ? String(value) : text(value)
  if (!raw) return null
  const token = raw.split(/\s+/)[0] ?? ''
  if (/^AS\d+$/i.test(token)) return token.toUpperCase()
  if (/^\d+$/.test(token)) return `AS${token}`
  return null
}

const PROVIDER_DEFS: readonly ProviderDef[] = [
  {
    id: 'ipwhois',
    label: 'ipwho.is',
    description: '免密钥、无日志的出口 IP + 地理元数据源',
    endpoint: 'http://ipwho.is/',
    kind: 'ip-geo',
    parse: (body) => {
      const obj = record(body)
      if (!obj || obj.success === false) return null
      const connection = record(obj.connection) ?? {}
      return {
        ip: text(obj.ip),
        country: text(obj.country),
        city: text(obj.city),
        asn: normalizeAsn(connection.asn ?? connection.isp)
      }
    }
  },
  {
    id: 'ipapi',
    label: 'ip-api.com',
    description: '免密钥的出口 IP + 国家/城市/ASN 元数据源（按需查询）',
    endpoint: 'http://ip-api.com/json/',
    kind: 'ip-geo',
    parse: (body) => {
      const obj = record(body)
      if (!obj || obj.status !== 'success') return null
      return {
        ip: text(obj.query),
        country: text(obj.country),
        city: text(obj.city),
        asn: normalizeAsn(obj.as)
      }
    }
  },
  {
    id: 'ipinfo',
    label: 'ipinfo.io',
    description: '免密钥的出口 IP + 国家/城市/ASN（no-log）元数据源',
    endpoint: 'http://ipinfo.io/json',
    kind: 'ip-geo',
    parse: (body) => {
      const obj = record(body)
      if (!obj) return null
      return {
        ip: text(obj.ip),
        country: text(obj.country),
        city: text(obj.city),
        asn: normalizeAsn(obj.org ?? obj.asn)
      }
    }
  }
]

/** The function-free provider list, ready to cross IPC or be rendered. */
export function networkMetadataProviderList(): NetworkMetadataProvider[] {
  return PROVIDER_DEFS.map(({ id, label, description, endpoint, kind }) => ({ id, label, description, endpoint, kind }))
}

/** Resolve a provider by id, or null when unknown. */
export function getNetworkMetadataProvider(id: string): NetworkMetadataProvider | null {
  const def = PROVIDER_DEFS.find((provider) => provider.id === id)
  return def ? { id: def.id, label: def.label, description: def.description, endpoint: def.endpoint, kind: def.kind } : null
}

/** The human-facing label for a provider id, falling back to the raw id. */
export function providerDisplayName(providerId: string): string {
  return getNetworkMetadataProvider(providerId)?.label ?? providerId
}

/** The default provider id. */
export function defaultNetworkMetadataProviderId(): NetworkMetadataProviderId {
  return DEFAULT_PROVIDER
}

/**
 * Parse a provider JSON body into a normalized {@link NetworkMetadata}, or null
 * when the body is unusable (an error payload or an unexpected shape). Every
 * field is defensively optional so a provider change can never crash the app.
 */
export function parseNetworkMetadataJson(body: unknown, providerId: string, now: number): NetworkMetadata | null {
  const def = PROVIDER_DEFS.find((provider) => provider.id === providerId)
  if (!def) return null
  const parsed = def.parse(body)
  if (!parsed || !parsed.ip) return null
  return {
    ip: parsed.ip,
    provider: providerId,
    country: parsed.country,
    city: parsed.city,
    asn: parsed.asn,
    fetchedAt: now
  }
}

/** Mask the last octet of an IPv4 address for a privacy-forward default display. */
export function networkMetadataMaskIp(ip: string): string {
  const match = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/)
  if (match) return `${match[1]}.•••`
  // IPv6 or unexpected: mask the trailing hextet.
  const parts = ip.split(':')
  if (parts.length > 2) parts[parts.length - 1] = '•••'
  return parts.join(':')
}

/** A compact, human-readable single line for display. */
export function networkMetadataDisplayText(metadata: NetworkMetadata): string {
  const geo = [metadata.country, metadata.city].filter(Boolean).join(' · ')
  return [metadata.ip, geo, metadata.asn].filter(Boolean).join(' · ')
}

/** A privacy-safe single line for the clipboard (no hostnames or user data). */
export function networkMetadataCopyText(metadata: NetworkMetadata): string {
  return `${metadata.ip}${metadata.country ? ` (${metadata.country}${metadata.city ? `, ${metadata.city}` : ''})` : ''}${metadata.asn ? ` ${metadata.asn}` : ''}`
}
