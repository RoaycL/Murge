import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { TunStatus } from '@shared/tun'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Live TUN lifecycle status. The main-process `TunCoordinator` is the single
 * source of truth; this store mirrors it over `tun:status-event` and the pull
 * handler. Updates are never optimistically applied — the UI reflects what the
 * coordinator reports after it has completed (or rejected) the native
 * transition, so an action can only move the lifecycle when the backend allows
 * it. Enabling TUN requires the safe kernel and system proxy to be stopped
 * (the IPC handler enforces this), and on unsupported platforms the phase
 * stays `unsupported` with the enable/disable controls disabled.
 */
export const useTunStore = defineStore('tun', () => {
  const status = ref<TunStatus>({ supported: false, phase: 'unsupported', errorMessage: null, conflictDetail: null, updatedAt: null })
  const busy = ref(false)
  const actionError = ref('')
  let unsub: (() => void) | null = null

  async function refresh(): Promise<void> {
    try {
      status.value = await window.desktop.tun.getStatus()
    } catch (error) {
      actionError.value = toProtocolError(error).message
    }
  }

  async function enable(): Promise<void> {
    if (busy.value) return
    busy.value = true
    actionError.value = ''
    try {
      status.value = await window.desktop.tun.enable()
    } catch (error) {
      actionError.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  async function disable(): Promise<void> {
    if (busy.value) return
    busy.value = true
    actionError.value = ''
    try {
      status.value = await window.desktop.tun.disable()
    } catch (error) {
      actionError.value = toProtocolError(error).message
    } finally {
      busy.value = false
    }
  }

  function connect(): void {
    if (unsub) return
    unsub = window.desktop.tun.onStatus((next) => {
      status.value = next
      actionError.value = ''
    })
    void refresh()
  }

  function disconnect(): void {
    unsub?.()
    unsub = null
  }

  return { status, busy, actionError, refresh, enable, disable, connect, disconnect }
})
