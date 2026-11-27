<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import { useTrafficStore } from '../../stores/traffic'
import { useConnectionsStore } from '../../stores/connections'
import { formatBytes, formatRate } from '../../lib/format'

// 活动 (Surge 6): live download/upload with a mirrored one-minute chart, the
// minute's peak, and the since-start request / traffic / connection counts.
const BARS = 60
const traffic = useTrafficStore()
const connections = useConnectionsStore()
const router = useRouter()

const down = computed(() => formatRate(traffic.current?.down ?? 0))
const up = computed(() => formatRate(traffic.current?.up ?? 0))

function padded(series: number[]): number[] {
  const recent = series.slice(-BARS)
  return [...Array.from({ length: BARS - recent.length }, () => 0), ...recent]
}

function heights(series: number[]): number[] {
  const values = padded(series)
  const max = Math.max(...values, 1)
  return values.map((value) => (value > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0))
}

const downBars = computed(() => heights(traffic.downloadSeries))
const upBars = computed(() => heights(traffic.uploadSeries))
const peakText = computed(() => {
  const peakDown = formatRate(Math.max(0, ...traffic.downloadSeries))
  const peakUp = formatRate(Math.max(0, ...traffic.uploadSeries))
  return `↓ ${peakDown.value} ${peakDown.unit}  ↑ ${peakUp.value} ${peakUp.unit}`
})
const requests = computed(() => connections.summary?.requestCount ?? 0)
const transferred = computed(() => formatBytes((traffic.current?.downTotal ?? 0) + (traffic.current?.upTotal ?? 0)))
const active = computed(() => connections.summary?.totalConnections ?? 0)
</script>

<template>
  <SurfaceCard class="widget-card widget-square activity-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="router.push('/connections')">{{ t('widgets.activity') }}<AppIcon name="next" :size="14" /></button>
    </div>
    <div class="activity-rates">
      <div class="rate-down"><span><AppIcon name="move-down" :size="12" />{{ t('common.download') }}</span><strong>{{ down.value }}<i class="widget-unit">{{ down.unit }}</i></strong></div>
      <div class="rate-up"><span><AppIcon name="move-up" :size="12" />{{ t('common.upload') }}</span><strong>{{ up.value }}<i class="widget-unit">{{ up.unit }}</i></strong></div>
    </div>
    <div class="mirror-chart" role="img" :aria-label="t('widgets.activityChart')">
      <div class="mirror-half mirror-down"><i v-for="(height, index) in downBars" :key="index" :class="{ idle: !height }" :style="{ height: `${height}%` }" /></div>
      <div class="mirror-half mirror-up"><i v-for="(height, index) in upBars" :key="index" :class="{ idle: !height }" :style="{ height: `${height}%` }" /></div>
    </div>
    <div class="mirror-axis"><span>-60 s</span><span>{{ t('widgets.peak') }} {{ peakText }}</span><span>{{ t('widgets.now') }}</span></div>
    <div class="activity-stats">
      <div><span>{{ t('widgets.requests') }}</span><strong>{{ requests }}</strong></div>
      <div><span>{{ t('stats.traffic') }}</span><strong>{{ transferred }}</strong></div>
      <button type="button" @click="router.push('/connections')"><span>{{ t('widgets.connections') }}</span><strong>{{ active }}</strong></button>
    </div>
  </SurfaceCard>
</template>

<style scoped>
.activity-rates { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
.activity-rates span { display: inline-flex; align-items: center; gap: 2px; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.rate-down span { color: var(--app-blue); }
.rate-up span { color: #f08c2e; }
.activity-rates strong { display: block; margin-top: 2px; font-size: var(--font-size-display); line-height: 1.15; font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mirror-chart { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 60px; margin-top: 10px; }
.mirror-half { display: flex; flex: 1 1 0; gap: 2px; }
.mirror-down { align-items: flex-end; padding-bottom: 2px; }
.mirror-up { align-items: flex-start; padding-top: 2px; }
.mirror-half i { flex: 1 1 0; min-width: 0; border-radius: 3px; }
.mirror-down i { background: color-mix(in srgb, var(--app-blue) 70%, white); }
.mirror-up i { background: color-mix(in srgb, #f08c2e 70%, white); }
.mirror-half i.idle { height: 4px !important; opacity: .45; }
.mirror-axis { display: flex; justify-content: space-between; gap: 6px; margin-top: 6px; color: var(--app-faint); font-size: var(--font-size-2xs); white-space: nowrap; }
.mirror-axis span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; }
.activity-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--app-divider); }
.activity-stats > * { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; }
.activity-stats button { cursor: pointer; }
.activity-stats button:hover strong { color: var(--app-accent); }
.activity-stats span { color: var(--app-muted); font-size: var(--font-size-xs); }
.activity-stats strong { max-width: 100%; overflow: hidden; font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
@container (max-width: 320px) {
  .activity-rates strong { font-size: var(--font-size-2xl); }
  .activity-stats strong { font-size: var(--font-size-body); }
}
</style>
