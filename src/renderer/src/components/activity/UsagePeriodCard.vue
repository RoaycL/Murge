<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UsageBucket } from '@shared/usage'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import { formatBytes, formatBytesParts } from '../../lib/format'
import { summarizeUsagePeriod, usageHistorySince, type UsagePeriod } from '../../lib/usage-period'
import { niceBytesCeiling } from '../../lib/activity-widgets'

// 流量用量 (Surge 6): today / this month / last month from the persisted
// hourly usage history, with the proxy/DIRECT split and an hourly or daily chart.
const emit = defineEmits<{ history: [] }>()
const period = ref<UsagePeriod>('today')
const buckets = ref<UsageBucket[]>([])
const now = ref(new Date())
let timer: number | null = null

async function load(): Promise<void> {
  now.value = new Date()
  try {
    buckets.value = await window.desktop.usageHistory.hourly(usageHistorySince(now.value))
  } catch {
    // Keep the last good read; the shell's usage store never fails a read in practice.
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 60_000)
})
onUnmounted(() => { if (timer != null) window.clearInterval(timer) })

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: 'today', label: t('widgets.today') },
  { value: 'month', label: t('widgets.thisMonth') },
  { value: 'lastMonth', label: t('widgets.lastMonth') }
]

const summary = computed(() => summarizeUsagePeriod(buckets.value, period.value, now.value))
const total = computed(() => formatBytesParts(summary.value.total))
const splitTotal = computed(() => summary.value.proxy + summary.value.direct)
const proxyPct = computed(() => (splitTotal.value ? (summary.value.proxy / splitTotal.value) * 100 : 0))
const ceiling = computed(() => niceBytesCeiling(Math.max(0, ...summary.value.slots.map((slot) => slot.bytes))))
const bars = computed(() => summary.value.slots.map((slot) => ({
  key: slot.start,
  future: slot.future,
  height: ceiling.value && slot.bytes ? Math.max(4, (slot.bytes / ceiling.value) * 100) : 0
})))
const ticks = computed(() => {
  const slots = summary.value.slots
  if (summary.value.slotKind === 'hour') return [0, 6, 12, 18].map((hour) => ({ index: hour, label: t('widgets.hourTick', [hour]) }))
  return [0, 7, 14, 21, 28].filter((index) => index < slots.length).map((index) => ({ index, label: t('widgets.dayTick', [index + 1]) }))
})
</script>

<template>
  <SurfaceCard class="widget-card widget-square usage-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="emit('history')">{{ t('widgets.usage') }}<AppIcon name="next" :size="14" /></button>
      <div class="segmented widget-segmented" role="group" :aria-label="t('widgets.usagePeriod')">
        <button v-for="entry in PERIODS" :key="entry.value" type="button" :class="{ selected: period === entry.value }" :aria-pressed="period === entry.value" @click="period = entry.value">{{ entry.label }}</button>
      </div>
    </div>
    <div class="usage-headline">
      <strong>{{ total.value }}<i class="widget-unit">{{ total.unit }}</i></strong>
      <div class="usage-direction"><span><AppIcon name="move-down" :size="12" :stroke-width="2.4" />{{ formatBytes(summary.down) }}</span><span><AppIcon name="move-up" :size="12" :stroke-width="2.4" />{{ formatBytes(summary.up) }}</span></div>
    </div>
    <div class="usage-split" :class="{ unknown: !summary.splitKnown || !splitTotal }"><i class="proxy" :style="{ width: `${proxyPct}%` }" /><i class="direct" :style="{ width: `${100 - proxyPct}%` }" /></div>
    <div class="usage-legend">
      <span><i class="proxy" />{{ t('activity.proxy') }} <b>{{ summary.splitKnown ? formatBytes(summary.proxy) : '—' }}</b></span>
      <span><i class="direct" />{{ t('widgets.direct') }} <b>{{ summary.splitKnown ? formatBytes(summary.direct) : '—' }}</b></span>
    </div>
    <div class="usage-chart" role="img" :aria-label="t('widgets.usageChart')">
      <div class="usage-grid"><span>{{ ceiling ? formatBytes(ceiling) : '' }}</span><span>{{ ceiling ? formatBytes(ceiling / 2) : '' }}</span></div>
      <div class="usage-bars"><span v-for="bar in bars" :key="bar.key" :class="{ future: bar.future, empty: !bar.height }"><i :style="{ height: `${bar.height}%` }" /></span></div>
    </div>
    <div class="usage-axis" :style="{ '--slots': summary.slots.length }"><span v-for="tick in ticks" :key="tick.index" :style="{ left: `calc(${tick.index} / var(--slots) * 100%)` }">{{ tick.label }}</span></div>
  </SurfaceCard>
</template>

<style scoped>
.usage-headline { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-top: 6px; }
.usage-headline strong { font-size: var(--font-size-hero); line-height: 1.1; font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; white-space: nowrap; }
.usage-direction { display: flex; flex-direction: column; align-items: flex-end; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; white-space: nowrap; }
.usage-direction span { display: inline-flex; align-items: center; gap: 2px; }
.usage-split { display: flex; gap: 2px; height: 6px; margin-top: 10px; border-radius: 3px; overflow: hidden; background: var(--app-fill); }
.usage-split i { display: block; height: 100%; border-radius: 3px; }
.usage-split .proxy, .usage-legend .proxy { background: var(--app-blue); }
.usage-split .direct, .usage-legend .direct { background: var(--app-purple); }
.usage-split.unknown i { display: none; }
.usage-legend { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.usage-legend i { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 2px; }
.usage-legend b { color: var(--app-text); font-weight: var(--font-weight-semibold); }
.usage-chart { position: relative; flex: 1 1 auto; min-height: 50px; margin-top: 10px; }
.usage-grid { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; }
.usage-grid span { height: 50%; border-top: 1px dashed var(--app-divider); color: var(--app-faint); font-size: var(--font-size-2xs); text-align: right; }
.usage-bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
.usage-bars span { display: flex; flex: 1 1 0; align-items: flex-end; justify-content: center; height: 100%; min-width: 0; }
.usage-bars i { width: min(5px, 100%); min-height: 0; border-radius: 3px; background: var(--app-purple); }
.usage-bars span.empty i { width: 4px; height: 4px !important; border-radius: 50%; opacity: .8; }
.usage-bars span.future i { background: var(--app-fill-strong); opacity: 1; }
.usage-axis { position: relative; height: 14px; margin-top: 4px; color: var(--app-faint); font-size: var(--font-size-2xs); }
.usage-axis span { position: absolute; top: 0; white-space: nowrap; }
@container (max-width: 320px) {
  .usage-headline strong { font-size: var(--font-size-display); }
  .widget-segmented button { min-width: 0; padding: 0 6px; }
}
</style>
