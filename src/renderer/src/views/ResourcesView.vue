<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import GeodataSettingsPanel from '../components/GeodataSettingsPanel.vue'
import ProviderContentModal from '../components/ProviderContentModal.vue'
import { useKernelStore } from '../stores/kernel'
import { useProvidersStore } from '../stores/providers'
import { formatBytes } from '../lib/format'
import type { MihomoProxyProvider, MihomoRuleProvider } from '@shared/mihomo-api'
import type { ProfileProviderConfig } from '@shared/profiles'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'

const kernel = useKernelStore()
const providers = useProvidersStore()
const refreshing = ref(false)
const total = computed(() => providers.remoteProxyProviders.length + providers.remoteRuleProviders.length)

type ResourceKind = 'proxy' | 'rule'
type ResourceStatus = 'ready' | 'updating' | 'failed' | 'pending'
interface ResourceRow {
  key: string
  kind: ResourceKind
  name: string
  count: string
  updatedAt: string | undefined
  url: string
  status: ResourceStatus
  error: string | null
}
/** 全部 / 代理集合 / 规则集合: one table, filtered by type. */
const kindFilter = ref<'all' | ResourceKind>('all')
const onlyNotReady = ref(false)
const STATUS_TEXT: Record<ResourceStatus, string> = { ready: '就绪', updating: '更新中', failed: '失败', pending: '未加载' }

function declaredUrl(kind: ResourceKind, name: string): string {
  const list = kind === 'proxy' ? providers.providerCatalog.proxy : providers.providerCatalog.rule
  return list.find((entry) => entry.name === name)?.url ?? ''
}
function rowStatus(kind: ResourceKind, name: string, updatedAt: string | undefined): ResourceStatus {
  const op = providers.opOf(name, kind)
  if (op.refreshing) return 'updating'
  if (op.error) return 'failed'
  return updatedAt ? 'ready' : 'pending'
}
const rows = computed<ResourceRow[]>(() => [
  ...providers.remoteProxyProviders.map((item) => ({
    key: `proxy\0${item.name}`, kind: 'proxy' as const, name: item.name,
    count: `${item.proxies?.length ?? 0} 个节点`, updatedAt: item.updatedAt,
    url: declaredUrl('proxy', item.name), status: rowStatus('proxy', item.name, item.updatedAt),
    error: providers.opOf(item.name, 'proxy').error ?? null
  })),
  ...providers.remoteRuleProviders.map((item) => ({
    key: `rule\0${item.name}`, kind: 'rule' as const, name: item.name,
    count: `${item.ruleCount ?? 0} 条规则`, updatedAt: item.updatedAt,
    url: declaredUrl('rule', item.name), status: rowStatus('rule', item.name, item.updatedAt),
    error: providers.opOf(item.name, 'rule').error ?? null
  }))
])
const visibleRows = computed(() => rows.value.filter((row) =>
  (kindFilter.value === 'all' || row.kind === kindFilter.value) && (!onlyNotReady.value || row.status !== 'ready')
))
const kindTabs = computed(() => [
  { value: 'all' as const, label: '全部', count: rows.value.length },
  { value: 'proxy' as const, label: '代理集合', count: providers.remoteProxyProviders.length },
  { value: 'rule' as const, label: '规则集合', count: providers.remoteRuleProviders.length }
])
const notReadyCount = computed(() => rows.value.filter((row) => row.status !== 'ready').length)
const now = ref(Date.now())
let clock: number | null = null
onMounted(() => { clock = window.setInterval(() => { now.value = Date.now() }, 30_000) })
onUnmounted(() => { if (clock != null) window.clearInterval(clock) })

/** 「8 小时之前」 style relative time, matching the table's 最后更新 column. */
function relativeTime(value: string | undefined): string {
  if (!value) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.max(0, Math.floor((now.value - time) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟之前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时之前`
  return `${Math.floor(seconds / 86_400)} 天之前`
}
/** Split a URL so the middle elides and the distinguishing file name stays visible. */
function pathParts(url: string): { head: string; tail: string } {
  if (!url) return { head: '—', tail: '' }
  const tail = url.length > 30 ? url.slice(-18) : ''
  return { head: tail ? url.slice(0, -18) : url, tail }
}

/** Row currently opened in the 集合配置 viewer (null = closed). */
const viewing = ref<{ kind: 'proxy' | 'rule'; name: string } | null>(null)
const viewingContent = ref<{ kind: 'proxy' | 'rule'; name: string } | null>(null)

async function load(): Promise<void> {
  if (kernel.status.phase !== 'running') return
  await Promise.all([providers.loadProxyProviders(), providers.loadRuleProviders(), providers.loadProviderCatalog()])
}

/** 全部更新 follows the type filter: 代理集合 / 规则集合 only refresh that section. */
async function refreshAll(): Promise<void> {
  refreshing.value = true
  try {
    if (kindFilter.value === 'proxy') await providers.refreshAllProxyProviders()
    else if (kindFilter.value === 'rule') await providers.refreshAllRuleProviders()
    else await providers.refreshAllProviders()
  } finally { refreshing.value = false }
}
function refreshRow(row: ResourceRow): void {
  if (row.kind === 'proxy') void providers.refreshProxyProvider(row.name)
  else void providers.refreshRuleProvider(row.name)
}

onMounted(() => void load())
watch(() => kernel.status.phase, (phase) => { if (phase === 'running') void load() })

const viewTarget = computed(() => {
  if (!viewing.value) return null
  if (viewing.value.kind === 'proxy') return providers.proxyProviders[viewing.value.name] ?? null
  return providers.ruleProviders[viewing.value.name] ?? null
})

/** Profile-declared fields for the viewed row (absent when not declared). */
const viewConfig = computed<ProfileProviderConfig | null>(() => {
  if (!viewing.value) return null
  const list = viewing.value.kind === 'proxy' ? providers.providerCatalog.proxy : providers.providerCatalog.rule
  return list.find((entry) => entry.name === viewing.value!.name) ?? null
})

const viewTitle = computed(() => viewTarget.value?.name ?? viewing.value?.name ?? '')

function intervalText(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '未声明'
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return `${hours} 小时`
  }
  return `${seconds} 秒`
}

function expireText(expire: number | undefined): string {
  if (!expire) return '—'
  return new Date(expire * 1000).toLocaleString('zh-CN', { hour12: false })
}

function vehicleText(provider: MihomoProxyProvider | MihomoRuleProvider | null): string {
  return provider?.vehicleType ?? '—'
}

function updatedAtText(provider: MihomoProxyProvider | MihomoRuleProvider | null): string {
  const updatedAt = provider?.updatedAt
  if (!updatedAt) return '—'
  return new Date(updatedAt).toLocaleString('zh-CN', { hour12: false })
}

function subscriptionText(provider: MihomoProxyProvider | null): string {
  const info = provider?.subscriptionInfo
  if (!info) return '—'
  const parts = [`已用 ${formatBytes((info.Upload ?? 0) + (info.Download ?? 0))}`, `总量 ${formatBytes(info.Total ?? 0)}`]
  if (info.Expire) parts.push(`到期 ${expireText(info.Expire)}`)
  return parts.join(' · ')
}
</script>

<template><div class="page-shell feature-page">
  <header class="feature-header">
    <div><h1>外部资源</h1><p>代理集合、规则集合与地理数据库。</p></div>
  </header>
  <p v-if="kernel.status.phase !== 'running'" class="inline-note">启动内核后即可读取和更新集合。</p>
  <section v-else class="surface-card resource-table-card" aria-label="远程集合">
    <div class="resource-table-filter" role="group" aria-label="集合类型">
      <button v-for="tab in kindTabs" :key="tab.value" type="button" :class="{ selected: kindFilter === tab.value }" :aria-pressed="kindFilter === tab.value" @click="kindFilter = tab.value">{{ tab.label }}<span>{{ tab.count }}</span></button>
    </div>
    <div class="resource-table" role="table" aria-label="外部资源列表">
      <div class="resource-tr resource-th" role="row">
        <span role="columnheader">类型</span><span role="columnheader">名称</span><span role="columnheader">最后更新</span><span role="columnheader">路径</span><span role="columnheader">状态</span><span role="columnheader" class="sr-only">操作</span>
      </div>
      <div v-for="row in visibleRows" :key="row.key" class="resource-tr" role="row" :class="`status-${row.status}`">
        <span role="cell" class="resource-kind">{{ row.kind === 'proxy' ? '代理集合' : '规则集合' }}</span>
        <button role="cell" type="button" class="resource-name" :aria-label="row.kind === 'proxy' ? '查看代理集合配置' : '查看规则集合配置'" :title="row.error ?? row.name" @click="viewing = { kind: row.kind, name: row.name }"><strong>{{ row.name }}</strong><small>{{ row.count }}</small></button>
        <span role="cell" class="resource-updated" :title="updatedAtText(row.kind === 'proxy' ? providers.proxyProviders[row.name] ?? null : providers.ruleProviders[row.name] ?? null)">{{ relativeTime(row.updatedAt) }}</span>
        <span role="cell" class="resource-path" :title="row.url || '未声明远程地址'"><span>{{ pathParts(row.url).head }}</span><span v-if="pathParts(row.url).tail">{{ pathParts(row.url).tail }}</span></span>
        <span role="cell" class="resource-status" :title="row.error ?? undefined"><i />{{ STATUS_TEXT[row.status] }}</span>
        <span role="cell" class="resource-actions">
          <button class="icon-control" type="button" :aria-label="row.kind === 'proxy' ? '查看代理集合内容' : '查看规则集合内容'" title="查看内容" @click="viewingContent = { kind: row.kind, name: row.name }"><AppIcon name="code" :size="15" /></button>
          <button class="icon-control" type="button" :class="{ spinning: providers.opOf(row.name, row.kind).refreshing }" :disabled="providers.opOf(row.name, row.kind).refreshing" :aria-label="providers.opOf(row.name, row.kind).refreshing ? '更新中' : row.kind === 'proxy' ? '更新代理集合' : '更新规则集合'" title="更新" @click="refreshRow(row)"><AppIcon name="refresh" :size="15" /></button>
        </span>
      </div>
      <p v-if="!visibleRows.length" class="resource-table-empty">{{ onlyNotReady ? '所有集合都已就绪。' : total ? '该类型下没有远程集合。' : '当前配置没有远程代理集合或规则集合。' }}</p>
    </div>
    <footer class="resource-table-footer">
      <label class="resource-only-pending"><input v-model="onlyNotReady" type="checkbox" />仅显示未就绪的项目<span v-if="notReadyCount">（{{ notReadyCount }}）</span></label>
      <button type="button" class="secondary-button" :disabled="providers.batchRefreshing || !total" @click="refreshAll">{{ refreshing ? '更新中…' : '全部更新' }}</button>
    </footer>
  </section>
  <ConfigInspectionCard section="geodata" title="Geodata" />
  <GeodataSettingsPanel />

  <DetailDrawer :open="Boolean(viewing)" :title="viewTitle" subtitle="集合配置" @close="viewing = null">
    <div v-if="viewing" class="provider-config-detail">
      <dl class="detail-list">
        <div class="detail-item"><dt>类型</dt><dd>{{ vehicleText(viewTarget) }}</dd></div>
        <div class="detail-item"><dt>远程地址</dt><dd class="break-all">{{ viewConfig?.url ?? '未声明（本地/内联集合）' }}</dd></div>
        <div class="detail-item"><dt>自动更新间隔</dt><dd>{{ intervalText(viewConfig?.interval) }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.behavior"><dt>behavior</dt><dd>{{ viewConfig.behavior }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.format"><dt>format</dt><dd>{{ viewConfig.format }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.testUrl"><dt>健康检查 URL</dt><dd class="break-all">{{ viewConfig.testUrl }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'rule'"><dt>规则数</dt><dd>{{ (viewTarget as MihomoRuleProvider | null)?.ruleCount ?? 0 }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'proxy'"><dt>节点数</dt><dd>{{ (viewTarget as MihomoProxyProvider | null)?.proxies?.length ?? 0 }}</dd></div>
        <div class="detail-item"><dt>最近更新</dt><dd>{{ updatedAtText(viewTarget) }}</dd></div>
        <div class="detail-item" v-if="providers.opOf(viewing.name, viewing.kind).error"><dt>最近错误</dt><dd class="row-error">{{ providers.opOf(viewing.name, viewing.kind).error }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'proxy'"><dt>订阅信息</dt><dd>{{ subscriptionText(viewTarget as MihomoProxyProvider | null) }}</dd></div>
      </dl>
      <p class="detail-note">远程地址与间隔来自当前配置文件的集合声明；运行状态来自控制器。</p>
    </div>
  </DetailDrawer>
  <ProviderContentModal
    v-if="viewingContent"
    :open="true"
    :kind="viewingContent.kind"
    :name="viewingContent.name"
    @close="viewingContent = null"
  />
</div></template>

<style scoped>
.resource-table-card { display: flex; flex-direction: column; width: 100%; margin-bottom: 18px; padding: 0; overflow: hidden; }
.resource-table-filter { display: flex; gap: var(--space-2); padding: 12px 14px 10px; }
.resource-table-filter button { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 26px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); cursor: pointer; }
.resource-table-filter button span { color: var(--app-faint, var(--app-muted)); font-variant-numeric: tabular-nums; }
.resource-table-filter button.selected { background: var(--app-fill); color: var(--app-text); font-weight: var(--font-weight-medium); }
.resource-table { display: flex; flex-direction: column; min-width: 0; border-top: 1px solid var(--app-divider); }
.resource-tr { display: grid; grid-template-columns: 64px minmax(120px, 1fr) 80px minmax(160px, 1.6fr) 60px 60px; align-items: center; gap: var(--space-4); min-height: 40px; padding: 0 14px; border-bottom: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.resource-tr:nth-child(odd):not(.resource-th) { background: color-mix(in srgb, var(--app-fill-subtle) 60%, transparent); }
.resource-tr:not(.resource-th):hover { background: var(--app-fill-subtle); }
.resource-th { min-height: 30px; color: var(--app-muted); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); }
.resource-kind { color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.resource-name { display: flex; align-items: baseline; gap: var(--space-3); min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.resource-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--font-weight-medium); }
.resource-name small { flex: none; color: var(--app-muted); font-size: var(--font-size-2xs); }
.resource-name:hover strong { color: var(--app-accent); }
.resource-updated { color: var(--app-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.resource-path { display: flex; min-width: 0; color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.resource-path span:first-child { flex: 0 1 auto; min-width: 4ch; overflow: hidden; text-overflow: ellipsis; }
.resource-path span + span { flex: none; }
.resource-status { display: inline-flex; align-items: center; gap: var(--space-2); white-space: nowrap; font-size: var(--font-size-xs); }
.resource-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--app-green); }
.status-updating .resource-status { color: var(--app-purple); }
.status-updating .resource-status i { background: var(--app-purple); }
.status-failed .resource-status, .status-failed .resource-name strong { color: var(--app-danger); }
.status-failed .resource-status i { background: var(--app-danger); }
.status-pending .resource-status { color: var(--app-muted); }
.status-pending .resource-status i { background: var(--app-muted); }
.resource-actions { display: inline-flex; justify-content: flex-end; gap: var(--space-1); }
.resource-actions .icon-control { width: 26px; height: 26px; border-color: transparent; background: transparent; color: var(--app-muted); }
.resource-actions .icon-control:hover:not(:disabled) { background: var(--app-fill); color: var(--app-text); }
.resource-table-empty { margin: 0; padding: 22px 14px; color: var(--app-muted); font-size: var(--font-size-xs); text-align: center; }
.resource-table-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); padding: 10px 14px; }
.resource-only-pending { display: inline-flex; align-items: center; gap: var(--space-3); color: var(--app-text); font-size: var(--font-size-sm); cursor: pointer; }
.resource-only-pending input { width: 15px; height: 15px; margin: 0; accent-color: var(--app-accent); }
.resource-only-pending span { color: var(--app-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.row-error { color: var(--app-danger); }
.detail-list { display: grid; gap: 0; margin: 0; }
.detail-item { display: flex; justify-content: space-between; gap: var(--space-6); padding: 8px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.detail-item:first-child { border-top: 0; }
.detail-item dt { color: var(--app-muted); flex-shrink: 0; }
.detail-item dd { margin: 0; text-align: right; font-weight: var(--font-weight-semibold); min-width: 0; overflow-wrap: anywhere; }
.break-all { word-break: break-all; }
.detail-note { margin: 14px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.quiet-button { width: 102px; min-height: 30px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; flex-shrink: 0; }
.quiet-button:disabled { opacity: 0.5; }
</style>
