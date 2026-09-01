import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { SystemProxyStatus } from '@shared/system-proxy'

/**
 * Live system-proxy status. The main process (and the OS registry on Windows)
 * is the single source of truth; this store mirrors it over the
 * `system-proxy:status-event` channel and the pull handler. Updates are never
 * optimistically applied — the UI reflects what the main process reports after
 * it has completed (or rejected) the registry change.
 */
export const useSystemProxyStore = defineStore('system-proxy', () => {
  const status = ref<SystemProxyStatus>({
    supported: true,
    phase: 'disabled',
    address: null,
    port: null,
    proxyOverride: null,
    errorMessage: null,
    conflictDetail: null,
    updatedAt: null
  })
  let unsub: (() => void) | null = null

  async function refresh(): Promise<void> {
    status.value = await window.desktop.systemProxy.getStatus()
  }

  async function enable(): Promise<void> {
    status.value = await window.desktop.systemProxy.enable()
  }

  async function disable(): Promise<void> {
    status.value = await window.desktop.systemProxy.disable()
  }

  function connect(): void {
    if (unsub) return
    unsub = window.desktop.systemProxy.onStatus((next) => {
      status.value = next
    })
    void refresh()
  }

  function disconnect(): void {
    unsub?.()
    unsub = null
  }

  return { status, refresh, enable, disable, connect, disconnect }
})
