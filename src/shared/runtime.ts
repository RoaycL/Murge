export type KernelPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type OutboundMode = 'rule' | 'global' | 'direct'

export interface KernelStatus {
  phase: KernelPhase
  pid: number | null
  version: string | null
  controllerUrl: string | null
  startedAt: string | null
  lastError: string | null
}

export interface RuntimeSummary {
  networkName: string
  profileName: string
  mode: OutboundMode
  externalIp: string | null
  systemProxyEnabled: boolean
  tunEnabled: boolean
}

export interface TrafficSample {
  timestamp: number
  up: number
  down: number
  upTotal: number
  downTotal: number
}
