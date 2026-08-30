import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { StartupStatus } from '@shared/startup'
import { toProtocolError } from '@shared/protocol-errors'

export const useStartupStore = defineStore('startup', () => {
  const status = ref<StartupStatus>({ supported: false, enabled: false, phase: 'unsupported', errorMessage: null })
  const busy = ref(false)

  async function refresh(): Promise<void> {
    try {
      status.value = await window.desktop.startup.getStatus()
    } catch (error) {
      status.value = { ...status.value, phase: 'error', errorMessage: toProtocolError(error).message }
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    if (busy.value || !status.value.supported) return
    busy.value = true
    try {
      status.value = await window.desktop.startup.setEnabled(enabled)
    } catch (error) {
      status.value = { ...status.value, phase: 'error', errorMessage: toProtocolError(error).message }
    } finally {
      busy.value = false
    }
  }

  return { status, busy, refresh, setEnabled }
})
