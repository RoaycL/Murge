import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { TunConfigModel } from '@shared/tun-config'
import { EMPTY_TUN_CONFIG, coerceTunConfig } from '@shared/tun-config'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the typed TUN configuration model.
 * The model is loaded through IPC on mount, edited locally, and saved through
 * IPC; the main process validates every stack, device, MTU, dns-hijack entry and
 * route CIDR before persisting, so an invalid edit is never applied. This is a
 * *configuration* independent of the TUN lifecycle: enabling/disabling TUN is a
 * separate privileged action, and the persisted model is read by the
 * mihomo-owned adapter at enable-time.
 */
export const useTunConfigStore = defineStore('tun-config', () => {
  const config = ref<TunConfigModel>({ ...EMPTY_TUN_CONFIG })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      config.value = coerceTunConfig((await window.desktop.tunConfig.get()).config)
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: TunConfigModel): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      config.value = coerceTunConfig((await window.desktop.tunConfig.set(input)).config)
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: TunConfigModel): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.tunConfig.preview(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { config, busy, lastError, refresh, save, preview }
})
