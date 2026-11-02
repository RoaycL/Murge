import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LocalAddress } from '@shared/lan'

/**
 * This PC's IPv4 addresses, read on demand. The 概览 局域网设备接管 card shows
 * the LAN-reachable ones as the address other devices dial; the 设备 page uses
 * the full list to tell this PC apart from other LAN devices. Failures leave
 * the previous list (a missing list only degrades labels, never blocks).
 */
export const useLanStore = defineStore('lan', () => {
  const addresses = ref<LocalAddress[]>([])
  let inflight: Promise<void> | null = null

  function refresh(): Promise<void> {
    inflight ??= window.desktop.app.listLocalAddresses()
      .then((list) => { if (Array.isArray(list)) addresses.value = list })
      .catch(() => undefined)
      .finally(() => { inflight = null })
    return inflight
  }

  return { addresses, refresh }
})
