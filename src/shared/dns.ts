/**
 * Typed DNS enhancement model (Phase 12, P1).
 *
 * A structured, schema-validated version of mihomo's `dns:` block that is
 * re-applied every time the runtime kernel config is generated, through the
 * configuration-enhancement pipeline (ordered YAML/JS overrides → typed DNS
 * operations → the safety-owned transform). It lets the owner edit DNS without
 * editing — or ever mutating — the subscription source profile.
 *
 * The model is deliberately typed so every server URI, IP, domain and CIDR is
 * validated before it can reach the runtime config. It is authoritative for the
 * fields it owns: when enabled, the generated `dns:` block replaces those keys,
 * while any profile `dns` keys this model does not know about (e.g.
 * `fallback-filter`) are preserved.
 */

/** mihomo `dns.enhanced-mode`. */
import { isValidIp, isValidHostname } from './net'

// Re-export the shared network validators so existing `@shared/dns` consumers
// (the IPC schema and tests) keep their import path unchanged.
export { isIpv4, isIpv6, isValidIp, isValidCidr, isValidDomainOrRule } from './net'

export type DnsEnhancedMode = 'fake-ip' | 'redir-host' | 'normal'

/** mihomo `dns.fake-ip-filter-mode`. */
export type FakeIpFilterMode = 'blacklist' | 'whitelist'

/** A single `dns.hosts` mapping (`domain -> address`). */
export interface DnsHostEntry {
  domain: string
  address: string
}

/** A single `dns.nameserver-policy` mapping (`domain-pattern -> server`). */
export interface DnsPolicyEntry {
  domain: string
  server: string
}

/** The complete typed DNS enhancement model. */
export interface DnsEnhancement {
  /** Master switch. When false the enhancement is skipped entirely. */
  enabled: boolean
  enhancedMode: DnsEnhancedMode
  ipv6: boolean
  respectRules: boolean
  fakeIpRange: string
  fakeIpFilterMode: FakeIpFilterMode
  fakeIpFilter: string[]
  useHosts: boolean
  hosts: DnsHostEntry[]
  defaultNameserver: string[]
  proxyServerNameserver: string[]
  directNameserver: string[]
  nameserver: string[]
  fallback: string[]
  nameserverPolicy: DnsPolicyEntry[]
}

/** The snapshot of the persisted enhancement the renderer observes. */
export interface DnsSnapshot {
  enhancement: DnsEnhancement
}

export const EMPTY_DNS_ENHANCEMENT: DnsEnhancement = {
  enabled: false,
  enhancedMode: 'fake-ip',
  ipv6: false,
  respectRules: false,
  fakeIpRange: '198.18.0.1/16',
  fakeIpFilterMode: 'blacklist',
  fakeIpFilter: ['*.lan', '*.local', 'local'],
  useHosts: true,
  hosts: [],
  defaultNameserver: ['1.1.1.1', '8.8.8.8'],
  proxyServerNameserver: [],
  directNameserver: [],
  nameserver: ['https://1.1.1.1/dns-query'],
  fallback: ['tls://8.8.8.8:853'],
  nameserverPolicy: []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* Validators                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validate a mihomo nameserver entry: `system`/`default` keywords, an allowed
 * scheme (`udp|tcp|tls|https|h3|quic|dhcp`) with a host, a bare IPv4/IPv6, or a
 * plain hostname.
 */
export function isValidNameserver(value: string): boolean {
  const v = value.trim()
  if (v.length === 0) return false
  if (v === 'system' || v === 'default') return true
  if (/^dhcp:\/\//i.test(v)) return true

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/.exec(v)
  if (!schemeMatch) {
    if (isValidIp(v)) return true
    return isValidHostname(v)
  }
  const scheme = schemeMatch[1].toLowerCase()
  if (!['udp', 'tcp', 'tls', 'https', 'h3', 'quic', 'dhcp'].includes(scheme)) return false
  const rest = schemeMatch[2]
  if (rest.length === 0) return false
  const authority = rest.split('/')[0]
  if (authority.length === 0) return false
  // Strip userinfo, then brackets/port, then validate the remaining host.
  let host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close === -1) return false
    const inner = host.slice(1, close)
    const after = host.slice(close + 1)
    if (after && !/^:\d+$/.test(after)) return false
    if (isValidIp(inner)) return true
    return false
  }
  const colon = host.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
    host = host.slice(0, colon)
  }
  if (isValidIp(host)) return true
  return isValidHostname(host)
}

/**
 * Redact any userinfo (e.g. `user:pass@`) from a nameserver URI so a preview can
 * be rendered without leaking credentials.
 */
export function redactServer(value: string): string {
  const at = value.lastIndexOf('@')
  const scheme = value.indexOf('://')
  if (at !== -1 && scheme !== -1 && at > scheme) {
    return `${value.slice(0, scheme + 3)}***${value.slice(at)}`
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                    */
/* -------------------------------------------------------------------------- */

/** Coerce arbitrary input into a valid model, falling back to safe defaults. */
export function coerceDnsEnhancement(input: unknown): DnsEnhancement {
  const source = isRecord(input) ? input : {}
  const asBool = (key: keyof DnsEnhancement): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : (EMPTY_DNS_ENHANCEMENT[key] as boolean)
  const asEnum = <T extends string>(key: keyof DnsEnhancement, allowed: readonly T[], fallback: T): T =>
    allowed.includes(source[key] as T) ? (source[key] as T) : fallback
  const asString = (key: keyof DnsEnhancement): string =>
    typeof source[key] === 'string' ? (source[key] as string) : (EMPTY_DNS_ENHANCEMENT[key] as string)
  // A present-but-empty array is an intentional clear and is honored; a missing
  // field falls back to the curated default list.
  const asStringList = (key: keyof DnsEnhancement): string[] =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((s): s is string => typeof s === 'string')
      : (EMPTY_DNS_ENHANCEMENT[key] as string[])
  const asPairs = <T extends { domain: string }>(key: keyof DnsEnhancement): T[] =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter(isRecord).map((entry) => ({ ...entry })) as unknown as T[]
      : []

  return {
    enabled: asBool('enabled'),
    enhancedMode: asEnum('enhancedMode', ['fake-ip', 'redir-host', 'normal'] as const, 'fake-ip'),
    ipv6: asBool('ipv6'),
    respectRules: asBool('respectRules'),
    fakeIpRange: asString('fakeIpRange'),
    fakeIpFilterMode: asEnum('fakeIpFilterMode', ['blacklist', 'whitelist'] as const, 'blacklist'),
    fakeIpFilter: asStringList('fakeIpFilter'),
    useHosts: asBool('useHosts'),
    hosts: asPairs<DnsHostEntry>('hosts'),
    defaultNameserver: asStringList('defaultNameserver'),
    proxyServerNameserver: asStringList('proxyServerNameserver'),
    directNameserver: asStringList('directNameserver'),
    nameserver: asStringList('nameserver'),
    fallback: asStringList('fallback'),
    nameserverPolicy: asPairs<DnsPolicyEntry>('nameserverPolicy')
  }
}

/** Coerce a snapshot of the persisted enhancement. */
export function coerceDnsSnapshot(input: unknown): DnsSnapshot {
  if (!isRecord(input)) return { enhancement: { ...EMPTY_DNS_ENHANCEMENT } }
  return { enhancement: coerceDnsEnhancement(input.enhancement) }
}

/* -------------------------------------------------------------------------- */
/* Config generation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the mihomo `dns:` block (as a plain object) for an enhancement.
 *
 * Scalar/enum keys the model owns are always emitted. List keys are only emitted
 * when non-empty so an untouched group never clobbers a profile value with an
 * empty array. `hosts`/`nameserver-policy` are emitted as mapping objects only
 * when they have entries.
 */
export function buildDnsBlock(enhancement: DnsEnhancement): Record<string, unknown> {
  const block: Record<string, unknown> = {
    enable: enhancement.enabled,
    'enhanced-mode': enhancement.enhancedMode,
    ipv6: enhancement.ipv6,
    'respect-rules': enhancement.respectRules,
    'fake-ip-range': enhancement.fakeIpRange,
    'fake-ip-filter-mode': enhancement.fakeIpFilterMode,
    'use-hosts': enhancement.useHosts
  }
  if (enhancement.fakeIpFilter.length > 0) block['fake-ip-filter'] = [...enhancement.fakeIpFilter]
  if (enhancement.hosts.length > 0) {
    const hosts: Record<string, unknown> = {}
    for (const entry of enhancement.hosts) hosts[entry.domain] = entry.address
    block.hosts = hosts
  }
  if (enhancement.defaultNameserver.length > 0) block['default-nameserver'] = [...enhancement.defaultNameserver]
  if (enhancement.proxyServerNameserver.length > 0) block['proxy-server-nameserver'] = [...enhancement.proxyServerNameserver]
  if (enhancement.directNameserver.length > 0) block['direct-nameserver'] = [...enhancement.directNameserver]
  if (enhancement.nameserver.length > 0) block.nameserver = [...enhancement.nameserver]
  if (enhancement.fallback.length > 0) block.fallback = [...enhancement.fallback]
  if (enhancement.nameserverPolicy.length > 0) {
    const policy: Record<string, unknown> = {}
    for (const entry of enhancement.nameserverPolicy) policy[entry.domain] = entry.server
    block['nameserver-policy'] = policy
  }
  return block
}

/** Copy an enhancement with every nameserver string redacted for preview. */
export function redactDnsEnhancement(enhancement: DnsEnhancement): DnsEnhancement {
  const redactAll = (list: string[]): string[] => list.map(redactServer)
  return {
    ...enhancement,
    defaultNameserver: redactAll(enhancement.defaultNameserver),
    proxyServerNameserver: redactAll(enhancement.proxyServerNameserver),
    directNameserver: redactAll(enhancement.directNameserver),
    nameserver: redactAll(enhancement.nameserver),
    fallback: redactAll(enhancement.fallback),
    nameserverPolicy: enhancement.nameserverPolicy.map((entry) => ({ ...entry, server: redactServer(entry.server) }))
  }
}
