import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { GeodataSettings } from '@shared/geodata'
import { coerceGeodataSettings, EMPTY_GEODATA_SETTINGS } from '@shared/geodata'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the controlled mihomo geodata settings. The
 * model is loaded through IPC on mount, edited locally, and saved through IPC;
 * the main process validates every field before persisting, so an invalid model
 * is never applied. The main kernel reflects an `enabled` model via read-back,
 * so the runtime config always shows exactly these geodata keys.
 */
export const useGeodataSettingsStore = defineStore('geodata-settings', () => {
  const settings = ref<GeodataSettings>({ ...EMPTY_GEODATA_SETTINGS })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      settings.value = coerceGeodataSettings(await window.desktop.geodata.get())
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: GeodataSettings): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      settings.value = coerceGeodataSettings(await window.desktop.geodata.set(input))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: GeodataSettings): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.geodata.preview(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { settings, busy, lastError, refresh, save, preview }
})
