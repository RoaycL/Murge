import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { CoreSettings } from '@shared/core-settings'
import { coerceCoreSettings, EMPTY_CORE_SETTINGS } from '@shared/core-settings'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the controlled mihomo core settings. The
 * model is loaded through IPC on mount, edited locally, and saved through IPC;
 * the main process validates every field before persisting, so an invalid model
 * is never applied. The main kernel reflects an `enabled` model via read-back,
 * so the runtime config always shows exactly these core keys.
 */
export const useCoreSettingsStore = defineStore('core-settings', () => {
  const settings = ref<CoreSettings>({ ...EMPTY_CORE_SETTINGS })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      settings.value = coerceCoreSettings(await window.desktop.core.get())
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: CoreSettings): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      settings.value = coerceCoreSettings(await window.desktop.core.set(input))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: CoreSettings): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.core.preview(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { settings, busy, lastError, refresh, save, preview }
})
