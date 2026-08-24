import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoRule } from '@shared/mihomo-api'
import { toProtocolError } from '@shared/protocol-errors'

export type RulesStatus = 'idle' | 'loading' | 'ready' | 'error'
export type RulesSortKey = 'index' | 'type' | 'payload' | 'proxy' | 'size'
export type SortDirection = 'asc' | 'desc'

export interface RulesSummary {
  total: number
  totalHits: number
}

export const useRulesStore = defineStore('rules', () => {
  const status = ref<RulesStatus>('idle')
  const lastError = ref<string | null>(null)
  const rows = ref<MihomoRule[]>([])
  const search = ref('')
  const sortKey = ref<RulesSortKey>('index')
  const sortDirection = ref<SortDirection>('asc')

  const visibleRows = computed<MihomoRule[]>(() => {
    const term = search.value.trim().toLowerCase()
    let result = rows.value
    if (term) {
      result = result.filter((rule) => {
        return (
          rule.type.toLowerCase().includes(term) ||
          rule.payload.toLowerCase().includes(term) ||
          rule.proxy.toLowerCase().includes(term)
        )
      })
    }
    const dir = sortDirection.value === 'asc' ? 1 : -1
    return [...result].sort((a, b) => {
      const key = sortKey.value
      if (key === 'index') return (a.index - b.index) * dir
      if (key === 'size') {
        const left = typeof a.size === 'number' ? a.size : 0
        const right = typeof b.size === 'number' ? b.size : 0
        return (left - right) * dir
      }
      const left = String(a[key] ?? '')
      const right = String(b[key] ?? '')
      if (left < right) return -1 * dir
      if (left > right) return 1 * dir
      return 0
    })
  })

  const summary = computed<RulesSummary>(() => {
    const total = rows.value.length
    const totalHits = rows.value.reduce((sum, rule) => sum + (typeof rule.size === 'number' ? rule.size : 0), 0)
    return { total, totalHits }
  })

  async function load(): Promise<void> {
    status.value = 'loading'
    lastError.value = null
    try {
      const result = await window.desktop.mihomo.getRules()
      rows.value = result.rules
      status.value = 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      rows.value = []
      status.value = 'error'
    }
  }

  function setSearch(value: string): void {
    search.value = value
  }

  function sortBy(key: RulesSortKey): void {
    if (sortKey.value === key) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDirection.value = 'asc'
    }
  }

  function reset(): void {
    status.value = 'idle'
    lastError.value = null
    rows.value = []
    search.value = ''
    sortKey.value = 'index'
    sortDirection.value = 'asc'
  }

  return {
    status,
    lastError,
    rows,
    search,
    sortKey,
    sortDirection,
    visibleRows,
    summary,
    load,
    setSearch,
    sortBy,
    reset
  }
})
