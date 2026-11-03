<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePoliciesStore, POLICY_MODE_OPTIONS, type PolicyMode } from '../stores/policies'
import { useKernelStore } from '../stores/kernel'
import { useLocalStore } from '../stores/local'
import { useConnectionsStore } from '../stores/connections'
import { useKernelManagerStore } from '../stores/kernel-manager'
import { formatBytes } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import CachedRemoteIcon from '../components/CachedRemoteIcon.vue'
import LocalNodesSection from '../components/LocalNodesSection.vue'
import GroupWizardModal from '../components/GroupWizardModal.vue'
import PopoverMenu from '../components/PopoverMenu.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { plainClone, type LocalGroup } from '@shared/local'
import { latencyLabel as nodeLatencyLabel, latencyTitle, type LatencyLabel } from '../lib/node-latency'

const policies = usePoliciesStore()
const kernel = useKernelStore()
// The node list lives in a drawer since the inline section was removed: the
// group card IS the entry point now.
const groupDrawerOpen = ref(false)

function openGroup(name: string): void {
  policies.selectGroup(name)
  groupDrawerOpen.value = true
}

const MODE_LABELS: Record<PolicyMode, string> = {
  direct: '直接连接',
  global: '全局代理',
  rule: '规则判定'
}

/** Kernel group/node types in Chinese; unknown types fall back to the raw one. */
const PROXY_TYPE_LABELS: Record<string, string> = {
  selector: '手动选择',
  urltest: '自动测试',
  fallback: '故障转移',
  loadbalance: '负载均衡',
  relay: '链式代理',
  direct: '直接连接',
  reject: '拒绝'
}

function displayType(proxyType: string | null | undefined): string {
  if (!proxyType) return '节点'
  return PROXY_TYPE_LABELS[proxyType.toLowerCase()] ?? proxyType
}

/** Group types the kernel nests inside a group (the mihomo group set). */
const NESTED_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])

/** True when a member is itself a (nested) policy group rather than a concrete node. */
function isNestedGroup(member: string): boolean {
  const proxy = policies.nodeByMember[member]
  return Boolean(proxy && NESTED_GROUP_TYPES.has(proxy.type))
}

/** Capability tags of a concrete node, in the clash-party/sparkle order. */
const CAPABILITY_TAGS = ['udp', 'xudp', 'tfo', 'mptcp', 'smux'] as const

/** The chips shown under a node name: protocol first, then its true capability flags. */
function nodeTags(member: string): string[] {
  const proxy = policies.nodeByMember[member]
  if (!proxy || isNestedGroup(member)) return []
  const tags: string[] = []
  if (proxy.type) tags.push(proxy.type)
  for (const flag of CAPABILITY_TAGS) {
    if ((proxy as unknown as Record<string, unknown>)[flag] === true) tags.push(flag)
  }
  return tags
}

function groupSummary(group: Parameters<typeof policies.groupSelectedMember>[0]): string {
  return policies.groupSelectedMember(group) || (policies.isSelectableGroup(group) ? '未选择' : '内核自动')
}

/**
 * A Tailscale node without an exit node only reaches the tailnet, so the
 * HTTP latency test through it always fails; that is not a broken node.
 */
function isTailscaleNode(name: string): boolean {
  return policies.nodeByMember[name]?.type === 'Tailscale'
}

const localStore = useLocalStore()
/** Local Tailscale nodes are tested by the local store (control server when there is no exit node). */
const localTailscale = computed(() => new Set(localStore.settings.nodes.filter((node) => String(node.config.type).toLowerCase() === 'tailscale').map((node) => node.config.name)))

function memberState(name: string) {
  return localTailscale.value.has(name) ? localStore.delayOf(name) : policies.nodeState(name)
}

function testMember(name: string): void {
  if (localTailscale.value.has(name)) void localStore.testNode(name)
  else void policies.testNode(name)
}

// ------------------------------------------------------- local policy groups
const toast = useToast()
const wizardOpen = ref(false)
const wizardGroup = ref<LocalGroup | null>(null)
const connections = useConnectionsStore()
/** The group card that was right-clicked (any group; `local` when created in the app). */
const groupMenu = ref<{ name: string; type: string; current: string; local: LocalGroup | null } | null>(null)
const groupMenuStats = computed(() => {
  const name = groupMenu.value?.name
  if (!name) return null
  let count = 0
  let up = 0
  let down = 0
  for (const connection of connections.snapshot?.connections ?? []) {
    if (!connection.chains.includes(name)) continue
    count++
    up += connection.upload
    down += connection.download
  }
  return { count, total: formatBytes(up + down), up: formatBytes(up), down: formatBytes(down) }
})
const groupMenuAt = ref({ x: 0, y: 0 })
const removingGroup = ref<LocalGroup | null>(null)
const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

const localGroupOf = (name: string): LocalGroup | null => localStore.settings.groups?.find((group) => group.config.name === name) ?? null
const wizardPolicies = computed(() => {
  const groupNames = new Set(localStore.state.groups.map((group) => group.name))
  const proxies = Object.keys(policies.proxies?.proxies ?? {}).filter((name) => !groupNames.has(name) && !BUILTIN_POLICIES.includes(name))
  const local = localStore.settings.nodes.filter((node) => node.enabled).map((node) => node.config.name)
  const managed = new Set(localStore.state.managedProxies)
  return [...new Set(['DIRECT', 'REJECT', ...localStore.state.groups.map((group) => group.name), ...local, ...proxies])].filter((name) => !managed.has(name))
})
const wizardGroups = computed(() => localStore.state.groups.filter((group) => !group.local).map((group) => group.name))
const wizardTaken = computed(() => {
  const own = wizardGroup.value?.config.name
  const names = [...Object.keys(policies.proxies?.proxies ?? {}), ...localStore.state.groups.map((group) => group.name), ...localStore.settings.nodes.map((node) => node.config.name), ...BUILTIN_POLICIES]
  return names.filter((name) => name !== own)
})

const kernelManager = useKernelManagerStore()

function addGroup(): void {
  void kernelManager.refresh()
  wizardGroup.value = null
  wizardOpen.value = true
}

function editGroup(group: LocalGroup): void {
  void kernelManager.refresh()
  wizardGroup.value = plainClone(group)
  wizardOpen.value = true
}

function onGroupContext(event: MouseEvent, group: (typeof policies.groups)[number]): void {
  event.preventDefault()
  groupMenu.value = { name: group.name, type: displayType(group.type), current: groupSummary(group), local: localGroupOf(group.name) }
  groupMenuAt.value = { x: event.clientX, y: event.clientY }
}

function testGroupFromMenu(name: string): void {
  openGroup(name)
  testGroup()
}

async function saveGroup(group: LocalGroup): Promise<void> {
  const message = await localStore.upsertGroup(group)
  if (message) {
    toast.error('保存失败', message)
    return
  }
  toast.success(group.id ? '已保存' : `已添加策略组「${group.config.name}」`)
  wizardOpen.value = false
  onLocalChanged()
}

async function confirmRemoveGroup(): Promise<void> {
  const group = removingGroup.value
  if (!group) return
  const message = await localStore.removeGroup(group.id)
  if (message) {
    toast.error('删除失败', message)
    return
  }
  removingGroup.value = null
  toast.success('已删除')
  onLocalChanged()
}

function testGroup(): void {
  for (const member of policies.groupMembers) if (localTailscale.value.has(member)) void localStore.testNode(member)
  void policies.testAll()
}

function latencyLabel(name: string): LatencyLabel {
  return nodeLatencyLabel(memberState(name), isTailscaleNode(name) && !localTailscale.value.has(name))
}

function isUnavailable(name: string): boolean {
  const proxy = policies.nodeByMember[name]
  return proxy ? proxy.alive === false : false
}

function delayTitle(name: string): string {
  return latencyTitle(memberState(name), isTailscaleNode(name) && !localTailscale.value.has(name))
}

const drawerSubtitle = computed(() => {
  const group = policies.currentGroup
  if (!group) return '节点列表'
  return displayType(group.type)
})

async function onCardClick(name: string): Promise<void> {
  // A rejected selection is surfaced via `panelError` by the store; swallow it
  // here so a click never becomes an unhandled promise rejection in the view.
  try {
    await policies.selectNode(name)
  } catch {
    /* no-op: the store keeps the error message in `panelError` */
  }
}

async function init(): Promise<void> {
  await kernel.refresh()
  if (kernel.status.phase !== 'running') return
  await Promise.all([policies.load(), policies.syncMode()])
}

/** A local node change hot-reloads the core; re-read the groups. */
function onLocalChanged(): void {
  if (kernel.status.phase === 'running') void policies.load()
}

onMounted(() => {
  void init()
})

watch(() => kernel.status.phase, (phase, previous) => {
  if (phase === 'running' && previous !== 'running') void init()
})
</script>

<template>
  <div class="page-shell policy-view">
    <h1>策略</h1>

    <div class="mode-selector" role="tablist" aria-label="代理模式">
      <button
        v-for="option in POLICY_MODE_OPTIONS"
        :key="option"
        :class="{ selected: policies.mode === option }"
        type="button"
        :disabled="kernel.status.phase !== 'running'"
        @click="policies.setMode(option)"
      >{{ MODE_LABELS[option] }}</button>
    </div>

    <div v-if="kernel.status.phase !== 'running'" class="empty-state">
      <p>内核尚未运行</p>
      <span>请先在“概览”中启动内核，策略将在 Controller 就绪后自动载入。</span>
    </div>

    <div v-else-if="policies.status === 'error'" class="empty-state">
      <p>无法读取策略</p>
      <span>{{ policies.lastError }}</span>
      <button type="button" @click="init">重试</button>
    </div>

    <template v-else>
      <div class="section-caption"><span>策略组</span></div>
      <div class="policy-group-grid">
        <button v-for="group in policies.groups" :key="group.name" type="button" :class="{ selected: policies.selectedGroup === group.name, 'has-icon': Boolean(group.icon) }" @click="openGroup(group.name)" @contextmenu="onGroupContext($event, group)"><CachedRemoteIcon v-if="group.icon" class="group-icon" :src="group.icon" :cache-key="`policy:${group.name}`" /><small>{{ displayType(group.type) }}</small><strong>{{ group.name }}</strong><span>{{ groupSummary(group) }}</span><AppIcon name="next" :size="14" /></button>
        <button type="button" class="policy-group-add" :disabled="localStore.busy" aria-label="新建策略组" title="新建策略组" @click="addGroup"><span aria-hidden="true">+</span></button>
      </div>
    </template>

    <div v-if="policies.panelError" class="panel-error">{{ policies.panelError }}</div>

    <LocalNodesSection @changed="onLocalChanged" />

    <GroupWizardModal :open="wizardOpen" :group="wizardGroup" :policies="wizardPolicies" :groups="wizardGroups" :taken-names="wizardTaken" :busy="localStore.busy" :smart="kernelManager.state.smartEnabled" @close="wizardOpen = false" @save="saveGroup" />
    <PopoverMenu :open="!!groupMenu" :x="groupMenuAt.x" :y="groupMenuAt.y" :label="groupMenu?.name" @close="groupMenu = null">
      <template v-if="groupMenu">
        <div class="group-menu-head" @click.stop>
          <strong>{{ groupMenu.name }}</strong>
          <small>{{ groupMenu.type }}<template v-if="groupMenu.local"> · 本地</template><template v-if="groupMenu.current"> · 当前 {{ groupMenu.current }}</template></small>
          <div v-if="groupMenuStats" class="group-menu-stats">
            <span><small>活跃连接</small><b>{{ groupMenuStats.count }}</b></span>
            <span><small>上传</small><b>{{ groupMenuStats.up }}</b></span>
            <span><small>下载</small><b>{{ groupMenuStats.down }}</b></span>
          </div>
        </div>
        <div class="popover-sep" />
        <button type="button" class="popover-item" role="menuitem" @click="openGroup(groupMenu.name)">查看策略…</button>
        <button type="button" class="popover-item" role="menuitem" @click="testGroupFromMenu(groupMenu.name)">测试策略组延迟</button>
        <template v-if="groupMenu.local">
          <div class="popover-sep" />
          <button type="button" class="popover-item" role="menuitem" :disabled="localStore.busy" @click="editGroup(groupMenu.local)">编辑策略组…</button>
          <button type="button" class="popover-item danger" role="menuitem" :disabled="localStore.busy" @click="removingGroup = groupMenu.local">删除策略组…</button>
        </template>
        <template v-else>
          <div class="popover-sep" />
          <button type="button" class="popover-item" role="menuitem" :disabled="localStore.busy" @click="addGroup">新建策略组…</button>
        </template>
      </template>
    </PopoverMenu>
    <ConfirmModal :open="!!removingGroup" title="删除策略组" :description="`删除「${removingGroup?.config.name ?? ''}」？引用它的规则和策略组会自动跳过它。`" :busy="localStore.busy" @close="removingGroup = null" @confirm="confirmRemoveGroup" />

    <DetailDrawer :open="groupDrawerOpen && Boolean(policies.selectedGroup)" :title="policies.selectedGroup" :subtitle="drawerSubtitle" :icon="policies.currentGroup?.icon" :icon-cache-key="`policy:${policies.selectedGroup}`" @close="groupDrawerOpen = false">
      <div class="node-caption"><span>节点列表</span><button type="button" :disabled="policies.groupDelayStatus === 'testing'" @click="testGroup">{{ policies.groupDelayStatus === 'testing' ? '测试中…' : '测试当前组' }}</button></div>
      <div class="drawer-body-grid">
        <div class="node-grid"><div v-for="member in policies.groupMembers" :key="member" class="node-card" :class="{ selected: policies.selectedMember === member, unavailable: isUnavailable(member) }"><button type="button" class="node-select" :disabled="!policies.isSelectableGroup(policies.currentGroup)" @click="onCardClick(member)"><small v-if="isNestedGroup(member)">{{ displayType(policies.nodeByMember[member]?.type) }}</small><strong>{{ member }}</strong><span v-if="nodeTags(member).length" class="node-tags"><i v-for="tag in nodeTags(member)" :key="tag">{{ tag }}</i></span></button><button type="button" class="node-delay" :class="latencyLabel(member).kind" :title="delayTitle(member)" :disabled="memberState(member).status === 'testing'" @click="testMember(member)">{{ latencyLabel(member).text }}</button></div></div>
      </div>
      <div v-if="policies.panelError" class="panel-error drawer-panel-error">{{ policies.panelError }}</div>
    </DetailDrawer>

  </div>
</template>

<style scoped>
.mode-selector { width: 100%; max-width: 510px; }
.policy-group-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: var(--space-4); width: 100%; }
.policy-group-grid button { display: grid; grid-template-columns: minmax(0, 1fr) 28px; grid-template-rows: 16px 24px 24px; column-gap: 8px; min-width: 0; min-height: 86px; padding: 10px; border: 1px solid transparent; border-radius: var(--radius-md); background: var(--app-surface); color: inherit; text-align: left; }
.policy-group-grid button:hover, .policy-group-grid button.selected { border-color: color-mix(in srgb, var(--app-blue) 48%, var(--app-divider)); background: color-mix(in srgb, var(--app-blue) 7%, var(--app-surface)); }
.policy-group-grid small { grid-column: 1; grid-row: 1; align-self: start; color: var(--app-muted); font-size: var(--font-size-2xs); }
.policy-group-grid strong { grid-column: 1; grid-row: 2; align-self: center; overflow: hidden; font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; }
.policy-group-grid span { grid-column: 1; grid-row: 3; align-self: end; overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
.group-icon { grid-column: 2; grid-row: 1 / 3; align-self: start; justify-self: end; width: 26px; height: 26px; border-radius: var(--radius-sm); object-fit: contain; }
.policy-group-grid svg { grid-column: 2; grid-row: 1 / 4; align-self: center; justify-self: end; color: var(--app-muted); }
.group-menu-head { display: grid; gap: 3px; padding: 8px 10px 6px; }
.group-menu-head > strong { overflow: hidden; font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.group-menu-head > small { overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
.group-menu-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 6px; }
.group-menu-stats span { display: grid; gap: 1px; }
.group-menu-stats small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.group-menu-stats b { font-size: var(--font-size-body); font-weight: 600; font-variant-numeric: tabular-nums; }
.policy-group-grid .policy-group-add { display: flex; align-items: center; justify-content: center; border: 1px dashed var(--app-divider); background: transparent; color: var(--app-muted); font-size: 22px; font-weight: 300; }
.policy-group-grid .policy-group-add:hover { border-color: color-mix(in srgb, var(--app-blue) 48%, var(--app-divider)); background: transparent; color: var(--app-text); }
.policy-group-grid .policy-group-add:disabled { opacity: 0.5; }
.policy-group-grid .policy-group-add span { display: grid; align-self: center; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: color-mix(in srgb, var(--app-text) 16%, transparent); color: var(--app-surface-solid); font-size: 17px; font-weight: 500; line-height: 1; }
.policy-group-grid button.has-icon > svg { grid-row: 3; align-self: end; }
.node-caption{display:flex;justify-content:space-between;align-items:center;margin:4px 0 12px;color:var(--app-pink);font-size:var(--font-size-sm)}.node-caption button{border:0;background:transparent;color:var(--app-muted);font-size:var(--font-size-xs)}
.drawer-panel-error{margin-top:12px}
.drawer-body-grid .node-grid{--node-card-min:128px}
.policy-view .node-caption{margin-top:4px}
.group-tabs { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: 20px; }
.group-tabs button { height: 27px; padding: 0 14px; border: 0; border-radius: var(--radius-control); background: var(--app-fill); }
.group-tabs button.selected { color: var(--app-on-accent); background: var(--app-blue); }
/* 选中环用 inset box-shadow 画在卡片内部：outline 型外扩环会溢出网格，
   在抽屉左缘被裁切，看起来像整列边框错位。 */
.node-grid .node-card { display:flex; flex-direction:column; min-width:0; height:94px; padding:12px; border-radius:var(--radius-control); background:var(--app-fill); }
.node-grid .node-card.selected { box-shadow: inset 0 0 0 2px var(--app-blue); background: rgba(22,132,248,.12); }
.node-grid .node-card.unavailable { opacity: .78; }
.node-select,.node-delay { min-width:0; padding:0; border:0; background:transparent; color:inherit; text-align:left; }
.node-select { display:flex; flex-direction:column; }
.node-select:disabled { cursor:default; opacity:1; }
.node-select small { color:var(--app-muted); }
.node-select strong { overflow:hidden; margin-top:3px; text-overflow:ellipsis; white-space:nowrap; }
/* 节点协议/能力标签（协议 + udp/xudp/tfo/mptcp/smux），对齐 clash-party/sparkle。 */
.node-tags{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:5px}
.node-tags i{padding:1px 6px;border-radius:var(--radius-sm);background:rgba(127,127,127,.16);color:var(--app-muted);font-size:var(--font-size-2xs);font-style:normal;line-height:1.5;white-space:nowrap}
.node-delay { align-self:flex-start; margin-top:auto; color:var(--app-latency-good); }
.node-delay.testing { color: var(--app-muted); }
.node-delay.timeout { color: var(--app-danger); }
.node-delay.idle { color: var(--app-faint); }
.panel-error { margin-top: 14px; color: var(--app-danger); font-size: var(--font-size-sm); }
.empty-state { margin-top: 26px; padding: 26px; border: 1px dashed var(--app-divider); border-radius: var(--radius-control); }
.empty-state p { margin: 0 0 8px; }
.empty-state span { color: var(--app-muted); font-size: var(--font-size-sm); }
.empty-state button { margin-top: 12px; height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-sm); background: var(--app-fill); }
.provider-section { margin-top: 42px; }
.provider-list { width: 100%; }
.provider-row { display: grid; grid-template-columns: 1fr auto; column-gap: 14px; row-gap: 6px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--app-divider); }
.provider-row:first-child { border-top: 0; }
.provider-info strong { display: block; font-size: var(--font-size-body); }
.provider-info small { display: block; margin-top: 3px; color: var(--app-muted); font-size: var(--font-size-xs); }
.provider-actions { display: flex; gap: var(--space-3); }
.provider-actions button { height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-sm); background: var(--app-fill); }
.provider-actions button:disabled { opacity: .5; }
.provider-error { grid-column: 1 / -1; color: var(--app-danger); font-size: var(--font-size-xs); }
.provider-health { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--app-muted); font-size: var(--font-size-xs); }
.provider-health span.unavailable { color: var(--app-danger); }
</style>
