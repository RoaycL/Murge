import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings } from '@shared/app-settings'
import { DEFAULT_APP_SETTINGS } from '@shared/app-settings'
import { toProtocolError } from '@shared/protocol-errors'
import { applyLanguageSetting } from '@shared/i18n'

/** Renderer mirror of durable main-process application preferences. */
const INITIAL: AppSettings = { ...DEFAULT_APP_SETTINGS }

export const useAppSettingsStore = defineStore('app-settings', () => {
  const settings = ref<AppSettings>({ ...INITIAL })
  const busy = ref(false)
  const errorMessage = ref<string | null>(null)

  // The interface language is the one setting every view depends on.
  watch(() => settings.value.language, (language) => applyLanguageSetting(language))

  async function refresh(): Promise<void> {
    try {
      settings.value = await window.desktop.appSettings.get()
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    }
  }

  /**
   * Persist a partial app-setting change. Optimistically applies the local value
   * then reconciles with the authoritative main-process result; a failure rolls
   * the local value back and surfaces the message.
   */
  async function set(patch: Partial<AppSettings>): Promise<boolean> {
    if (busy.value) return false
    const previous = { ...settings.value }
    settings.value = { ...settings.value, ...patch }
    busy.value = true
    try {
      settings.value = await window.desktop.appSettings.set(patch)
      errorMessage.value = null
      return true
    } catch (error) {
      settings.value = previous
      errorMessage.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  return { settings, busy, errorMessage, refresh, set }
})
