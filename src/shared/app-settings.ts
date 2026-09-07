import type { KernelVersionChannel } from './kernel-manager'

/**
 * User-facing application preferences that live outside a profile and outside
 * the OS network configuration. Persisted by the main process in the stable
 * app-data namespace so they survive restarts and are readable at launch time
 * (which a renderer localStorage value is not — the main process needs the
 * choice before the window exists).
 */

export interface AppSettings {
  /**
   * Start the kernel automatically when the app launches, so the Policy/Rules
   * views reflect the active profile immediately without a manual start. A
   * remembered proxy/TUN intent still starts the required host when this is
   * false; those takeovers cannot function without a live kernel.
   */
  autoStartKernel: boolean
  /**
   * Check for a newer published release on launch and, when one exists,
   * download it in the background so it can be installed on the next quit. Only
   * affects the automatic check; a manual "检查更新" always works regardless of
   * this flag.
   */
  autoCheckUpdate: boolean
  /**
   * User's durable intent for the Windows system proxy. Clean application/OS
   * shutdown may temporarily restore the registry, but the next launch applies
   * this intent again after a kernel host is confirmed ready.
   */
  systemProxyDesired: boolean
  /**
   * User's durable intent for TUN mode. This is deliberately separate from the
   * live coordinator phase: boot reconciliation first removes an interrupted
   * session, then startup may create a fresh one from this intent.
   */
  tunDesired: boolean
  /**
   * Master switch for the kernel: when false the kernel refuses to start
   * (automatic and manual). The safe default is enabled.
   */
  kernelEnabled: boolean
  /**
   * Which kernel build the next start uses. `stable` is the built-in pinned
   * build; `specific` runs the user-selected mihomo version.
   */
  kernelChannel: KernelVersionChannel
  /**
   * The user-chosen specific mihomo version (leading `v`), e.g. `v1.19.30`.
   * Empty string means none selected; the effective build falls back to stable.
   */
  kernelSpecificVersion: string
  /** Which URL source interactive proxy delay tests prefer. */
  delayTestUrlScope: 'group' | 'global'
  /** Optional global HTTP(S) delay target; blank uses the safe built-in 204 URL. */
  delayTestUrl: string
  /**
   * Silent start (party/sparkle's 静默启动): when true the Windows login item
   * is registered with `--hidden`, so a login launch stays in the tray instead
   * of popping the main window. Manual launches are unaffected.
   */
  silentLaunch: boolean
  /**
   * Close-to-tray (verge's 最小化到托盘而非退出): when true closing the main
   * window only hides it and the app keeps running in the tray; when false the
   * close button quits through the normal restore-and-shutdown flow.
   */
  closeToTray: boolean
  /**
   * Proxy guard (verge's 代理守护): while the app owns an enabled system proxy,
   * periodically re-apply the exact written values if something on the box
   * mutated them. Values the app does not own are never fought.
   */
  proxyGuard: boolean
  /**
   * Sub-Store lifecycle switch. It defaults on because Sub-Store is a first-class
   * configuration tool; verified assets are downloaded in the background.
   */
  subStoreEnabled: boolean
  /**
   * Route Sub-Store's own outbound subscription fetches through the kernel
   * mixed-port (HTTP_PROXY/HTTPS_PROXY env on the worker).
   */
  subStoreUseProxy: boolean
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  autoStartKernel: true,
  autoCheckUpdate: true,
  systemProxyDesired: false,
  tunDesired: false,
  kernelEnabled: true,
  kernelChannel: 'stable',
  kernelSpecificVersion: '',
  delayTestUrlScope: 'group',
  delayTestUrl: '',
  // Reference-client parity: party/sparkle default silent start OFF, verge
  // keeps close-to-tray ON and its proxy guard ON by default. Sub-Store ships
  // as a first-class configuration tool and prepares its assets by default.
  silentLaunch: false,
  closeToTray: true,
  proxyGuard: true,
  subStoreEnabled: true,
  subStoreUseProxy: false
})

function parseDelayTestUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_APP_SETTINGS.delayTestUrl
  const normalized = value.trim()
  if (!normalized) return ''
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : ''
  } catch {
    return ''
  }
}

/**
 * Coerce an on-disk JSON string into a complete {@link AppSettings}. Unknown or
 * malformed fields fall back to the default so a corrupt or older file can never
 * produce a partially-typed object or crash the launcher.
 */
export function parseAppSettings(value: string | null): AppSettings {
  if (!value) return { ...DEFAULT_APP_SETTINGS }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      autoStartKernel:
        typeof parsed.autoStartKernel === 'boolean'
          ? parsed.autoStartKernel
          : DEFAULT_APP_SETTINGS.autoStartKernel,
      autoCheckUpdate:
        typeof parsed.autoCheckUpdate === 'boolean'
          ? parsed.autoCheckUpdate
          : DEFAULT_APP_SETTINGS.autoCheckUpdate,
      systemProxyDesired:
        typeof parsed.systemProxyDesired === 'boolean'
          ? parsed.systemProxyDesired
          : DEFAULT_APP_SETTINGS.systemProxyDesired,
      tunDesired:
        typeof parsed.tunDesired === 'boolean'
          ? parsed.tunDesired
          : DEFAULT_APP_SETTINGS.tunDesired,
      kernelEnabled:
        typeof parsed.kernelEnabled === 'boolean'
          ? parsed.kernelEnabled
          : DEFAULT_APP_SETTINGS.kernelEnabled,
      kernelChannel:
        parsed.kernelChannel === 'specific' ? 'specific' : DEFAULT_APP_SETTINGS.kernelChannel,
      kernelSpecificVersion:
        typeof parsed.kernelSpecificVersion === 'string'
          ? parsed.kernelSpecificVersion
          : DEFAULT_APP_SETTINGS.kernelSpecificVersion,
      delayTestUrlScope:
        parsed.delayTestUrlScope === 'global' ? 'global' : DEFAULT_APP_SETTINGS.delayTestUrlScope,
      delayTestUrl:
        parseDelayTestUrl(parsed.delayTestUrl),
      silentLaunch:
        typeof parsed.silentLaunch === 'boolean'
          ? parsed.silentLaunch
          : DEFAULT_APP_SETTINGS.silentLaunch,
      closeToTray:
        typeof parsed.closeToTray === 'boolean'
          ? parsed.closeToTray
          : DEFAULT_APP_SETTINGS.closeToTray,
      proxyGuard:
        typeof parsed.proxyGuard === 'boolean'
          ? parsed.proxyGuard
          : DEFAULT_APP_SETTINGS.proxyGuard,
      subStoreEnabled:
        typeof parsed.subStoreEnabled === 'boolean'
          ? parsed.subStoreEnabled
          : DEFAULT_APP_SETTINGS.subStoreEnabled,
      subStoreUseProxy:
        typeof parsed.subStoreUseProxy === 'boolean'
          ? parsed.subStoreUseProxy
          : DEFAULT_APP_SETTINGS.subStoreUseProxy
    }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}
