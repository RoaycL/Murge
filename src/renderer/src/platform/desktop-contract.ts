/**
 * Renderer-side shell contract (Phase 1).
 *
 * Views and stores must not know which shell is running (Electron preload vs
 * the Tauri compatibility bridge). This module is the single seam: it detects
 * the shell once and re-exports the typed contract. Tauri's bridge will
 * install `window.desktop` with the same `DesktopApi` shape before Vue mounts,
 * so this file stays the only platform-aware module in the renderer.
 *
 * The `DesktopApi` interface lives in `@shared/ipc` and is the behavior spec
 * for both shells (see docs/tauri/phase0/IPC_INVENTORY.md).
 */

/** The subset of shell facts the renderer is allowed to know. */
export type ShellKind = 'electron' | 'tauri' | 'browser'

export interface ShellDetection {
  readonly kind: ShellKind
  /** True when the typed `window.desktop` bridge is present. */
  readonly hasDesktopBridge: boolean
}

export function detectShell(target: { desktop?: unknown; __TAURI_INTERNALS__?: unknown } = window): ShellDetection {
  const hasDesktopBridge = typeof target.desktop === 'object' && target.desktop !== null
  const isTauri = hasDesktopBridge && typeof target.__TAURI_INTERNALS__ !== 'undefined'
  return {
    kind: hasDesktopBridge ? (isTauri ? 'tauri' : 'electron') : 'browser',
    hasDesktopBridge
  }
}

export type { DesktopApi } from '@shared/ipc'
export { IPC } from '@shared/ipc'

// Re-export the renderer-visible payload types stores already consume, so a
// future shell swap never touches view/store imports.
export type {
  BrandConfig,
  AppInfo,
  KernelStatus,
  KernelManagerState,
  RuntimeSummary,
  TrafficSample,
  MihomoDelayResult,
  MihomoDelayMap,
  MihomoDnsQueryResult,
  MihomoDnsQueryType,
  MihomoLogMessage,
  MihomoLogsSnapshot,
  MihomoStreamError,
  ProfileMeta,
  Profile,
  ImportRequest,
  ConfigEdit,
  ProfileProviderCatalog,
  ProfileProviderContent,
  ActiveProfileConfigInspection,
  ValidationResult,
  SystemProxyStatus,
  ProxyBypassPolicy,
  StartupStatus,
  ServiceUnlockResult,
  AppSettings,
  SubStoreState,
  OverridesSnapshot,
  OverrideInput,
  OverridePreview,
  OverrideValidation,
  OverrideLastKnownGood,
  DnsSnapshot,
  DnsEnhancement,
  SnifferSnapshot,
  SnifferEnhancement,
  UpdateState,
  TunStatus,
  TunConfigModel,
  TunConfigSnapshot,
  CoreSettings,
  GeodataSettings,
  UsageWindow,
  UsageRanking,
  UsageHistorySnapshot,
  UsageRankingEntry,
  UsageCapacity,
  NetworkMetadataProvider,
  NetworkMetadataSnapshot,
  NetworkMetadataState
} from '@shared/ipc-types'
