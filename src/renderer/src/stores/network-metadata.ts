import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { defaultNetworkMetadataProviderId } from '@shared/network-metadata'
import type { NetworkMetadataProvider, NetworkMetadataState } from '@shared/network-metadata'

const IDLE_STATE: NetworkMetadataState = {
  phase: 'idle',
  provider: defaultNetworkMetadataProviderId(),
  metadata: null,
  error: null
}

/**
 * Read-only network (egress) metadata store. Owns the provider list and the
 * explicit resolve state, and exposes the single privacy-forward IP source for
 * the activity header. All reads go through the main-process bounded cache.
 */
export const useNetworkMetadataStore = defineStore('network-metadata', () => {
  const providers = ref<NetworkMetadataProvider[]>([])
  const state = ref<NetworkMetadataState>({ ...IDLE_STATE })
  const busy = ref(false)

  const currentProviderId = computed(() => state.value.provider)
  const metadata = computed(() => state.value.metadata)
  const error = computed(() => state.value.error)
  const ipText = computed(() => metadata.value?.ip ?? '—')

  /** Load the provider list and warm the cache via a non-forced resolve. */
  async function init(): Promise<void> {
    try {
      providers.value = await window.desktop.networkMetadata.getProviders()
    } catch {
      providers.value = []
    }
    await refresh()
  }

  async function refresh(force = false): Promise<void> {
    busy.value = true
    try {
      state.value = await window.desktop.networkMetadata.resolve(force)
    } catch {
      state.value = { phase: 'error', provider: currentProviderId.value, metadata: metadata.value, error: '查询失败，请重试' }
    } finally {
      busy.value = false
    }
  }

  async function selectProvider(id: string): Promise<void> {
    if (id === currentProviderId.value) return
    try {
      state.value = await window.desktop.networkMetadata.selectProvider(id)
    } catch {
      state.value = { phase: 'error', provider: id, metadata: metadata.value, error: '未知的数据源' }
    }
    await refresh()
  }

  /** Copy a privacy-safe one-line metadata summary to the clipboard. */
  async function copy(): Promise<void> {
    const meta = metadata.value
    if (!meta) return
    const text = `${meta.ip}${meta.country ? ` (${meta.country}${meta.city ? `, ${meta.city}` : ''})` : ''}${meta.asn ? ` ${meta.asn}` : ''}`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard can be unavailable (no document focus); fail silently.
    }
  }

  return { providers, state, busy, currentProviderId, metadata, error, ipText, init, refresh, selectProvider, copy }
})
