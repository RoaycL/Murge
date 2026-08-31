/**
 * Typed TUN configuration model (Phase 12, P1).
 *
 * Unlike the DNS and sniffer enhancements — which merge a generated `dns:` /
 * `sniffer:` block into the main-kernel profile — TUN belongs to the
 * mihomo-owned adapter lifecycle: it runs a self-contained bootstrap profile
 * (`generateMihomoTunConfig`) on an elevated, mihomo-owned kernel that is
 * mutually exclusive with the main kernel (the safety transform drops `tun`).
 *
 * This model is the renderer-visible, schema-validated set of user preferences
 * that the owned adapter reads at enable-time and folds into that bootstrap. It
 * is a *configuration*, not a lifecycle action: enabling/disabling TUN is a
 * separate, privileged operation routed through the Windows service. The model
 * here only shapes the generated `tun:` block.
 *
 * Every field is validated before it can be persisted or reach the bootstrap:
 * stack enum, device identity, MTU range, dns-hijack host:port entries and
 * IPv4/IPv6 route CIDRs.
 */

import { isValidAddressOrCidr, isValidHostname, isValidIp } from './net'

export type TunConfigStack = 'mixed' | 'system' | 'gvisor'

/** The complete typed TUN configuration model. */
export interface TunConfigModel {
  /** mihomo `tun.stack`. */
  stack: TunConfigStack
  /** mihomo `tun.device` (adapter identity). */
  device: string
  /** mihomo `tun.mtu`. */
  mtu: number
  /** mihomo `tun.strict-route`. */
  strictRoute: boolean
  /** mihomo `tun.auto-route`. */
  autoRoute: boolean
  /** mihomo `tun.auto-detect-interface`. */
  autoDetectInterface: boolean
  /** mihomo `tun.dns-hijack` entries (`any`, `host:port`, `ip`, `[ipv6]:port`). */
  dnsHijack: string[]
  /** mihomo `tun.route-address` CIDRs. */
  routeAddress: string[]
  /** mihomo `tun.route-exclude-address` CIDRs. */
  routeExcludeAddress: string[]
}

/** The snapshot of the persisted model the renderer observes. */
export interface TunConfigSnapshot {
  config: TunConfigModel
}

export const TUN_STACKS: readonly TunConfigStack[] = ['mixed', 'system', 'gvisor']
export const TUN_MTU_MIN = 576
export const TUN_MTU_MAX = 65535

/** mihomo TUN adapter identity: a bounded printable label with no control chars. */
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

export const EMPTY_TUN_CONFIG: TunConfigModel = {
  stack: 'mixed',
  device: 'Mihomo',
  mtu: 9000,
  strictRoute: false,
  autoRoute: true,
  autoDetectInterface: true,
  dnsHijack: ['any:53'],
  routeAddress: [],
  routeExcludeAddress: []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* Validators                                                                   */
/* -------------------------------------------------------------------------- */

export function isValidTunStack(value: unknown): value is TunConfigStack {
  return typeof value === 'string' && (TUN_STACKS as readonly string[]).includes(value)
}

export function isValidTunDevice(value: string): boolean {
  return DEVICE_PATTERN.test(value)
}

export function isValidTunMtu(value: number): boolean {
  return Number.isInteger(value) && value >= TUN_MTU_MIN && value <= TUN_MTU_MAX
}

function isSinglePort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false
  const n = Number(value)
  return n >= 1 && n <= 65535
}

/** Validate a mihomo `tun.dns-hijack` entry (`any`, `ip`, `host:port`, `[ipv6]:port`). */
export function isValidDnsHijackEntry(value: string): boolean {
  const v = value.trim()
  if (v.length === 0) return false
  if (v === 'any') return true
  if (v.startsWith('[')) {
    const close = v.indexOf(']')
    if (close === -1) return false
    const host = v.slice(1, close)
    if (!isValidIp(host)) return false
    const rest = v.slice(close + 1)
    if (rest === '') return true
    if (!rest.startsWith(':')) return false
    return isSinglePort(rest.slice(1))
  }
  const idx = v.lastIndexOf(':')
  if (idx === -1) return isValidIp(v) || isValidHostname(v)
  const hostPart = v.slice(0, idx)
  const portPart = v.slice(idx + 1)
  if (!isSinglePort(portPart)) return false
  return hostPart === 'any' || isValidIp(hostPart) || isValidHostname(hostPart)
}

export function isValidTunRouteAddress(value: string): boolean {
  return isValidAddressOrCidr(value)
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                     */
/* -------------------------------------------------------------------------- */

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((item): item is string => typeof item === 'string')
}

/** Collapse an unknown value into a structurally safe TUN config model. */
export function coerceTunConfig(input: unknown): TunConfigModel {
  const src = isRecord(input) ? input : {}
  return {
    stack: isValidTunStack(src.stack) ? src.stack : EMPTY_TUN_CONFIG.stack,
    device: typeof src.device === 'string' && isValidTunDevice(src.device) ? src.device : EMPTY_TUN_CONFIG.device,
    mtu: typeof src.mtu === 'number' && isValidTunMtu(src.mtu) ? src.mtu : EMPTY_TUN_CONFIG.mtu,
    strictRoute: asBool(src.strictRoute, EMPTY_TUN_CONFIG.strictRoute),
    autoRoute: asBool(src.autoRoute, EMPTY_TUN_CONFIG.autoRoute),
    autoDetectInterface: asBool(src.autoDetectInterface, EMPTY_TUN_CONFIG.autoDetectInterface),
    dnsHijack: asStringList(src.dnsHijack, EMPTY_TUN_CONFIG.dnsHijack).filter(isValidDnsHijackEntry),
    routeAddress: asStringList(src.routeAddress, []).filter(isValidTunRouteAddress),
    routeExcludeAddress: asStringList(src.routeExcludeAddress, []).filter(isValidTunRouteAddress)
  }
}

/** Collapse an unknown value into a structurally safe snapshot. */
export function coerceTunConfigSnapshot(input: unknown): TunConfigSnapshot {
  const src = isRecord(input) ? input : {}
  return { config: coerceTunConfig(src.config) }
}

/* -------------------------------------------------------------------------- */
/* Config generation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Render the `tun:` sub-block a model would produce. The owned bootstrap adds
 * `enable: true` and the surrounding profile; this only renders the tun keys
 * owned by this model. List keys are emitted only when non-empty so an
 * intentionally-empty set (e.g. no extra routes) never emits a bare sequence.
 */
export function buildTunBlock(config: TunConfigModel): Record<string, unknown> {
  const block: Record<string, unknown> = {
    'auto-route': config.autoRoute,
    'auto-detect-interface': config.autoDetectInterface,
    'strict-route': config.strictRoute,
    device: config.device,
    stack: config.stack,
    mtu: config.mtu,
    'dns-hijack': [...config.dnsHijack]
  }
  if (config.routeAddress.length > 0) block['route-address'] = [...config.routeAddress]
  if (config.routeExcludeAddress.length > 0) block['route-exclude-address'] = [...config.routeExcludeAddress]
  return block
}
