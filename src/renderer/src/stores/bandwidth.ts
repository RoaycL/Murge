import { ref } from 'vue'
import { defineStore } from 'pinia'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * 带宽 card state. A test only runs when the user asks (it moves tens of
 * megabytes through the current policy), and the last result is kept for the
 * session so leaving the page does not lose it.
 */
export const useBandwidthStore = defineStore('bandwidth', () => {
  const state = ref<'idle' | 'testing' | 'ready' | 'error'>('idle')
  const downMbps = ref<number | null>(null)
  const upMbps = ref<number | null>(null)
  const testedAt = ref<number | null>(null)
  const lastError = ref<string | null>(null)

  async function run(): Promise<void> {
    if (state.value === 'testing') return
    state.value = 'testing'
    lastError.value = null
    try {
      const result = await window.desktop.bandwidth.test()
      downMbps.value = result.downMbps
      upMbps.value = result.upMbps
      testedAt.value = result.testedAt
      state.value = result.downMbps == null && result.upMbps == null ? 'error' : 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      state.value = 'error'
    }
  }

  return { state, downMbps, upMbps, testedAt, lastError, run }
})
