<script setup lang="ts">
import { computed } from 'vue'
import type { EntityTrafficStats } from '../lib/entity-traffic'
import { formatBytes, formatRate } from '../lib/format'

/**
 * Surge-style statistics block shared by the 进程 and 设备 drawers:
 * 带宽 / 连接 / 详情 / 流量. Windowed traffic comes from the in-app history,
 * which only covers the current app run.
 */
const props = defineProps<{
  stats: EntityTrafficStats | null
  activeConnections: number
  details: Array<{ label: string; value: string }>
}>()

const up = computed(() => formatRate(props.stats?.rate.up ?? 0))
const down = computed(() => formatRate(props.stats?.rate.down ?? 0))
const totalConnections = computed(() => Math.max(props.stats?.totalConnections ?? 0, props.activeConnections))
const windows = computed(() => props.stats?.windows ?? [])
</script>

<template>
  <div class="entity-stats">
    <section class="entity-stats-section bandwidth" aria-label="带宽">
      <h3>带宽</h3>
      <div class="entity-stats-pair">
        <div><span>上传</span><strong>{{ up.value }}<small>{{ up.unit }}</small></strong></div>
        <div><span>下载</span><strong>{{ down.value }}<small>{{ down.unit }}</small></strong></div>
      </div>
    </section>
    <section class="entity-stats-section connections" aria-label="连接">
      <h3>连接</h3>
      <div class="entity-stats-pair">
        <div><span>活动</span><strong>{{ activeConnections }}</strong></div>
        <div><span>总计</span><strong>{{ totalConnections }}</strong></div>
      </div>
    </section>
    <section class="entity-stats-section details" aria-label="详情">
      <h3>详情</h3>
      <dl>
        <div v-for="row in details" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
      </dl>
    </section>
    <section class="entity-stats-section traffic" aria-label="流量">
      <h3>流量</h3>
      <dl>
        <div v-for="row in windows" :key="row.key"><dt>{{ row.label }}</dt><dd>↑ {{ formatBytes(row.up) }} / ↓ {{ formatBytes(row.down) }}</dd></div>
      </dl>
      <p class="entity-stats-note">统计自本次启动，按连接字节增量累计；退出后不保留。</p>
    </section>
  </div>
</template>

<style scoped>
.entity-stats { display: grid; gap: var(--space-6); }
.entity-stats-section h3 { margin: 0 0 6px; padding-bottom: 5px; border-bottom: 1px solid var(--app-divider); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold, 600); }
.entity-stats-section.bandwidth h3 { color: var(--app-purple); }
.entity-stats-section.connections h3 { color: var(--app-pink); }
.entity-stats-section.details h3 { color: var(--app-blue); }
.entity-stats-section.traffic h3 { color: var(--app-warning); }
.entity-stats-pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-5); }
.entity-stats-pair span { display: block; color: var(--app-muted); font-size: var(--font-size-2xs); }
.entity-stats-pair strong { display: block; margin-top: 2px; font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); line-height: 30px; font-variant-numeric: tabular-nums; }
.entity-stats-pair strong small { margin-left: 3px; font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
.entity-stats dl { margin: 0; }
.entity-stats dl div { display: flex; justify-content: space-between; gap: var(--space-5); padding: 5px 0; font-size: var(--font-size-xs); }
.entity-stats dt { flex: none; color: var(--app-text); }
.entity-stats dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.entity-stats-note { margin: 6px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); }
</style>
