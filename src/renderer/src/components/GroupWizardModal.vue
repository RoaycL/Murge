<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import AppSelect from './AppSelect.vue'
import { useDialogFocus } from '../composables/use-dialog-focus'
import { plainClone, type LocalGroup, type LocalGroupType } from '@shared/local'

/**
 * Surge-style 新建策略组 wizard: 1. type, 2. members, 3. name and test
 * options. Editing an existing local group starts at step 2.
 */
const props = defineProps<{
  open: boolean
  group: LocalGroup | null
  /** Every policy a group may contain (proxies, groups, DIRECT/REJECT). */
  policies: string[]
  /** Existing groups whose members can be included. */
  groups: string[]
  /** Proxy and group names a new group may not reuse. */
  takenNames: string[]
  busy: boolean
}>()
const emit = defineEmits<{ close: []; save: [group: LocalGroup] }>()

const dialog = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), dialog, () => {
  if (!props.busy) emit('close')
})

interface TypeOption {
  id: LocalGroupType | 'smart' | 'subnet'
  label: string
  description: string
  disabled?: string
}

const TYPES: TypeOption[] = [
  { id: 'select', label: '手动选择', description: '手动选择一个策略' },
  { id: 'smart', label: 'Smart', description: '根据网络情况和历史表现自动选择', disabled: 'mihomo 内核暂不支持' },
  { id: 'url-test', label: '自动测试', description: '自动选择延迟最低的策略' },
  { id: 'fallback', label: 'Fallback', description: '按顺序选择第一个可用的策略' },
  { id: 'subnet', label: 'Subnet', description: '根据所在网络选择策略', disabled: 'Surge 专有，mihomo 不支持' },
  { id: 'load-balance', label: '负载均衡', description: '把请求分散到多个策略' }
]
const TYPE_LABELS: Record<LocalGroupType, string> = { select: '手动选择', 'url-test': '自动测试', fallback: 'Fallback', 'load-balance': '负载均衡' }

const INTERVALS = [
  { value: '0', label: '不自动更新' },
  { value: '3600', label: '每 1 小时' },
  { value: '21600', label: '每 6 小时' },
  { value: '43200', label: '每 12 小时' },
  { value: '86400', label: '每 24 小时' }
]
const STRATEGIES = [
  { value: 'consistent-hashing', label: '一致性哈希（同一目标走同一策略）' },
  { value: 'round-robin', label: '轮询' },
  { value: 'sticky-sessions', label: '粘性会话' }
]

const step = ref(1)
const type = ref<LocalGroupType>('select')
const members = ref<string[]>([])
const search = ref('')
const useProvider = ref(false)
const providerUrl = ref('')
const providerInterval = ref('86400')
const includeAll = ref(false)
const useIncludeGroups = ref(false)
const includeGroups = ref<string[]>([])
const useFilter = ref(false)
const filter = ref('')
const name = ref('')
const icon = ref('')
const testUrl = ref('')
const interval = ref('300')
const tolerance = ref('')
const strategy = ref('consistent-hashing')
const error = ref<string | null>(null)

const isNew = computed(() => !props.group?.id)
const title = computed(() => (isNew.value ? '新建策略组' : `编辑策略组「${props.group?.config.name ?? ''}」`))
const tests = computed(() => type.value !== 'select')
const ownName = computed(() => props.group?.config.name ?? '')
const choices = computed(() => {
  const query = search.value.trim().toLowerCase()
  return props.policies.filter((item) => item !== ownName.value && (!query || item.toLowerCase().includes(query)))
})
const groupChoices = computed(() => props.groups.filter((item) => item !== ownName.value))

const asText = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

watch(
  () => [props.open, props.group] as const,
  ([open]) => {
    if (!open) return
    error.value = null
    search.value = ''
    const group = props.group
    const config = group?.config ?? ({} as Record<string, unknown>)
    step.value = group?.id ? 2 : 1
    type.value = (group?.config.type as LocalGroupType) ?? 'select'
    members.value = Array.isArray(config.proxies) ? (config.proxies as unknown[]).map(asText).filter(Boolean) : []
    const provider = group?.providers?.[0]
    useProvider.value = Boolean(provider)
    providerUrl.value = provider?.url ?? ''
    providerInterval.value = String(provider?.interval ?? 86400)
    includeAll.value = config['include-all-proxies'] === true
    includeGroups.value = [...(group?.includeGroups ?? [])]
    useIncludeGroups.value = includeGroups.value.length > 0
    filter.value = asText(config.filter)
    useFilter.value = Boolean(filter.value)
    name.value = asText(config.name)
    icon.value = asText(config.icon)
    testUrl.value = asText(config.url)
    interval.value = asText(config.interval) || '300'
    tolerance.value = asText(config.tolerance)
    strategy.value = asText(config.strategy) || 'consistent-hashing'
  },
  { immediate: true }
)

function pickType(option: TypeOption): void {
  if (option.disabled) return
  type.value = option.id as LocalGroupType
  step.value = 2
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item]
}

function membersProblem(): string | null {
  if (useProvider.value && !/^https?:\/\//i.test(providerUrl.value.trim())) return '外部策略需要 http(s) 地址'
  if (useFilter.value && filter.value.trim()) {
    try {
      new RegExp(filter.value.replace(/^\(\?i\)/, ''))
    } catch {
      return '过滤正则无效'
    }
  }
  const any = members.value.length || (useProvider.value && providerUrl.value.trim()) || includeAll.value || (useIncludeGroups.value && includeGroups.value.length)
  return any ? null : '至少选择一个策略，或勾选右侧的包含方式'
}

function next(): void {
  error.value = membersProblem()
  if (!error.value) step.value = 3
}

function positive(value: string, label: string): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  const number = Number(text)
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label}必须是非负整数`)
  return number
}

function submit(): void {
  error.value = membersProblem()
  if (error.value) {
    step.value = 2
    return
  }
  const groupName = name.value.trim()
  if (!groupName) {
    error.value = '请填写名称'
    return
  }
  if (props.takenNames.includes(groupName)) {
    error.value = `「${groupName}」已被节点或策略组使用`
    return
  }
  try {
    const base = plainClone(props.group?.config ?? {}) as Record<string, unknown>
    for (const key of ['proxies', 'include-all-proxies', 'filter', 'icon', 'url', 'interval', 'tolerance', 'strategy', 'lazy']) delete base[key]
    const config: Record<string, unknown> = { ...base, name: groupName, type: type.value }
    if (members.value.length) config.proxies = [...members.value]
    if (includeAll.value) config['include-all-proxies'] = true
    if (useFilter.value && filter.value.trim()) config.filter = filter.value.trim()
    if (icon.value.trim()) config.icon = icon.value.trim()
    if (tests.value) {
      if (testUrl.value.trim()) {
        if (!/^https?:\/\//i.test(testUrl.value.trim())) throw new Error('测试地址需要 http(s) 开头')
        config.url = testUrl.value.trim()
      }
      config.interval = positive(interval.value, '测试间隔') ?? 300
      if (type.value === 'url-test') {
        const value = positive(tolerance.value, '容差')
        if (value !== undefined) config.tolerance = value
      }
      if (type.value === 'load-balance') config.strategy = strategy.value
    }
    emit('save', {
      id: props.group?.id ?? '',
      enabled: props.group?.enabled ?? true,
      config: config as LocalGroup['config'],
      includeGroups: useIncludeGroups.value ? [...includeGroups.value] : [],
      providers: useProvider.value && providerUrl.value.trim() ? [{ url: providerUrl.value.trim(), interval: Number(providerInterval.value) || 0 }] : []
    })
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-shade group-wizard-shade" role="presentation" @click.self="!busy && emit('close')">
      <section ref="dialog" class="group-wizard" role="dialog" aria-modal="true" :aria-label="title">
        <header class="gw-head">
          <h2>{{ title }}</h2>
          <ol class="gw-steps" aria-label="步骤">
            <li :class="{ on: step === 1, done: step > 1 }">类型</li>
            <li :class="{ on: step === 2, done: step > 2 }">策略</li>
            <li :class="{ on: step === 3 }">名称与选项</li>
          </ol>
        </header>

        <div class="gw-body">
          <div v-if="step === 1" class="gw-types">
            <p class="gw-lead">选择策略组的类型</p>
            <button v-for="option in TYPES" :key="option.id" type="button" class="gw-type" :class="{ selected: type === option.id }" :disabled="Boolean(option.disabled)" :title="option.disabled" @click="pickType(option)">
              <strong>{{ option.label }}</strong>
              <small>{{ option.disabled ?? option.description }}</small>
            </button>
          </div>

          <div v-else-if="step === 2" class="gw-members">
            <section class="gw-list">
              <h3>选择包含的策略 <small>{{ members.length ? `已选 ${members.length} 个` : '' }}</small></h3>
              <input v-model="search" class="gw-input" type="search" placeholder="搜索" aria-label="搜索策略" />
              <div class="gw-checks">
                <label v-for="item in choices" :key="item" class="surge-check"><input type="checkbox" :checked="members.includes(item)" @change="members = toggle(members, item)" /><span>{{ item }}</span></label>
                <p v-if="!choices.length" class="gw-hint">{{ props.policies.length ? '没有匹配的策略' : '启动内核后可以选择策略' }}</p>
              </div>
            </section>
            <section class="gw-options">
              <div class="gw-option">
                <label class="surge-check"><input v-model="useProvider" type="checkbox" />同时包含外部策略</label>
                <template v-if="useProvider">
                  <input v-model="providerUrl" class="gw-input" type="url" spellcheck="false" placeholder="https://example.com/nodes.yaml" aria-label="外部策略地址" />
                  <div class="gw-inline"><span>自动更新间隔</span><AppSelect v-model="providerInterval" :options="INTERVALS" label="自动更新间隔" /></div>
                </template>
              </div>
              <div class="gw-option">
                <label class="surge-check"><input v-model="includeAll" type="checkbox" />同时包含所有代理策略</label>
                <small>订阅和本地的全部节点，不含策略组</small>
              </div>
              <div class="gw-option">
                <label class="surge-check"><input v-model="useIncludeGroups" type="checkbox" />同时包含其他策略组的策略</label>
                <div v-if="useIncludeGroups" class="gw-checks gw-checks-small">
                  <label v-for="item in groupChoices" :key="item" class="surge-check"><input type="checkbox" :checked="includeGroups.includes(item)" @change="includeGroups = toggle(includeGroups, item)" /><span>{{ item }}</span></label>
                  <p v-if="!groupChoices.length" class="gw-hint">没有可选的策略组</p>
                </div>
              </div>
              <div class="gw-option">
                <label class="surge-check"><input v-model="useFilter" type="checkbox" />包含过滤</label>
                <template v-if="useFilter">
                  <input v-model="filter" class="gw-input" type="text" spellcheck="false" placeholder="正则，例如 (?i)港|hk" aria-label="过滤正则" />
                  <small>只保留名称匹配的节点（作用于外部策略和“所有代理策略”）</small>
                </template>
              </div>
            </section>
          </div>

          <div v-else class="gw-final">
            <section class="gw-card">
              <label class="gw-row"><span>名称</span><input v-model="name" class="gw-input" type="text" spellcheck="false" placeholder="必填" /></label>
              <div class="gw-row"><span>类型</span><b>{{ TYPE_LABELS[type] }}</b></div>
              <label class="gw-row"><span>图标<small>可选，图片地址</small></span><input v-model="icon" class="gw-input" type="url" spellcheck="false" placeholder="https://…" /></label>
            </section>
            <section v-if="tests" class="gw-card">
              <label class="gw-row"><span>测试地址<small>留空使用内核默认</small></span><input v-model="testUrl" class="gw-input" type="url" spellcheck="false" placeholder="https://www.gstatic.com/generate_204" /></label>
              <label class="gw-row"><span>测试间隔（秒）</span><input v-model="interval" class="gw-input" type="text" inputmode="numeric" /></label>
              <label v-if="type === 'url-test'" class="gw-row"><span>容差（毫秒）<small>延迟差小于它时不切换</small></span><input v-model="tolerance" class="gw-input" type="text" inputmode="numeric" placeholder="50" /></label>
              <div v-if="type === 'load-balance'" class="gw-row"><span>分配方式</span><AppSelect v-model="strategy" :options="STRATEGIES" label="分配方式" /></div>
            </section>
          </div>
        </div>

        <footer class="gw-foot">
          <p v-if="error" class="gw-error" role="alert">{{ error }}</p>
          <span class="spacer" />
          <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">取消</button>
          <button v-if="step > 1 && (isNew || step > 2)" type="button" class="surge-button" :disabled="busy" @click="step--; error = null">上一步</button>
          <button v-if="step === 2" type="button" class="surge-button primary" @click="next">下一步</button>
          <button v-if="step === 3" type="button" class="surge-button primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : '完成' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.group-wizard-shade { z-index: 72; }
.group-wizard { display: flex; flex-direction: column; width: min(820px, calc(100vw - 40px)); height: min(600px, calc(100vh - 48px)); overflow: hidden; border: 1px solid var(--app-divider); border-radius: var(--radius-large); color: var(--app-text); background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter); box-shadow: 0 22px 70px rgba(0, 0, 0, 0.3); }
.gw-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px 14px; border-bottom: 1px solid var(--app-divider); }
.gw-head h2 { overflow: hidden; margin: 0; font-size: var(--font-size-title); text-overflow: ellipsis; white-space: nowrap; }
.gw-steps { display: flex; flex: none; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: var(--font-size-xs); }
.gw-steps li { padding: 2px 10px; border-radius: 999px; color: var(--app-muted); background: var(--app-fill); }
.gw-steps li.on { color: var(--app-on-accent); background: var(--app-blue); }
.gw-steps li.done { color: var(--app-text); }
.gw-body { flex: 1; min-height: 0; overflow: auto; padding: 18px 20px; }
.gw-lead { margin: 0 0 12px 4px; color: var(--app-muted); font-size: var(--font-size-sm); }
.gw-types { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.gw-types .gw-lead { grid-column: 1 / -1; margin-bottom: 0; }
.gw-type { display: grid; gap: 6px; min-height: 92px; padding: 14px; border: 1px solid transparent; border-radius: var(--radius-md); background: var(--app-surface-solid); color: inherit; text-align: left; align-content: start; }
.gw-type strong { font-size: var(--font-size-body); }
.gw-type small { color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.45; }
.gw-type:hover:not(:disabled), .gw-type.selected { border-color: color-mix(in srgb, var(--app-blue) 55%, var(--app-divider)); background: color-mix(in srgb, var(--app-blue) 8%, var(--app-surface-solid)); }
.gw-type:disabled { opacity: 0.5; }
.gw-members { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; height: 100%; }
.gw-list { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 8px; min-height: 0; }
.gw-list h3 { display: flex; justify-content: space-between; margin: 0 4px; font-size: var(--font-size-sm); }
.gw-list h3 small { color: var(--app-muted); font-weight: 400; }
.gw-checks { display: grid; align-content: start; gap: 2px; min-height: 0; overflow: auto; padding: 6px 10px; border-radius: var(--radius-panel); background: var(--app-surface-solid); font-size: var(--font-size-sm); }
.gw-checks .surge-check { min-width: 0; padding: 4px 0; }
.gw-checks .surge-check span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-checks-small { max-height: 150px; background: color-mix(in srgb, var(--app-surface-solid) 60%, var(--app-bg)); }
.gw-options { display: grid; align-content: start; gap: 10px; min-height: 0; overflow: auto; }
.gw-option { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); font-size: var(--font-size-sm); }
.gw-option small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.gw-inline { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; color: var(--app-muted); font-size: var(--font-size-xs); }
.gw-input { width: 100%; min-width: 0; height: 28px; padding: 0 9px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: color-mix(in srgb, var(--app-surface-solid) 70%, var(--app-bg)); color: var(--app-text); font-size: var(--font-size-sm); }
.gw-input::placeholder { color: var(--app-faint); }
.gw-input:focus { outline: none; border-color: var(--app-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-blue) 22%, transparent); }
.gw-final { display: grid; align-content: start; gap: 16px; max-width: 560px; margin: 0 auto; }
.gw-card { display: grid; padding: 0 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.gw-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: center; gap: 12px; min-height: 42px; padding: 6px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.gw-row:first-child { border-top: 0; }
.gw-row > span { display: grid; gap: 2px; }
.gw-row small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.gw-row b { font-weight: 500; }
.gw-hint { margin: 4px 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.gw-error { margin: 0; overflow: hidden; color: var(--app-danger); font-size: var(--font-size-xs); text-overflow: ellipsis; }
.gw-foot { display: flex; align-items: center; gap: var(--space-3); padding: 12px 20px; border-top: 1px solid var(--app-divider); }
.gw-foot .spacer { flex: 1; }
@media (max-width: 700px) {
  .gw-types { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gw-members { grid-template-columns: minmax(0, 1fr); }
}
</style>
