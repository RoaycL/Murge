import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppLogEntry } from '@shared/diagnostics'
import { redactLogText } from '@shared/log-redaction'
import type { LogLevelFilter } from './logs'

export interface DisplayAppLogEntry extends AppLogEntry { id: number }

/** Friendly names for the app-log module tags; unknown tags show as-is. */
export const APP_LOG_MODULE_LABELS: Record<string, string> = {
  startup: '启动',
  runtime: '运行时',
  kernel: '内核',
  tun: '增强模式',
  'system-proxy': '系统代理',
  'lan-gateway': '网关模式',
  mitm: 'MITM',
  script: '脚本',
  rewrite: '重写',
  profiles: '配置',
  substore: 'Sub-Store',
  updates: '更新',
  backup: '备份',
  'app-settings': '设置',
  'usage-history': '用量',
  notifications: '通知',
  'session-events': '会话',
  'session-end': '会话',
  tray: '托盘',
  window: '窗口',
  local: '本地节点'
}

export function appLogModuleLabel(module: string): string {
  return APP_LOG_MODULE_LABELS[module] ?? module
}

/**
 * The 应用 source of the logs page: the tail of the on-disk app log (MITM,
 * scripts, TUN, profiles, updates…). Polled only while the source is shown.
 */
export const useAppLogsStore = defineStore('app-logs', () => {
  const entries = ref<DisplayAppLogEntry[]>([])
  const modules = ref<string[]>([])
  const loading = ref(false)
  const lastError = ref<string | null>(null)
  const search = ref('')
  const level = ref<LogLevelFilter>('all')
  const module = ref('all')
  /** Entries at or before this timestamp are hidden after 清空. */
  const clearedThrough = ref<string | null>(null)

  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      const snapshot = await window.desktop.logs.readApp()
      entries.value = snapshot.entries.map((entry, index) => ({ ...entry, message: redactLogText(entry.message), id: index + 1 }))
      modules.value = snapshot.modules
      lastError.value = null
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
    } finally {
      loading.value = false
    }
  }

  function clear(): void {
    const last = entries.value[entries.value.length - 1]
    if (last) clearedThrough.value = last.time
  }

  const visibleEntries = computed(() => {
    const term = search.value.trim().toLocaleLowerCase()
    const after = clearedThrough.value
    return entries.value.filter((entry) => {
      if (after && entry.time <= after) return false
      if (level.value !== 'all' && entry.level !== level.value) return false
      if (module.value !== 'all' && entry.module !== module.value) return false
      if (!term) return true
      return entry.message.toLocaleLowerCase().includes(term) || entry.module.toLocaleLowerCase().includes(term)
    }).reverse()
  })

  return { entries, modules, loading, lastError, search, level, module, visibleEntries, refresh, clear }
})
