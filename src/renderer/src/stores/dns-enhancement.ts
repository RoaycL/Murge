import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { DnsEnhancement } from '@shared/dns'
import { EMPTY_DNS_ENHANCEMENT, coerceDnsEnhancement } from '@shared/dns'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the typed DNS enhancement (DNS 增强). The
 * model is loaded through IPC on mount, edited locally, and saved through IPC;
 * the main process validates every server URI, IP, domain and CIDR before
 * persisting, so an invalid edit is never applied.
 */
export const useDnsEnhancementStore = defineStore('dns-enhancement', () => {
  const enhancement = ref<DnsEnhancement>({ ...EMPTY_DNS_ENHANCEMENT })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      enhancement.value = coerceDnsEnhancement((await window.desktop.dns.get()).enhancement)
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: DnsEnhancement): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      enhancement.value = coerceDnsEnhancement((await window.desktop.dns.set(input)).enhancement)
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: DnsEnhancement): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.dns.preview(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { enhancement, busy, lastError, refresh, save, preview }
})
