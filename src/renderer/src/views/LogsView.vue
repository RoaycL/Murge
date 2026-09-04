<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useLogsStore } from '../stores/logs'
import { serializeLogs } from '../lib/logs'
import AppSelect from '../components/AppSelect.vue'
import EmptyState from '../components/EmptyState.vue'

const store = useLogsStore()
const { status, lastError, search, level, visibleEntries } = storeToRefs(store)
const LEVEL_OPTIONS = [
  { value: 'all', label: '所有级别' }, { value: 'debug', label: '调试' },
  { value: 'info', label: '信息' }, { value: 'warning', label: '警告' }, { value: 'error', label: '错误' }
] as const

function exportLogs(): void {
  const blob = new Blob([serializeLogs(visibleEntries.value)], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mihomo-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(store.connect)
onUnmounted(store.disconnect)
</script>

<template>
  <div class="page-shell logs-view">
    <header class="logs-header">
      <div><h1>日志</h1><p>{{ status === 'live' ? '实时' : status === 'loading' ? '连接中' : '已断开' }} · {{ visibleEntries.length }} 条</p></div>
      <div class="logs-actions">
        <button type="button" @click="store.clear">清空</button>
        <button type="button" :disabled="!visibleEntries.length" @click="exportLogs">导出</button>
      </div>
    </header>
    <div class="logs-toolbar">
      <input v-model="search" type="search" placeholder="筛选日志" aria-label="筛选日志" />
      <AppSelect v-model="level" :options="LEVEL_OPTIONS" label="日志级别" />
    </div>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p>
    <section class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!visibleEntries.length && status !== 'loading'" icon="logs" :title="search || level !== 'all' ? '没有匹配的日志' : '暂无运行日志'" :detail="search || level !== 'all' ? '请调整筛选条件或日志级别。' : '内核运行后，实时日志会显示在这里。'" />
      <div v-else-if="!visibleEntries.length" class="logs-empty">正在等待日志…</div>
      <div v-for="entry in visibleEntries" :key="entry.id" class="log-row">
        <time>{{ new Date(entry.time).toLocaleTimeString([], { hour12: false }) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <code>{{ entry.message }}</code>
      </div>
    </section>
  </div>
</template>
