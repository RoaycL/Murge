import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RuntimeSummary } from '@shared/runtime'

/** Static runtime context (network, profile, outbound mode) pulled once on demand. */
export const useRuntimeStore = defineStore('runtime', () => {
  const summary = ref<RuntimeSummary | null>(null)

  async function refresh(): Promise<void> {
    summary.value = await window.desktop.runtime.getSummary()
  }

  return { summary, refresh }
})
