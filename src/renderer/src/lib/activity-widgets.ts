import type { LocalAddress } from '@shared/lan'

/** Small pure helpers behind the Surge-style Activity widgets. */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** 网络 card: the adapter on the gateway's /24 first, then any LAN adapter, then any IPv4. */
export function pickLocalAddress(list: readonly LocalAddress[], gateway: string | null): string | null {
  const ipv4 = list.filter((entry) => IPV4.test(entry.address))
  const prefix = gateway && IPV4.test(gateway) ? gateway.split('.').slice(0, 3).join('.') : null
  const sameSubnet = prefix ? ipv4.find((entry) => entry.address.split('.').slice(0, 3).join('.') === prefix) : undefined
  return (sameSubnet ?? ipv4.find((entry) => entry.lan) ?? ipv4[0])?.address ?? null
}

/** 外部 IP card: `AS4134 China Telecom` → organisation + AS number (either may be missing). */
export function splitAsn(asn: string | null | undefined): { org: string | null; number: string | null } {
  const text = (asn ?? '').trim()
  if (!text) return { org: null, number: null }
  const match = /^(AS\d+)\s*(.*)$/i.exec(text)
  if (match) return { number: match[1].toUpperCase(), org: match[2].trim() || null }
  const tail = /^(.*?)\s*\(?(AS\d+)\)?$/i.exec(text)
  if (tail && tail[1]) return { org: tail[1].trim(), number: tail[2].toUpperCase() }
  return { org: text, number: null }
}

/** Regional-indicator flag for a two-letter country code (`CN` → 🇨🇳); empty for anything else. */
export function countryFlag(code: string | null | undefined): string {
  const value = (code ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(value)) return ''
  return String.fromCodePoint(...[...value].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
}

/** DNS card: average and maximum of the recent query timings. */
export function dnsStats(samples: readonly number[]): { average: number | null; max: number | null } {
  if (!samples.length) return { average: null, max: null }
  const sum = samples.reduce((total, value) => total + value, 0)
  return { average: Math.round(sum / samples.length), max: Math.round(Math.max(...samples)) }
}

/** A round chart ceiling (the next power of two, at least 1 KB) so gridline labels read cleanly. */
export function niceBytesCeiling(max: number): number {
  if (!(max > 0)) return 0
  let ceiling = 1024
  while (ceiling < max) ceiling *= 2
  return ceiling
}

/** Local `HH:mm` for a timestamp (card footers). */
export function clockTime(at: number | string | Date): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
