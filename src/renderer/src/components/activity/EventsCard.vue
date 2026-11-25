<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { AppLogEntry } from '@shared/diagnostics'
import { redactLogText } from '@shared/log-redaction'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import { appLogModuleLabel } from '../../stores/app-logs'
import { clockTime } from '../../lib/activity-widgets'

// 事件 (Surge 6): the latest app events (startup, TUN, profiles, updates…)
// from the app log, or only its warnings and errors.
const ROWS = 3
const router = useRouter()
const filter = ref<'all' | 'warnings'>('all')
const entries = ref<AppLogEntry[]>([])
let timer: number | null = null

async function load(): Promise<void> {
  try {
    const snapshot = await window.desktop.logs.readApp()
    entries.value = snapshot.entries.slice(-300)
  } catch {
    // Keep the last read.
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 30_000)
})
onUnmounted(() => { if (timer != null) window.clearInterval(timer) })

const rows = computed(() => entries.value
  .filter((entry) => entry.level !== 'debug' && (filter.value === 'all' || entry.level === 'warning' || entry.level === 'error'))
  .slice(-ROWS)
  .reverse()
  .map((entry, index) => ({ key: `${entry.time}-${index}`, time: clockTime(entry.time), level: entry.level, module: appLogModuleLabel(entry.module), message: redactLogText(entry.message) })))
</script>

<template>
  <SurfaceCard class="widget-card widget-wide events-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="router.push('/logs')">{{ t('widgets.events') }}<AppIcon name="next" :size="14" /></button>
      <div class="segmented widget-segmented" role="group" :aria-label="t('widgets.eventsFilter')">
        <button type="button" :class="{ selected: filter === 'all' }" :aria-pressed="filter === 'all'" @click="filter = 'all'">{{ t('widgets.allEvents') }}</button>
        <button type="button" :class="{ selected: filter === 'warnings' }" :aria-pressed="filter === 'warnings'" @click="filter = 'warnings'">{{ t('widgets.warnings') }}</button>
      </div>
    </div>
    <ul v-if="rows.length" class="events-list">
      <li v-for="row in rows" :key="row.key" :class="`event-${row.level}`">
        <i class="event-dot" /><span class="event-time">{{ row.time }}</span><span class="event-module">{{ row.module }}</span><span class="event-message" :title="row.message">{{ row.message }}</span>
      </li>
    </ul>
    <p v-else class="widget-empty">{{ filter === 'all' ? t('widgets.noEvents') : t('widgets.noWarnings') }}</p>
  </SurfaceCard>
</template>

<style scoped>
.events-list { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: space-evenly; margin: 4px 0 0; padding: 0; list-style: none; }
.events-list li { display: grid; grid-template-columns: 8px auto auto minmax(0, 1fr); align-items: center; gap: 7px; font-size: var(--font-size-xs); }
.event-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--app-blue); }
.event-warning .event-dot { background: #f08c2e; }
.event-error .event-dot { background: var(--app-danger); }
.event-time { color: var(--app-muted); font-variant-numeric: tabular-nums; }
.event-module { color: var(--app-muted); white-space: nowrap; }
.event-message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
