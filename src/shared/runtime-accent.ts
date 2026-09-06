import type { SystemProxyPhase } from './system-proxy'
import type { TunPhase } from './tun'

export type RuntimeAccent = 'idle' | 'proxy' | 'tun'

/**
 * One status-colour contract for the window, tray and dashboard.
 * TUN wins while it owns the network path; otherwise the verified system
 * proxy state wins. Transitional/error states deliberately stay neutral.
 */
export function resolveRuntimeAccent(
  systemProxyPhase: SystemProxyPhase,
  tunPhase: TunPhase
): RuntimeAccent {
  if (tunPhase === 'active') return 'tun'
  if (systemProxyPhase === 'enabled') return 'proxy'
  return 'idle'
}

export const RUNTIME_ACCENT_HEX: Readonly<Record<RuntimeAccent, string>> = {
  idle: '#8e8e93',
  proxy: '#34c759',
  tun: '#0a84ff'
}
