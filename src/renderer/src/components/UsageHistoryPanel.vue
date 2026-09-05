<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useUsageHistoryStore } from '../stores/usage-history'
import type { UsageBucket, UsageRanking, UsageWindow } from '@shared/usage'
import { USAGE_WINDOW_CONFIG } from '@shared/usage'
import { formatBytes, formatBytesParts } from '../lib/format'
import ConfirmModal from './ConfirmModal.vue'
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'

const store = useUsageHistoryStore()
const toast = useToast()
const clearOpen = ref(false)

const WINDOWS: Array<{ value: UsageWindow; label: string }> = [
  { value: '1h', label: '1 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' }
]

const RANKINGS: Array<{ value: UsageRanking; label: string }> = [
  { value: 'total', label: '总计' },
  { value: 'down', label: '下载' },
  { value: 'up', label: '上传' },
  { value: 'count', label: '次数' }
]

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await store.refresh()
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

const rankingUnit = computed(() =>
  store.ranking === 'count' ? '次' : ''
)
const rankingValueText = computed(() => {
  const totals = store.snapshot?.totals
  if (!totals) return ''
  return store.ranking === 'count' ? `${totals.count}` : formatBytes(bucketValue({ bucketStart: 0, up: totals.up, down: totals.down, count: totals.count }, store.ranking))
})

const capacityText = computed(() => {
  if (!store.capacity) return `最多保留 ${USAGE_WINDOW_CONFIG['30d'].spanBuckets} 天`
  const days = Math.round((store.capacity.retentionHours || 0) / 24)
  return `最多保留 ${store.capacity.maxBuckets} 个分桶（约 ${days} 天），仅存储聚合流量，不保存凭据或原始配置`
})

const hasData = computed(() => (store.snapshot?.totals?.total ?? 0) > 0 || (store.ranked?.length ?? 0) > 0)

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
  if (ok) { clearOpen.value = false; toast.success('使用记录已清空') }
  else toast.error('无法清空使用记录', store.lastError ?? undefined)
}
</script>

<template>
  <SurfaceCard class="usage-card">
    <div class="card-title-row">
      <span class="metric-label">使用历史</span>
      <div class="segmented" role="group" aria-label="使用历史时间范围">
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
    <p v-else-if="!hasData" class="usage-empty">暂无使用数据，开始使用后这里会显示分桶用量。</p>

    <template v-else>
      <div class="usage-metric">
        <strong>{{ totalText.value }}<span>{{ totalText.unit }}</span></strong>
        <em>{{ windowLabel }} · {{ rankingUnit || '总流量' }} {{ rankingValueText }}</em>
      </div>

      <div class="usage-chart" role="img" :aria-label="`${windowLabel}流量柱状图`">
        <i
          v-for="bar in bars"
          :key="bar.step"
          :class="{ peak: bar.pct >= 75 }"
          :style="{ height: `${bar.pct}%` }"
        />
      </div>

      <div class="rank-tabs" role="group" aria-label="使用历史排行维度">
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
          <strong>{{ store.ranking === 'count' ? `${item.count} 次` : formatBytes(item.value) }}</strong>
        </div>
      </div>
      <p v-else class="usage-empty">该时间范围内没有排名数据。</p>
    </template>

    <footer class="usage-footer">
      <span>{{ capacityText }}</span>
      <button type="button" class="usage-clear" :disabled="store.busy" @click="clearOpen = true"><AppIcon name="delete" :size="14" />清空记录</button>
    </footer>
    <ConfirmModal :open="clearOpen" title="清空使用记录？" description="这会永久删除全部聚合流量历史，此操作不可撤销。" confirm-label="确认清空" :busy="store.busy" @close="clearOpen = false" @confirm="confirmClear" />
  </SurfaceCard>
</template>

<style scoped>
.usage-card { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.usage-metric { display: flex; align-items: baseline; gap: 12px; margin-top: 12px; }
.usage-metric strong { font-size: 22px; font-weight: 650; }
.usage-metric strong span { margin-left: 3px; font-size: 12px; color: var(--app-muted); }
.usage-metric em { font-style: normal; color: var(--app-muted); font-size: 11px; }
.usage-chart { display: flex; align-items: flex-end; gap: 3px; height: 88px; margin: 16px 0 10px; }
.usage-chart i { flex: 1; min-height: 2px; background: var(--app-blue); opacity: 0.55; border-radius: 2px 2px 0 0; transition: height 0.3s ease; }
.usage-chart i.peak { opacity: 1; }
.rank-tabs { display: flex; gap: 4px; }
.rank-list { display: grid; gap: 6px; margin-top: 12px; }
.rank-row { display: grid; grid-template-columns: 28px 1fr auto auto; align-items: center; gap: 8px; }
.rank-index { color: var(--app-muted); font-size: 11px; }
.rank-bar { height: 7px; border-radius: 4px; background: rgba(127, 127, 127, 0.14); overflow: hidden; }
.rank-bar i { display: block; height: 100%; background: var(--app-blue); border-radius: 4px; }
.rank-time { color: var(--app-muted); font-size: 11px; }
.rank-row strong { font-size: 12px; font-weight: 600; }
.usage-empty { margin: 14px 0; color: var(--app-muted); font-size: 11px; }
.usage-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; }
.usage-footer span { color: var(--app-muted); font-size: 10px; }
.usage-clear { display: inline-flex; min-height: 28px; align-items: center; gap: 5px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-danger, #d64f4f); font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.usage-clear:disabled { opacity: 0.5; }
</style>
