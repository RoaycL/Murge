<script setup lang="ts">
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
  { value: 'DIRECT', label: '直连 · DIRECT' },
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
    if (!(await overrides.create(draft.value))) throw new Error(overrides.lastError ?? '保存失败')
    const item = overrides.items.find((candidate) => !before.has(candidate.id))
    if (item) created.value = { id: item.id, rule }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { saving.value = false }
}

async function undo(): Promise<void> {
  if (!created.value || saving.value) return
  saving.value = true
  const removed = await overrides.remove(created.value.id)
  if (removed) created.value = null
  else error.value = overrides.lastError ?? '撤销失败'
  saving.value = false
}

onMounted(() => { void policies.load() })
</script>

<template>
  <section class="connection-rule-panel" aria-label="为连接创建域名规则">
    <h3>为此域名创建分流规则</h3>
    <p v-if="!domain">这条连接没有可用的域名，无法生成域名规则。</p>
    <template v-else>
      <p>从连接记录提取 {{ domain }}；保存为全局覆写，下次重载配置后生效。</p>
      <label>匹配范围<AppSelect v-model="match" :options="[{ value: 'exact', label: '仅此域名' }, { value: 'suffix', label: '包含子域名' }]" label="域名规则匹配范围" /></label>
      <label>出站策略<AppSelect v-model="target" :options="targetOptions" label="域名规则出站策略" /></label>
      <div class="connection-rule-preview"><span>保存前预览</span><code>{{ draft?.rule ?? '请选择有效策略' }}</code></div>
      <div class="connection-rule-actions"><button type="button" :disabled="!draft || saving || !targetOptions.some((option) => option.value === target)" @click="save">{{ saving ? '保存中…' : '保存规则' }}</button><button v-if="created" type="button" :disabled="saving" @click="undo">撤销本次添加</button></div>
      <p v-if="created" role="status">已保存 {{ created.rule }}</p>
    </template>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.connection-rule-panel{display:grid;gap:10px;margin-top:20px;padding:15px;border:1px solid var(--app-divider);border-radius:12px}
.connection-rule-panel h3,.connection-rule-panel p{margin:0}
.connection-rule-panel p{color:var(--app-muted);font-size:11px;line-height:1.5}
.connection-rule-panel label{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}
.connection-rule-preview{display:grid;gap:4px;padding:9px;border-radius:8px;background:var(--app-surface)}
.connection-rule-preview span{font-size:10px;color:var(--app-muted)}
.connection-rule-preview code{overflow-wrap:anywhere;font-size:11px}
.connection-rule-actions{display:flex;gap:8px;flex-wrap:wrap}
.connection-rule-actions button{padding:7px 11px;border:1px solid var(--app-divider);border-radius:8px;background:var(--app-accent);color:white;cursor:pointer}
.connection-rule-actions button+button{background:transparent;color:var(--app-text)}
.connection-rule-actions button:disabled{opacity:.5;cursor:not-allowed}
</style>
