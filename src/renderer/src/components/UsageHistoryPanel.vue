<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useUsageHistoryStore } from '../stores/usage-history'
import type { UsageBucket, UsageRanking, UsageWindow } from '@shared/usage'
import { formatBytes, formatBytesParts } from '../lib/format'
import ConfirmModal from './ConfirmModal.vue'
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'

const store = useUsageHistoryStore()
const toast = useToast()
const clearOpen = ref(false)

const WINDOWS: Array<{ value: UsageWindow; label: string }> = [
  { value: '1h', label: t('usage.hour1') },
  { value: '24h', label: t('usage.hour24') },
  { value: '7d', label: t('usage.day7') },
  { value: '30d', label: t('usage.day30') }
]

const RANKINGS: Array<{ value: UsageRanking; label: string }> = [
  { value: 'total', label: t('stats.total') },
  { value: 'down', label: t('common.download') },
  { value: 'up', label: t('common.upload') },
  { value: 'count', label: t('usage.connectionCount') }
]

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  // Arm synchronously: awaiting the first IPC refresh allowed the component to
  // unmount before timer assignment, after which the continuation leaked an
  // interval that no mounted instance could clear.
  void store.refresh()
  timer = setInterval(() => void store.refresh(), 30_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})

/** The per-bucket metric value used to size the bars and label the totals. */
function bucketValue(bucket: UsageBucket, ranking: UsageRanking): number {
  switch (ranking) {
    case 'up':
      return bucket.up
    case 'down':
      return bucket.down
    case 'count':
      return bucket.count
    default:
      return bucket.up + bucket.down
  }
}

const bars = computed(() => {
  const buckets = store.snapshot?.buckets ?? []
  const values = buckets.map((bucket) => bucketValue(bucket, store.ranking))
  const max = Math.max(...values, 1)
  return buckets.map((bucket, index) => ({
    step: index,
    pct: Math.round((values[index] / max) * 100)
  }))
})

const windowLabel = computed(() => {
  const found = WINDOWS.find((entry) => entry.value === store.window)
  return found?.label ?? store.window
})

const totalText = computed(() => {
  const totals = store.snapshot?.totals
  return formatBytesParts(totals?.total ?? 0)
})

const rankingValueText = computed(() => {
  const totals = store.snapshot?.totals
  if (!totals) return ''
  return store.ranking === 'count' ? `${totals.count}` : formatBytes(bucketValue({ bucketStart: 0, up: totals.up, down: totals.down, count: totals.count }, store.ranking))
})

const hasData = computed(() => (store.snapshot?.totals?.total ?? 0) > 0 || (store.ranked?.length ?? 0) > 0 || (store.processes?.entries.length ?? 0) > 0)

/** Short human label for a bucket start, scaled to the current window grid. */
function timeLabel(bucketStart: number): string {
  const date = new Date(bucketStart)
  if (store.window === '7d' || store.window === '30d') {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

async function confirmClear(): Promise<void> {
  const ok = await store.clear()
  if (ok) { clearOpen.value = false; toast.success(t('usage.cleared')) }
  else toast.error(t('usage.clearFailed'), store.lastError ?? undefined)
}
</script>

<template>
  <SurfaceCard class="usage-card">
    <div class="card-title-row">
      <span class="metric-label">{{ t('usage.title') }}</span>
      <div class="segmented" role="group" :aria-label="t('usage.rangeLabel')">
        <button
          v-for="entry in WINDOWS"
          :key="entry.value"
          type="button"
          :class="{ selected: store.window === entry.value }"
          :aria-pressed="store.window === entry.value"
          @click="store.selectWindow(entry.value)"
        >
          {{ entry.label }}
        </button>
      </div>
    </div>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>
    <p v-else-if="!hasData" class="usage-empty">{{ t('usage.empty') }}</p>

    <template v-else>
      <div class="usage-metric">
        <strong>{{ totalText.value }}<span>{{ totalText.unit }}</span></strong>
        <em>{{ windowLabel }} · {{ store.ranking === 'count' ? t('usage.connectionCount') : t('usage.totalTraffic') }} {{ rankingValueText }}</em>
      </div>

      <div class="usage-chart" role="img" :aria-label="t('usage.chartLabel', [windowLabel])">
        <i
          v-for="bar in bars"
          :key="bar.step"
          :class="{ peak: bar.pct >= 75 }"
          :style="{ height: `${bar.pct}%` }"
        />
      </div>

      <div class="rank-tabs" role="group" :aria-label="t('usage.rankingLabel')">
        <button
          v-for="entry in RANKINGS"
          :key="entry.value"
          type="button"
          :class="{ selected: store.ranking === entry.value }"
          :aria-pressed="store.ranking === entry.value"
          @click="store.selectRanking(entry.value)"
        >
          {{ entry.label }}
        </button>
      </div>

      <div v-if="store.ranked.length" class="rank-list">
        <div v-for="item in store.ranked" :key="item.bucketStart" class="rank-row">
          <span class="rank-index">#{{ item.rank }}</span>
          <div class="rank-bar"><i :style="{ width: `${Math.min(100, (item.value / (store.ranked[0]?.value || 1)) * 100)}%` }" /></div>
          <span class="rank-time">{{ timeLabel(item.bucketStart) }}</span>
          <strong>{{ store.ranking === 'count' ? t('usage.countUnit', [item.count]) : formatBytes(item.value) }}</strong>
        </div>
      </div>
      <p v-else class="usage-empty">{{ t('usage.noRanking') }}</p>
      <section class="process-usage" :aria-label="t('usage.appLabel')">
        <h3>{{ t('usage.appTraffic') }}</h3>
        <div v-for="item in store.processes?.entries.slice(0, 20) ?? []" :key="item.name" class="process-usage-row">
          <span>{{ item.name }}</span><strong>{{ formatBytes(item.total) }}</strong>
        </div>
        <p v-if="!store.processes?.entries.length" class="usage-empty">{{ t('usage.noAppTraffic') }}</p>
      </section>
    </template>

    <footer class="usage-footer">
      <button type="button" class="usage-clear" :disabled="store.busy" @click="clearOpen = true"><AppIcon name="delete" :size="14" />{{ t('usage.clear') }}</button>
    </footer>
    <ConfirmModal :open="clearOpen" :title="t('usage.clearTitle')" :description="t('usage.clearDescription')" :confirm-label="t('usage.clearConfirm')" :busy="store.busy" @close="clearOpen = false" @confirm="confirmClear" />
  </SurfaceCard>
</template>

<style scoped>
.usage-card { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.card-title-row .metric-label { flex: none; white-space: nowrap; }
.card-title-row .segmented { flex: 0 1 auto; min-width: 0; }
.usage-metric { display: flex; align-items: baseline; gap: var(--space-5); margin-top: 12px; }
.usage-metric strong { font-size: var(--font-size-title); font-weight: var(--font-weight-bold); }
.usage-metric strong span { margin-left: 3px; font-size: var(--font-size-sm); color: var(--app-muted); }
.usage-metric em { font-style: normal; color: var(--app-muted); font-size: var(--font-size-xs); }
.usage-chart { display: flex; align-items: flex-end; gap: var(--space-1); height: 88px; margin: 16px 0 10px; }
.usage-chart i { flex: 1; min-height: 2px; background: var(--app-blue); opacity: 0.55; border-radius: 2px 2px 0 0; transition: height 0.3s ease; }
.usage-chart i.peak { opacity: 1; }
.rank-tabs { display: flex; gap: var(--space-1); }
.rank-list { display: grid; gap: var(--space-2); margin-top: 12px; }
.rank-row { display: grid; grid-template-columns: 28px 1fr auto auto; align-items: center; gap: var(--space-3); }
.rank-index { color: var(--app-muted); font-size: var(--font-size-xs); }
.rank-bar { height: 7px; border-radius: var(--radius-xs); background: var(--app-fill); overflow: hidden; }
.rank-bar i { display: block; height: 100%; background: var(--app-blue); border-radius: var(--radius-xs); }
.rank-time { color: var(--app-muted); font-size: var(--font-size-xs); }
.rank-row strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.usage-empty { margin: 14px 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.usage-footer { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-4); margin-top: 16px; }
.usage-clear { display: inline-flex; min-height: 28px; align-items: center; gap: var(--space-2); padding: 0 10px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: transparent; color: var(--app-danger); font-size: var(--font-size-xs); white-space: nowrap; flex-shrink: 0; }
.usage-clear:disabled { opacity: 0.5; }
.process-usage{display:grid;gap:var(--space-3);margin-top:18px;padding-top:14px;border-top:1px solid var(--app-divider)}
.process-usage h3,.process-usage p{margin:0}
.process-usage h3{font-size:var(--font-size-md)}
.process-usage p{color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.5}
.process-usage-row{display:flex;justify-content:space-between;gap:var(--space-4);font-size:var(--font-size-xs)}
.process-usage-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.process-usage-row strong{flex:none;font-weight:var(--font-weight-semibold)}
</style>
