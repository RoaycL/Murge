import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { UpdateState } from '@shared/updates'
import { DEFAULT_UPDATE_STATE, coerceUpdateState } from '@shared/updates'
import { toProtocolError } from '@shared/protocol-errors'

const INITIAL: UpdateState = { ...DEFAULT_UPDATE_STATE }

/**
 * Renderer-side source of truth for application-update state. The main process
 * broadcasts pushed transitions on every state change; manual commands round-trip
 * through IPC and reconcile with the authoritative snapshot.
 */
export const useUpdatesStore = defineStore('updates', () => {
  const state = ref<UpdateState>({ ...INITIAL })
  const busy = ref(false)
  const errorMessage = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      state.value = coerceUpdateState(await window.desktop.updates.getState())
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    }
  }

  async function check(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      state.value = coerceUpdateState(await window.desktop.updates.check())
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function download(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await window.desktop.updates.download()
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  function install(): void {
    window.desktop.updates.install()
  }

  /**
   * Subscribe to pushed transitions from the main process. Returns a clean-up
   * function the view calls on unmount; calling it again re-subscribes.
   */
  function subscribe(): () => void {
    return window.desktop.updates.onState((next) => {
      state.value = coerceUpdateState(next)
    })
  }

  return { state, busy, errorMessage, refresh, check, download, install, subscribe }
})
