import type { KernelPhase } from './runtime'
import type { SystemProxyPhase } from './system-proxy'
import type { TunPhase } from './tun'

export type DiagnosticPortLabel = 'mixed' | 'http' | 'socks' | 'controller'
export type StartupStage =
  | 'electron-ready'
  | 'settings-ready'
  | 'ipc-ready'
  | 'window-created'
  | 'managed-state-recovered'
  | 'kernel-ready'
  | 'system-proxy-enabled'
  | 'tun-active'
  | 'runtime-reconciled'
  | 'network-monitor-started'

export interface StartupTimingMark { stage: StartupStage; elapsedMs: number }
export interface StartupTimelineSnapshot { processStartedAt: string; marks: StartupTimingMark[] }
export type DiagnosticErrorCategory =
  | 'controller-auth'
  | 'controller-unreachable'
  | 'kernel-start'
  | 'tun'
  | 'system-proxy'
  | 'subscription'
  | 'update'
  | 'other'
export type DiagnosticCollectionWarning =
  | 'kernel-status-unavailable'
  | 'system-proxy-status-unavailable'
  | 'tun-status-unavailable'
  | 'settings-unavailable'
  | 'core-settings-unavailable'
  | 'tun-config-unavailable'
  | 'host-inspection-unavailable'
  | 'app-log-summary-unavailable'

export interface DiagnosticReport {
  schemaVersion: 1
  generatedAt: string
  app: { version: string; platform: string; arch: string }
  startup: StartupTimelineSnapshot
  runtime: {
    kernel: { phase: KernelPhase | 'unavailable'; pid: number | null }
    systemProxy: { desired: boolean | null; phase: SystemProxyPhase | 'unavailable'; port: number | null }
    tun: { desired: boolean | null; phase: TunPhase | 'unavailable' }
  }
  host: {
    startupTask: { state: 'enabled' | 'disabled' | 'missing' | 'unavailable'; lastRunAt: string | null; lastResult: number | null }
    coreService: 'running' | 'stopped' | 'starting' | 'missing' | 'unavailable'
    tunAdapterPresent: boolean | null
    systemProxyRegistry: { enabled: boolean | null; target: 'loopback' | 'external' | 'none' | 'unavailable'; port: number | null }
    ports: Array<{ label: DiagnosticPortLabel; port: number; ownerPids: number[]; ownedByKernel: boolean | null }>
  }
  recentErrors: Array<{ category: DiagnosticErrorCategory; count: number; lastAt: string | null }>
  collectionWarnings: DiagnosticCollectionWarning[]
  privacy: 'No raw logs, configuration, subscription URLs, controller secrets, domains or destinations are included.'
}
