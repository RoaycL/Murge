import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LanGatewayState, LocalAddress } from '@shared/lan'

/**
 * This PC's IPv4 addresses, read on demand. The 概览 局域网设备接管 card shows
 * the LAN-reachable ones as the address other devices dial; the 设备 page uses
 * the full list to tell this PC apart from other LAN devices. Failures leave
 * the previous list (a missing list only degrades labels, never blocks).
 *
 * It also holds the 网关模式 switch: Windows IPv4 forwarding on the LAN and TUN
 * adapters, applied by the privileged TUN service (or, without one, by a
 * single elevated PowerShell run behind a UAC prompt).
 */
export const useLanStore = defineStore('lan', () => {
  const addresses = ref<LocalAddress[]>([])
  const gateway = ref<LanGatewayState | null>(null)
  const gatewayBusy = ref(false)
  const gatewayError = ref('')
  let inflight: Promise<void> | null = null

  function refresh(): Promise<void> {
    inflight ??= window.desktop.app.listLocalAddresses()
      .then((list) => { if (Array.isArray(list)) addresses.value = list })
      .catch(() => undefined)
      .finally(() => { inflight = null })
    return inflight
  }

  async function refreshGateway(): Promise<void> {
    try {
      gateway.value = await window.desktop.app.getLanGateway()
    } catch {
      // Keep the last known state; the switch still works.
    }
  }

  async function setGateway(enabled: boolean, device: string): Promise<void> {
    if (gatewayBusy.value) return
    gatewayBusy.value = true
    gatewayError.value = ''
    try {
      const next = await window.desktop.app.setLanGateway(enabled, device)
      gateway.value = next
      gatewayError.value = next.error ?? ''
    } catch (error) {
      gatewayError.value = error instanceof Error ? error.message : '切换失败'
    } finally {
      gatewayBusy.value = false
    }
  }

  return { addresses, refresh, gateway, gatewayBusy, gatewayError, refreshGateway, setGateway }
})
