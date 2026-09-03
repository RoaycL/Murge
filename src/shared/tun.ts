/** Renderer-visible Phase 9 TUN lifecycle. No type in this file performs I/O. */
export type TunPhase =
  | 'configured'
  | 'starting'
  | 'active'
  | 'restoring'
  | 'failed'
  | 'conflict'
  | 'unsupported'
  | 'restore-failed'

export interface TunStatus {
  supported: boolean
  phase: TunPhase
  errorMessage: string | null
  conflictDetail: string | null
  updatedAt: string | null
}

export type CanonicalNetLuid = string
export type CanonicalGuid = string

export interface DesiredNetworkRoute {
  family: 4 | 6
  destination: string
  prefixLength: number
  nextHop: string | null
  metric: number
  routeStore: 'active' | 'persistent'
}

export interface DesiredNetworkState {
  schemaVersion: 1
  adapter: {
    name: string
    tunnelType: string
    requestedGuid: CanonicalGuid
  }
  routes: DesiredNetworkRoute[]
  dns: Array<{ luid: CanonicalNetLuid; servers: string[]; source: 'static' | 'dhcp' }>
  metrics: Array<{ luid: CanonicalNetLuid; metric: number }>
}

/** Phase 9B renderer-safe intent. It contains no privileged paths or OS mutations. */
export interface MihomoOwnedTunIntent {
  schemaVersion: 2
  device: string
  stack: 'mixed' | 'system' | 'gvisor'
}

export type TunIntent = 'initialize' | 'enable' | 'enabled' | 'disable' | 'restored' | 'fail' | 'fatal' | 'conflict' | 'unsupported'

export interface TunGateway {
  getStatus(): TunStatus | Promise<TunStatus>
  enable(): Promise<TunStatus>
  disable(): Promise<TunStatus>
  onStatus(listener: (status: TunStatus) => void): () => void
}

/** Reserved typed IPC names. They are not registered or exposed until the Phase 9 gate passes. */
export const TUN_IPC = {
  getStatus: 'tun:get-status',
  enable: 'tun:enable',
  disable: 'tun:disable',
  statusEvent: 'tun:status-event'
} as const

export const TUN_UI_COPY: Readonly<Record<TunPhase, string>> = {
  configured: 'TUN 未启用（当前平台支持）',
  starting: 'TUN 正在启动…',
  active: 'TUN 已启用',
  restoring: '正在恢复网络设置…',
  failed: 'TUN 启用失败，可重试',
  // Conflict is recoverable: toggling off re-runs the restore path, which
  // reconciles with the service first (the only way a latched conflict clears).
  conflict: 'TUN 状态冲突：请先关闭 TUN 以重新对齐服务状态',
  unsupported: '当前平台不支持 TUN',
  'restore-failed': '网络设置恢复失败，可重试关闭'
}
