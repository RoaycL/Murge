import type { SystemProxyTarget } from '../../shared/system-proxy'

export type { SystemProxyTarget } from '../../shared/system-proxy'

/** Backing type of a single registry value as read from the target key. */
export type RegistryValueType = 'string' | 'dword' | 'binary' | 'none'

export interface RegistryValue {
  exists: boolean
  type: RegistryValueType
  /** string → raw text; dword → number (0..0xFFFFFFFF); binary/none → hex string. */
  value: string | number | null
}

/**
 * Snapshot of the three HKCU Internet Settings values the feature owns:
 * `ProxyEnable` (REG_DWORD), `ProxyServer` (REG_SZ) and `ProxyOverride` (REG_SZ).
 */
export interface SystemProxyRegistryState {
  proxyEnable: RegistryValue
  proxyServer: RegistryValue
  proxyOverride: RegistryValue
}

/** The value set the app writes while a proxy is enabled. */
export interface SystemProxyWrittenState {
  proxyEnable: RegistryValue
  proxyServer: RegistryValue
  proxyOverride: RegistryValue
}

/** Point-in-time record of an owned proxy, persisted for crash recovery. */
export interface SystemProxyBackup {
  schemaVersion: number
  /** Startup instance id; used to identify the owner across reboots. */
  instanceId: string
  createdAt: string
  target: SystemProxyTarget
  /** The exact pre-enable registry snapshot (restored on disable). */
  previous: SystemProxyRegistryState
  /** The exact values the app wrote (ownership comparison target). */
  written: SystemProxyWrittenState
}

/**
 * Platform adapter boundary. The decision logic lives in `SystemProxyService`;
 * an adapter only reads/applies/restores the *platform* values on one OS.
 */
export interface SystemProxyAdapter {
  /** Human readable platform label, e.g. `win32`. */
  readonly platform: string
  /** Whether this adapter can own the system proxy on the running platform. */
  readonly supported: boolean
  read(): Promise<SystemProxyRegistryState>
  apply(written: SystemProxyWrittenState): Promise<void>
  restore(previous: SystemProxyRegistryState): Promise<void>
  /** Notify the OS so running apps pick up the change (WinINet refresh). */
  refresh(): Promise<void>
}

/**
 * Kernel readiness probe. `SystemProxyService.enable()` calls this and refuses to
 * enable unless the kernel is running, authenticated and exposes a mixed-port.
 */
export interface SystemProxyKernelProbe {
  resolveTarget(): Promise<SystemProxyTarget>
}

/**
 * Owned-backup persistence. `SystemProxyService` writes the backup before
 * applying so a crash mid-apply is recoverable on next startup.
 */
export interface SystemProxyBackupStore {
  read(): Promise<SystemProxyBackup | null>
  write(backup: SystemProxyBackup): Promise<void>
  delete(): Promise<void>
}
