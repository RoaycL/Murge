import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { KernelManagerState } from '@shared/kernel-manager'
import { DEFAULT_KERNEL_MANAGER_STATE, coerceKernelManagerState } from '@shared/kernel-manager'
import { toProtocolError } from '@shared/protocol-errors'

const INITIAL: KernelManagerState = { ...DEFAULT_KERNEL_MANAGER_STATE }

/**
 * Renderer-side source of truth for kernel-management state (the enable switch
 * and the version manager). The main process broadcasts pushed transitions on
 * every change; manual commands round-trip through IPC and reconcile with the
 * authoritative snapshot, so a busy install never loses its progress banner.
 */
export const useKernelManagerStore = defineStore('kernel-manager', () => {
  const state = ref<KernelManagerState>({ ...INITIAL })
  const busy = ref(false)
  const errorMessage = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      state.value = coerceKernelManagerState(await window.desktop.kernelManager.getState())
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    }
  }

  async function setEnabled(enabled: boolean): Promise<boolean> {
    if (busy.value) return false
    const previous = { ...state.value }
    state.value = { ...state.value, enabled }
    busy.value = true
    try {
      state.value = coerceKernelManagerState(await window.desktop.kernelManager.setEnabled(enabled))
      errorMessage.value = null
      return true
    } catch (error) {
      state.value = previous
      errorMessage.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function setChannel(channel: 'stable' | 'specific'): Promise<boolean> {
    if (busy.value) return false
    const previous = { ...state.value }
    state.value = { ...state.value, channel }
    busy.value = true
    try {
      state.value = coerceKernelManagerState(await window.desktop.kernelManager.setChannel(channel))
      errorMessage.value = null
      return true
    } catch (error) {
      state.value = previous
      errorMessage.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function listVersions(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      state.value = coerceKernelManagerState(await window.desktop.kernelManager.listVersions())
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  /** Download + verify + install a specific version, then select it. */
  async function install(version: string): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      state.value = coerceKernelManagerState(await window.desktop.kernelManager.install(version))
      errorMessage.value = null
      return true
    } catch (error) {
      errorMessage.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * Subscribe to pushed transitions from the main process. Returns a clean-up
   * function the view calls on unmount; calling it again re-subscribes.
   */
  function subscribe(): () => void {
    return window.desktop.kernelManager.onState((next) => {
      state.value = coerceKernelManagerState(next)
    })
  }

  return { state, busy, errorMessage, refresh, setEnabled, setChannel, listVersions, install, subscribe }
})
