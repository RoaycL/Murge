<script setup lang="ts">
import { locale, t } from '@shared/i18n'
import { onMounted, ref, watch } from 'vue'
import { useRulesStore, type RulesSortKey } from '../stores/rules'
import { useProvidersStore } from '../stores/providers'
import { useKernelStore } from '../stores/kernel'
import AppIcon from '../components/AppIcon.vue'
import RefreshAllButton from '../components/RefreshAllButton.vue'
import RefreshIndicator from '../components/RefreshIndicator.vue'
import LocalRulesSection from '../components/LocalRulesSection.vue'
import { useLocalStore } from '../stores/local'
import { RULE_TYPE_KEYWORDS, isManagedProxy, ruleIdentity } from '@shared/local'
import type { MihomoRule } from '@shared/mihomo-api'

const rules = useRulesStore()
const providers = useProvidersStore()
const kernel = useKernelStore()
const local = useLocalStore()
const localSection = ref<InstanceType<typeof LocalRulesSection> | null>(null)

/** Where a runtime rule came from, for the 来源 column and its action. */
function ruleOrigin(row: MihomoRule): 'local' | 'edited' | 'managed' | 'subscription' | 'fixed' {
  if (isManagedProxy(local.state, row.proxy)) return 'managed'
  const identity = ruleIdentity(row.type, row.payload, row.proxy)
  if (local.localRuleIdentities.has(identity)) return 'local'
  if (local.editedIdentities.has(identity)) return 'edited'
  return RULE_TYPE_KEYWORDS[row.type] ? 'subscription' : 'fixed'
}

function editRow(row: MihomoRule): void {
  const edit = local.editedIdentities.get(ruleIdentity(row.type, row.payload, row.proxy))
  localSection.value?.editSubscriptionRule(row, edit)
}

/** A local change hot-reloads the core; re-read the runtime rule list. */
function onLocalChanged(): void {
  if (kernel.status.phase === 'running') void rules.load()
}

const COLUMNS: Array<{ key: RulesSortKey | null; label: string; className?: string }> = [
  { key: null, label: 'ID' },
  { key: 'type', label: t('common.type') },
  { key: 'payload', label: t('localRule.value') },
  { key: 'proxy', label: t('common.policy') },
  { key: 'hits', label: t('rules.hitCount') },
  { key: null, label: '', className: 'rule-action-head' }
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
  return date.toLocaleDateString(locale.value, { month: 'short', day: 'numeric' })
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
        <h1>{{ t('nav.rules') }}</h1>
      </div>
      <input :value="rules.search" :aria-label="t('rules.search')" :placeholder="t('rules.search')" @input="rules.setSearch(($event.target as HTMLInputElement).value)">
    </header>

    <LocalRulesSection ref="localSection" @changed="onLocalChanged" />

    <div v-if="rules.status === 'ready'" class="rules-counters">
      <span>{{ t('rules.total', [rules.summary.total]) }}<span v-if="rules.summary.totalHits !== null"> {{ t('rules.hits', [rules.summary.totalHits]) }}</span></span>
      <span class="rules-hint">{{ t('rules.orderNote') }}</span>
    </div>

    <div v-if="kernel.status.phase !== 'running'" class="empty-state">
      <p>{{ t('common.coreNotStarted') }}</p>
      <span>{{ t('rules.startHint') }}</span>
    </div>

    <div v-else-if="rules.status === 'error'" class="empty-state">
      <p>{{ t('rules.loadFailed') }}</p>
      <span>{{ rules.lastError }}</span>
      <button type="button" @click="init">{{ t('common.retry') }}</button>
    </div>

    <div v-else-if="rules.status === 'ready' && rules.visibleRows.length === 0" class="empty-state">
      <p>{{ rules.search ? t('rules.noMatch') : t('rules.empty') }}</p>
      <span v-if="rules.search">{{ t('rules.adjustSearch') }}</span>
    </div>

    <div v-else class="table-frame">
      <table>
        <thead>
          <tr>
            <th v-for="column in COLUMNS" :key="column.label" :class="column.className" @click="column.key && rules.sortBy(column.key)">
              {{ column.label }}<AppIcon v-if="column.key && rules.sortKey === column.key" :name="rules.sortDirection === 'asc' ? 'move-up' : 'move-down'" :size="12" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rules.visibleRows" :key="row.index">
            <td>{{ row.index }}</td>
            <td>{{ row.type }}</td>
            <td :title="row.payload">{{ row.payload }}</td>
            <td :title="row.proxy">{{ row.proxy }}</td>
            <td>{{ formatHits(row) }}</td>
            <td class="rule-action-cell">
              <span v-if="ruleOrigin(row) === 'local'" class="rule-origin">{{ t('common.local') }}</span>
              <span v-else-if="ruleOrigin(row) === 'managed'" class="rule-origin managed" :title="t('rules.autoTitle')">{{ t('rules.auto') }}</span>
              <button v-else-if="ruleOrigin(row) === 'edited'" type="button" class="rule-edit-button edited" :disabled="local.busy" @click="editRow(row)">{{ t('localRules.modified') }}</button>
              <button v-else-if="ruleOrigin(row) === 'subscription'" type="button" class="rule-edit-button" :disabled="local.busy" @click="editRow(row)">{{ t('rules.modify') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="providers.orderedRuleProviders.length" class="provider-section">
      <header class="section-caption rules-provider-caption">
        <span>{{ t('rules.ruleSet') }}</span>
        <RefreshAllButton :run="providers.refreshAllRuleProviders" :disabled="providers.batchRefreshing || !providers.remoteRuleProviders.length || kernel.status.phase !== 'running'" />
      </header>
      <div class="provider-list surface-card">
        <div v-for="provider in providers.orderedRuleProviders" :key="provider.name" class="provider-row">
          <div class="provider-info">
            <strong>{{ provider.name }}</strong>
            <small>{{ t('rules.ruleSetMeta', [provider.behavior || 'rule', provider.ruleCount ?? 0, formatUpdatedAt(provider.updatedAt)]) }}</small>
          </div>
          <div v-if="providers.opOf(provider.name, 'rule').error" class="provider-error">
            {{ providers.opOf(provider.name, 'rule').error }}
          </div>
          <div class="provider-actions">
            <button
              type="button"
              class="icon-control refresh-control"
              :disabled="providers.opOf(provider.name, 'rule').refreshing"
              :aria-label="providers.opOf(provider.name, 'rule').refreshing ? t('geodata.updating') : t('rules.updateRuleSet')"
              :title="t('common.update')"
              @click="providers.refreshRuleProvider(provider.name)"
            ><RefreshIndicator :busy="providers.opOf(provider.name, 'rule').refreshing" :failed="Boolean(providers.opOf(provider.name, 'rule').error)" :size="16" /></button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rules-counters { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-5); margin-bottom: 10px; color: var(--app-muted); font-size: var(--font-size-xs); }
.rules-hint { text-align: right; }
.rule-action-cell { text-align: right; white-space: nowrap; }
.rule-origin { padding: 1px 6px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--app-blue) 14%, transparent); color: var(--app-blue); font-size: var(--font-size-2xs); }
.rule-origin.managed { background: var(--app-fill); color: var(--app-muted); }
.rule-edit-button { padding: 0 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); cursor: pointer; opacity: 0; }
.rule-edit-button.edited { color: var(--app-warning); opacity: 1; }
tr:hover .rule-edit-button, .rule-edit-button:focus-visible { opacity: 1; }
.rule-edit-button:hover:not(:disabled) { color: var(--app-blue); }
.rules-provider-caption { display: flex; align-items: center; justify-content: space-between; }
.sort-arrow { margin-left: 3px; font-size: var(--font-size-2xs); }
.empty-state { padding: 26px; border: 1px dashed var(--app-divider); border-radius: var(--radius-control); }
.empty-state p { margin: 0 0 8px; }
.empty-state span { color: var(--app-muted); font-size: var(--font-size-sm); }
.empty-state button { margin-top: 12px; height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-sm); background: var(--app-fill); }
.provider-section { margin-top: 42px; }
.provider-list { width: 100%; }
.provider-row { display: grid; grid-template-columns: 1fr auto; column-gap: 14px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--app-divider); }
.provider-row:first-child { border-top: 0; }
.provider-info strong { display: block; font-size: var(--font-size-body); }
.provider-info small { display: block; margin-top: 3px; color: var(--app-muted); font-size: var(--font-size-xs); }
.provider-actions { display: flex; grid-column: 2; grid-row: 1 / span 2; gap: var(--space-3); }
/* 逐项更新改为图标按钮后移除旧的文本按钮底色规则。 */
.provider-error { grid-column: 1; color: var(--app-danger); font-size: var(--font-size-xs); }
</style>
