/**
 * Typed sniffer enhancement model (Phase 12, P1).
 *
 * Mirrors the typed DNS model: a strict, schema-validated version of mihomo's
 * `sniffer:` block that is re-applied every time the runtime kernel config is
 * generated — after the ordered YAML/JS overrides and before the safety pass —
 * so the owner can enable/configure sniffing without editing the subscription
 * source profile. Ports, domain patterns and CIDRs are all validated before the
 * model can be persisted or materialized.
 */

import { isValidAddressOrCidr, isValidDomainOrRule } from './net'

/** The three mihomo probe families, each a list of sniffing ports/ranges. */
export interface SnifferPorts {
  http: string[]
  tls: string[]
  quic: string[]
}

/** The complete typed sniffer enhancement model. */
export interface SnifferEnhancement {
  /** Master switch. When false the enhancement is skipped entirely. */
  enabled: boolean
  overrideDestination: boolean
  forceDnsMapping: boolean
  parsePureIp: boolean
  ports: SnifferPorts
  skipDomain: string[]
  forceDomain: string[]
  skipSrcAddress: string[]
  skipDstAddress: string[]
}

/** The snapshot of the persisted enhancement the renderer observes. */
export interface SnifferSnapshot {
  enhancement: SnifferEnhancement
}

export const EMPTY_SNIFFER_ENHANCEMENT: SnifferEnhancement = {
  enabled: false,
  overrideDestination: true,
  forceDnsMapping: true,
  parsePureIp: true,
  ports: { http: ['80', '8080-8880'], tls: ['443', '8443'], quic: ['443'] },
  skipDomain: [],
  forceDomain: [],
  skipSrcAddress: ['127.0.0.1/8', '::1/128'],
  skipDstAddress: ['127.0.0.1/8', '::1/128']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A single mihomo sniffer port entry: a port, a port range or `*`. */
export function isValidPortToken(value: string): boolean {
  const v = value.trim()
  if (v === '*') return true
  const range = /^(\d{1,5})-(\d{1,5})$/.exec(v)
  if (range) {
    const from = Number(range[1])
    const to = Number(range[2])
    return from >= 1 && from <= 65535 && to >= 1 && to <= 65535 && from <= to
  }
  if (/^\d{1,5}$/.test(v)) {
    const port = Number(v)
    return port >= 1 && port <= 65535
  }
  return false
}

/** Coerce arbitrary input into a valid model, falling back to safe defaults. */
export function coerceSnifferEnhancement(input: unknown): SnifferEnhancement {
  const source = isRecord(input) ? input : {}
  const asBool = (key: keyof SnifferEnhancement): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : (EMPTY_SNIFFER_ENHANCEMENT[key] as boolean)
  const asStringList = (key: keyof SnifferEnhancement): string[] =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((s): s is string => typeof s === 'string')
      : (EMPTY_SNIFFER_ENHANCEMENT[key] as string[])
  const portsRaw = isRecord(source.ports) ? source.ports : {}
  const asPorts = (key: keyof SnifferPorts): string[] =>
    Array.isArray(portsRaw[key])
      ? (portsRaw[key] as unknown[]).filter((s): s is string => typeof s === 'string')
      : EMPTY_SNIFFER_ENHANCEMENT.ports[key]

  return {
    enabled: asBool('enabled'),
    overrideDestination: asBool('overrideDestination'),
    forceDnsMapping: asBool('forceDnsMapping'),
    parsePureIp: asBool('parsePureIp'),
    ports: { http: asPorts('http'), tls: asPorts('tls'), quic: asPorts('quic') },
    skipDomain: asStringList('skipDomain'),
    forceDomain: asStringList('forceDomain'),
    skipSrcAddress: asStringList('skipSrcAddress'),
    skipDstAddress: asStringList('skipDstAddress')
  }
}

/** Coerce a snapshot of the persisted enhancement. */
export function coerceSnifferSnapshot(input: unknown): SnifferSnapshot {
  if (!isRecord(input)) return { enhancement: { ...EMPTY_SNIFFER_ENHANCEMENT } }
  return { enhancement: coerceSnifferEnhancement(input.enhancement) }
}

/**
 * Build the mihomo `sniffer:` block (as a plain object) for an enhancement.
 *
 * Scalar keys the model owns are always emitted; list keys and the `sniff`
 * families are emitted only when non-empty so an untouched group never clobbers
 * a profile value with an empty array. The profile keeps any `sniffer` keys the
 * model does not own (e.g. `port-black-list`).
 */
export function buildSnifferBlock(enhancement: SnifferEnhancement): Record<string, unknown> {
  const block: Record<string, unknown> = {
    enable: enhancement.enabled,
    'override-destination': enhancement.overrideDestination,
    'force-dns-mapping': enhancement.forceDnsMapping,
    'parse-pure-ip': enhancement.parsePureIp
  }
  const sniff: Record<string, unknown> = {}
  if (enhancement.ports.http.length > 0) sniff.HTTP = { ports: [...enhancement.ports.http] }
  if (enhancement.ports.tls.length > 0) sniff.TLS = { ports: [...enhancement.ports.tls] }
  if (enhancement.ports.quic.length > 0) sniff.QUIC = { ports: [...enhancement.ports.quic] }
  if (Object.keys(sniff).length > 0) block.sniff = sniff
  if (enhancement.skipDomain.length > 0) block['skip-domain'] = [...enhancement.skipDomain]
  if (enhancement.forceDomain.length > 0) block['force-domain'] = [...enhancement.forceDomain]
  if (enhancement.skipSrcAddress.length > 0) block['skip-src-address'] = [...enhancement.skipSrcAddress]
  if (enhancement.skipDstAddress.length > 0) block['skip-dst-address'] = [...enhancement.skipDstAddress]
  return block
}

// Re-export the shared validators the IPC schema uses for this model.
export { isValidAddressOrCidr, isValidDomainOrRule }
