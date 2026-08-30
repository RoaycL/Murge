import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { TunStatus } from '@shared/tun'

export const useTunStore = defineStore('tun', () => {
  const status = ref<TunStatus>({ supported: false, phase: 'unsupported', errorMessage: null, conflictDetail: null, updatedAt: null })
  let unsub: (() => void) | null = null

  async function refresh(): Promise<void> { status.value = await window.desktop.tun.getStatus() }
  async function enable(): Promise<void> { status.value = await window.desktop.tun.enable() }
  async function disable(): Promise<void> { status.value = await window.desktop.tun.disable() }
  function connect(): void {
    if (unsub) return
    unsub = window.desktop.tun.onStatus(next => { status.value = next })
    void refresh()
  }
  function disconnect(): void { unsub?.(); unsub = null }
  return { status, refresh, enable, disable, connect, disconnect }
})
