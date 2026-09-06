<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useNetworkMetadataStore, type NetworkMetadataRow } from '../stores/network-metadata'
import { useLatencyStore } from '../stores/latency'
import { useUnlockStore } from '../stores/unlock'
import type { ServiceUnlockResult } from '@shared/unlock'
import { networkMetadataMaskIp } from '@shared/network-metadata'

const store = useNetworkMetadataStore()
// Same Pinia instance the activity page probes: the drawer renders the latest
// shared sample instead of firing its own duplicate measurement on open.
const latency = useLatencyStore()
const unlock = useUnlockStore()

/** Privacy-forward default: mask every IP until the user explicitly reveals it. */
const revealed = ref(false)

onMounted(() => {
  void store.init()
  if (Object.keys(unlock.results).length === 0) void unlock.testAll()
})

const rows = computed(() => store.rows)
const busy = computed(() => store.busy)

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

const DIAG_LABELS = {
  idle: '待检测',
  probing: '检测中…',
  ready: '已完成',
  error: '检测失败'
} as const

const diagLabel = computed(() => DIAG_LABELS[latency.state])

/** 每一格：实测到显示（ms 保留整数；未测到显示 em dash），与活动页口径一致。 */
function delayText(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}`
}

const gatewayText = computed(() => delayText(latency.gatewayMs))
const dnsText = computed(() => delayText(latency.dnsMs))
const proxyText = computed(() => delayText(latency.proxyMs))

const unlockRows = computed(() => unlock.orderedResults())

const STATUS_LABELS = {
  supported: '支持',
  unsupported: '不支持',
  error: '测试失败'
} as const

function statusLabel(status: ServiceUnlockResult['status']): string {
  return STATUS_LABELS[status]
}

function hasRegion(region: string | null): boolean {
  return typeof region === 'string' && region.length > 0
}
</script>

<template>
  <SurfaceCard class="network-card">
    <div class="diag-title-row"><span class="metric-label">网络诊断 <em class="status">{{ diagLabel }}</em></span></div>
    <div class="diag-grid" role="table" aria-label="网络诊断结果">
      <div class="diag-row" role="row">
        <span role="cell">路由网关</span>
        <strong role="cell">{{ gatewayText }}<i v-if="gatewayText !== '—'" class="delay-unit">ms</i></strong>
      </div>
      <div class="diag-row" role="row">
        <span role="cell">DNS 解析</span>
        <strong role="cell">{{ dnsText }}<i v-if="dnsText !== '—'" class="delay-unit">ms</i></strong>
      </div>
      <div class="diag-row" role="row">
        <span role="cell">{{ latency.proxyNode ?? '代理出口' }}</span>
        <strong role="cell">{{ proxyText }}<i v-if="proxyText !== '—'" class="delay-unit">ms</i></strong>
      </div>
    </div>

    <div class="card-title-row unlock-title-row">
      <span class="metric-label">服务解锁测试 <em v-if="unlock.testingAll" class="status">检测中…</em></span>
      <div class="title-actions">
        <button type="button" class="quiet-button" :disabled="unlock.testingAll" @click="unlock.testAll()">
          {{ unlock.testingAll ? '检测中…' : '测试全部' }}
        </button>
      </div>
    </div>
    <div class="unlock-grid" role="table" aria-label="服务解锁测试结果">
      <div v-for="row in unlockRows" :key="row.name" class="unlock-row" role="row">
        <span class="unlock-name" role="cell" :title="row.name">{{ row.name }}</span>
        <span class="unlock-verdict" role="cell">
          <template v-if="unlock.testing[row.name]"><span class="unlock-pill pending">待检测</span></template>
          <template v-else>
            <span class="unlock-pill" :class="row.status">{{ statusLabel(row.status) }}</span>
            <span v-if="hasRegion(row.region)" class="unlock-region">{{ row.region }}</span>
          </template>
        </span>
        <button type="button" class="icon-control unlock-retest" :disabled="unlock.testing[row.name]" :aria-label="`重新测试 ${row.name}`" @click="unlock.testOne(row.name)">⟳</button>
      </div>
    </div>
    <p v-if="unlock.error" class="inline-error" role="alert">{{ unlock.error }}</p>

    <div class="card-title-row info-title-row">
      <span class="metric-label">出口网络信息</span>
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
.diag-title-row { display: flex; align-items: center; min-height: 28px; }
.diag-grid { display: grid; margin-top: 10px; }
.diag-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-height: 30px;
  padding: 4px 0;
  border-top: 1px solid var(--app-divider);
  font-size: 12px;
}
.diag-row span { overflow: hidden; color: var(--app-muted); text-overflow: ellipsis; white-space: nowrap; }
.diag-row strong { font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.delay-unit { font-style: normal; font-weight: 400; font-size: 10px; color: var(--app-muted); margin-left: 2px; }
.info-title-row { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--app-divider); }
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
.unlock-title-row { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--app-divider); }
.unlock-grid { display: grid; margin-top: 10px; }
.unlock-row {
  display: grid;
  grid-template-columns: minmax(90px, 1.2fr) minmax(0, 1fr) 28px;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  padding: 3px 0;
  border-top: 1px solid var(--app-divider);
  font-size: 12px;
}
.unlock-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.unlock-verdict { display: flex; align-items: center; gap: 6px; min-width: 0; }
.unlock-pill { padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; white-space: nowrap; }
.unlock-pill.supported { background: rgba(49, 201, 90, 0.14); color: var(--app-green); }
.unlock-pill.unsupported { background: rgba(214, 79, 79, 0.13); color: var(--app-danger, #d64f4f); }
.unlock-pill.error { background: rgba(214, 79, 79, 0.13); color: var(--app-danger, #d64f4f); }
.unlock-pill.pending { background: rgba(133, 139, 149, 0.14); color: var(--app-muted); }
.unlock-region { overflow: hidden; color: var(--app-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.unlock-retest { justify-self: end; }
.quiet-button { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.quiet-button:disabled { opacity: 0.5; }
</style>
