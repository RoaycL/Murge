import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ProxyBypassPolicy } from '@shared/proxy-bypass'
import { coerceProxyBypassPolicy, EMPTY_PROXY_BYPASS_POLICY } from '@shared/proxy-bypass'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the controlled system-proxy bypass policy.
 * The model is loaded through IPC on mount, edited locally, and saved through
 * IPC; the main process validates every field before persisting and re-applies
 * it to the live `ProxyOverride` when the system proxy is enabled (conflict
 * checked + read-back verified). The effective bypass is reported over the
 * system-proxy status channel, so the UI never touches the registry.
 */
export const useProxyBypassStore = defineStore('proxy-bypass', () => {
  const policy = ref<ProxyBypassPolicy>({ ...EMPTY_PROXY_BYPASS_POLICY })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      policy.value = coerceProxyBypassPolicy(await window.desktop.systemProxy.getProxyBypass())
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function save(input: ProxyBypassPolicy): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      policy.value = coerceProxyBypassPolicy(await window.desktop.systemProxy.setProxyBypass(input))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function preview(input: ProxyBypassPolicy): Promise<string> {
    if (busy.value) return ''
    busy.value = true
    try {
      lastError.value = null
      return await window.desktop.systemProxy.previewProxyBypass(input)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return ''
    } finally {
      busy.value = false
    }
  }

  return { policy, busy, lastError, refresh, save, preview }
})
