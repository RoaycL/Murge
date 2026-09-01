<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useNetworkMetadataStore } from '../stores/network-metadata'
import { networkMetadataMaskIp } from '@shared/network-metadata'

const store = useNetworkMetadataStore()

/** Privacy-forward default: mask the IP until the user explicitly reveals it. */
const revealed = ref(false)

onMounted(() => {
  void store.init()
})

const metadata = computed(() => store.metadata)
const statePhase = computed(() => store.state.phase)

const ipDisplay = computed(() => {
  const meta = metadata.value
  if (!meta) return '—'
  return revealed.value ? meta.ip : networkMetadataMaskIp(meta.ip)
})

const geoText = computed(() => {
  const meta = metadata.value
  if (!meta) return '—'
  const parts = [meta.country, meta.city].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
})

const statusLabel = computed(() => {
  switch (statePhase.value) {
    case 'fetching':
      return '查询中'
    case 'error':
      return '查询失败'
    case 'ready':
      return '已更新'
    default:
      return '等待查询'
  }
})

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
      <div class="segmented" role="group" aria-label="网络元数据数据源">
        <button
          v-for="provider in store.providers"
          :key="provider.id"
          type="button"
          :class="{ selected: store.currentProviderId === provider.id }"
          :aria-pressed="store.currentProviderId === provider.id"
          :title="provider.description"
          @click="store.selectProvider(provider.id)"
        >
          {{ provider.label }}
        </button>
      </div>
    </div>

    <p v-if="store.error" class="inline-error" role="alert">{{ store.error }}</p>

    <div class="network-meta" :class="{ empty: !metadata }">
      <div class="ip-row">
        <strong>{{ ipDisplay }}</strong>
        <button type="button" class="quiet-button" :aria-pressed="revealed" @click="toggleReveal">
          {{ revealed ? '隐藏' : '显示' }}
        </button>
      </div>
      <dl class="meta-grid">
        <div><dt>地区</dt><dd>{{ metadata?.country ?? '—' }}</dd></div>
        <div><dt>城市</dt><dd>{{ metadata?.city ?? '—' }}</dd></div>
        <div><dt>ASN</dt><dd>{{ metadata?.asn ?? '—' }}</dd></div>
        <div><dt>数据源</dt><dd>{{ metadata?.provider ?? '—' }}</dd></div>
      </dl>
    </div>

    <footer class="network-footer">
      <span>仅显示出口节点的公开元数据，不保存凭据或原始配置。</span>
      <div class="network-actions">
        <button type="button" class="usage-clear" :disabled="store.busy || statePhase === 'fetching'" @click="onRefresh">刷新</button>
        <button type="button" class="usage-clear copy" :disabled="!metadata" @click="store.copy">复制信息</button>
      </div>
    </footer>
  </SurfaceCard>
</template>

<style scoped>
.network-card { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.status { font-style: normal; color: var(--app-muted); font-size: 10px; margin-left: 6px; }
.network-meta { display: grid; gap: 10px; margin-top: 14px; }
.network-meta.empty { opacity: 0.6; }
.ip-row { display: flex; align-items: center; gap: 12px; }
.ip-row strong { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0; }
.meta-grid > div { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--app-surface-border); border-radius: 7px; background: var(--app-surface); }
.meta-grid dt { color: var(--app-muted); font-size: 10px; }
.meta-grid dd { margin: 0; font-size: 12px; font-weight: 600; }
.network-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; }
.network-footer > span { color: var(--app-muted); font-size: 10px; }
.network-actions { display: flex; gap: 8px; }
.usage-clear { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; }
.usage-clear.copy { color: var(--app-blue); }
.usage-clear:disabled { opacity: 0.5; }
.quiet-button { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; }
.inline-error { margin: 12px 0 0; color: var(--app-danger, #d64f4f); font-size: 12px; }
</style>
