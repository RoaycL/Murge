<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, ref, toRef, watch } from 'vue'
import AppSelect from './AppSelect.vue'
import PopoverMenu from './PopoverMenu.vue'
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
  /** The Smart kernel is selected, so `type: smart` groups work. */
  smart?: boolean
}>()
const emit = defineEmits<{ close: []; save: [group: LocalGroup] }>()

const dialog = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), dialog, () => {
  // Escape first closes the 选择策略组 popover, then the wizard.
  if (groupPicker.value) groupPicker.value = null
  else if (!props.busy) emit('close')
})

interface TypeOption {
  id: LocalGroupType
  label: string
  description: string
  disabled?: string
}

const SMART: TypeOption = { id: 'smart', label: t('groupWizard.smartTitle'), description: t('groupWizard.smartDesc') }
const BASE_TYPES: TypeOption[] = [
  { id: 'select', label: t('groupWizard.selectTitle'), description: t('groupWizard.selectDesc') },
  { id: 'url-test', label: t('groupWizard.urlTestTitle'), description: t('groupWizard.urlTestDesc') },
  { id: 'fallback', label: t('groupWizard.fallbackTitle'), description: t('groupWizard.fallbackDesc') },
  { id: 'load-balance', label: t('groupWizard.loadBalanceTitle'), description: t('groupWizard.loadBalanceDesc') }
]
/** Smart is offered only with the Smart kernel (or when editing a Smart group). */
const TYPES = computed<TypeOption[]>(() => (props.smart || props.group?.config.type === 'smart' ? [BASE_TYPES[0]!, SMART, ...BASE_TYPES.slice(1)] : BASE_TYPES))
const SUBTITLES = [t('groupWizard.stepType'), t('groupWizard.stepMembers'), t('groupWizard.stepOptions')]
const groupPicker = ref<{ x: number; y: number } | null>(null)
function openGroupPicker(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  groupPicker.value = { x: rect.left, y: rect.bottom + 4 }
}
const TYPE_LABELS: Record<LocalGroupType, string> = { smart: 'Smart', select: t('groupWizard.kindSelect'), 'url-test': t('groupWizard.kindUrlTest'), fallback: 'Fallback', 'load-balance': t('groupWizard.kindLoadBalance') }

const STRATEGIES = [
  { value: 'consistent-hashing', label: t('groupWizard.strategyHash') },
  { value: 'round-robin', label: t('groupWizard.strategyRoundRobin') },
  { value: 'sticky-sessions', label: t('groupWizard.strategySticky') }
]

const step = ref(1)
const type = ref<LocalGroupType>('select')
const members = ref<string[]>([])
const search = ref('')
const useProvider = ref(false)
const providerUrl = ref('')
const providerInterval = ref('86400')
const providerAuto = ref(true)
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
const title = computed(() => (isNew.value ? t('groupWizard.newTitle') : t('groupWizard.editTitle', [props.group?.config.name ?? ''])))
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
    providerInterval.value = String(provider?.interval || 86400)
    providerAuto.value = provider ? provider.interval > 0 : true
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
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item]
}

function membersProblem(): string | null {
  if (useProvider.value && !/^https?:\/\//i.test(providerUrl.value.trim())) return t('groupWizard.providerUrlInvalid')
  if (useFilter.value && filter.value.trim()) {
    try {
      new RegExp(filter.value.replace(/^\(\?i\)/, ''))
    } catch {
      return t('groupWizard.filterInvalid')
    }
  }
  const any = members.value.length || (useProvider.value && providerUrl.value.trim()) || includeAll.value || (useIncludeGroups.value && includeGroups.value.length)
  return any ? null : t('groupWizard.needMember')
}

function next(): void {
  if (step.value === 1) {
    step.value = 2
    return
  }
  error.value = membersProblem()
  if (!error.value) step.value = 3
}

function positive(value: string, label: string): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  const number = Number(text)
  if (!Number.isInteger(number) || number < 0) throw new Error(t('groupWizard.mustBeNonNegative', [label]))
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
    error.value = t('groupWizard.nameRequired')
    return
  }
  if (groupName.includes(',')) {
    error.value = t('groupWizard.nameComma')
    return
  }
  if (props.takenNames.includes(groupName)) {
    error.value = t('groupWizard.nameTaken', [groupName])
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
        if (!/^https?:\/\//i.test(testUrl.value.trim())) throw new Error(t('groupWizard.testUrlInvalid'))
        config.url = testUrl.value.trim()
      }
      config.interval = positive(interval.value, t('groupWizard.testInterval')) ?? 300
      if (type.value === 'url-test') {
        const value = positive(tolerance.value, t('groupWizard.tolerance'))
        if (value !== undefined) config.tolerance = value
      }
      if (type.value === 'load-balance') config.strategy = strategy.value
    }
    emit('save', {
      id: props.group?.id ?? '',
      enabled: props.group?.enabled ?? true,
      config: config as LocalGroup['config'],
      includeGroups: useIncludeGroups.value ? [...includeGroups.value] : [],
      providers: useProvider.value && providerUrl.value.trim() ? [{ url: providerUrl.value.trim(), interval: providerAuto.value ? positive(providerInterval.value, t('groupWizard.updateInterval')) || 86400 : 0 }] : []
    })
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-shade group-wizard-shade" role="presentation" @click.self="!busy && emit('close')">
      <section ref="dialog" class="group-wizard" :class="`step-${step}`" role="dialog" aria-modal="true" :aria-label="title">
        <header class="gw-head">
          <h2>{{ isNew ? t('common.policyGroup') : title }}</h2>
          <p>{{ SUBTITLES[step - 1] }}</p>
        </header>

        <div class="gw-body">
          <div v-if="step === 1" class="gw-types" role="radiogroup" :aria-label="t('groupWizard.typeLabel')">
            <button v-for="option in TYPES" :key="option.id" type="button" role="radio" class="gw-type" :aria-checked="type === option.id" :disabled="Boolean(option.disabled)" @click="pickType(option)" @dblclick="!option.disabled && next()">
              <i class="gw-radio" :class="{ on: type === option.id }" aria-hidden="true" />
              <span><strong>{{ option.label }}</strong><small>{{ option.disabled ?? option.description }}</small></span>
            </button>
          </div>

          <div v-else-if="step === 2" class="gw-members">
            <section class="gw-list">
              <div class="gw-list-head">
                <h3>{{ t('groupWizard.chooseMembers') }}</h3>
                <input v-model="search" class="gw-input gw-search" type="search" :placeholder="t('common.search')" :aria-label="t('groupWizard.searchPolicies')" />
              </div>
              <div class="gw-table" role="group" :aria-label="t('groupWizard.subPolicies')">
                <div class="gw-table-head"><span />{{ t('common.policy') }}<small v-if="members.length">{{ t('groupWizard.selectedCount', [members.length]) }}</small></div>
                <div class="gw-table-body">
                  <label v-for="item in choices" :key="item" class="gw-table-row" :class="{ on: members.includes(item) }">
                    <input type="checkbox" :checked="members.includes(item)" @change="members = toggle(members, item)" />
                    <span>{{ item }}</span>
                  </label>
                  <p v-if="!choices.length" class="gw-hint">{{ props.policies.length ? t('groupWizard.noMatch') : t('groupWizard.startCoreFirst') }}</p>
                </div>
              </div>
            </section>
            <div class="gw-divider" aria-hidden="true" />
            <section class="gw-options">
              <div class="gw-card">
                <div class="gw-row">
                  <span class="gw-label"><b>{{ t('groupWizard.includeProvider') }}</b><small>{{ t('groupWizard.includeProviderHint') }}</small></span>
                  <button type="button" class="switch" :class="{ on: useProvider }" role="switch" :aria-checked="useProvider" :aria-label="t('groupWizard.includeProvider')" @click="useProvider = !useProvider" />
                </div>
                <div class="gw-row" :class="{ off: !useProvider }">
                  <span class="gw-label"><b>{{ t('groupWizard.path') }}</b></span>
                  <input v-model="providerUrl" class="gw-input gw-wide" type="url" spellcheck="false" placeholder="URL" :aria-label="t('groupWizard.providerUrlLabel')" :disabled="!useProvider" />
                </div>
                <div class="gw-row" :class="{ off: !useProvider }">
                  <span class="gw-label"><b>{{ t('groupWizard.updateIntervalSeconds') }}</b></span>
                  <span class="gw-pair">
                    <input v-model="providerInterval" class="gw-input gw-number" type="text" inputmode="numeric" :aria-label="t('groupWizard.updateInterval')" :disabled="!useProvider || !providerAuto" />
                    <button type="button" class="switch" :class="{ on: providerAuto }" role="switch" :aria-checked="providerAuto" :aria-label="t('common.autoUpdate')" :disabled="!useProvider" @click="providerAuto = !providerAuto" />
                  </span>
                </div>
              </div>
              <div class="gw-card">
                <div class="gw-row">
                  <span class="gw-label"><b>{{ t('groupWizard.includeAll') }}</b><small>{{ t('groupWizard.includeAllHint') }}</small></span>
                  <button type="button" class="switch" :class="{ on: includeAll }" role="switch" :aria-checked="includeAll" :aria-label="t('groupWizard.includeAll')" @click="includeAll = !includeAll" />
                </div>
                <div class="gw-row">
                  <span class="gw-label"><b>{{ t('groupWizard.includeGroups') }}</b><small>{{ useIncludeGroups && includeGroups.length ? t('groupWizard.selectedList', [includeGroups.join(t('common.listSeparator'))]) : t('groupWizard.includeGroupsHint') }}</small></span>
                  <span class="gw-pair">
                    <button type="button" class="surge-button gw-small" :disabled="!useIncludeGroups" @click="openGroupPicker">{{ t('groupWizard.chooseGroups') }}</button>
                    <button type="button" class="switch" :class="{ on: useIncludeGroups }" role="switch" :aria-checked="useIncludeGroups" :aria-label="t('groupWizard.includeGroups')" @click="useIncludeGroups = !useIncludeGroups" />
                  </span>
                </div>
              </div>
              <div class="gw-card">
                <div class="gw-row">
                  <span class="gw-label"><b>{{ t('groupWizard.includeFilter') }}</b><small>{{ t('groupWizard.includeFilterHint') }}</small></span>
                  <input v-model="filter" class="gw-input gw-filter" type="text" spellcheck="false" :placeholder="t('groupWizard.regexOptional')" :aria-label="t('groupWizard.filterLabel')" @input="useFilter = Boolean(filter.trim())" />
                </div>
              </div>
            </section>
          </div>

          <div v-else class="gw-final">
            <div class="gw-card">
              <label class="gw-row"><span class="gw-label"><b>{{ t('common.name') }}</b></span><input v-model="name" class="gw-input gw-wide" type="text" spellcheck="false" :placeholder="t('common.required')" /></label>
              <div class="gw-row"><span class="gw-label"><b>{{ t('common.type') }}</b></span><span class="gw-value">{{ TYPE_LABELS[type] }}</span></div>
              <label class="gw-row"><span class="gw-label"><b>{{ t('groupWizard.icon') }}</b><small>{{ t('groupWizard.iconHint') }}</small></span><input v-model="icon" class="gw-input gw-wide" type="url" spellcheck="false" placeholder="https://…" /></label>
            </div>
            <div v-if="tests" class="gw-card">
              <label class="gw-row"><span class="gw-label"><b>{{ t('groupWizard.testUrl') }}</b><small>{{ t('groupWizard.testUrlHint') }}</small></span><input v-model="testUrl" class="gw-input gw-wide" type="url" spellcheck="false" placeholder="https://www.gstatic.com/generate_204" /></label>
              <label class="gw-row"><span class="gw-label"><b>{{ t('groupWizard.testIntervalSeconds') }}</b></span><input v-model="interval" class="gw-input gw-number" type="text" inputmode="numeric" /></label>
              <label v-if="type === 'url-test'" class="gw-row"><span class="gw-label"><b>{{ t('groupWizard.toleranceMs') }}</b><small>{{ t('groupWizard.toleranceHint') }}</small></span><input v-model="tolerance" class="gw-input gw-number" type="text" inputmode="numeric" placeholder="50" /></label>
              <div v-if="type === 'load-balance'" class="gw-row"><span class="gw-label"><b>{{ t('groupWizard.strategy') }}</b></span><span class="gw-select"><AppSelect v-model="strategy" :options="STRATEGIES" :label="t('groupWizard.strategy')" /></span></div>
            </div>
          </div>
        </div>

        <footer class="gw-foot">
          <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button>
          <p v-if="error" class="gw-error" role="alert">{{ error }}</p>
          <span class="spacer" />
          <button v-if="step > 1 && (isNew || step > 2)" type="button" class="surge-button" :disabled="busy" @click="step--; error = null">{{ t('common.back') }}</button>
          <button v-if="step < 3" type="button" class="surge-button primary" @click="next">{{ t('common.next') }}</button>
          <button v-else type="button" class="surge-button primary" :disabled="busy" @click="submit">{{ busy ? t('common.saving') : t('common.done') }}</button>
        </footer>
      </section>
    </div>
    <PopoverMenu :open="!!groupPicker" :x="groupPicker?.x ?? 0" :y="groupPicker?.y ?? 0" :label="t('groupWizard.chooseGroupLabel')" @close="groupPicker = null">
      <div class="gw-picker" @click.stop>
        <label v-for="item in groupChoices" :key="item" class="popover-item gw-picker-item"><span>{{ item }}</span><input type="checkbox" :checked="includeGroups.includes(item)" @change="includeGroups = toggle(includeGroups, item)" /></label>
        <p v-if="!groupChoices.length" class="gw-hint">{{ t('groupWizard.noGroups') }}</p>
      </div>
    </PopoverMenu>
  </Teleport>
</template>

<style scoped>
.group-wizard-shade { z-index: 72; background: rgba(9, 11, 15, 0.28); }
.group-wizard { display: flex; flex-direction: column; width: min(700px, calc(100vw - 40px)); max-height: calc(100vh - 48px); overflow: hidden; border: 1px solid var(--glass-edge); border-radius: 14px; color: var(--app-text); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); box-shadow: var(--glass-shadow); }
.group-wizard.step-2 { width: min(860px, calc(100vw - 40px)); height: min(620px, calc(100vh - 48px)); }
.gw-head { padding: 16px 24px 12px; border-bottom: 1px solid var(--app-divider); }
.gw-head h2 { overflow: hidden; margin: 0; font-size: var(--font-size-body); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.gw-head p { margin: 3px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); }
.gw-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; }
.gw-types { display: grid; gap: 4px; padding: 4px 6px; }
.gw-type { display: flex; align-items: flex-start; gap: 10px; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; text-align: left; }
.gw-type:hover:not(:disabled) { background: color-mix(in srgb, var(--app-text) 5%, transparent); }
.gw-type span { display: grid; gap: 3px; }
.gw-type strong { font-size: var(--font-size-sm); font-weight: 600; }
.gw-type small { color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.45; }
.gw-type:disabled { cursor: default; }
.gw-type:disabled strong { color: var(--app-muted); }
.gw-radio { flex: none; width: 15px; height: 15px; margin-top: 1px; border-radius: 50%; background: color-mix(in srgb, var(--app-text) 12%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--app-text) 22%, transparent); }
.gw-radio.on { background: var(--app-blue); box-shadow: inset 0 0 0 4.5px var(--app-blue), inset 0 0 0 15px #fff; }
.gw-members { display: grid; grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); gap: 18px; height: 100%; min-height: 0; }
.gw-divider { background: var(--app-divider); }
.gw-list { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 8px; min-height: 0; }
.gw-list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gw-list h3 { margin: 0; font-size: var(--font-size-sm); font-weight: 600; }
.gw-search { max-width: 160px; height: 24px; }
.gw-table { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 6px; background: var(--app-surface-solid); }
.gw-table-head { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; height: 26px; padding-right: 10px; border-bottom: 1px solid var(--app-divider); color: var(--app-muted); font-size: var(--font-size-2xs); font-weight: 600; }
.gw-table-head small { font-weight: 400; }
.gw-table-body { min-height: 0; overflow: auto; }
.gw-table-row { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; height: 24px; font-size: var(--font-size-sm); }
.gw-table-row:nth-child(even) { background: color-mix(in srgb, var(--app-text) 4%, transparent); }
.gw-table-row.on { background: color-mix(in srgb, var(--app-blue) 12%, transparent); }
.gw-table-row input { justify-self: center; margin: 0; accent-color: var(--app-blue); }
.gw-table-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-options, .gw-final { display: grid; align-content: start; gap: 14px; min-height: 0; overflow: auto; }
.gw-final { max-width: 560px; margin: 0 auto; width: 100%; }
.gw-card { display: grid; padding: 0 14px; border-radius: 10px; background: color-mix(in srgb, var(--app-text) 4.5%, transparent); }
.gw-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 40px; padding: 8px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.gw-row:first-child { border-top: 0; }
.gw-card .switch:not(.on) { background: color-mix(in srgb, var(--app-text) 20%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--app-text) 14%, transparent); }
.gw-card .switch:disabled { opacity: 0.5; cursor: default; }
.gw-row.off .gw-label { opacity: 0.55; }
.gw-label { display: grid; gap: 3px; min-width: 0; }
.gw-label b { font-weight: 600; }
.gw-label small { color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.45; }
.gw-pair { display: flex; flex: none; align-items: center; gap: 10px; }
.gw-value { color: var(--app-muted); }
.gw-select { flex: 0 1 260px; min-width: 0; }
.gw-input { min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--app-divider); border-radius: 6px; background: var(--app-surface-solid); color: var(--app-text); font-size: var(--font-size-sm); }
.gw-input::placeholder { color: var(--app-faint); }
.gw-input:focus { outline: none; border-color: var(--app-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-blue) 22%, transparent); }
.gw-input:disabled { opacity: 0.55; }
.gw-wide { flex: 0 1 260px; width: 260px; }
.gw-number { width: 72px; text-align: right; }
.gw-filter { flex: 0 0 180px; width: 180px; }
.gw-small { height: 24px; padding: 0 10px; font-size: var(--font-size-xs); white-space: nowrap; }
.gw-hint { margin: 8px 10px; color: var(--app-muted); font-size: var(--font-size-xs); }
.gw-error { margin: 0; overflow: hidden; color: var(--app-danger); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.gw-foot { display: flex; align-items: center; gap: var(--space-3); padding: 12px 20px; border-top: 1px solid var(--app-divider); }
.gw-foot .spacer { flex: 1; }
.gw-picker { display: grid; max-height: 260px; overflow: auto; }
.gw-picker-item input { margin: 0; accent-color: var(--app-blue); }
@media (max-width: 700px) {
  .gw-members { grid-template-columns: minmax(0, 1fr); }
  .gw-divider { display: none; }
}
</style>
