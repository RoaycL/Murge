<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import AppSelect from './AppSelect.vue'
import { useDialogFocus } from '../composables/use-dialog-focus'
import { isTailscaleDnsSafeName, plainClone, type LocalNode, type ProxyConfig } from '@shared/local'
import { configToYaml, parseNodeText, type NodeEditorStart } from '../lib/local-node-form'
import { nameFromFileName } from '@shared/wireguard-conf'
import {
  PROTOCOLS,
  applyField,
  commonSections,
  fieldBool,
  fieldSelectValue,
  fieldText,
  newConfig,
  protocolById,
  protocolOf,
  switchProtocol,
  validateConfig,
  visibleSections,
  type FieldSpec,
  type ProtocolSpec,
  type SectionSpec
} from '../lib/proxy-schema'

/**
 * 增加 / 编辑代理. Two views of one proxy map: a protocol-aware form (left:
 * basics, server, credentials, protocol and TLS; right: chain, outbound,
 * options and groups) and the raw text, which also accepts share links,
 * Surge proxy lines, WireGuard files and several nodes at once.
 */
const props = defineProps<{
  open: boolean
  /** The node being edited; a new node when null or its id is empty. */
  node: LocalNode | null
  start: NodeEditorStart
  groups: Array<{ name: string; type: string }>
  /** Policies usable as 跳板代理 (dialer-proxy). */
  targets: string[]
  /** Names already used by other local nodes. */
  takenNames: string[]
  busy: boolean
}>()
const emit = defineEmits<{ close: []; save: [node: LocalNode]; saveMany: [nodes: LocalNode[]] }>()

const dialog = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), dialog, () => {
  if (!props.busy) emit('close')
})

const mode = ref<'form' | 'text'>('form')
const config = ref<Record<string, unknown>>({})
const protocol = ref<ProtocolSpec | null>(null)
const text = ref('')
const groups = ref<string[]>([])
const tailnetRules = ref(true)
const drafts = ref<Record<string, string>>({})
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const isNew = computed(() => !props.node?.id)
const title = computed(() => (isNew.value ? '增加代理' : '编辑代理'))
const protocolOptions = PROTOCOLS.map((spec) => ({ value: spec.id, label: spec.label }))
const RESERVED_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']
const dialerOptions = computed(() => [
  { value: '', label: '不使用' },
  ...props.targets.filter((name) => !RESERVED_TARGETS.includes(name) && name !== String(config.value.name ?? '').trim()).map((name) => ({ value: name, label: name }))
])

const allSections = computed<SectionSpec[]>(() => (protocol.value ? [...protocol.value.sections, ...commonSections(protocol.value, dialerOptions.value)] : []))
const shown = computed(() => {
  void drafts.value
  const visible = visibleSections(allSections.value, config.value)
  return { left: visible.filter((section) => section.column === 'left'), right: visible.filter((section) => section.column === 'right') }
})

const tsNameWarning = computed(() => {
  if (protocol.value?.id !== 'tailscale' || !tailnetRules.value) return null
  const name = String(config.value.name ?? '').trim()
  return name && !isTailscaleDnsSafeName(name) ? '名称含空格或 / ? # @ : 等字符，MagicDNS 无法使用此节点解析 *.ts.net。' : null
})

/** The form protocol, or null when the config needs the text view. */
function formSpecOf(current: Record<string, unknown>): ProtocolSpec | null {
  const spec = protocolOf(current)
  if (spec?.id === 'wireguard' && Array.isArray(current.peers)) return null
  return spec
}

function load(next: Record<string, unknown>, spec: ProtocolSpec | null): void {
  config.value = next
  protocol.value = spec
  drafts.value = {}
}

watch(
  () => [props.open, props.node, props.start] as const,
  ([open]) => {
    if (!open) return
    error.value = null
    notice.value = null
    groups.value = [...(props.node?.groups ?? [])]
    tailnetRules.value = props.node?.tailnetRules ?? true
    if (props.node?.config) {
      const current = plainClone(props.node.config) as Record<string, unknown>
      const spec = formSpecOf(current)
      load(current, spec)
      text.value = configToYaml(current)
      mode.value = props.start.mode === 'text' || !spec ? 'text' : 'form'
      if (!spec) notice.value = Array.isArray(current.peers) ? '多 Peer 的 WireGuard 配置请直接编辑内容。' : `${String(current.type)} 协议没有表单，请直接编辑内容。`
    } else {
      const spec = protocolById(props.start.mode === 'form' ? props.start.protocol : 'ss') ?? PROTOCOLS[0]!
      load(newConfig(spec), spec)
      text.value = ''
      mode.value = props.start.mode
    }
  },
  { immediate: true }
)

// ---------------------------------------------------------------- form

function draftKey(field: FieldSpec): string {
  return `${field.key}|${field.label}`
}

function inputValue(field: FieldSpec): string {
  return drafts.value[draftKey(field)] ?? fieldText(field, config.value)
}

function onInput(field: FieldSpec, value: string): void {
  drafts.value = { ...drafts.value, [draftKey(field)]: value }
  error.value = null
  try {
    applyField(field, config.value, value)
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}

function onBool(field: FieldSpec): void {
  if (field.key === '$tailnetRules') {
    tailnetRules.value = !tailnetRules.value
    return
  }
  applyField(field, config.value, !fieldBool(field, config.value))
  drafts.value = { ...drafts.value }
}

function boolValue(field: FieldSpec): boolean {
  return field.key === '$tailnetRules' ? tailnetRules.value : fieldBool(field, config.value)
}

function onSelect(field: FieldSpec, value: string): void {
  applyField(field, config.value, value)
  drafts.value = { ...drafts.value }
}

function setName(value: string): void {
  config.value.name = value
  drafts.value = { ...drafts.value }
}

function setServer(value: string): void {
  if (value.trim()) config.value.server = value
  else delete config.value.server
  drafts.value = { ...drafts.value }
}

const portText = ref<string | null>(null)
function setPort(value: string): void {
  portText.value = value
  const trimmed = value.trim()
  if (!trimmed) delete config.value.port
  else config.value.port = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
}

function changeProtocol(id: string): void {
  const spec = protocolById(id)
  if (!spec || spec.id === protocol.value?.id) return
  load(switchProtocol(config.value, spec), spec)
  portText.value = null
  error.value = null
}

// ---------------------------------------------------------------- text

function showText(): void {
  if (mode.value === 'text') return
  error.value = null
  text.value = configToYaml(config.value)
  mode.value = 'text'
}

function showForm(): void {
  if (mode.value === 'form') return
  error.value = null
  if (!text.value.trim() && isNew.value) {
    mode.value = 'form'
    return
  }
  try {
    const { configs } = parseNodeText(text.value, '', { allowEmptyName: true })
    if (configs.length !== 1) throw new Error('内容里有多个节点，请直接保存，或只保留一个再切换到表单')
    const spec = formSpecOf(configs[0]!)
    if (!spec) throw new Error(`${configs[0]!.type} 的这份配置没有表单，请直接编辑内容`)
    load(configs[0]!, spec)
    portText.value = null
    mode.value = 'form'
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}

const fileInput = ref<HTMLInputElement | null>(null)

/** Loads a WireGuard .conf, Surge lines or mihomo YAML from a file. */
async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = null
  notice.value = null
  try {
    const content = await file.text()
    const { configs, warnings } = parseNodeText(content, nameFromFileName(file.name))
    const spec = configs.length === 1 ? formSpecOf(configs[0]!) : null
    if (spec) {
      load(configs[0]!, spec)
      portText.value = null
      mode.value = 'form'
    } else {
      text.value = configs.length === 1 ? configToYaml(configs[0]!) : content
      mode.value = 'text'
    }
    notice.value = warnings.length ? warnings.join('；') : `已导入「${file.name}」`
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}

// ---------------------------------------------------------------- save

function assertFreeName(config: ProxyConfig): void {
  if (props.takenNames.includes(config.name)) throw new Error(`已有名为「${config.name}」的本地节点`)
}

function submit(): void {
  error.value = null
  try {
    if (mode.value === 'text') {
      const { configs, warnings } = parseNodeText(text.value)
      if (configs.length > 1) {
        if (!isNew.value) throw new Error('编辑已有节点时只能包含一个节点')
        const seen = new Set<string>()
        for (const item of configs) {
          assertFreeName(item)
          if (seen.has(item.name)) throw new Error(`内容里有两个节点都叫「${item.name}」`)
          seen.add(item.name)
        }
        emit('saveMany', configs.map((item) => ({ id: '', enabled: true, config: item, groups: [...groups.value], tailnetRules: true })))
        return
      }
      const single = configs[0]!
      const spec = formSpecOf(single)
      const checked = spec ? validateConfig(spec, single, [...spec.sections, ...commonSections(spec, dialerOptions.value)]) : single
      assertFreeName(checked)
      if (warnings.length) notice.value = warnings.join('；')
      emitSave(checked)
      return
    }
    if (!protocol.value) throw new Error('请选择协议')
    const checked = validateConfig(protocol.value, config.value, allSections.value)
    assertFreeName(checked)
    emitSave(checked)
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
}

function emitSave(next: ProxyConfig): void {
  emit('save', { id: props.node?.id ?? '', enabled: props.node?.enabled ?? true, config: plainClone(next), groups: groups.value, tailnetRules: tailnetRules.value })
}

function toggleGroup(name: string): void {
  groups.value = groups.value.includes(name) ? groups.value.filter((item) => item !== name) : [...groups.value, name]
}

const TEXT_PLACEHOLDER = `支持以下任一种内容，可以一次粘贴多个节点：
· mihomo YAML（单个节点、列表或带 proxies: 的片段）
· 分享链接：ss:// vmess:// vless:// trojan:// hysteria2:// tuic:// anytls://
· Surge 代理行：香港 = snell, 1.2.3.4, 443, psk=xxx, version=3
· WireGuard 配置（wg-quick .conf 或 Surge [WireGuard] 段落）`
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-shade node-modal-shade" role="presentation" @click.self="!busy && emit('close')">
      <section ref="dialog" class="node-modal" role="dialog" aria-modal="true" :aria-label="title">
        <header class="node-modal-head">
          <h2>{{ title }}</h2>
          <div class="node-mode" role="tablist" aria-label="编辑方式">
            <button type="button" role="tab" :aria-selected="mode === 'form'" :class="{ on: mode === 'form' }" @click="showForm">表单</button>
            <button type="button" role="tab" :aria-selected="mode === 'text'" :class="{ on: mode === 'text' }" @click="showText">文本</button>
          </div>
        </header>

        <form id="node-editor-form" class="node-modal-body" @submit.prevent="submit">
          <div v-if="mode === 'form' && protocol" class="nf-columns">
            <div class="nf-column">
              <section class="nf-section">
                <h3>基本信息</h3>
                <div class="nf-card">
                  <label class="nf-row"><span class="nf-label">名称</span><input class="nf-input" :value="String(config.name ?? '')" type="text" spellcheck="false" placeholder="必填" @input="setName(($event.target as HTMLInputElement).value)" /></label>
                  <div class="nf-row"><span class="nf-label">协议</span><span class="nf-control"><AppSelect :model-value="protocol.id" :options="protocolOptions" label="协议" @update:model-value="changeProtocol" /></span></div>
                </div>
              </section>
              <section v-if="protocol.endpoint" class="nf-section">
                <h3>服务器信息</h3>
                <div class="nf-card">
                  <div class="nf-row">
                    <span class="nf-label">服务器地址</span>
                    <span class="nf-endpoint">
                      <input class="nf-input" :value="String(config.server ?? '')" type="text" spellcheck="false" placeholder="地址" aria-label="服务器地址" @input="setServer(($event.target as HTMLInputElement).value)" />
                      <i>:</i>
                      <input class="nf-input nf-port" :value="portText ?? (config.port === undefined ? '' : String(config.port))" type="text" inputmode="numeric" placeholder="端口" aria-label="端口" @input="setPort(($event.target as HTMLInputElement).value)" />
                    </span>
                  </div>
                </div>
              </section>
              <section v-for="section in shown.left" :key="section.title" class="nf-section">
                <h3>{{ section.title }}</h3>
                <div class="nf-card">
                  <template v-for="field in section.fields" :key="draftKey(field)">
                    <div class="nf-row" :class="{ tall: field.kind === 'kv' || field.kind === 'multiline' }">
                      <span class="nf-label">{{ field.label }}<small v-if="field.hint">{{ field.hint }}</small></span>
                      <button v-if="field.kind === 'bool'" type="button" class="switch" :class="{ on: boolValue(field) }" role="switch" :aria-checked="boolValue(field)" :aria-label="field.label" @click="onBool(field)" />
                      <span v-else-if="field.kind === 'select'" class="nf-control"><AppSelect :model-value="fieldSelectValue(field, config)" :options="field.options ?? []" :label="field.label" @update:model-value="(value: string) => onSelect(field, value)" /></span>
                      <textarea v-else-if="field.kind === 'kv' || field.kind === 'multiline'" class="nf-input nf-area" :value="inputValue(field)" spellcheck="false" :placeholder="field.placeholder" :aria-label="field.label" rows="3" @input="onInput(field, ($event.target as HTMLTextAreaElement).value)" />
                      <input v-else class="nf-input" :value="inputValue(field)" :type="field.kind === 'secret' ? 'password' : 'text'" :inputmode="field.kind === 'number' ? 'numeric' : undefined" spellcheck="false" autocomplete="off" :placeholder="field.placeholder" :aria-label="field.label" @input="onInput(field, ($event.target as HTMLInputElement).value)" />
                    </div>
                  </template>
                </div>
              </section>
              <p v-if="tsNameWarning" class="nf-warning">{{ tsNameWarning }}</p>
            </div>

            <div class="nf-column">
              <section v-for="section in shown.right" :key="section.title" class="nf-section">
                <h3>{{ section.title }}</h3>
                <div class="nf-card">
                  <template v-for="field in section.fields" :key="draftKey(field)">
                    <div class="nf-row">
                      <span class="nf-label">{{ field.label }}<small v-if="field.hint">{{ field.hint }}</small></span>
                      <button v-if="field.kind === 'bool'" type="button" class="switch" :class="{ on: boolValue(field) }" role="switch" :aria-checked="boolValue(field)" :aria-label="field.label" @click="onBool(field)" />
                      <span v-else-if="field.kind === 'select'" class="nf-control"><AppSelect :model-value="fieldSelectValue(field, config)" :options="field.options ?? []" :label="field.label" @update:model-value="(value: string) => onSelect(field, value)" /></span>
                      <input v-else class="nf-input" :value="inputValue(field)" type="text" :inputmode="field.kind === 'number' ? 'numeric' : undefined" spellcheck="false" autocomplete="off" :placeholder="field.placeholder" :aria-label="field.label" @input="onInput(field, ($event.target as HTMLInputElement).value)" />
                    </div>
                  </template>
                </div>
              </section>
              <section class="nf-section">
                <h3>加入策略组</h3>
                <div v-if="props.groups.length" class="nf-card nf-groups">
                  <label v-for="group in props.groups" :key="group.name" class="surge-check"><input type="checkbox" :checked="groups.includes(group.name)" @change="toggleGroup(group.name)" />{{ group.name }}</label>
                </div>
                <p v-else class="nf-hint">启动内核或选择订阅后可以选择策略组。</p>
              </section>
            </div>
          </div>

          <div v-else class="nf-text">
            <textarea v-model="text" class="nf-input nf-text-area" spellcheck="false" :placeholder="TEXT_PLACEHOLDER" aria-label="节点内容" />
            <p class="nf-hint">mihomo 的 proxies 格式支持内核的全部协议和参数。<template v-if="isNew">粘贴多个节点会一次全部添加，并加入下面勾选的策略组。</template></p>
            <div v-if="props.groups.length" class="nf-card nf-groups">
              <label v-for="group in props.groups" :key="group.name" class="surge-check"><input type="checkbox" :checked="groups.includes(group.name)" @change="toggleGroup(group.name)" />{{ group.name }}</label>
            </div>
          </div>
        </form>

        <footer class="node-modal-foot">
          <template v-if="isNew">
            <button type="button" class="surge-button" :disabled="busy" @click="fileInput?.click()">从文件导入…</button>
            <input ref="fileInput" type="file" accept=".conf,.txt,.yaml,.yml,text/plain" hidden @change="importFile" />
          </template>
          <p v-if="error" class="nf-error" role="alert">{{ error }}</p>
          <p v-else-if="notice" class="nf-hint">{{ notice }}</p>
          <span class="spacer" />
          <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">取消</button>
          <button type="submit" form="node-editor-form" class="surge-button primary" :disabled="busy">{{ busy ? '保存中…' : '完成' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.node-modal-shade { z-index: 72; }
.node-modal { display: flex; flex-direction: column; width: min(920px, calc(100vw - 40px)); height: min(720px, calc(100vh - 48px)); overflow: hidden; border: 1px solid var(--glass-edge); border-radius: 14px; color: var(--app-text); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); box-shadow: var(--glass-shadow); }
.node-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px 14px; border-bottom: 1px solid var(--app-divider); }
.node-modal-head h2 { margin: 0; font-size: var(--font-size-title); }
.node-mode { display: inline-flex; padding: 2px; border-radius: var(--radius-control); background: var(--app-fill); }
.node-mode button { min-width: 56px; height: 24px; padding: 0 12px; border: 0; border-radius: calc(var(--radius-control) - 2px); background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); }
.node-mode button.on { color: var(--app-text); background: var(--app-surface-solid); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
.node-modal-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 16px 20px; }
.nf-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; align-items: start; }
.nf-column { display: grid; gap: 16px; min-width: 0; }
.nf-section h3 { margin: 0 0 6px 8px; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.nf-card { display: grid; padding: 0 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.nf-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); align-items: center; gap: 12px; min-height: 40px; padding: 6px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.nf-row:first-child { border-top: 0; }
.nf-row.tall { align-items: start; }
.nf-row:has(> .switch) { grid-template-columns: minmax(0, 1fr) auto; }
.nf-label { display: grid; gap: 2px; min-width: 0; }
.nf-label small { color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.4; }
.nf-control { min-width: 0; }
.nf-control :deep(.app-select) { min-width: 0; }
.nf-control :deep(.app-select-trigger) { min-height: 28px; }
.nf-input { width: 100%; min-width: 0; height: 28px; padding: 0 9px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: color-mix(in srgb, var(--app-surface-solid) 70%, var(--app-bg)); color: var(--app-text); font-size: var(--font-size-sm); }
.nf-input::placeholder { color: var(--app-faint); }
.nf-input:focus { outline: none; border-color: var(--app-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-blue) 22%, transparent); }
.nf-area { height: auto; min-height: 64px; padding: 6px 9px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.nf-endpoint { display: grid; grid-template-columns: minmax(0, 1fr) auto 74px; align-items: center; gap: 6px; }
.nf-endpoint i { color: var(--app-muted); font-style: normal; }
.nf-groups { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 11px 14px; font-size: var(--font-size-sm); }
.nf-text { display: grid; gap: 10px; height: 100%; grid-template-rows: minmax(220px, 1fr) auto auto; }
.nf-text-area { height: 100%; min-height: 220px; padding: 12px 14px; font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; resize: none; }
.nf-hint { margin: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.nf-warning { margin: 0 6px; color: var(--app-warning, #d97706); font-size: var(--font-size-xs); line-height: 1.5; }
.nf-error { margin: 0; color: var(--app-danger); font-size: var(--font-size-xs); line-height: 1.5; }
.node-modal-foot { display: flex; align-items: center; gap: var(--space-3); padding: 12px 20px; border-top: 1px solid var(--app-divider); }
.node-modal-foot p { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.node-modal-foot .spacer { flex: 1; }
@media (max-width: 760px) {
  .nf-columns { grid-template-columns: minmax(0, 1fr); gap: 16px; }
}
</style>
