<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref } from 'vue'
import { useLocalStore } from '../stores/local'
import { useToast } from '../composables/use-toast'
import SurfaceCard from './SurfaceCard.vue'
import AppIcon from './AppIcon.vue'
import LocalRuleDrawer, { type SubscriptionRuleRef } from './LocalRuleDrawer.vue'
import { RULE_TYPE_KEYWORDS, isManagedProxy, plainClone, type LocalRule, type RuleEdit } from '@shared/local'

const emit = defineEmits<{ changed: [] }>()
const local = useLocalStore()
const toast = useToast()

const drawerOpen = ref(false)
const drawerMode = ref<'local' | 'subscription'>('local')
const editingRule = ref<LocalRule | null>(null)
const editingSubscription = ref<SubscriptionRuleRef | null>(null)

const rules = computed(() => local.settings.rules)
const edits = computed(() => local.profileEdits)
const stale = computed(() => new Set(local.state.staleEdits))
const skipped = computed(() => new Set(local.state.skippedRules))
const targets = computed(() => local.state.targets.filter((name) => !isManagedProxy(local.state, name)))

function keyword(type: string): string {
  return RULE_TYPE_KEYWORDS[type] ?? type.toUpperCase()
}

function describeEdit(edit: RuleEdit): { from: string; to: string } {
  const from = keyword(edit.ruleType) === 'MATCH' ? `MATCH,${edit.target}` : `${keyword(edit.ruleType)},${edit.payload},${edit.target}`
  if (edit.action === 'disable') return { from, to: t('common.disabled') }
  if (edit.action === 'retarget') return { from, to: t('localRules.usePolicy', [edit.newTarget ?? '']) }
  return { from, to: t('localRules.replaceWith', [edit.replacement ?? '']) }
}

function openLocal(rule: LocalRule | null = null): void {
  drawerMode.value = 'local'
  editingRule.value = rule ? plainClone(rule) : null
  editingSubscription.value = null
  drawerOpen.value = true
}

/** Called by the rules table for a subscription rule row. */
function editSubscriptionRule(row: { type: string; payload: string; proxy: string }, edit?: RuleEdit): void {
  if (!local.profileId) {
    toast.error(t('localRules.cannotModify'), t('common.noActiveSubscription'))
    return
  }
  drawerMode.value = 'subscription'
  editingRule.value = null
  editingSubscription.value = edit
    ? { type: edit.ruleType, payload: edit.payload, proxy: edit.target, edit }
    : { type: row.type, payload: row.payload, proxy: row.proxy }
  drawerOpen.value = true
}

async function done(message: string | null, success: string): Promise<boolean> {
  if (message) {
    toast.error(t('common.saveFailed'), message)
    return false
  }
  toast.success(success)
  emit('changed')
  return true
}

async function saveLocal(rule: LocalRule): Promise<void> {
  if (await done(await local.upsertRule(rule), rule.id ? t('common.saved') : t('localRules.added'))) drawerOpen.value = false
}

async function saveEdit(edit: Omit<RuleEdit, 'id'> & { id?: string }): Promise<void> {
  if (await done(await local.setEdit(edit), t('localRules.modified'))) drawerOpen.value = false
}

async function removeEdit(id: string): Promise<void> {
  if (await done(await local.removeEdit(id), t('localRules.restored'))) drawerOpen.value = false
}

async function toggleRule(rule: LocalRule): Promise<void> {
  await done(await local.setRuleEnabled(rule.id, !rule.enabled), rule.enabled ? t('common.disabled') : t('common.enabled'))
}

async function removeRule(rule: LocalRule): Promise<void> {
  await done(await local.removeRule(rule.id), t('common.deleted'))
}

async function move(rule: LocalRule, offset: -1 | 1): Promise<void> {
  const message = await local.moveRule(rule.id, offset)
  if (message) toast.error(t('localRules.moveFailed'), message)
  else emit('changed')
}

defineExpose({ editSubscriptionRule, openLocal })

onMounted(() => {
  void local.refresh()
})
</script>

<template>
  <section class="local-rules">
    <header class="section-caption local-rules-caption">
      <span>{{ t('localRules.title') }}</span>
      <button type="button" class="surge-button compact" :disabled="local.busy" @click="openLocal()">{{ t('localRules.add') }}</button>
    </header>
    <SurfaceCard v-if="rules.length" class="local-rule-list">
      <div v-for="(rule, index) in rules" :key="rule.id" class="local-rule-row" :class="{ off: !rule.enabled }">
        <code>{{ rule.rule }}</code>
        <small v-if="rule.enabled && skipped.has(rule.id)" class="local-rule-error">{{ t('localRules.policyMissing') }}</small>
        <div class="local-rule-actions">
          <button type="button" class="icon-control" :disabled="local.busy || index === 0" :aria-label="t('common.moveUp')" :title="t('common.moveUp')" @click="move(rule, -1)"><AppIcon name="move-up" :size="14" /></button>
          <button type="button" class="icon-control" :disabled="local.busy || index === rules.length - 1" :aria-label="t('common.moveDown')" :title="t('common.moveDown')" @click="move(rule, 1)"><AppIcon name="move-down" :size="14" /></button>
          <button type="button" class="surge-button compact" :disabled="local.busy" @click="openLocal(rule)">{{ t('common.edit') }}</button>
          <button type="button" class="surge-button compact danger" :disabled="local.busy" @click="removeRule(rule)">{{ t('common.delete') }}</button>
          <button type="button" class="switch" :class="{ on: rule.enabled }" role="switch" :aria-checked="rule.enabled" :aria-label="t('localRules.enable', [rule.rule])" :disabled="local.busy" @click="toggleRule(rule)" />
        </div>
      </div>
    </SurfaceCard>
    <p v-else class="surge-hint local-rules-empty">{{ t('localRules.empty') }}</p>

    <template v-if="edits.length">
      <header class="section-caption local-rules-caption edits-caption">
        <span>{{ t('localRules.modifiedTitle') }}<small v-if="local.state.profile?.name"> · {{ local.state.profile.name }}</small></span>
      </header>
      <SurfaceCard class="local-rule-list">
        <div v-for="edit in edits" :key="edit.id" class="local-rule-row">
          <div class="local-edit-text">
            <code>{{ describeEdit(edit).from }}</code>
            <small>{{ describeEdit(edit).to }}<b v-if="stale.has(edit.id)" class="local-rule-error"> {{ t('localRules.stale') }}</b></small>
          </div>
          <div class="local-rule-actions">
            <button type="button" class="surge-button compact" :disabled="local.busy" @click="editSubscriptionRule({ type: edit.ruleType, payload: edit.payload, proxy: edit.target }, edit)">{{ t('common.edit') }}</button>
            <button type="button" class="surge-button compact danger" :disabled="local.busy" @click="removeEdit(edit.id)">{{ t('common.restore') }}</button>
          </div>
        </div>
      </SurfaceCard>
    </template>

    <LocalRuleDrawer
      :open="drawerOpen"
      :mode="drawerMode"
      :rule="editingRule"
      :subscription="editingSubscription"
      :targets="targets"
      :busy="local.busy"
      @close="drawerOpen = false"
      @save-local="saveLocal"
      @save-edit="saveEdit"
      @remove-edit="removeEdit"
    />
  </section>
</template>

<style scoped>
.local-rules { margin-bottom: 26px; }
.local-rules-caption { display: flex; align-items: center; justify-content: space-between; }
.local-rules-caption small { color: var(--app-muted); font-weight: var(--font-weight-regular); }
.edits-caption { margin-top: 20px; }
.local-rule-list { display: grid; border-radius: var(--radius-panel); }
.local-rule-row { display: flex; align-items: center; gap: 12px; padding: 9px 12px 9px 16px; border-top: 1px solid var(--app-divider); }
.local-rule-row:first-child { border-top: 0; }
.local-rule-row.off code { opacity: 0.5; }
.local-rule-row > code, .local-edit-text code { flex: 1; min-width: 0; overflow: hidden; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; user-select: text; }
.local-edit-text { display: grid; flex: 1; gap: 2px; min-width: 0; }
.local-edit-text small { overflow: hidden; color: var(--app-muted); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.local-rule-error { color: var(--app-danger); font-size: var(--font-size-xs); font-weight: var(--font-weight-regular); white-space: nowrap; }
.local-rule-actions { display: flex; flex: none; align-items: center; gap: var(--space-2); }
.local-rules-empty { padding: 2px 4px; }
</style>
