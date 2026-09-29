<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useLogsStore } from '../stores/logs'
import { serializeLogs } from '../lib/logs'
import { formatWallClock } from '../lib/format'
import AppSelect from '../components/AppSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import AppIcon from '../components/AppIcon.vue'
import { downloadDiagnosticReport } from '../lib/diagnostic-export'

const store = useLogsStore()
const { status, lastError, search, level, visibleEntries } = storeToRefs(store)
const exportingDiagnostics = ref(false)
const diagnosticError = ref('')
const LEVEL_OPTIONS = [
  { value: 'all', label: 'all' }, { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' }, { value: 'warning', label: 'warning' }, { value: 'error', label: 'error' }
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

async function exportDiagnostics(): Promise<void> {
  if (exportingDiagnostics.value) return
  exportingDiagnostics.value = true
  diagnosticError.value = ''
  try {
    await downloadDiagnosticReport()
  } catch {
    diagnosticError.value = '诊断报告生成失败，请稍后重试。'
  } finally {
    exportingDiagnostics.value = false
  }
}

// Capture runs app-long at module scope; mount only (re)syncs history so a
// reopened view recovers the lines emitted while it was closed.
onMounted(store.connect)
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
    <section class="diagnostic-export-card surface-card" aria-label="诊断报告">
      <div class="diagnostic-export-symbol"><AppIcon name="kernel" :size="19" /></div>
      <div class="diagnostic-export-copy">
        <strong>运行诊断</strong>
        <p>导出启动耗时、任务与服务状态、端口归属和错误类别。仅保存在本机，不包含原始日志、配置或订阅密钥。</p>
      </div>
      <button type="button" class="secondary-button" :disabled="exportingDiagnostics" @click="exportDiagnostics"><AppIcon name="download" :size="15" />{{ exportingDiagnostics ? '生成中…' : '导出诊断' }}</button>
    </section>
    <p v-if="diagnosticError" class="inline-error" role="alert">{{ diagnosticError }}</p>
    <div class="logs-toolbar">
      <input v-model="search" type="search" placeholder="筛选日志" aria-label="筛选日志" />
      <AppSelect v-model="level" :options="LEVEL_OPTIONS" label="日志级别" />
    </div>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p>
    <section class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!visibleEntries.length && status !== 'loading'" icon="logs" :title="search || level !== 'all' ? '没有匹配的日志' : '暂无运行日志'" :detail="search || level !== 'all' ? '请调整筛选条件或日志级别。' : '内核运行后，实时日志会显示在这里。'" />
      <div v-else-if="!visibleEntries.length" class="logs-empty">正在等待日志…</div>
      <div v-for="entry in visibleEntries" :key="entry.id" class="log-row">
        <time>{{ formatWallClock(entry.time) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <code>{{ entry.message }}</code>
      </div>
    </section>
  </div>
</template>
