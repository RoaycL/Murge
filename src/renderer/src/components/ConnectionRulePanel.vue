<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref, watch } from 'vue'
import type { MihomoConnection } from '@shared/mihomo-api'
import { buildDomainRuleOverride, normalizeRuleDomain, type DomainRuleMatch } from '@shared/domain-rule'
import { useOverridesStore } from '../stores/overrides'
import { usePoliciesStore } from '../stores/policies'
import AppSelect from './AppSelect.vue'

const props = defineProps<{ connection: MihomoConnection }>()
const overrides = useOverridesStore()
const policies = usePoliciesStore()
const match = ref<DomainRuleMatch>('exact')
const target = ref('DIRECT')
const saving = ref(false)
const error = ref('')
const created = ref<{ id: string; rule: string } | null>(null)
const domain = computed(() => normalizeRuleDomain(props.connection.metadata.host ?? ''))
const targetOptions = computed(() => [
  { value: 'DIRECT', label: t('connRule.directOption') },
  ...policies.groups.filter((group) => group.name !== 'DIRECT' && !/[\r\n,]/.test(group.name))
    .map((group) => ({ value: group.name, label: group.name }))
])
const draft = computed(() => {
  if (!domain.value) return null
  try { return buildDomainRuleOverride({ host: domain.value, match: match.value, target: target.value }) }
  catch { return null }
})

watch(() => props.connection.id, () => {
  match.value = 'exact'; target.value = 'DIRECT'; error.value = ''; created.value = null
})

async function save(): Promise<void> {
  if (!draft.value || saving.value || !targetOptions.value.some((option) => option.value === target.value)) return
  saving.value = true; error.value = ''
  try {
    await overrides.refresh()
    if (overrides.lastError) throw new Error(overrides.lastError)
    const before = new Set(overrides.items.map((item) => item.id))
    const rule = draft.value.rule
    if (!(await overrides.create(draft.value))) throw new Error(overrides.lastError ?? t('common.saveFailed'))
    const item = overrides.items.find((candidate) => !before.has(candidate.id))
    if (item) created.value = { id: item.id, rule }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t('common.saveFailed') }
  finally { saving.value = false }
}

async function undo(): Promise<void> {
  if (!created.value || saving.value) return
  saving.value = true
  const removed = await overrides.remove(created.value.id)
  if (removed) created.value = null
  else error.value = overrides.lastError ?? t('connRule.undoFailed')
  saving.value = false
}

onMounted(() => { void policies.load() })
</script>

<template>
  <section class="connection-rule-panel" :aria-label="t('connRule.label')">
    <h3>{{ t('connRule.title') }}</h3>
    <p v-if="!domain">{{ t('connRule.noDomain') }}</p>
    <template v-else>
      <p>{{ t('connRule.intro', [domain]) }}</p>
      <label>{{ t('connRule.scope') }}<AppSelect v-model="match" :options="[{ value: 'exact', label: t('connRule.exactDomain') }, { value: 'suffix', label: t('connRule.withSubdomains') }]" :label="t('connRule.scopeLabel')" /></label>
      <label>{{ t('connRule.outbound') }}<AppSelect v-model="target" :options="targetOptions" :label="t('connRule.outboundLabel')" /></label>
      <div class="connection-rule-preview"><span>{{ t('connRule.preview') }}</span><code>{{ draft?.rule ?? t('connRule.pickPolicy') }}</code></div>
      <div class="connection-rule-actions"><button type="button" :disabled="!draft || saving || !targetOptions.some((option) => option.value === target)" @click="save">{{ saving ? t('common.saving') : t('connRule.saveRule') }}</button><button v-if="created" type="button" :disabled="saving" @click="undo">{{ t('connRule.undo') }}</button></div>
      <p v-if="created" role="status">{{ t('connRule.saved', [created.rule]) }}</p>
    </template>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.connection-rule-panel{display:grid;gap:var(--space-4);margin-top:20px;padding:15px;border:1px solid var(--app-divider);border-radius:var(--radius-card)}
.connection-rule-panel h3,.connection-rule-panel p{margin:0}
.connection-rule-panel p{color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.5}
.connection-rule-panel label{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);font-size:var(--font-size-sm)}
.connection-rule-preview{display:grid;gap:var(--space-1);padding:9px;border-radius:var(--radius-control);background:var(--app-surface)}
.connection-rule-preview span{font-size:var(--font-size-2xs);color:var(--app-muted)}
.connection-rule-preview code{overflow-wrap:anywhere;font-size:var(--font-size-xs)}
.connection-rule-actions{display:flex;gap:var(--space-3);flex-wrap:wrap}
.connection-rule-actions button{padding:7px 11px;border:1px solid var(--app-divider);border-radius:var(--radius-control);background:var(--app-accent);color:var(--app-on-accent);cursor:pointer}
.connection-rule-actions button+button{background:transparent;color:var(--app-text)}
.connection-rule-actions button:disabled{opacity:.5;cursor:not-allowed}
</style>
