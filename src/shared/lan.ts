/**
 * 局域网设备接管 helpers shared by the 概览 card and the 设备 page.
 *
 * Mihomo identifies a client only by the source address of its connection
 * (no MAC, vendor or DHCP lease), so "is this another device?" is answered by
 * comparing that address with this PC's own addresses.
 */

/** One IPv4 address of this host (`app:list-local-addresses`). */
export interface LocalAddress {
  /** OS adapter name, e.g. `WLAN` or `以太网`. */
  name: string
  address: string
  /** An RFC 1918 address on a physical adapter that other LAN devices can dial. */
  lan: boolean
}

function ipv4Octets(address: string): number[] | null {
  const plain = address.replace(/^::ffff:/i, '')
  const parts = plain.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null
}

export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || ipv4Octets(address)?.[0] === 127
}

/**
 * 198.18.0.0/15 is the benchmark range mihomo uses for its TUN adapter and
 * fake-IP pool: a connection from there was made by a process on this PC.
 */
export function isTunAddress(address: string): boolean {
  const octets = ipv4Octets(address)
  return octets !== null && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)
}

export function isPrivateAddress(address: string): boolean {
  const octets = ipv4Octets(address)
  if (octets) {
    const [a, b] = octets
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return /^(f[cd][0-9a-f]{2}:|fe80:)/i.test(address)
}

/** Whether a connection source address belongs to this PC. */
export function isThisHost(address: string, local: readonly LocalAddress[]): boolean {
  const plain = address.replace(/^::ffff:/i, '')
  return isLoopbackAddress(plain) || isTunAddress(plain) || local.some((entry) => entry.address === plain)
}

/**
 * The 设备 page's one-line kind for a source address. `inbounds` are the
 * mihomo inbound types (`metadata.type`) of that address's connections.
 */
export function describeDevice(address: string, inbounds: readonly string[], local: readonly LocalAddress[]): string {
  const plain = address.replace(/^::ffff:/i, '')
  const viaTun = inbounds.some((type) => type.toLowerCase() === 'tun')
  if (isLoopbackAddress(plain)) return '本机 · 回环地址'
  if (isTunAddress(plain)) return '本机 · TUN'
  if (local.some((entry) => entry.address === plain)) return viaTun ? '本机 · TUN' : '本机'
  if (isPrivateAddress(plain)) return viaTun ? '局域网设备 · 网关' : '局域网设备 · 代理'
  return '其他地址'
}

/** The addresses other devices should dial: the LAN-reachable ones only. */
export function lanAddresses(local: readonly LocalAddress[]): LocalAddress[] {
  return local.filter((entry) => entry.lan)
}
