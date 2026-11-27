<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onUnmounted, ref } from 'vue'
import SurfaceCard from '../SurfaceCard.vue'
import RefreshIndicator from '../RefreshIndicator.vue'
import { useNetworkMetadataStore } from '../../stores/network-metadata'
import { networkMetadataMaskIpMiddle } from '@shared/network-metadata'
import { countryFlag, splitAsn } from '../../lib/activity-widgets'

// 外部 IP (Surge 6): the egress address with its location and network owner.
// Surge's NAT 类型 needs a STUN probe that mihomo does not offer, so the right
// column shows the city instead.
const networkMeta = useNetworkMetadataStore()
const emit = defineEmits<{ details: [] }>()

// Like the header IP: masked by default, a click shows it for 10 seconds.
const revealed = ref(false)
let revealTimer: number | null = null
function toggleReveal(): void {
  revealed.value = !revealed.value
  if (revealTimer != null) window.clearTimeout(revealTimer)
  revealTimer = revealed.value ? window.setTimeout(() => { revealed.value = false; revealTimer = null }, 10_000) : null
}
onUnmounted(() => { if (revealTimer != null) window.clearTimeout(revealTimer) })

const meta = computed(() => networkMeta.metadata)
const family = computed(() => (meta.value?.ip.includes(':') ? 'IPv6' : 'IPv4'))
const ipText = computed(() => {
  const ip = meta.value?.ip
  if (!ip) return networkMeta.busy ? '···' : '—'
  return revealed.value ? ip : networkMetadataMaskIpMiddle(ip)
})
const owner = computed(() => splitAsn(meta.value?.asn))
const flag = computed(() => countryFlag(meta.value?.country))
</script>

<template>
  <SurfaceCard class="widget-card widget-wide external-ip-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="emit('details')">{{ t('widgets.externalIp') }}</button>
      <button type="button" class="widget-icon-button" :disabled="networkMeta.busy" :aria-label="t('widgets.refresh')" @click="networkMeta.refresh(true)"><RefreshIndicator :busy="networkMeta.busy" :failed="Boolean(networkMeta.refreshError)" :size="14" /></button>
    </div>
    <div class="external-ip-body">
      <div class="external-ip-main">
        <span class="widget-muted">{{ family }}</span>
        <button type="button" class="external-ip-value" :aria-pressed="revealed" :title="revealed ? t('activity.clickHide') : t('activity.clickShow')" @click="toggleReveal">{{ ipText }}</button>
        <span class="widget-muted external-ip-country">{{ flag }}{{ flag ? ' ' : '' }}{{ meta?.country ?? '—' }}</span>
      </div>
      <div class="external-ip-side">
        <span class="widget-muted">{{ t('widgets.city') }}</span>
        <strong>{{ meta?.city ?? '—' }}</strong>
      </div>
    </div>
    <div class="external-ip-footer"><span>{{ owner.org ?? '—' }}</span><span>{{ owner.number ?? '' }}</span></div>
  </SurfaceCard>
</template>

<style scoped>
.external-ip-body { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 10px; margin: auto 0; }
.external-ip-main, .external-ip-side { display: flex; flex-direction: column; min-width: 0; }
.external-ip-main > span, .external-ip-side > span { font-size: var(--font-size-xs); }
.external-ip-value { overflow: hidden; padding: 0; border: 0; background: transparent; color: var(--app-text); font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.external-ip-country { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.external-ip-side strong { overflow: hidden; font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); text-overflow: ellipsis; white-space: nowrap; }
.external-ip-footer { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--app-divider); color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.external-ip-footer span:first-child { overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 320px) {
  .external-ip-value { font-size: var(--font-size-xl); }
  .external-ip-side strong { font-size: var(--font-size-body); }
}
</style>
