import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RuntimeSummary } from '@shared/runtime'
import { toProtocolError } from '@shared/protocol-errors'

/** Static runtime context (network, profile, outbound mode) pulled once on demand. */
export const useRuntimeStore = defineStore('runtime', () => {
  const summary = ref<RuntimeSummary | null>(null)
  const externalIp = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<boolean> {
    try {
      summary.value = await window.desktop.runtime.getSummary()
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    }
  }

  /** Fetch the proxy egress IP without blocking the summary above. */
  async function fetchExternalIp(): Promise<void> {
    try {
      externalIp.value = await window.desktop.runtime.getExternalIp()
    } catch {
      externalIp.value = null
    }
  }

  return { summary, externalIp, lastError, refresh, fetchExternalIp }
})
