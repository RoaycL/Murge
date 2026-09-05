import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { providerDisplayName } from '@shared/network-metadata'
import type { NetworkMetadata, NetworkMetadataProvider, NetworkMetadataSnapshot } from '@shared/network-metadata'

/** One rendered provider row: label + its resolve outcome. */
export interface NetworkMetadataRow {
  providerId: string
  label: string
  phase: NetworkMetadataSnapshot['results'][number]['state']['phase']
  metadata: NetworkMetadata | null
  error: string | null
}

const EMPTY_ROWS: NetworkMetadataRow[] = []

/**
 * Read-only network (egress) metadata store. Resolves every shipped provider
 * through the main-process bounded cache so all sources render side by side —
 * the user never switches between them. Also keeps the activity header's
 * single egress IP fed from the default provider's row.
 */
export const useNetworkMetadataStore = defineStore('network-metadata', () => {
  const providers = ref<NetworkMetadataProvider[]>([])
  const rows = ref<NetworkMetadataRow[]>(EMPTY_ROWS)
  const busy = ref(false)

  /** The primary (default-provider) row, kept for the activity header IP. */
  const primaryRow = computed<NetworkMetadataRow | null>(() => rows.value[0] ?? null)
  const metadata = computed(() => primaryRow.value?.metadata ?? null)
  const error = computed(() => primaryRow.value?.error ?? null)
  const ipText = computed(() => metadata.value?.ip ?? '—')

  /** Load the provider list and warm every row via a non-forced whole-set sweep. */
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
      rows.value = toRows(await window.desktop.networkMetadata.resolveAll(force))
    } catch {
      // Keep the previous rows; only surface a refresh failure through busy
      // state, matching the old store's fail-quiet retry semantics.
    } finally {
      busy.value = false
    }
  }

  /** Map a main-process snapshot into display rows (main supplies the order). */
  function toRows(snapshot: NetworkMetadataSnapshot): NetworkMetadataRow[] {
    return snapshot.results.map((result) => ({
      providerId: result.providerId,
      label: result.label || providerDisplayName(result.providerId),
      phase: result.state.phase,
      metadata: result.state.metadata,
      error: result.state.error
    }))
  }

  /** Copy every resolved row as a privacy-safe multi-line clipboard summary. */
  async function copy(): Promise<void> {
    const lines = rows.value
      .filter((row) => row.metadata)
      .map((row) => {
        const meta = row.metadata as NetworkMetadata
        return `${row.label}: ${meta.ip}${meta.country ? ` (${meta.country}${meta.city ? `, ${meta.city}` : ''})` : ''}${meta.asn ? ` ${meta.asn}` : ''}`
      })
    if (!lines.length) return
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
    } catch {
      // Clipboard can be unavailable (no document focus); fail silently.
    }
  }

  return { providers, rows, busy, primaryRow, metadata, error, ipText, init, refresh, copy }
})
