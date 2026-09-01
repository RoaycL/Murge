/**
 * Shared system-proxy contract.
 *
 * These types cross the main/renderer boundary over typed IPC. They describe
 * the *reported* state of the platform system proxy as owned by the app — never
 * the raw registry, which no renderer code may touch.
 */

/**
 * Lifecycle phase of the app-owned system proxy.
 *
 * `disabled` means the OS proxy is not currently owned by the app (either it was
 * never enabled or it was cleanly restored). `enabled` means the OS proxy is
 * pointed at our controller and the registry matches what we wrote. `restoring`
 * / `restore-failed` belong to the restore path, `conflict` means an external
 * process changed a value we own so we will not overwrite it, and
 * `unsupported` means the current platform cannot own the system proxy.
 */
export type SystemProxyPhase =
  | 'disabled'
  | 'enabling'
  | 'enabled'
  | 'restoring'
  | 'restore-failed'
  | 'conflict'
  | 'unsupported'

export interface SystemProxyStatus {
  /** Whether the current platform/build can own the system proxy at all. */
  supported: boolean
  phase: SystemProxyPhase
  /** The host:port that the system proxy points to while enabled, else null. */
  address: string | null
  /** The controller mixed-port, while enabled, else null. */
  port: number | null
  /**
   * The `ProxyOverride` value the app most recently wrote while enabled (or
   * observed, when the phase is `conflict`), else null. This is the verified
   * read-back of the bypass list so the renderer can show what is actually
   * applied without touching the registry.
   */
  proxyOverride: string | null
  /** Human readable (usually Chinese) error detail for the current phase. */
  errorMessage: string | null
  /** Extra detail for a conflict phase (which value was mutated). */
  conflictDetail: string | null
  /** ISO timestamp of the last status transition, else null. */
  updatedAt: string | null
}

/** Sentinel host that the system proxy may only ever point at. */
export const SYSTEM_PROXY_LOOPBACK_HOST = '127.0.0.1'

/** The listeners the system proxy may be pointed at (always the loopback mixed-port). */
export interface SystemProxyTarget {
  host: string
  port: number
}
