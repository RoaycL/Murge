<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed } from 'vue'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import RefreshIndicator from '../RefreshIndicator.vue'
import { useBandwidthStore } from '../../stores/bandwidth'
import { clockTime } from '../../lib/activity-widgets'

// 带宽 (Surge 6): a short download + upload test through the current policy,
// only when the refresh button is pressed.
const bandwidth = useBandwidthStore()

const mbps = (value: number | null): string => (value == null ? '—' : value >= 100 ? String(Math.round(value)) : value.toFixed(1))
// Bars share one scale so download and upload compare at a glance.
const scale = computed(() => Math.max(bandwidth.downMbps ?? 0, bandwidth.upMbps ?? 0, 1))
const width = (value: number | null): string => `${value == null ? 0 : Math.max(3, Math.round((value / scale.value) * 100))}%`
const footer = computed(() => {
  if (bandwidth.state === 'testing') return t('widgets.bandwidthTesting')
  if (bandwidth.state === 'error') return bandwidth.lastError ? t('widgets.bandwidthFailed') : t('widgets.bandwidthNoResult')
  if (bandwidth.testedAt) return t('widgets.testedAt', [clockTime(bandwidth.testedAt)])
  return t('widgets.notTested')
})
</script>

<template>
  <SurfaceCard class="widget-card widget-half bandwidth-widget">
    <div class="widget-head">
      <span class="widget-title">{{ t('widgets.bandwidth') }}</span>
      <button type="button" class="widget-icon-button" :disabled="bandwidth.state === 'testing'" :aria-label="t('widgets.bandwidthRun')" :title="t('widgets.bandwidthHint')" @click="bandwidth.run()"><RefreshIndicator :busy="bandwidth.state === 'testing'" :failed="bandwidth.state === 'error'" :size="14" /></button>
    </div>
    <div class="bandwidth-rows">
      <div><strong><AppIcon name="move-down" :size="15" :stroke-width="2.4" />{{ mbps(bandwidth.downMbps) }}<i class="widget-unit">Mbps</i></strong><span class="bar"><b class="down" :style="{ width: width(bandwidth.downMbps) }" /></span></div>
      <div><strong><AppIcon name="move-up" :size="15" :stroke-width="2.4" />{{ mbps(bandwidth.upMbps) }}<i class="widget-unit">Mbps</i></strong><span class="bar"><b class="up" :style="{ width: width(bandwidth.upMbps) }" /></span></div>
    </div>
    <p class="bandwidth-footer" :title="bandwidth.lastError ?? undefined">{{ footer }}</p>
  </SurfaceCard>
</template>

<style scoped>
.bandwidth-rows { display: grid; gap: 10px; margin: auto 0; }
.bandwidth-rows strong { display: flex; align-items: center; gap: 2px; font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bandwidth-rows .widget-unit { font-size: var(--font-size-xs); }
.bar { display: block; height: 5px; margin-top: 6px; border-radius: 3px; background: var(--app-fill); overflow: hidden; }
.bar b { display: block; height: 100%; border-radius: 3px; transition: width .4s ease; }
.bar b.down { background: var(--app-blue); }
.bar b.up { background: #f08c2e; }
.bandwidth-footer { margin: 0; overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
</style>
