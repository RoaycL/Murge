import { SYSTEM_PROXY_LOOPBACK_HOST } from '../../shared/system-proxy'
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
const LOCAL_BYPASS_ENTRIES = ['<local>', 'localhost', '127.*', '10.*', '172.16.*', '192.168.*'] as const

/**
 * Build the `ProxyOverride` value we write while enabled.
 *
 * The mandatory local bypass list is always present. If the user already had a
 * `ProxyOverride`, its entries are preserved and de-duplicated so no user-facing
 * bypass is silently dropped during ownership; the original value is still
 * restored verbatim on `disable()`.
 */
export function mergeProxyOverride(original: string | null | undefined): string {
  const merged = new Set<string>(LOCAL_BYPASS_ENTRIES)
  if (typeof original === 'string' && original.length > 0) {
    for (const entry of original.split(';')) {
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      merged.add(trimmed)
    }
  }
  return Array.from(merged).join(';')
}

/** Build the value set the app owns while the system proxy is enabled. */
export function buildWrittenState(
  target: SystemProxyTarget,
  observed: SystemProxyRegistryState
): SystemProxyWrittenState {
  return {
    proxyEnable: { exists: true, type: 'dword', value: 1 },
    proxyServer: { exists: true, type: 'string', value: buildProxyServerValue(target) },
    proxyOverride: { exists: true, type: 'string', value: mergeProxyOverride(observed.proxyOverride.value as string | null) }
  }
}

function normalizedString(value: RegistryValue): string | null {
  return value.exists && typeof value.value === 'string' ? value.value : null
}

function normalizedDword(value: RegistryValue): number | null {
  return value.exists && typeof value.value === 'number' ? value.value : null
}

/** The set of proxy keys whose observed value differs from what the app wrote. */
export function differingKeys(observed: SystemProxyRegistryState, written: SystemProxyWrittenState): string[] {
  const differing: string[] = []
  if (normalizedDword(observed.proxyEnable) !== normalizedDword(written.proxyEnable)) differing.push('ProxyEnable')
  if (normalizedString(observed.proxyServer) !== normalizedString(written.proxyServer)) differing.push('ProxyServer')
  if (normalizedString(observed.proxyOverride) !== normalizedString(written.proxyOverride)) differing.push('ProxyOverride')
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
