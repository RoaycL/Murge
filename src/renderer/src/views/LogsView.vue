<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useLogsStore } from '../stores/logs'
import { appLogModuleLabel, useAppLogsStore } from '../stores/app-logs'
import { serializeLogs } from '../lib/logs'
import { formatWallClock } from '../lib/format'
import AppSelect from '../components/AppSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import AppIcon from '../components/AppIcon.vue'
import { downloadDiagnosticReport, exportStamp, saveTextFile } from '../lib/diagnostic-export'
import { useToast } from '../composables/use-toast'

type LogSource = 'core' | 'app'
/** The 应用 tail is re-read from disk on this cadence while it is shown. */
const APP_POLL_MS = 3000

const store = useLogsStore()
const appStore = useAppLogsStore()
const toast = useToast()
const { status, lastError, search, level, visibleEntries } = storeToRefs(store)
const { visibleEntries: appVisibleEntries, modules: appModules, lastError: appError } = storeToRefs(appStore)
const source = ref<LogSource>('core')
const exportingDiagnostics = ref(false)
const exportingBundle = ref(false)
const exportingLogs = ref(false)
const LEVEL_OPTIONS = [
  { value: 'all', label: '全部级别' }, { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' }, { value: 'warning', label: 'warning' }, { value: 'error', label: 'error' }
] as const
const moduleOptions = computed(() => [
  { value: 'all', label: '全部模块' },
  ...appModules.value.map((value) => ({ value, label: appLogModuleLabel(value) }))
])

// One search/level pair per source, bound through these proxies.
const searchModel = computed({
  get: () => source.value === 'core' ? search.value : appStore.search,
  set: (value: string) => { if (source.value === 'core') search.value = value; else appStore.search = value }
})
const levelModel = computed({
  get: () => source.value === 'core' ? level.value : appStore.level,
  set: (value: string) => {
    const next = value as typeof level.value
    if (source.value === 'core') level.value = next; else appStore.level = next
  }
})
const moduleModel = computed({ get: () => appStore.module, set: (value: string) => { appStore.module = value } })
const shownCount = computed(() => source.value === 'core' ? visibleEntries.value.length : appVisibleEntries.value.length)
const filtered = computed(() => Boolean(searchModel.value) || levelModel.value !== 'all' || (source.value === 'app' && appStore.module !== 'all'))
const statusLabel = computed(() => {
  if (source.value === 'app') return appError.value ? '读取失败' : '应用日志'
  return status.value === 'live' ? '实时' : status.value === 'loading' ? '连接中' : '已断开'
})

async function exportLogs(): Promise<void> {
  if (exportingLogs.value) return
  exportingLogs.value = true
  try {
    const stamp = exportStamp()
    const result = source.value === 'core'
      ? await saveTextFile(`mihomo-logs-${stamp}.txt`, serializeLogs(visibleEntries.value))
      : await saveTextFile(`murge-app-logs-${stamp}.txt`, serializeLogs(appVisibleEntries.value.map((entry) => ({ ...entry, message: `[${entry.module}] ${entry.message}` }))))
    if (result.saved) toast.success('日志已导出', result.path)
  } catch (error) {
    toast.error('日志导出失败', error instanceof Error ? error.message : undefined)
  } finally {
    exportingLogs.value = false
  }
}

function clearLogs(): void {
  if (source.value === 'core') store.clear()
  else appStore.clear()
}

async function exportDiagnostics(): Promise<void> {
  if (exportingDiagnostics.value) return
  exportingDiagnostics.value = true
  try {
    const result = await downloadDiagnosticReport()
    if (result.saved) toast.success('诊断报告已导出', result.path)
  } catch (error) {
    toast.error('诊断报告导出失败', error instanceof Error ? error.message : '请稍后重试。')
  } finally {
    exportingDiagnostics.value = false
  }
}

async function exportBundle(): Promise<void> {
  if (exportingBundle.value) return
  exportingBundle.value = true
  try {
    const result = await window.desktop.logs.exportBundle()
    if (result.saved) toast.success('日志包已导出', result.path)
  } catch (error) {
    toast.error('日志包导出失败', error instanceof Error ? error.message : undefined)
  } finally {
    exportingBundle.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await window.desktop.logs.openFolder()
  } catch (error) {
    toast.error('无法打开日志文件夹', error instanceof Error ? error.message : undefined)
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
}
watch(source, (next) => {
  stopPolling()
  if (next !== 'app') return
  void appStore.refresh()
  pollTimer = setInterval(() => { void appStore.refresh() }, APP_POLL_MS)
})

// Capture runs app-long at module scope; mount only (re)syncs history so a
// reopened view recovers the lines emitted while it was closed.
onMounted(store.connect)
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="page-shell logs-view">
    <header class="logs-header">
      <div><h1>日志</h1><p>{{ statusLabel }} · {{ shownCount }} 条</p></div>
      <div class="logs-actions">
        <div class="segmented logs-source" role="group" aria-label="日志来源">
          <button type="button" :class="{ selected: source === 'core' }" :aria-pressed="source === 'core'" @click="source = 'core'">内核</button>
          <button type="button" :class="{ selected: source === 'app' }" :aria-pressed="source === 'app'" @click="source = 'app'">应用</button>
        </div>
        <button type="button" @click="clearLogs">清空</button>
        <button type="button" :disabled="!shownCount || exportingLogs" @click="exportLogs">{{ exportingLogs ? '导出中…' : '导出' }}</button>
      </div>
    </header>
    <section class="troubleshoot-bar surface-card" aria-label="问题排查">
      <div class="troubleshoot-copy">
        <strong>问题排查</strong>
        <span title="包含最近 3 天的应用、内核与 Sub-Store 日志和运行诊断；订阅凭据、Token、密码及 WireGuard / Tailscale 密钥已脱敏，但仍包含访问的域名。">最近 3 天日志与运行诊断，导出时自动脱敏</span>
      </div>
      <div class="troubleshoot-actions">
        <button type="button" class="troubleshoot-button" @click="openFolder"><AppIcon name="folder" :size="14" />日志文件夹</button>
        <button type="button" class="troubleshoot-button" :disabled="exportingDiagnostics" @click="exportDiagnostics"><AppIcon name="kernel" :size="14" />{{ exportingDiagnostics ? '生成中…' : '导出诊断' }}</button>
        <button type="button" class="troubleshoot-button accent" :disabled="exportingBundle" @click="exportBundle"><AppIcon name="archive" :size="14" />{{ exportingBundle ? '打包中…' : '导出日志包' }}</button>
      </div>
    </section>
    <div class="logs-toolbar">
      <input v-model="searchModel" type="search" placeholder="筛选日志" aria-label="筛选日志" />
      <AppSelect v-if="source === 'app'" v-model="moduleModel" :options="moduleOptions" label="模块" />
      <AppSelect v-model="levelModel" :options="LEVEL_OPTIONS" label="日志级别" />
    </div>
    <p v-if="source === 'core' && lastError" class="inline-error">{{ lastError }}</p>
    <p v-if="source === 'app' && appError" class="inline-error">{{ appError }}</p>
    <section v-if="source === 'core'" class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!visibleEntries.length && status !== 'loading'" icon="logs" :title="filtered ? '没有匹配的日志' : '暂无运行日志'" :detail="filtered ? '请调整筛选条件或日志级别。' : '内核运行后，实时日志会显示在这里。'" />
      <div v-else-if="!visibleEntries.length" class="logs-empty">正在等待日志…</div>
      <div v-for="entry in visibleEntries" :key="entry.id" class="log-row">
        <time>{{ formatWallClock(entry.time) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <code>{{ entry.message }}</code>
      </div>
    </section>
    <section v-else class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!appVisibleEntries.length" icon="logs" :title="filtered ? '没有匹配的日志' : '暂无应用日志'" :detail="filtered ? '请调整筛选条件、模块或日志级别。' : 'MITM、脚本、增强模式、配置更新等模块的记录会显示在这里。'" />
      <div v-for="entry in appVisibleEntries" :key="entry.id" class="log-row app-log-row">
        <time>{{ formatWallClock(entry.time) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <button type="button" class="log-module" :title="`只看「${appLogModuleLabel(entry.module)}」`" @click="moduleModel = entry.module">{{ appLogModuleLabel(entry.module) }}</button>
        <code>{{ entry.message }}</code>
      </div>
    </section>
  </div>
</template>
