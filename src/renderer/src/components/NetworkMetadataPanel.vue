<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useNetworkMetadataStore, type NetworkMetadataRow } from '../stores/network-metadata'
import { networkMetadataMaskIp } from '@shared/network-metadata'

const store = useNetworkMetadataStore()

/** Privacy-forward default: mask every IP until the user explicitly reveals it. */
const revealed = ref(false)

onMounted(() => {
  void store.init()
})

const rows = computed(() => store.rows)
const busy = computed(() => store.busy)

const statusLabel = computed(() => {
  if (busy.value && !rows.value.length) return '查询中'
  if (store.refreshError) return '查询失败'
  if (!rows.value.length) return '等待查询'
  if (rows.value.every((row) => row.phase === 'error')) return '查询失败'
  return '已更新'
})

function ipText(row: NetworkMetadataRow): string {
  const ip = row.metadata?.ip
  if (!ip) return '—'
  return revealed.value ? ip : networkMetadataMaskIp(ip)
}

function geoText(row: NetworkMetadataRow): string {
  const meta = row.metadata
  if (!meta) return row.error ?? '—'
  const parts = [meta.country, meta.city].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

function asnText(row: NetworkMetadataRow): string {
  return row.metadata?.asn ?? '—'
}

async function onRefresh(): Promise<void> {
  await store.refresh(true)
}

function toggleReveal(): void {
  revealed.value = !revealed.value
}
</script>

<template>
  <SurfaceCard class="network-card">
    <div class="card-title-row">
      <span class="metric-label">网络信息 <em class="status">{{ statusLabel }}</em></span>
      <div class="title-actions">
        <button type="button" class="quiet-button" :disabled="busy" @click="onRefresh">刷新</button>
        <button type="button" class="quiet-button" :aria-pressed="revealed" @click="toggleReveal">
          {{ revealed ? '隐藏' : '显示' }}
        </button>
      </div>
    </div>

    <div class="provider-table" :class="{ empty: !rows.length }" role="table" aria-label="出口网络信息（全部数据源）">
      <div class="provider-row head" role="row">
        <span role="columnheader">数据源</span>
        <span role="columnheader">出口 IP</span>
        <span role="columnheader">地区 · 城市</span>
        <span role="columnheader">ASN</span>
      </div>
      <div v-for="row in rows" :key="row.providerId" class="provider-row" role="row" :class="{ failed: row.phase === 'error' && !row.metadata }">
        <span class="provider-name" role="cell" :title="row.label">{{ row.label }}</span>
        <span class="provider-ip" role="cell">{{ ipText(row) }}</span>
        <span class="provider-geo" role="cell" :title="geoText(row)">{{ geoText(row) }}</span>
        <span class="provider-asn" role="cell" :title="asnText(row)">{{ asnText(row) }}</span>
      </div>
    </div>
    <p v-if="store.refreshError" class="inline-error" role="alert">{{ store.refreshError }}</p>
  </SurfaceCard>
</template>

<style scoped>
.network-card { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.title-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.status { font-style: normal; color: var(--app-muted); font-size: 10px; margin-left: 6px; }
.provider-table { display: grid; margin-top: 12px; }
.provider-row {
  display: grid;
  grid-template-columns: minmax(74px, auto) minmax(96px, 1.1fr) minmax(0, 1.4fr) minmax(64px, 0.7fr);
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 5px 0;
  border-top: 1px solid var(--app-divider);
  font-size: 12px;
}
.provider-row.head { min-height: 24px; color: var(--app-muted); font-size: 10px; }
.provider-row.failed { opacity: 0.72; }
.provider-row.failed .provider-ip { color: var(--app-danger, #d64f4f); }
.provider-table.empty { opacity: 0.6; }
.provider-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.provider-ip { font-weight: 650; font-variant-numeric: tabular-nums; }
.provider-geo, .provider-asn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inline-error { margin: 12px 0 0; color: var(--app-danger, #d64f4f); font-size: 12px; }
.quiet-button { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.quiet-button:disabled { opacity: 0.5; }
</style>
