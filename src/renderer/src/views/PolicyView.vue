<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePoliciesStore, POLICY_MODE_OPTIONS, type PolicyMode } from '../stores/policies'
import { useProvidersStore } from '../stores/providers'
import type { MihomoProxy } from '@shared/mihomo-api'

const policies = usePoliciesStore()
const providers = useProvidersStore()

const MODE_LABELS: Record<PolicyMode, string> = {
  direct: '直接连接',
  global: '全局代理',
  rule: '规则判定'
}

function displayType(proxy: MihomoProxy | null): string {
  if (!proxy) return 'Node'
  return proxy.type ?? 'Node'
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

async function onCardClick(name: string): Promise<void> {
  // A rejected selection is surfaced via `panelError` by the store; swallow it
  // here so a click never becomes an unhandled promise rejection in the view.
  try {
    await policies.selectNode(name)
  } catch {
    /* no-op: the store keeps the error message in `panelError` */
  }
  void policies.testNode(name)
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

async function init(): Promise<void> {
  await policies.load()
  void policies.testAll()
  void providers.loadProxyProviders()
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
        @click="policies.setMode(option)"
      >{{ MODE_LABELS[option] }}</button>
    </div>

    <div v-if="policies.groups.length > 1" class="group-tabs">
      <button
        v-for="group in policies.groups"
        :key="group.name"
        :class="{ selected: policies.selectedGroup === group.name }"
        type="button"
        @click="policies.selectGroup(group.name)"
      >{{ group.name }}</button>
    </div>

    <div class="section-caption"><span>代理</span><button type="button" @click="policies.testAll()">测试全部</button></div>

    <div v-if="policies.status === 'error'" class="empty-state">
      <p>无法读取策略</p>
      <span>{{ policies.lastError }}</span>
      <button type="button" @click="init">重试</button>
    </div>

    <div v-else class="node-grid">
      <button
        v-for="member in policies.groupMembers"
        :key="member"
        type="button"
        :class="{ selected: policies.selectedMember === member, unavailable: isUnavailable(member) }"
        @click="onCardClick(member)"
      >
        <small>{{ displayType(policies.nodeByMember[member]) }}</small>
        <strong>{{ member }}</strong>
        <span :class="latencyLabel(member).kind">{{ latencyLabel(member).text }}</span>
      </button>
    </div>

    <div v-if="policies.panelError" class="panel-error">{{ policies.panelError }}</div>

    <section v-if="providers.orderedProxyProviders.length" class="provider-section">
      <header class="section-caption"><span>机场订阅</span></header>
      <div class="provider-list surface-card">
        <div v-for="provider in providers.orderedProxyProviders" :key="provider.name" class="provider-row">
          <div class="provider-info">
            <strong>{{ provider.name }}</strong>
            <small>{{ provider.vehicleType || 'unknown' }} · {{ provider.proxiesCount ?? 0 }} 节点 · {{ formatUpdatedAt(provider.updatedAt) }}</small>
          </div>
          <div v-if="providers.opOf(provider.name).error" class="provider-error">
            {{ providers.opOf(provider.name).error }}
          </div>
          <div v-if="providers.healthOf(provider.name)" class="provider-health">
            <span v-for="(delay, member) in providers.healthOf(provider.name)" :key="member">{{ member }} {{ delay }}ms</span>
          </div>
          <div class="provider-actions">
            <button
              type="button"
              :disabled="providers.opOf(provider.name).healthchecking"
              @click="providers.healthCheckProxyProvider(provider.name)"
            >{{ providers.opOf(provider.name).healthchecking ? '检查中' : '健康检查' }}</button>
            <button
              type="button"
              :disabled="providers.opOf(provider.name).refreshing"
              @click="providers.refreshProxyProvider(provider.name)"
            >{{ providers.opOf(provider.name).refreshing ? '更新中' : '更新' }}</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mode-selector { width: 510px; }
.group-tabs { display: flex; gap: 8px; margin-top: 20px; }
.group-tabs button { height: 27px; padding: 0 14px; border: 0; border-radius: 8px; background: rgba(127,127,127,.12); }
.group-tabs button.selected { color: white; background: var(--app-blue); }
.node-grid button.selected { box-shadow: 0 0 0 2px var(--app-blue); background: rgba(22,132,248,.12); }
.node-grid button.unavailable { opacity: .78; }
.node-grid span.testing { color: var(--app-muted); }
.node-grid span.timeout { color: #e05b5b; }
.node-grid span.idle { color: var(--app-faint); }
.panel-error { margin-top: 14px; color: #e05b5b; font-size: 12px; }
.empty-state { margin-top: 26px; padding: 26px; border: 1px dashed var(--app-divider); border-radius: 8px; }
.empty-state p { margin: 0 0 8px; }
.empty-state span { color: var(--app-muted); font-size: 12px; }
.empty-state button { margin-top: 12px; height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-section { margin-top: 42px; }
.provider-list { width: 646px; }
.provider-row { display: grid; grid-template-columns: 1fr auto; column-gap: 14px; row-gap: 6px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--app-divider); }
.provider-row:first-child { border-top: 0; }
.provider-info strong { display: block; font-size: 14px; }
.provider-info small { display: block; margin-top: 3px; color: var(--app-muted); font-size: 11px; }
.provider-actions { display: flex; gap: 8px; }
.provider-actions button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: rgba(127,127,127,.13); }
.provider-actions button:disabled { opacity: .5; }
.provider-error { grid-column: 1 / -1; color: #e05b5b; font-size: 11px; }
.provider-health { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--app-muted); font-size: 11px; }
</style>
