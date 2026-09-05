<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePoliciesStore, POLICY_MODE_OPTIONS, type PolicyMode } from '../stores/policies'
import { useKernelStore } from '../stores/kernel'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'

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

function latencyLabel(name: string): { text: string; kind: string } {
  const state = policies.nodeState(name)
  switch (state.status) {
    case 'testing':
      return { text: '测试中…', kind: 'testing' }
    case 'ok':
      return { text: `${state.delay} ms`, kind: 'ok' }
    case 'timeout':
      return { text: '超时', kind: 'timeout' }
    case 'unavailable':
      return { text: '不可用', kind: 'timeout' }
    case 'error':
      return { text: '失败', kind: 'timeout' }
    default:
      return { text: '选择测试', kind: 'idle' }
  }
}

function isUnavailable(name: string): boolean {
  const proxy = policies.nodeByMember[name]
  return proxy ? proxy.alive === false : false
}

const drawerSubtitle = computed(() => {
  const group = policies.currentGroup
  if (!group) return '节点列表'
  return displayType(group.type)
})

/** A broken/remote icon must not leave a torn image in the grid: hide it. */
function onGroupIconError(event: Event): void {
  const img = event.currentTarget as HTMLImageElement | null
  if (img) img.style.display = 'none'
}

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
  await policies.load()
  try {
    const config = await window.desktop.mihomo.getConfig()
    if (config.mode && POLICY_MODE_OPTIONS.includes(config.mode as PolicyMode)) {
      policies.mode = config.mode as PolicyMode
    }
  } catch {
    /* the mode selector falls back to the store default */
  }
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
        <button v-for="group in policies.groups" :key="group.name" type="button" :class="{ selected: policies.selectedGroup === group.name }" @click="openGroup(group.name)"><img v-if="group.icon" class="group-icon" :src="group.icon" alt="" loading="lazy" @error="onGroupIconError" /><small>{{ displayType(group.type) }}</small><strong>{{ group.name }}</strong><span>{{ policies.groupSelectedMember(group) || '未选择' }}</span><AppIcon name="next" :size="14" /></button>
      </div>
    </template>

    <div v-if="policies.panelError" class="panel-error">{{ policies.panelError }}</div>

    <DetailDrawer :open="groupDrawerOpen && Boolean(policies.selectedGroup)" :title="policies.selectedGroup" :subtitle="drawerSubtitle" @close="groupDrawerOpen = false">
      <div class="node-caption"><span>节点列表</span><button type="button" @click="policies.testAll()">测试当前组</button></div>
      <div class="drawer-body-grid">
        <div class="node-grid"><div v-for="member in policies.groupMembers" :key="member" class="node-card" :class="{ selected: policies.selectedMember === member, unavailable: isUnavailable(member) }"><button type="button" class="node-select" @click="onCardClick(member)"><small>{{ displayType(policies.nodeByMember[member]?.type) }}</small><strong>{{ member }}</strong></button><button type="button" class="node-delay" :class="latencyLabel(member).kind" :disabled="policies.nodeState(member).status === 'testing'" @click="policies.testNode(member)">{{ latencyLabel(member).text }}</button></div></div>
      </div>
      <div v-if="policies.panelError" class="panel-error drawer-panel-error">{{ policies.panelError }}</div>
    </DetailDrawer>

  </div>
</template>

<style scoped>
.mode-selector { width: 100%; max-width: 510px; }
.policy-group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:10px;width:100%}.group-icon{grid-column:2;grid-row:1;justify-self:end;width:18px;height:18px;border-radius:4px;object-fit:contain}.policy-group-grid button{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto auto;min-width:0;min-height:86px;padding:10px;border:1px solid transparent;border-radius:10px;background:var(--app-surface);color:inherit;text-align:left}.policy-group-grid button:hover,.policy-group-grid button.selected{border-color:color-mix(in srgb,var(--app-blue) 48%,var(--app-divider));background:color-mix(in srgb,var(--app-blue) 7%,var(--app-surface))}.policy-group-grid small{grid-column:1;color:var(--app-muted);font-size:9px}.policy-group-grid strong{grid-column:1;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.policy-group-grid span{grid-column:1;overflow:hidden;color:var(--app-muted);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.policy-group-grid svg{grid-column:2;grid-row:1 / 4;align-self:center;color:var(--app-muted)}.node-caption{display:flex;justify-content:space-between;align-items:center;margin:4px 0 12px;color:var(--app-pink);font-size:12px}.node-caption button{border:0;background:transparent;color:var(--app-muted);font-size:11px}
.drawer-panel-error{margin-top:12px}
.drawer-body-grid .node-grid{--node-card-min:128px}
.policy-view .node-caption{margin-top:4px}
.group-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.group-tabs button { height: 27px; padding: 0 14px; border: 0; border-radius: 8px; background: rgba(127,127,127,.12); }
.group-tabs button.selected { color: white; background: var(--app-blue); }
/* 选中环用 inset box-shadow 画在卡片内部：outline 型外扩环会溢出网格，
   在抽屉左缘被裁切，看起来像整列边框错位。 */
.node-grid .node-card { display:flex; flex-direction:column; min-width:0; height:94px; padding:12px; border-radius:8px; background:rgba(127,127,127,.12); }
.node-grid .node-card.selected { box-shadow: inset 0 0 0 2px var(--app-blue); background: rgba(22,132,248,.12); }
.node-grid .node-card.unavailable { opacity: .78; }
.node-select,.node-delay { min-width:0; padding:0; border:0; background:transparent; color:inherit; text-align:left; }
.node-select { display:flex; flex-direction:column; }
.node-select small { color:var(--app-muted); }
.node-select strong { overflow:hidden; margin-top:3px; text-overflow:ellipsis; white-space:nowrap; }
.node-delay { align-self:flex-start; margin-top:auto; color:#68d21d; }
.node-delay.testing { color: var(--app-muted); }
.node-delay.timeout { color: #e05b5b; }
.node-delay.idle { color: var(--app-faint); }
.panel-error { margin-top: 14px; color: #e05b5b; font-size: 12px; }
.empty-state { margin-top: 26px; padding: 26px; border: 1px dashed var(--app-divider); border-radius: 8px; }
.empty-state p { margin: 0 0 8px; }
.empty-state span { color: var(--app-muted); font-size: 12px; }
.empty-state button { margin-top: 12px; height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-section { margin-top: 42px; }
.provider-list { width: 100%; }
.provider-row { display: grid; grid-template-columns: 1fr auto; column-gap: 14px; row-gap: 6px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--app-divider); }
.provider-row:first-child { border-top: 0; }
.provider-info strong { display: block; font-size: 14px; }
.provider-info small { display: block; margin-top: 3px; color: var(--app-muted); font-size: 11px; }
.provider-actions { display: flex; gap: 8px; }
.provider-actions button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-actions button:disabled { opacity: .5; }
.provider-error { grid-column: 1 / -1; color: #e05b5b; font-size: 11px; }
.provider-health { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--app-muted); font-size: 11px; }
.provider-health span.unavailable { color: #e05b5b; }
</style>
