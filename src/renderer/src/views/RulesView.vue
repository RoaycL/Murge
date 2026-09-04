<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRulesStore, type RulesSortKey } from '../stores/rules'
import { useProvidersStore } from '../stores/providers'
import { useKernelStore } from '../stores/kernel'
import AppIcon from '../components/AppIcon.vue'

const rules = useRulesStore()
const providers = useProvidersStore()
const kernel = useKernelStore()

const COLUMNS: Array<{ key: RulesSortKey | null; label: string; className?: string }> = [
  { key: null, label: '' },
  { key: 'index', label: 'ID' },
  { key: 'type', label: '类型' },
  { key: 'payload', label: '值' },
  { key: 'proxy', label: '策略' },
  { key: 'hits', label: '使用计数' }
]

/** Format a rule's real hit count; mihomo reports rule-set sizes separately. */
function formatHits(row: { extra?: { hitCount?: number } }): string {
  const hits = row.extra?.hitCount
  return typeof hits === 'number' ? String(hits) : '—'
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

async function init(): Promise<void> {
  await kernel.refresh()
  if (kernel.status.phase !== 'running') return
  await rules.load()
  void providers.loadRuleProviders()
}

onMounted(() => {
  void init()
})

watch(() => kernel.status.phase, (phase, previous) => {
  if (phase === 'running' && previous !== 'running') void init()
})
</script>

<template>
  <div class="page-shell rules-view">
    <header class="rules-header">
      <div>
        <h1>规则</h1>
        <p>规则将按照从上至下的顺序进行测试。</p>
      </div>
      <input :value="rules.search" aria-label="搜索规则" placeholder="搜索规则" @input="rules.setSearch(($event.target as HTMLInputElement).value)">
    </header>

    <div v-if="rules.status === 'ready'" class="rules-counters">
      共 {{ rules.summary.total }} 条规则<span v-if="rules.summary.totalHits !== null"> · 命中 {{ rules.summary.totalHits }} 次</span>
    </div>

    <div v-if="kernel.status.phase !== 'running'" class="empty-state">
      <p>内核尚未运行</p>
      <span>请先在“概览”中启动内核，规则将在 Controller 就绪后自动载入。</span>
    </div>

    <div v-else-if="rules.status === 'error'" class="empty-state">
      <p>无法读取规则</p>
      <span>{{ rules.lastError }}</span>
      <button type="button" @click="init">重试</button>
    </div>

    <div v-else-if="rules.status === 'ready' && rules.visibleRows.length === 0" class="empty-state">
      <p>{{ rules.search ? '没有匹配的规则' : '暂无规则' }}</p>
      <span v-if="rules.search">请调整搜索条件。</span>
    </div>

    <div v-else class="table-frame">
      <table>
        <thead>
          <tr>
            <th v-for="column in COLUMNS" :key="column.label" @click="column.key && rules.sortBy(column.key)">
              {{ column.label }}<AppIcon v-if="column.key && rules.sortKey === column.key" :name="rules.sortDirection === 'asc' ? 'move-up' : 'move-down'" :size="12" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rules.visibleRows" :key="row.index">
            <td><input type="checkbox" :aria-label="`选择规则 ${row.index}`"></td>
            <td>{{ row.index }}</td>
            <td>{{ row.type }}</td>
            <td>{{ row.payload }}</td>
            <td>{{ row.proxy }}</td>
            <td>{{ formatHits(row) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="providers.orderedRuleProviders.length" class="provider-section">
      <header class="section-caption"><span>规则集</span></header>
      <div class="provider-list surface-card">
        <div v-for="provider in providers.orderedRuleProviders" :key="provider.name" class="provider-row">
          <div class="provider-info">
            <strong>{{ provider.name }}</strong>
            <small>{{ provider.behavior || 'rule' }} · {{ provider.ruleCount ?? 0 }} 条规则 · {{ formatUpdatedAt(provider.updatedAt) }}</small>
          </div>
          <div v-if="providers.opOf(provider.name).error" class="provider-error">
            {{ providers.opOf(provider.name).error }}
          </div>
          <div class="provider-actions">
            <button
              type="button"
              :disabled="providers.opOf(provider.name).refreshing"
              @click="providers.refreshRuleProvider(provider.name)"
            >{{ providers.opOf(provider.name).refreshing ? '更新中' : '更新' }}</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rules-counters { margin-bottom: 10px; color: var(--app-muted); font-size: 11px; }
.sort-arrow { margin-left: 3px; font-size: 10px; }
.empty-state { padding: 26px; border: 1px dashed var(--app-divider); border-radius: 8px; }
.empty-state p { margin: 0 0 8px; }
.empty-state span { color: var(--app-muted); font-size: 12px; }
.empty-state button { margin-top: 12px; height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-section { margin-top: 42px; }
.provider-list { width: 675px; }
.provider-row { display: grid; grid-template-columns: 1fr auto; column-gap: 14px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--app-divider); }
.provider-row:first-child { border-top: 0; }
.provider-info strong { display: block; font-size: 14px; }
.provider-info small { display: block; margin-top: 3px; color: var(--app-muted); font-size: 11px; }
.provider-actions { display: flex; gap: 8px; }
.provider-actions button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-actions button:disabled { opacity: .5; }
.provider-error { grid-column: 1 / -1; color: #e05b5b; font-size: 11px; }
</style>
