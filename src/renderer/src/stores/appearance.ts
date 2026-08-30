import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemePreference = 'system' | 'light' | 'dark'
export interface AppearancePreference {
  theme: ThemePreference
  highContrast: boolean
  reduceMotion: boolean
}

export const DEFAULT_APPEARANCE: AppearancePreference = Object.freeze({ theme: 'system', highContrast: false, reduceMotion: false })
const STORAGE_KEY = 'appearance.v1'

export function parseAppearancePreference(value: string | null): AppearancePreference {
  if (!value) return { ...DEFAULT_APPEARANCE }
  try {
    const parsed = JSON.parse(value) as Partial<AppearancePreference>
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'system',
      highContrast: parsed.highContrast === true,
      reduceMotion: parsed.reduceMotion === true
    }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function resolvedTheme(theme: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}

export const useAppearanceStore = defineStore('appearance', () => {
  const initial = parseAppearancePreference(window.localStorage.getItem(STORAGE_KEY))
  const theme = ref<ThemePreference>(initial.theme)
  const highContrast = ref(initial.highContrast)
  const reduceMotion = ref(initial.reduceMotion)
  let media: MediaQueryList | null = null

  function apply(): void {
    const systemDark = media?.matches ?? window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.dataset.theme = resolvedTheme(theme.value, systemDark)
    document.documentElement.dataset.contrast = highContrast.value ? 'high' : 'normal'
    document.documentElement.dataset.reduceMotion = reduceMotion.value ? 'true' : 'false'
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: theme.value, highContrast: highContrast.value, reduceMotion: reduceMotion.value }))
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

  return { theme, highContrast, reduceMotion, connect, disconnect, setTheme, setHighContrast, setReduceMotion }
})

