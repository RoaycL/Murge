<script setup lang="ts">
import { t } from '@shared/i18n'
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
  { value: 'all', label: t('logs.allLevels') }, { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' }, { value: 'warning', label: 'warning' }, { value: 'error', label: 'error' }
] as const
const moduleOptions = computed(() => [
  { value: 'all', label: t('logs.allScopes') },
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
  if (source.value === 'app') return appError.value ? t('logs.readFailed') : t('logs.appLogs')
  return status.value === 'live' ? t('logs.live') : status.value === 'loading' ? t('common.connecting') : t('common.disconnected')
})

async function exportLogs(): Promise<void> {
  if (exportingLogs.value) return
  exportingLogs.value = true
  try {
    const stamp = exportStamp()
    const result = source.value === 'core'
      ? await saveTextFile(`mihomo-logs-${stamp}.txt`, serializeLogs(visibleEntries.value))
      : await saveTextFile(`murge-app-logs-${stamp}.txt`, serializeLogs(appVisibleEntries.value.map((entry) => ({ ...entry, message: `[${entry.module}] ${entry.message}` }))))
    if (result.saved) toast.success(t('logs.exported'), result.path)
  } catch (error) {
    toast.error(t('logs.exportFailed'), error instanceof Error ? error.message : undefined)
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
    if (result.saved) toast.success(t('logs.diagExported'), result.path)
  } catch (error) {
    toast.error(t('logs.diagExportFailed'), error instanceof Error ? error.message : t('logs.retryLater'))
  } finally {
    exportingDiagnostics.value = false
  }
}

async function exportBundle(): Promise<void> {
  if (exportingBundle.value) return
  exportingBundle.value = true
  try {
    const result = await window.desktop.logs.exportBundle()
    if (result.saved) toast.success(t('logs.bundleExported'), result.path)
  } catch (error) {
    toast.error(t('logs.bundleExportFailed'), error instanceof Error ? error.message : undefined)
  } finally {
    exportingBundle.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await window.desktop.logs.openFolder()
  } catch (error) {
    toast.error(t('logs.openFolderFailed'), error instanceof Error ? error.message : undefined)
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
      <div><h1>{{ t('logs.title') }}</h1><p>{{ t('logs.summary', [statusLabel, shownCount]) }}</p></div>
      <div class="logs-actions">
        <div class="segmented logs-source" role="group" :aria-label="t('logs.sourceLabel')">
          <button type="button" :class="{ selected: source === 'core' }" :aria-pressed="source === 'core'" @click="source = 'core'">{{ t('logs.core') }}</button>
          <button type="button" :class="{ selected: source === 'app' }" :aria-pressed="source === 'app'" @click="source = 'app'">{{ t('logs.app') }}</button>
        </div>
        <button type="button" @click="clearLogs">{{ t('common.clear') }}</button>
        <button type="button" :disabled="!shownCount || exportingLogs" @click="exportLogs">{{ exportingLogs ? t('logs.exporting') : t('logs.export') }}</button>
      </div>
    </header>
    <section class="troubleshoot-bar surface-card" :aria-label="t('logs.troubleshooting')">
      <div class="troubleshoot-copy">
        <strong>{{ t('logs.troubleshooting') }}</strong>
        <span :title="t('logs.bundleTitle')">{{ t('logs.bundleHint') }}</span>
      </div>
      <div class="troubleshoot-actions">
        <button type="button" class="troubleshoot-button" @click="openFolder"><AppIcon name="folder" :size="14" />{{ t('logs.folder') }}</button>
        <button type="button" class="troubleshoot-button" :disabled="exportingDiagnostics" @click="exportDiagnostics"><AppIcon name="kernel" :size="14" />{{ exportingDiagnostics ? t('overrides.generating') : t('logs.exportDiag') }}</button>
        <button type="button" class="troubleshoot-button accent" :disabled="exportingBundle" @click="exportBundle"><AppIcon name="archive" :size="14" />{{ exportingBundle ? t('logs.packing') : t('logs.exportBundle') }}</button>
      </div>
    </section>
    <div class="logs-toolbar">
      <input v-model="searchModel" type="search" :placeholder="t('logs.filter')" :aria-label="t('logs.filter')" />
      <AppSelect v-if="source === 'app'" v-model="moduleModel" :options="moduleOptions" :label="t('logs.scope')" />
      <AppSelect v-model="levelModel" :options="LEVEL_OPTIONS" :label="t('core.logLevel')" />
    </div>
    <p v-if="source === 'core' && lastError" class="inline-error">{{ lastError }}</p>
    <p v-if="source === 'app' && appError" class="inline-error">{{ appError }}</p>
    <section v-if="source === 'core'" class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!visibleEntries.length && status !== 'loading'" icon="logs" :title="filtered ? t('logs.noMatch') : t('logs.noCoreLogs')" :detail="filtered ? t('logs.adjustCore') : t('logs.coreHint')" />
      <div v-else-if="!visibleEntries.length" class="logs-empty">{{ t('logs.waiting') }}</div>
      <div v-for="entry in visibleEntries" :key="entry.id" class="log-row">
        <time>{{ formatWallClock(entry.time) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <code>{{ entry.message }}</code>
      </div>
    </section>
    <section v-else class="surface-card logs-panel" aria-live="polite">
      <EmptyState v-if="!appVisibleEntries.length" icon="logs" :title="filtered ? t('logs.noMatch') : t('logs.noAppLogs')" :detail="filtered ? t('logs.adjustApp') : t('logs.appHint')" />
      <div v-for="entry in appVisibleEntries" :key="entry.id" class="log-row app-log-row">
        <time>{{ formatWallClock(entry.time) }}</time>
        <span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
        <button type="button" class="log-module" :title="t('logs.onlyScope', [appLogModuleLabel(entry.module)])" @click="moduleModel = entry.module">{{ appLogModuleLabel(entry.module) }}</button>
        <code>{{ entry.message }}</code>
      </div>
    </section>
  </div>
</template>
