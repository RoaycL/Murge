<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, ref, watch } from 'vue'
import DetailDrawer from './DetailDrawer.vue'
import AppSelect from './AppSelect.vue'
import {
  IP_RULE_TYPES,
  LOCAL_RULE_TYPES,
  RULE_TYPE_KEYWORDS,
  formatRuleLine,
  parseRuleLine,
  type LocalRule,
  type RuleEdit,
  type RuleEditAction
} from '@shared/local'

/**
 * One drawer for both kinds of rule change:
 * - `local`: write or edit a local rule (structured fields or a raw line);
 * - `subscription`: change one of the subscription's rules (change policy,
 *   disable, or replace the whole line).
 */
export interface SubscriptionRuleRef {
  type: string
  payload: string
  proxy: string
  edit?: RuleEdit
}

const props = defineProps<{
  open: boolean
  mode: 'local' | 'subscription'
  rule: LocalRule | null
  subscription: SubscriptionRuleRef | null
  targets: string[]
  busy: boolean
}>()
const emit = defineEmits<{
  close: []
  saveLocal: [rule: LocalRule]
  saveEdit: [edit: Omit<RuleEdit, 'id'> & { id?: string }]
  removeEdit: [id: string]
}>()

const raw = ref(false)
const type = ref<string>('DOMAIN-SUFFIX')
const payload = ref('')
const target = ref('')
const noResolve = ref(true)
const line = ref('')
const action = ref<RuleEditAction>('retarget')
const formError = ref<string | null>(null)

const targetOptions = computed(() => props.targets.map((name) => ({ value: name, label: name })))
const typeOptions = LOCAL_RULE_TYPES.map((value) => ({ value, label: value }))
const subscriptionKeyword = computed(() => (props.subscription ? RULE_TYPE_KEYWORDS[props.subscription.type] ?? props.subscription.type.toUpperCase() : ''))
const subscriptionLine = computed(() => {
  const sub = props.subscription
  if (!sub) return ''
  return subscriptionKeyword.value === 'MATCH' ? `MATCH,${sub.proxy}` : `${subscriptionKeyword.value},${sub.payload},${sub.proxy}`
})
const title = computed(() => {
  if (props.mode === 'subscription') return t('localRule.titleSubscription')
  return props.rule?.id ? t('localRule.titleEdit') : t('localRule.titleAdd')
})

watch(
  () => [props.open, props.rule, props.subscription, props.mode] as const,
  ([open]) => {
    if (!open) return
    formError.value = null
    const fallbackTarget = props.targets.find((name) => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].includes(name)) ?? 'DIRECT'
    if (props.mode === 'local') {
      const parsed = props.rule ? parseRuleLine(props.rule.rule) : null
      raw.value = Boolean(props.rule && (!parsed || !(LOCAL_RULE_TYPES as readonly string[]).includes(parsed.type)))
      line.value = props.rule?.rule ?? ''
      type.value = parsed?.type ?? 'DOMAIN-SUFFIX'
      payload.value = parsed?.payload ?? ''
      target.value = parsed?.target ?? fallbackTarget
      noResolve.value = parsed ? parsed.noResolve : true
    } else {
      const edit = props.subscription?.edit
      action.value = edit?.action ?? 'retarget'
      target.value = edit?.newTarget ?? props.subscription?.proxy ?? fallbackTarget
      line.value = edit?.replacement ?? subscriptionLine.value
    }
  },
  { immediate: true }
)

function buildLocalLine(): string {
  if (raw.value) {
    const text = line.value.trim()
    if (!parseRuleLine(text)) throw new Error(t('localRule.formatWithMatch'))
    return text
  }
  if (type.value !== 'MATCH' && !payload.value.trim()) throw new Error(t('localRule.valueRequired'))
  if (!target.value) throw new Error(t('localRule.policyRequired'))
  return formatRuleLine({ type: type.value, payload: payload.value, target: target.value, noResolve: noResolve.value })
}

function toggleRaw(): void {
  if (!raw.value) {
    try {
      line.value = buildLocalLine()
    } catch {
      // Keep the previous raw text.
    }
  } else {
    const parsed = parseRuleLine(line.value)
    if (parsed && (LOCAL_RULE_TYPES as readonly string[]).includes(parsed.type)) {
      type.value = parsed.type
      payload.value = parsed.payload
      target.value = parsed.target
      noResolve.value = parsed.noResolve
    }
  }
  raw.value = !raw.value
}

function submit(): void {
  formError.value = null
  try {
    if (props.mode === 'local') {
      emit('saveLocal', { id: props.rule?.id ?? '', enabled: props.rule?.enabled ?? true, rule: buildLocalLine() })
      return
    }
    const sub = props.subscription
    if (!sub) return
    const base = { id: sub.edit?.id, ruleType: sub.type, payload: sub.payload, target: sub.proxy, action: action.value }
    if (action.value === 'retarget') {
      if (!target.value) throw new Error(t('localRule.policyRequired'))
      if (target.value === sub.proxy) throw new Error(t('localRule.policyUnchanged'))
      emit('saveEdit', { ...base, newTarget: target.value, replacement: null })
    } else if (action.value === 'replace') {
      const text = line.value.trim()
      if (!parseRuleLine(text)) throw new Error(t('localRule.format'))
      emit('saveEdit', { ...base, newTarget: null, replacement: text })
    } else {
      emit('saveEdit', { ...base, newTarget: null, replacement: null })
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  }
}

const ACTIONS: Array<{ value: RuleEditAction; label: string }> = [
  { value: 'retarget', label: t('localRule.modePolicy') },
  { value: 'disable', label: t('localRule.modeDisable') },
  { value: 'replace', label: t('localRule.modeReplace') }
]
</script>

<template>
  <DetailDrawer :open="open" :title="title" :subtitle="mode === 'subscription' ? t('localRule.hintSubscription') : t('localRule.hintLocal')" @close="emit('close')">
    <form class="rule-editor" @submit.prevent="submit">
      <template v-if="mode === 'subscription' && subscription">
        <div class="rule-original">
          <small>{{ t('localRule.originalRule') }}</small>
          <code>{{ subscriptionLine }}</code>
        </div>
        <div class="rule-actions-list" role="radiogroup" :aria-label="t('localRule.modeLabel')">
          <label v-for="item in ACTIONS" :key="item.value" class="surge-check"><input v-model="action" type="radio" :value="item.value" />{{ item.label }}</label>
        </div>
        <div v-if="action === 'retarget'" class="rule-form-card">
          <label><span>{{ t('common.policy') }}</span><span class="rule-form-select"><AppSelect :model-value="target" :options="targetOptions" :label="t('common.policy')" plain @update:model-value="(value: string) => (target = value)" /></span></label>
        </div>
        <textarea v-else-if="action === 'replace'" v-model="line" class="rule-line" rows="2" spellcheck="false" :aria-label="t('localRule.replacementLabel')" />
        <p class="rule-hint">{{ t('localRule.matchHint') }}</p>
      </template>

      <template v-else>
        <div v-if="!raw" class="rule-form-card">
          <label><span>{{ t('common.type') }}</span><span class="rule-form-select"><AppSelect :model-value="type" :options="typeOptions" :label="t('common.type')" plain @update:model-value="(value: string) => (type = value)" /></span></label>
          <label v-if="type !== 'MATCH'"><span>{{ t('localRule.value') }}</span><input v-model="payload" type="text" spellcheck="false" :placeholder="type.startsWith('IP') || type === 'SRC-IP-CIDR' ? '192.168.1.0/24' : type === 'RULE-SET' ? t('localRule.ruleSetName') : 'example.com'" /></label>
          <label><span>{{ t('common.policy') }}</span><span class="rule-form-select"><AppSelect :model-value="target" :options="targetOptions" :label="t('common.policy')" plain @update:model-value="(value: string) => (target = value)" /></span></label>
          <label v-if="IP_RULE_TYPES.has(type)" class="rule-form-toggle"><span>{{ t('localRule.noResolve') }}</span><button type="button" class="switch" :class="{ on: noResolve }" role="switch" :aria-checked="noResolve" :aria-label="t('localRule.noResolveLabel')" @click="noResolve = !noResolve" /></label>
        </div>
        <textarea v-else v-model="line" class="rule-line" rows="2" spellcheck="false" placeholder="AND,((DOMAIN-SUFFIX,example.com),(NETWORK,UDP)),REJECT" :aria-label="t('common.rule')" />
        <p class="rule-hint">{{ t('localRule.policyHint') }}</p>
      </template>

      <p v-if="formError" class="rule-error" role="alert">{{ formError }}</p>
      <div class="rule-editor-actions">
        <button v-if="mode === 'local'" type="button" class="surge-button" @click="toggleRaw">{{ raw ? t('localRule.useForm') : t('localRule.useText') }}</button>
        <button v-else-if="subscription?.edit" type="button" class="surge-button danger" :disabled="busy" @click="emit('removeEdit', subscription.edit.id)">{{ t('localRule.restoreOriginal') }}</button>
        <span class="spacer" />
        <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button type="submit" class="surge-button primary" :disabled="busy">{{ busy ? t('common.saving') : t('common.save') }}</button>
      </div>
    </form>
  </DetailDrawer>
</template>

<style scoped>
.rule-editor { display: grid; gap: 14px; }
.rule-original { display: grid; gap: 6px; padding: 12px 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.rule-original small { color: var(--app-muted); font-size: var(--font-size-xs); }
.rule-original code, .rule-line { font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; user-select: text; }
.rule-actions-list { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); font-size: var(--font-size-sm); }
.rule-form-card { display: grid; padding: 0 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.rule-form-card label { display: grid; grid-template-columns: minmax(90px, 34%) 1fr; align-items: center; gap: 12px; min-height: 38px; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.rule-form-card label:first-child { border-top: 0; }
.rule-form-card input { min-width: 0; height: 30px; padding: 0; border: 0; background: transparent; color: var(--app-text); font-size: var(--font-size-sm); text-align: right; }
.rule-form-card input::placeholder { color: var(--app-faint); }
.rule-form-card input:focus { outline: none; }
.rule-form-card label:focus-within { box-shadow: inset 0 -2px 0 var(--app-blue); }
.rule-form-toggle .switch { justify-self: end; }
.rule-form-card label.rule-form-toggle { grid-template-columns: minmax(0, 1fr) auto; }
.rule-form-select { justify-self: end; width: max-content; max-width: 100%; }
.rule-form-select :deep(.app-select.plain .app-select-trigger) { gap: 4px; font-size: var(--font-size-sm); font-weight: var(--font-weight-regular); color: var(--app-muted); }
.rule-form-select :deep(.app-select.plain .trigger-chevron) { display: inline-block; }
.rule-line { padding: 10px 12px; border: 1px solid var(--app-divider); border-radius: var(--radius-panel); background: var(--app-surface-solid); color: var(--app-text); resize: vertical; }
.rule-hint { margin: 0 4px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.55; }
.rule-error { margin: 0 4px; color: var(--app-danger); font-size: var(--font-size-xs); }
.rule-editor-actions { display: flex; align-items: center; gap: var(--space-3); }
.rule-editor-actions .spacer { flex: 1; }
</style>
