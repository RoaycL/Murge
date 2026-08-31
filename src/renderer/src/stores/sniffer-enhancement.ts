import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { SnifferEnhancement } from '@shared/sniffer'
import { EMPTY_SNIFFER_ENHANCEMENT, coerceSnifferEnhancement } from '@shared/sniffer'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the typed sniffer enhancement (Sniffer 增强).
 * The model is loaded through IPC on mount, edited locally, and saved through
 * IPC; the main process validates every port, domain pattern and address CIDR
 * before persisting, so an invalid edit is never applied.
 */
export const useSnifferEnhancementStore = defineStore('sniffer-enhancement', () => {
  const enhancement = ref<SnifferEnhancement>({ ...EMPTY_SNIFFER_ENHANCEMENT })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      enhancement.value = coerceSnifferEnhancement((await window.desktop.sniffer.get()).enhancement)
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: SnifferEnhancement): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      enhancement.value = coerceSnifferEnhancement((await window.desktop.sniffer.set(input)).enhancement)
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: SnifferEnhancement): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.sniffer.preview(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { enhancement, busy, lastError, refresh, save, preview }
})
