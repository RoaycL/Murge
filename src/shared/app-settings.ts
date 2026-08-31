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
   * Start the safe loopback kernel automatically when the app launches, so the
   * Policy/Rules views reflect the active profile immediately without a manual
   * "安全直连内核" step. Only the loopback-only kernel is started; system proxy
   * and TUN remain explicit, user-triggered takeovers.
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
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  autoStartKernel: true,
  autoCheckUpdate: true,
  kernelEnabled: true,
  kernelChannel: 'stable',
  kernelSpecificVersion: ''
})

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
      kernelEnabled:
        typeof parsed.kernelEnabled === 'boolean'
          ? parsed.kernelEnabled
          : DEFAULT_APP_SETTINGS.kernelEnabled,
      kernelChannel:
        parsed.kernelChannel === 'specific' ? 'specific' : DEFAULT_APP_SETTINGS.kernelChannel,
      kernelSpecificVersion:
        typeof parsed.kernelSpecificVersion === 'string'
          ? parsed.kernelSpecificVersion
          : DEFAULT_APP_SETTINGS.kernelSpecificVersion
    }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}
