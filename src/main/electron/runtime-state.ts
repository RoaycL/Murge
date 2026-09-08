import type { BrowserWindow } from 'electron'
import type { KernelGateway } from '@shared/gateways'
import type { AppSettings } from '@shared/app-settings'
import type { TunStatus } from '@shared/tun'
import type { MihomoService } from '../services/mihomo-service'
import type { SystemProxyService } from '../system-proxy/service'
import type { SubStoreService } from '../substore/service'
import type { NetworkDetector } from '../services/network-detector'
import type { RuntimeIntentRecoveryCoordinator } from '../startup/runtime-intent-recovery'

/**
 * Mutable application state container for the Electron shell.
 *
 * Phase 1 (migration boundary) extracts the module-level mutable variables of
 * the former monolithic `src/main/index.ts` into one shared container so the
 * shell can be split across adapters without circular imports. Every field is
 * initialized to its exact pre-refactor value, so startup ordering semantics
 * are unchanged.
 *
 * The container imports Electron types only (`BrowserWindow`), never values,
 * keeping this module loadable from composition-root style code and unit
 * tests. Concrete service classes are also type-only here.
 */
export interface ApplicationState {
  /** Live kernel gateway (queued/ordered composition), null until wired. */
  kernel: KernelGateway | null
  /** Live mihomo service (dev mock or production controller service). */
  mihomo: MihomoService | null
  /** System proxy controller service. */
  systemProxy: SystemProxyService | null
  /** Dev-only in-process mock controller handle. */
  mockServer: { close(): Promise<void> } | null
  /** Dispose function returned by registerIpc, invoked at shutdown. */
  disposeIpc: (() => void) | null
  /** True between shutdown start and cleanup completion. */
  isQuitting: boolean
  /** Shared idempotent shutdown promise (session-end + shutdown join on it). */
  shutdownPromise: Promise<void> | null
  /** Mirrored app settings for synchronous event handlers. */
  cachedAppSettings: AppSettings
  /** Strong ref to the Sub-Store service for settings changes + disposal. */
  subStoreServiceRef: SubStoreService | null
  /** Strong window ref — a GC'd BrowserWindow becomes an invisible process. */
  mainWindow: BrowserWindow | null
  /** Tray controller for disposal and hidden-start readiness probes. */
  trayController: { isReady(): boolean; dispose(): void } | null
  /** Unsubscribe for the tray/system-proxy appearance listeners. */
  disposeRuntimeAppearance: (() => void) | null
  /** TUN coordinator for quit-path emergency disable. */
  tunCoordinator: { emergencyDisable(): Promise<TunStatus> } | null
  /** The one mode-transition controller (start/stop/TUN FIFO). */
  modeTransition: { runExclusive<T>(task: () => Promise<T>): Promise<T> } | null
  /** Stops the privileged-kernel liveness monitor. */
  tunExitMonitor: { stop(): void } | null
  /** Proxy-guard interval handle. */
  proxyGuardTimer: ReturnType<typeof setInterval> | null
  /** Connectivity watchdog. */
  networkDetector: NetworkDetector | null
  /** Durable-intent recovery loop. */
  runtimeIntentRecovery: RuntimeIntentRecoveryCoordinator | null
  /** Usage-history persistence, disposed at shutdown. */
  usageHistoryServiceRef: { dispose(): Promise<void> } | null
  /** Update service (auto-check + polling), disposed at shutdown. */
  updateService: { dispose(): void } | null
  /** File log service (module-level lifecycle: startup through final flush). */
  fileLogsRef: { writeApp(level: 'info' | 'warn' | 'error', values: readonly unknown[], module?: string): Promise<void>; flush(): Promise<void> } | null
  /** Drains profile/selection queue before teardown. */
  waitForProfileOperations: (() => Promise<void>) | null
  /** Trusted internal route queued for the renderer (notification clicks). */
  pendingRendererRoute: string | null
}

export function createApplicationState(defaultSettings: AppSettings): ApplicationState {
  return {
    kernel: null,
    mihomo: null,
    systemProxy: null,
    mockServer: null,
    disposeIpc: null,
    isQuitting: false,
    shutdownPromise: null,
    cachedAppSettings: { ...defaultSettings },
    subStoreServiceRef: null,
    mainWindow: null,
    trayController: null,
    disposeRuntimeAppearance: null,
    tunCoordinator: null,
    modeTransition: null,
    tunExitMonitor: null,
    proxyGuardTimer: null,
    networkDetector: null,
    runtimeIntentRecovery: null,
    usageHistoryServiceRef: null,
    updateService: null,
    fileLogsRef: null,
    waitForProfileOperations: null,
    pendingRendererRoute: null
  }
}
