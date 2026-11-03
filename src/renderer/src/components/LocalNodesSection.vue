<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocalStore } from '../stores/local'
import { useToast } from '../composables/use-toast'
import LocalNodeDrawer from './LocalNodeDrawer.vue'
import ConfirmModal from './ConfirmModal.vue'
import SurfaceCard from './SurfaceCard.vue'
import { nodeSummary, type NodeEditorKind } from '../lib/local-node-form'
import { nameFromFileName, parseWireGuardText } from '@shared/wireguard-conf'
import { plainClone, type LocalNode } from '@shared/local'

const emit = defineEmits<{ changed: [] }>()
const local = useLocalStore()
const toast = useToast()

const editing = ref<LocalNode | null>(null)
const editorKind = ref<NodeEditorKind>('wireguard')
const editorOpen = ref(false)
const removing = ref<LocalNode | null>(null)
const menuOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const nodes = computed(() => local.settings.nodes)
const skipped = computed(() => new Set(local.state.skippedNodes))
const takenNames = computed(() => nodes.value.filter((node) => node.id !== editing.value?.id).map((node) => node.config.name))
const ts = computed(() => local.state.tailscale)

const TYPE_LABELS: Record<string, string> = { wireguard: 'WireGuard', tailscale: 'Tailscale' }
const typeLabel = (node: LocalNode): string => TYPE_LABELS[String(node.config.type).toLowerCase()] ?? String(node.config.type)

function openEditor(kind: NodeEditorKind, node: LocalNode | null = null): void {
  menuOpen.value = false
  editorKind.value = kind
  editing.value = node ? plainClone(node) : null
  editorOpen.value = true
}

function edit(node: LocalNode): void {
  const type = String(node.config.type).toLowerCase()
  openEditor(type === 'tailscale' ? 'tailscale' : type === 'wireguard' ? 'wireguard' : 'yaml', node)
}

async function finish(message: string | null, success: string): Promise<boolean> {
  if (message) {
    toast.error('保存失败', message)
    return false
  }
  toast.success(success)
  emit('changed')
  return true
}

async function save(node: LocalNode): Promise<void> {
  const ok = await finish(await local.upsertNode(node), node.id ? '已保存' : `已添加「${node.config.name}」`)
  if (ok) editorOpen.value = false
}

async function saveMany(list: LocalNode[]): Promise<void> {
  const ok = await finish(await local.addNodes(list), `已添加 ${list.length} 个节点`)
  if (ok) editorOpen.value = false
}

async function toggle(node: LocalNode): Promise<void> {
  await finish(await local.setNodeEnabled(node.id, !node.enabled), node.enabled ? '已停用' : '已启用')
}

async function confirmRemove(): Promise<void> {
  const node = removing.value
  if (!node) return
  if (await finish(await local.removeNode(node.id), '已删除')) removing.value = null
}

function pickFile(): void {
  menuOpen.value = false
  fileInput.value?.click()
}

async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 256 * 1024) {
    toast.error('导入失败', '文件过大，WireGuard 配置通常只有几百字节')
    return
  }
  try {
    const result = parseWireGuardText(await file.text(), nameFromFileName(file.name))
    let name = result.config.name
    for (let i = 2; nodes.value.some((node) => node.config.name === name); i++) name = `${result.config.name} ${i}`
    openEditor('wireguard', { id: '', enabled: true, config: { ...result.config, name }, groups: [], tailnetRules: true })
    if (result.warnings.length) toast.info('已读取配置，请检查后保存', result.warnings.join('；'))
  } catch (error) {
    toast.error('导入失败', error instanceof Error ? error.message : String(error))
  }
}

async function setCoexist(): Promise<void> {
  await finish(await local.setTailscaleCoexist(!local.settings.tailscaleCoexist), local.settings.tailscaleCoexist ? '已关闭' : '已开启')
}

onMounted(() => {
  void local.refresh()
})
</script>

<template>
  <section class="local-nodes">
    <div class="section-caption local-nodes-caption">
      <span>本地节点</span>
      <div class="local-add">
        <button type="button" class="surge-button compact" :disabled="local.busy" aria-haspopup="menu" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">添加…</button>
        <div v-if="menuOpen" class="local-add-menu" role="menu" @keydown.escape="menuOpen = false">
          <button type="button" role="menuitem" @click="openEditor('wireguard')">WireGuard</button>
          <button type="button" role="menuitem" @click="pickFile">导入 WireGuard 配置文件…</button>
          <button type="button" role="menuitem" @click="openEditor('tailscale')">Tailscale</button>
          <button type="button" role="menuitem" @click="openEditor('yaml')">粘贴节点（mihomo YAML）</button>
        </div>
        <button v-if="menuOpen" type="button" class="local-add-shade" aria-label="关闭菜单" @click="menuOpen = false" />
      </div>
      <input ref="fileInput" type="file" accept=".conf,.txt,text/plain" hidden @change="importFile" />
    </div>

    <SurfaceCard v-if="ts.detected" class="local-ts-card">
      <div class="local-ts-text">
        <strong>检测到 Tailscale 客户端</strong>
        <small v-if="local.settings.tailscaleCoexist">tailnet 地址（100.64.0.0/10）和 *.ts.net 交给网卡「{{ ts.interface }}」处理，增强模式不会截走它们。</small>
        <small v-else>已关闭共存：开启增强模式后，tailnet 和 MagicDNS 可能无法访问。</small>
      </div>
      <button type="button" class="switch" :class="{ on: local.settings.tailscaleCoexist }" role="switch" :aria-checked="local.settings.tailscaleCoexist" aria-label="与 Tailscale 客户端共存" :disabled="local.busy" @click="setCoexist" />
    </SurfaceCard>

    <SurfaceCard v-if="nodes.length" class="local-list">
      <div v-for="node in nodes" :key="node.id" class="local-row" :class="{ off: !node.enabled }">
        <div class="local-row-text">
          <strong>{{ node.config.name }}<i>{{ typeLabel(node) }}</i></strong>
          <small>{{ nodeSummary(node.config) }}<template v-if="node.groups.length"> · 加入 {{ node.groups.join('、') }}</template></small>
          <small v-if="node.enabled && skipped.has(node.id)" class="local-row-error">与订阅中的节点或策略组重名，当前未生效</small>
        </div>
        <div class="local-row-actions">
          <button type="button" class="surge-button compact" :disabled="local.busy" @click="edit(node)">编辑</button>
          <button type="button" class="surge-button compact danger" :disabled="local.busy" @click="removing = node">删除</button>
          <button type="button" class="switch" :class="{ on: node.enabled }" role="switch" :aria-checked="node.enabled" :aria-label="`启用 ${node.config.name}`" :disabled="local.busy" @click="toggle(node)" />
        </div>
      </div>
    </SurfaceCard>
    <p v-else class="surge-hint local-empty">本地节点保存在订阅之外，更新或切换订阅都不会丢失。可以添加 WireGuard、Tailscale，或粘贴任意 mihomo 节点，并把它们加入现有的策略组。</p>

    <LocalNodeDrawer
      :open="editorOpen"
      :node="editing"
      :kind="editorKind"
      :groups="local.state.groups"
      :targets="local.state.targets"
      :taken-names="takenNames"
      :busy="local.busy"
      :error="null"
      @close="editorOpen = false"
      @save="save"
      @save-many="saveMany"
    />
    <ConfirmModal :open="!!removing" title="删除本地节点" :description="`删除「${removing?.config.name ?? ''}」？引用它的本地规则会自动跳过。`" :busy="local.busy" @close="removing = null" @confirm="confirmRemove" />
  </section>
</template>

<style scoped>
.local-nodes { margin-top: 34px; }
.local-nodes-caption { display: flex; align-items: center; justify-content: space-between; }
.local-add { position: relative; }
.local-add-menu { position: absolute; z-index: 30; top: calc(100% + 5px); right: 0; display: grid; min-width: 210px; padding: 5px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter); box-shadow: 0 12px 36px rgba(0, 0, 0, 0.2); }
.local-add-menu button { padding: 7px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--app-text); font-size: var(--font-size-sm); text-align: left; cursor: pointer; }
.local-add-menu button:hover { color: var(--app-on-accent); background: var(--app-blue); }
.local-add-shade { position: fixed; z-index: 29; inset: 0; border: 0; background: transparent; }
.local-ts-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; padding: 12px 16px; border-radius: var(--radius-panel); }
.local-ts-text { display: grid; gap: 3px; }
.local-ts-text strong { font-size: var(--font-size-sm); }
.local-ts-text small { color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.local-list { display: grid; border-radius: var(--radius-panel); }
.local-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 16px; border-top: 1px solid var(--app-divider); }
.local-row:first-child { border-top: 0; }
.local-row.off .local-row-text { opacity: 0.55; }
.local-row-text { display: grid; gap: 3px; min-width: 0; }
.local-row-text strong { display: flex; align-items: center; gap: 8px; overflow: hidden; font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.local-row-text strong i { padding: 1px 6px; border-radius: var(--radius-sm); background: rgba(127, 127, 127, 0.16); color: var(--app-muted); font-size: var(--font-size-2xs); font-style: normal; font-weight: var(--font-weight-regular); }
.local-row-text small { overflow: hidden; color: var(--app-muted); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.local-row-text small.local-row-error { color: var(--app-danger); }
.local-row-actions { display: flex; flex: none; align-items: center; gap: var(--space-3); }
.local-empty { padding: 2px 4px; }
</style>
