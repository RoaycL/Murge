<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref, watch } from 'vue'
import type { LocalAddress } from '@shared/lan'
import SurfaceCard from '../SurfaceCard.vue'
import RefreshIndicator from '../RefreshIndicator.vue'
import { useLatencyStore } from '../../stores/latency'
import { useRuntimeStore } from '../../stores/runtime'
import { pickLocalAddress } from '../../lib/activity-widgets'

// 网络 (Surge 6): the current network, device → gateway → internet RTTs, and
// the local / gateway addresses. 互联网 is the kernel's DIRECT delay (no node
// in the path); the gateway slot is the first-hop TCP handshake.
const latency = useLatencyStore()
const runtime = useRuntimeStore()
const addresses = ref<LocalAddress[]>([])

async function loadAddresses(): Promise<void> {
  try {
    addresses.value = await window.desktop.app.listLocalAddresses()
  } catch {
    addresses.value = []
  }
}

const localIp = computed(() => pickLocalAddress(addresses.value, latency.gatewayIp))
const ms = (value: number | null): string => (value == null ? '—' : `${Math.round(value)} ms`)

function refresh(): void {
  void latency.probe()
  void loadAddresses()
  void runtime.refresh()
}

onMounted(() => void loadAddresses())
// A network switch shows up as a new gateway: re-read the adapters then.
watch(() => latency.gatewayIp, (next, previous) => { if (next !== previous) void loadAddresses() })
</script>

<template>
  <SurfaceCard class="widget-card widget-wide network-widget">
    <div class="widget-head">
      <span class="widget-title">{{ t('widgets.network') }}<b v-if="runtime.summary?.networkName" class="network-name">{{ runtime.summary.networkName }}</b></span>
      <button type="button" class="widget-icon-button" :disabled="latency.state === 'probing'" :aria-label="t('widgets.refresh')" @click="refresh"><RefreshIndicator :busy="latency.state === 'probing'" :failed="latency.state === 'error'" :size="14" /></button>
    </div>
    <div class="network-path" role="img" :aria-label="t('widgets.networkPath', [ms(latency.gatewayMs), ms(latency.directMs)])">
      <div class="path-line"><i class="node device" /><b class="segment lan" /><i class="node gateway" :class="{ down: latency.state === 'ready' && latency.gatewayMs == null }" /><b class="segment wan" /><i class="node internet" :class="{ down: latency.state === 'ready' && latency.directMs == null }" /></div>
      <div class="path-labels">
        <span><strong>{{ t('widgets.device') }}</strong></span>
        <span>{{ t('widgets.gateway') }} <strong>{{ ms(latency.gatewayMs) }}</strong></span>
        <span>{{ t('widgets.internet') }} <strong>{{ ms(latency.directMs) }}</strong></span>
      </div>
    </div>
    <div class="network-addresses">
      <span>{{ t('widgets.localIp') }} <strong>{{ localIp ?? '—' }}</strong></span>
      <span>{{ t('widgets.gateway') }} <strong>{{ latency.gatewayIp ?? '—' }}</strong></span>
    </div>
  </SurfaceCard>
</template>

<style scoped>
.network-name { margin-left: 8px; overflow: hidden; color: var(--app-text); font-size: var(--font-size-md); font-weight: var(--font-weight-bold); text-overflow: ellipsis; }
.network-path { margin-top: auto; }
.path-line { display: flex; align-items: center; height: 14px; }
.node { flex: none; width: 11px; height: 11px; border: 2px solid #2fb8c9; border-radius: 50%; background: var(--app-surface-solid); }
.node.device { border-color: var(--app-text); background: var(--app-text); }
.node.internet { border-color: var(--app-blue); }
.node.down { border-color: var(--app-danger); }
.segment { flex: 1 1 0; height: 2px; }
.segment.lan { background: #2fb8c9; }
.segment.wan { flex-grow: 2; background: var(--app-blue); }
.path-labels { display: grid; grid-template-columns: 1fr 1fr 1fr; margin-top: 5px; color: var(--app-muted); font-size: var(--font-size-2xs); white-space: nowrap; }
.path-labels span:nth-child(2) { text-align: center; }
.path-labels span:last-child { text-align: right; }
.path-labels strong { color: var(--app-text); font-weight: var(--font-weight-semibold); }
.network-addresses { display: flex; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 8px; border-top: 1px solid var(--app-divider); color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.network-addresses strong { color: var(--app-text); font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; }
</style>
