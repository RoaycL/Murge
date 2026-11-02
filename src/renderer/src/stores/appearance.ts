import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { detectShell } from '../platform/desktop-contract'

export type ThemePreference = 'system' | 'light' | 'dark'
export interface AppearancePreference {
  theme: ThemePreference
  highContrast: boolean
  reduceMotion: boolean
  /** 窗口磨砂半透明背景（仅在系统支持时生效）。 */
  translucent: boolean
}

/** The DWM backdrop the shell applied (see src-tauri/src/window_backdrop.rs). */
export type WindowBackdrop = 'acrylic' | 'mica' | 'none'

export const DEFAULT_APPEARANCE: AppearancePreference = Object.freeze({ theme: 'system', highContrast: false, reduceMotion: false, translucent: true })
const STORAGE_KEY = 'appearance.v1'

export function parseAppearancePreference(value: string | null): AppearancePreference {
  if (!value) return { ...DEFAULT_APPEARANCE }
  try {
    const parsed = JSON.parse(value) as Partial<AppearancePreference>
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'system',
      highContrast: parsed.highContrast === true,
      reduceMotion: parsed.reduceMotion === true,
      translucent: parsed.translucent !== false
    }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function resolvedTheme(theme: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}

/**
 * The theme to pin on the native window. In system mode we must hand control
 * back to the OS (null): once the window/webview has been pinned to light or
 * dark, WebView2 reports that pinned value through prefers-color-scheme, so
 * the renderer could never see the real system theme again.
 */
export function nativeWindowTheme(theme: ThemePreference, resolved: 'light' | 'dark'): 'light' | 'dark' | null {
  return theme === 'system' ? null : resolved
}

export function windowBackdrop(target: { __MURGE_BACKDROP__?: unknown } = window): WindowBackdrop {
  const value = target.__MURGE_BACKDROP__
  return value === 'acrylic' || value === 'mica' ? value : 'none'
}

/** Frosted only when the window really has a backdrop; high contrast stays opaque. */
export function frostedWindow(backdrop: WindowBackdrop, preference: Pick<AppearancePreference, 'translucent' | 'highContrast'>): boolean {
  return backdrop !== 'none' && preference.translucent && !preference.highContrast
}

export const useAppearanceStore = defineStore('appearance', () => {
  const initial = parseAppearancePreference(window.localStorage.getItem(STORAGE_KEY))
  const theme = ref<ThemePreference>(initial.theme)
  const highContrast = ref(initial.highContrast)
  const reduceMotion = ref(initial.reduceMotion)
  const translucent = ref(initial.translucent)
  const backdrop = windowBackdrop()
  const isTauri = detectShell().kind === 'tauri'
  // undefined = never synced; null = following the system.
  let nativeTheme: 'light' | 'dark' | null | undefined
  let media: MediaQueryList | null = null

  function apply(): void {
    const systemDark = media?.matches ?? window.matchMedia('(prefers-color-scheme: dark)').matches
    const resolved = resolvedTheme(theme.value, systemDark)
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.contrast = highContrast.value ? 'high' : 'normal'
    document.documentElement.dataset.reduceMotion = reduceMotion.value ? 'true' : 'false'
    document.documentElement.dataset.frosted = frostedWindow(backdrop, { translucent: translucent.value, highContrast: highContrast.value }) ? 'true' : 'false'
    syncNativeTheme(nativeWindowTheme(theme.value, resolved))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: theme.value, highContrast: highContrast.value, reduceMotion: reduceMotion.value, translucent: translucent.value }))
  }

  // The acrylic/mica tint follows the window's own light/dark mode, which must
  // match the app theme rather than the system one.
  function syncNativeTheme(target: 'light' | 'dark' | null): void {
    if (!isTauri || nativeTheme === target) return
    nativeTheme = target
    getCurrentWindow().setTheme(target)
      // Releasing the pin changes what prefers-color-scheme reports; re-read it
      // in case the webview does not fire a media change event.
      .then(() => { if (target === null && theme.value === 'system') apply() })
      .catch(() => { nativeTheme = undefined })
  }

  function connect(): void {
    if (media) return
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    apply()
  }

  function disconnect(): void {
    media?.removeEventListener('change', apply)
    media = null
  }

  function setTheme(value: ThemePreference): void { theme.value = value; apply() }
  function setHighContrast(value: boolean): void { highContrast.value = value; apply() }
  function setReduceMotion(value: boolean): void { reduceMotion.value = value; apply() }
  function setTranslucent(value: boolean): void { translucent.value = value; apply() }

  return { theme, highContrast, reduceMotion, translucent, backdrop, connect, disconnect, setTheme, setHighContrast, setReduceMotion, setTranslucent }
})

