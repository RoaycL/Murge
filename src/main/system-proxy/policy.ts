import { SYSTEM_PROXY_LOOPBACK_HOST } from '../../shared/system-proxy'
import { DEFAULT_LOCAL_BYPASS_ENTRIES } from '../../shared/proxy-bypass'
import type { ProxyBypassPolicy } from '../../shared/proxy-bypass'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type {
  RegistryValue,
  SystemProxyRegistryState,
  SystemProxyTarget,
  SystemProxyWrittenState
} from './types'

/**
 * Pure decision helpers for the system-proxy feature.
 *
 * These are deliberately free of any Electron / registry / file I/O so they can
 * be unit tested on any platform (the Mac dev box, Linux CI) without executing
 * a real registry mutation. The Windows adapter only turns their output into
 * `reg.exe` arguments.
 */

/** Format a target as `host:port` for display and for the startup probe. */
export function formatAddress(target: SystemProxyTarget): string {
  return `${target.host}:${target.port}`
}

/**
 * The `ProxyServer` value WinINet understands. mihomo's `mixed-port` serves both
 * HTTP CONNECT and SOCKS5 on the same loopback socket, so a single `<p>` is
 * referenced by every scheme. The host is always loopback (never 0.0.0.0, never
 * a LAN address) so no external traffic can be routed through the app.
 */
export function buildProxyServerValue(target: SystemProxyTarget): string {
  const { host, port } = target
  return `http=${host}:${port};https=${host}:${port};socks=${host}:${port}`
}

/** Local/private destinations that must never be proxied. */
export const LOCAL_BYPASS_ENTRIES: readonly string[] = DEFAULT_LOCAL_BYPASS_ENTRIES

/**
 * Build the `ProxyOverride` value we write while enabled.
 *
 * The mandatory local bypass list is always present. If the user already had a
 * `ProxyOverride`, its entries are preserved and de-duplicated so no user-facing
 * bypass is silently dropped during ownership; the original value is still
 * restored verbatim on `disable()`.
 */
export function mergeProxyOverride(original: string | null | undefined): string {
  return mergeBypassEntries(original?.split(';') ?? [])
}

/**
 * Build the `ProxyOverride` value from an authoritative user policy: the
 * mandatory local bypass list (always present, for safety) merged with the
 * user's custom entries, de-duplicated. This is the "controlled" path used when
 * {@link ProxyBypassPolicy.enabled} is true.
 */
export function mergeLocalBypass(customEntries: readonly string[]): string {
  return mergeBypassEntries(customEntries)
}

function mergeBypassEntries(entries: readonly string[]): string {
  const merged = new Set<string>(DEFAULT_LOCAL_BYPASS_ENTRIES)
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    merged.add(trimmed)
  }
  return Array.from(merged).join(';')
}

/**
 * Resolve the `ProxyOverride` value the app should write given the controlled
 * policy, the current OS `ProxyOverride`, and the mandated local entries. An
 * `enabled` policy is authoritative for the custom section (local + custom);
 * a disabled / absent policy preserves whatever the OS already had (local +
 * existing) so no existing bypass is ever dropped.
 */
export function resolveProxyOverride(policy: ProxyBypassPolicy | undefined, original: string | null | undefined): string {
  if (policy?.enabled) return mergeLocalBypass(policy.customEntries)
  return mergeProxyOverride(original)
}

/** The raw registry types we can faithfully restore via `reg.exe`. */
export const RESTORABLE_REGISTRY_TYPES = ['REG_DWORD', 'REG_SZ', 'REG_EXPAND_SZ', 'REG_BINARY'] as const

function isRestorableType(type: RegistryValue['type']): boolean {
  return type !== 'none' && (RESTORABLE_REGISTRY_TYPES as readonly RegistryValue['type'][]).includes(type)
}

/** Build the value set the app owns while the system proxy is enabled. */
export function buildWrittenState(
  target: SystemProxyTarget,
  observed: SystemProxyRegistryState,
  policy?: ProxyBypassPolicy
): SystemProxyWrittenState {
  return {
    proxyEnable: { exists: true, type: 'REG_DWORD', value: 1 },
    proxyServer: { exists: true, type: 'REG_SZ', value: buildProxyServerValue(target) },
    proxyOverride: {
      exists: true,
      type: 'REG_SZ',
      value: resolveProxyOverride(policy, observed.proxyOverride.value as string | null)
    }
  }
}

/**
 * Strict registry-value equality: a value only matches when both `exists`, the
 * *literal* registry type, and the value all agree. Previously this compared the
 * bare value, so an `REG_SZ` value could masquerade as an `REG_EXPAND_SZ` (or an
 * `REG_BINARY` be read as a string) and ownership / restore verification passed
 * when it should not have.
 */
export function sameRegistryValue(a: RegistryValue, b: RegistryValue): boolean {
  if (a.exists !== b.exists) return false
  if (!a.exists) {
    return a.type === 'none' && b.type === 'none' && a.value === null && b.value === null
  }
  return a.type === b.type && a.value === b.value
}

/** The set of proxy keys whose observed value differs from what the app wrote. */
export function differingKeys(observed: SystemProxyRegistryState, written: SystemProxyWrittenState): string[] {
  const differing: string[] = []
  if (!sameRegistryValue(observed.proxyEnable, written.proxyEnable)) differing.push('ProxyEnable')
  if (!sameRegistryValue(observed.proxyServer, written.proxyServer)) differing.push('ProxyServer')
  if (!sameRegistryValue(observed.proxyOverride, written.proxyOverride)) differing.push('ProxyOverride')
  return differing
}

/** Whether the current registry exactly matches what the app wrote. */
export function isOwned(observed: SystemProxyRegistryState, written: SystemProxyWrittenState): boolean {
  return differingKeys(observed, written).length === 0
}

/** A short, human readable summary of which keys were mutated externally. */
export function conflictDetail(observed: SystemProxyRegistryState, written: SystemProxyWrittenState): string {
  const keys = differingKeys(observed, written)
  return keys.length === 0 ? '' : `注册表项被外部修改：${keys.join('、')}`
}

/** Whether the current registry exactly matches the pre-enable snapshot. */
export function matchesPrevious(observed: SystemProxyRegistryState, previous: SystemProxyRegistryState): boolean {
  return isOwned(observed, previous)
}

/**
 * Refuse to enable *before* any registry write if the pre-enable state contains a
 * value we cannot faithfully restore, or a structurally inconsistent value. This
 * is fail-closed: we would rather leave the system proxy untouched than enable on
 * top of a state we could not put back.
 */
export function validateRestorable(previous: SystemProxyRegistryState): void {
  const entries = Object.entries(previous) as [keyof SystemProxyRegistryState, RegistryValue][]
  for (const [name, value] of entries) {
    if (!value.exists) {
      if (value.type !== 'none' || value.value !== null) {
        throw new ProtocolError(
          ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED,
          `系统代理项 ${name} 的备份状态不一致，已拒绝启用`
        )
      }
      continue
    }
    if (!isRestorableType(value.type)) {
      throw new ProtocolError(
        ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED,
        `系统代理项 ${name} 的类型 ${value.type} 无法安全还原，已拒绝启用`
      )
    }
    if (value.type === 'REG_DWORD' || value.type === 'REG_QWORD') {
      if (typeof value.value !== 'number' || !Number.isInteger(value.value) || value.value < 0) {
        throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `系统代理项 ${name} 的数值无效`)
      }
    } else if (typeof value.value !== 'string') {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `系统代理项 ${name} 的字符串值无效`)
    }
  }
}

/** Hard validation of a target. Throws INVALID_ARGUMENT for a bad host/port. */
export function validateTarget(target: SystemProxyTarget): SystemProxyTarget {
  if (target.host !== SYSTEM_PROXY_LOOPBACK_HOST) {
    throw new ProtocolError(
      ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED,
      `系统代理必须指向回环地址，收到 ${target.host}`
    )
  }
  if (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) {
    throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `无效的混合端口 ${target.port}`)
  }
  return target
}
