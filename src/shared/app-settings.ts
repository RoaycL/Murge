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
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  autoStartKernel: true
})

/**
 * Coerce an on-disk JSON string into a complete {@link AppSettings}. Unknown or
 * malformed fields fall back to the default so a corrupt or older file can never
 * produce a partially-typed object or crash the launcher.
 */
export function parseAppSettings(value: string | null): AppSettings {
  if (!value) return { ...DEFAULT_APP_SETTINGS }
  try {
    const parsed = JSON.parse(value) as { autoStartKernel?: unknown }
    return {
      autoStartKernel:
        typeof parsed.autoStartKernel === 'boolean'
          ? parsed.autoStartKernel
          : DEFAULT_APP_SETTINGS.autoStartKernel
    }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}
