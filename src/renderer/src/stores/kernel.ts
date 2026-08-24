import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { KernelStatus } from '@shared/runtime'

/**
 * Live kernel status. The main process is the single source of truth; this store
 * mirrors it over the `kernel:status-event` channel and the pull handlers so the
 * UI can render lifecycle state without polling.
 */
export const useKernelStore = defineStore('kernel', () => {
  const status = ref<KernelStatus>({ phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null })
  let unsub: (() => void) | null = null

  async function refresh(): Promise<void> {
    status.value = await window.desktop.kernel.getStatus()
  }

  async function start(): Promise<void> {
    status.value = await window.desktop.kernel.start()
  }

  async function stop(): Promise<void> {
    status.value = await window.desktop.kernel.stop()
  }

  function connect(): void {
    if (unsub) return
    unsub = window.desktop.kernel.onStatus((next) => {
      status.value = next
    })
    void refresh()
  }

  function disconnect(): void {
    unsub?.()
    unsub = null
  }

  return { status, refresh, start, stop, connect, disconnect }
})
