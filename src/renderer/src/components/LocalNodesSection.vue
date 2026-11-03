<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocalStore } from '../stores/local'
import { useToast } from '../composables/use-toast'
import { useKernelStore } from '../stores/kernel'
import { useConnectionsStore } from '../stores/connections'
import NodeEditorModal from './NodeEditorModal.vue'
import ConfirmModal from './ConfirmModal.vue'
import SurfaceCard from './SurfaceCard.vue'
import PopoverMenu from './PopoverMenu.vue'
import { latencyLabel, latencyTitle } from '../lib/node-latency'
import { formatBytes, formatRate } from '../lib/format'
import { nodeSummary, type NodeEditorStart } from '../lib/local-node-form'
import { nodeInfoSections } from '../lib/local-node-info'
import { plainClone, type LocalNode } from '@shared/local'

const emit = defineEmits<{ changed: [] }>()
const local = useLocalStore()
const kernel = useKernelStore()
const connections = useConnectionsStore()
const toast = useToast()

const editing = ref<LocalNode | null>(null)
const editorStart = ref<NodeEditorStart>({ mode: 'form', protocol: 'ss' })
const editorOpen = ref(false)
const removing = ref<LocalNode | null>(null)
const contextNode = ref<LocalNode | null>(null)
const contextAt = ref({ x: 0, y: 0 })

const nodes = computed(() => local.settings.nodes)
const skipped = computed(() => new Set(local.state.skippedNodes))
const takenNames = computed(() => nodes.value.filter((node) => node.id !== editing.value?.id).map((node) => node.config.name))
const ts = computed(() => local.state.tailscale)

const running = computed(() => kernel.status.phase === 'running')

const TYPE_LABELS: Record<string, string> = {
  wireguard: 'WireGuard',
  tailscale: 'Tailscale',
  ss: 'Shadowsocks',
  ssr: 'ShadowsocksR',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  hysteria: 'Hysteria',
  hysteria2: 'Hysteria 2',
  tuic: 'TUIC',
  snell: 'Snell',
  anytls: 'AnyTLS',
  socks5: 'SOCKS5',
  http: 'HTTP',
  ssh: 'SSH',
  mieru: 'Mieru'
}
const typeLabel = (node: LocalNode): string => TYPE_LABELS[String(node.config.type).toLowerCase()] ?? String(node.config.type)
const isTailscale = (node: LocalNode): boolean => String(node.config.type).toLowerCase() === 'tailscale'

/** What the bottom line of a card says: latency, or why it is not running. */
function cardStatus(node: LocalNode): { text: string; kind: string; title: string } {
  if (!node.enabled) return { text: '已停用', kind: 'idle', title: '右键启用' }
  if (skipped.value.has(node.id)) return { text: '重名，未生效', kind: 'timeout', title: '与订阅中的节点或策略组重名' }
  if (!running.value) return { text: '内核未运行', kind: 'idle', title: '启动内核后可以测试延迟' }
  const state = local.delayOf(node.config.name)
  return { ...latencyLabel(state, false, '点击测试'), title: latencyTitle(state, false) }
}

const canTest = (node: LocalNode): boolean => running.value && node.enabled && !skipped.value.has(node.id) && local.delayOf(node.config.name).status !== 'testing'

function test(node: LocalNode): void {
  if (canTest(node)) void local.testNode(node.config.name)
}

const contextStats = computed(() => {
  const node = contextNode.value
  if (!node) return null
  const stats = connections.entityStats('node', node.config.name)
  if (!stats) return null
  const start = stats.windows.find((window) => window.key === 'start')
  const up = start?.up ?? 0
  const down = start?.down ?? 0
  return { total: formatBytes(up + down), up: formatBytes(up), down: formatBytes(down), peakUp: formatRate(stats.peak.up), peakDown: formatRate(stats.peak.down) }
})

const contextDelay = computed(() => {
  const node = contextNode.value
  if (!node) return null
  const state = local.delayOf(node.config.name)
  return state.status === 'ok' ? `${state.delay} ms` : null
})

const contextInfo = computed(() => {
  const node = contextNode.value
  if (!node) return []
  const kind = String(node.config.type).toLowerCase()
  if (kind !== 'tailscale' && kind !== 'wireguard') return []
  const status = !node.enabled ? '已停用' : skipped.value.has(node.id) ? '重名，未生效' : running.value ? '运行中' : '内核未运行'
  return nodeInfoSections(node.config as Record<string, unknown>, { status, connections: connections.snapshot?.connections ?? [] })
})

function openContext(event: MouseEvent, node: LocalNode): void {
  contextNode.value = node
  contextAt.value = { x: event.clientX, y: event.clientY }
}

async function duplicate(node: LocalNode): Promise<void> {
  await finish(await local.duplicateNode(node.id), '已创建副本')
}

function openEditor(start: NodeEditorStart, node: LocalNode | null = null): void {
  editorStart.value = start
  editing.value = node ? plainClone(node) : null
  editorOpen.value = true
}

function edit(node: LocalNode): void {
  openEditor({ mode: 'form', protocol: '' }, node)
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
      <button v-if="nodes.length" type="button" class="local-test-all" :disabled="!running" @click="local.testAll()">测试全部</button>
    </div>

    <SurfaceCard v-if="ts.detected" class="local-ts-card">
      <div class="local-ts-text">
        <strong>检测到 Tailscale 客户端</strong>
        <small v-if="local.settings.tailscaleCoexist">tailnet 地址（100.64.0.0/10）和 *.ts.net 交给网卡「{{ ts.interface }}」处理，增强模式不会截走它们。</small>
        <small v-else>已关闭共存：开启增强模式后，tailnet 和 MagicDNS 可能无法访问。</small>
      </div>
      <button type="button" class="switch" :class="{ on: local.settings.tailscaleCoexist }" role="switch" :aria-checked="local.settings.tailscaleCoexist" aria-label="与 Tailscale 客户端共存" :disabled="local.busy" @click="setCoexist" />
    </SurfaceCard>

    <div class="local-grid">
      <div
        v-for="node in nodes"
        :key="node.id"
        class="local-card"
        :class="{ off: !node.enabled, broken: node.enabled && skipped.has(node.id), menu: contextNode?.id === node.id }"
        @contextmenu.prevent="openContext($event, node)"
      >
        <button type="button" class="local-card-main" :title="`${node.config.name} · ${nodeSummary(node.config)}`" :aria-label="`编辑 ${node.config.name}`" @click="edit(node)">
          <small>{{ typeLabel(node) }}</small>
          <strong>{{ node.config.name }}</strong>
        </button>
        <button type="button" class="local-card-delay" :class="cardStatus(node).kind" :title="cardStatus(node).title" :disabled="!canTest(node)" @click="test(node)">{{ cardStatus(node).text }}</button>
      </div>
      <button type="button" class="local-card local-card-add" :disabled="local.busy" aria-label="添加本地节点" title="添加本地节点" @click="openEditor({ mode: 'form', protocol: 'ss' })">
        <span aria-hidden="true">+</span>
      </button>
    </div>
    <p v-if="!nodes.length" class="surge-hint local-empty">本地节点保存在订阅之外，更新或切换订阅都不会丢失。可以添加 WireGuard、Tailscale，或粘贴任意 mihomo 节点，并把它们加入现有的策略组。</p>

    <PopoverMenu :open="!!contextNode" :x="contextAt.x" :y="contextAt.y" :label="contextNode?.config.name" @close="contextNode = null">
      <template v-if="contextNode">
        <div class="context-head" @click.stop>
          <div class="context-title">
            <strong>{{ contextNode.config.name }}</strong>
            <span v-if="contextDelay" class="context-rtt">RTT {{ contextDelay }}</span>
          </div>
          <small>{{ typeLabel(contextNode) }} · {{ nodeSummary(contextNode.config) }}</small>
          <div v-if="contextStats" class="context-stats">
            <span><small>总计</small><b>{{ contextStats.total }}</b></span>
            <span><small>上传</small><b>{{ contextStats.up }}</b></span>
            <span><small>下载</small><b>{{ contextStats.down }}</b></span>
            <small class="context-peak-label">最高速度</small>
            <small>↑ {{ contextStats.peakUp.value }} {{ contextStats.peakUp.unit }}</small>
            <small>↓ {{ contextStats.peakDown.value }} {{ contextStats.peakDown.unit }}</small>
          </div>
          <small v-else class="context-none">启动以来还没有经过这个节点的流量</small>
          <dl v-for="section in contextInfo" :key="section.title" class="context-info">
            <dt>{{ section.title }}</dt>
            <div v-for="row in section.rows" :key="row.label"><span>{{ row.label }}</span><b :title="row.value">{{ row.value }}</b></div>
          </dl>
        </div>
        <div class="popover-sep" />
        <button type="button" class="popover-item" role="menuitem" :disabled="local.busy" @click="edit(contextNode)">编辑节点…</button>
        <button type="button" class="popover-item" role="menuitem" :disabled="local.busy" @click="duplicate(contextNode)">创建副本</button>
        <button type="button" class="popover-item" role="menuitem" :disabled="local.busy" @click="toggle(contextNode)">{{ contextNode.enabled ? '停用' : '启用' }}</button>
        <button type="button" class="popover-item danger" role="menuitem" :disabled="local.busy" @click="removing = contextNode">删除节点…</button>
        <div class="popover-sep" />
        <button type="button" class="popover-item" role="menuitem" :disabled="!canTest(contextNode)" @click="test(contextNode)">测试延迟</button>
      </template>
    </PopoverMenu>

    <NodeEditorModal
      :open="editorOpen"
      :node="editing"
      :start="editorStart"
      :groups="local.state.groups"
      :targets="local.state.targets"
      :taken-names="takenNames"
      :busy="local.busy"
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
.local-test-all { height: 22px; padding: 0 10px; border: 0; border-radius: 999px; background: var(--app-fill); color: var(--app-muted); font-size: var(--font-size-xs); }
.local-test-all:disabled { opacity: 0.5; }
.local-ts-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; padding: 12px 16px; border-radius: var(--radius-panel); }
.local-ts-text { display: grid; gap: 3px; }
.local-ts-text strong { font-size: var(--font-size-sm); }
.local-ts-text small { color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.local-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: var(--space-4); width: 100%; }
.local-card { display: flex; flex-direction: column; min-width: 0; height: 86px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-md); background: var(--app-surface); color: inherit; }
.local-card:hover, .local-card.menu { border-color: color-mix(in srgb, var(--app-blue) 48%, var(--app-divider)); background: color-mix(in srgb, var(--app-blue) 7%, var(--app-surface)); }
.local-card.off .local-card-main { opacity: 0.5; }
.local-card-main, .local-card-delay { min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; }
.local-card-main { display: flex; flex: 1; flex-direction: column; align-items: stretch; cursor: default; }
.local-card-main small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.local-card-main strong { display: -webkit-box; overflow: hidden; margin-top: 2px; font-size: var(--font-size-sm); line-height: 1.35; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.local-card-delay { align-self: flex-start; color: var(--app-latency-good); font-size: var(--font-size-2xs); font-weight: var(--font-weight-semibold, 600); }
.local-card-delay:disabled { cursor: default; opacity: 1; }
.local-card-delay.testing { color: var(--app-muted); }
.local-card-delay.timeout { color: var(--app-danger); }
.local-card-delay.idle { color: var(--app-faint); font-weight: var(--font-weight-regular); }
.local-card-add { align-items: center; justify-content: center; border: 1px dashed var(--app-divider); background: transparent; color: var(--app-muted); font-size: 22px; font-weight: 300; }
.local-card-add:disabled { opacity: 0.5; }
.local-empty { margin-top: 10px; padding: 2px 4px; }
.context-head { display: grid; gap: 4px; padding: 8px 10px 6px; }
.context-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.context-title strong { overflow: hidden; font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.context-rtt { flex: none; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--app-latency-good) 18%, transparent); color: var(--app-latency-good); font-size: var(--font-size-2xs); font-weight: 600; }
.context-head > small { overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
.context-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px 14px; margin-top: 6px; }
.context-stats span { display: grid; gap: 1px; }
.context-stats small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.context-stats b { font-size: var(--font-size-body); font-weight: 600; font-variant-numeric: tabular-nums; }
.context-stats .context-peak-label { margin-top: 4px; }
.context-stats .context-peak-label ~ small { margin-top: 4px; font-variant-numeric: tabular-nums; }
.context-none { margin-top: 4px; }
.context-info { display: grid; gap: 2px; margin: 8px 0 0; }
.context-info dt { color: var(--app-muted); font-size: var(--font-size-2xs); font-weight: 600; }
.context-info div { display: flex; justify-content: space-between; gap: 14px; font-size: var(--font-size-xs); }
.context-info span { flex: none; color: var(--app-muted); }
.context-info b { overflow: hidden; font-weight: 500; text-align: right; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
