/**
 * Pure, dependency-free network validators shared by the typed DNS, sniffer and
 * (later) TUN enhancement models. These run in both the main process and the
 * renderer, so they must never touch Node-only APIs like `node:net`.
 */

export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    if (part.length > 1 && part.startsWith('0')) return false
    const num = Number(part)
    return num >= 0 && num <= 255
  })
}

export function isIpv6(value: string): boolean {
  if (!value.includes(':')) return false
  if (value.includes(':::')) return false
  const doubleColon = (value.match(/::/g) ?? []).length
  if (doubleColon > 1) return false
  const group = /^[0-9a-fA-F]{1,4}$/
  const okGroups = (segment: string): boolean => segment.length === 0 || segment.split(':').every((g) => group.test(g))
  const segments = value.split('::')
  if (segments.length === 1) {
    return segments[0].split(':').length === 8 && segments[0].split(':').every((g) => group.test(g))
  }
  const left = segments[0].length === 0 ? 0 : segments[0].split(':').length
  const right = segments[1].length === 0 ? 0 : segments[1].split(':').length
  if (left + right >= 8) return false
  return okGroups(segments[0]) && okGroups(segments[1])
}

/** Accept an IP with or without surrounding brackets (for `[::1]:53`). */
export function isValidIp(value: string): boolean {
  const stripped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return isIpv4(stripped) || isIpv6(stripped)
}

/** A CIDR (`address/prefix`) of a single IP family, e.g. `198.18.0.0/16`. */
export function isValidCidr(value: string): boolean {
  const slash = value.lastIndexOf('/')
  if (slash <= 0) return false
  const ip = value.slice(0, slash)
  const prefix = value.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  if (isIpv4(ip)) return bits >= 0 && bits <= 32
  if (isIpv6(ip)) return bits >= 0 && bits <= 128
  return false
}

/** A plain DNS-style hostname (no scheme, no port). */
export function isValidHostname(value: string): boolean {
  if (value.length > 253) return false
  const labels = value.split('.')
  if (labels.length === 0) return false
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}

/**
 * A domain pattern used by DNS `fake-ip-filter`/`nameserver-policy` keys or the
 * sniffer `skip-domain`/`force-domain`: a plain hostname, a `*.` wildcard, or a
 * `geosite:`/`geoip:` rule expression.
 */
export function isValidDomainOrRule(value: string): boolean {
  if (value.startsWith('geosite:') || value.startsWith('geoip:')) return value.length > 'geosite:'.length
  if (value.length > 1 && value.startsWith('*.')) return isValidHostname(value.slice(2))
  if (value === '*') return true
  return isValidHostname(value)
}

/** An address list entry that may be a bare IP or a CIDR (`skip-src-address`). */
export function isValidAddressOrCidr(value: string): boolean {
  return isValidIp(value) || isValidCidr(value)
}
