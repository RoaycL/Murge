import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SubStoreState } from '@shared/substore'
import { toProtocolError } from '@shared/protocol-errors'

const INITIAL: SubStoreState = {
  enabled: false,
  useProxy: false,
  phase: 'idle',
  port: null,
  version: null,
  assetsReady: false,
  error: null
}

/** Renderer mirror of the main-process Sub-Store lifecycle. */
export const useSubStoreStore = defineStore('substore', () => {
  const state = ref<SubStoreState>({ ...INITIAL })
  const busy = ref(false)
  const errorMessage = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      state.value = await window.desktop.subStore.getState()
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    }
  }

  async function ensureRunning(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      state.value = await window.desktop.subStore.ensureRunning()
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function stop(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      state.value = await window.desktop.subStore.stop()
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function checkUpdate(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      state.value = await window.desktop.subStore.checkUpdate()
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function openExternal(url: string): Promise<void> {
    try {
      await window.desktop.subStore.openExternal(url)
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    }
  }

  return { state, busy, errorMessage, refresh, ensureRunning, stop, checkUpdate, openExternal }
})
