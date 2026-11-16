<script setup lang="ts">
import { locale, t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import GeodataSettingsPanel from '../components/GeodataSettingsPanel.vue'
import ProviderContentModal from '../components/ProviderContentModal.vue'
import { useKernelStore } from '../stores/kernel'
import { useProvidersStore } from '../stores/providers'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { formatBytes } from '../lib/format'
import type { MihomoProxyProvider, MihomoRuleProvider } from '@shared/mihomo-api'
import type { ProfileProviderConfig } from '@shared/profiles'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'
import RefreshAllButton from '../components/RefreshAllButton.vue'
import RefreshIndicator from '../components/RefreshIndicator.vue'

const kernel = useKernelStore()
const providers = useProvidersStore()
const mitm = useMitmStore()
const toast = useToast()
// 重写模块与模块脚本也是外部资源：可在这里查看状态并单独更新。
const remoteModules = computed(() => mitm.state.modules.filter((module) => module.url))
const moduleScripts = computed(() => mitm.state.scriptResources ?? [])
const total = computed(() => providers.remoteProxyProviders.length + providers.remoteRuleProviders.length + remoteModules.value.length + moduleScripts.value.length)

type ResourceKind = 'proxy' | 'rule' | 'module' | 'script'
/** `…/rule-parser.js` → `rule-parser.js` for scripts declared without a name. */
function scriptFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? url)
  } catch {
    return url
  }
}

const KIND_TEXT: Record<ResourceKind, string> = { proxy: t('resources.proxyProvider'), rule: t('resources.ruleProvider'), module: t('common.module'), script: t('common.script') }
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
  /** Module id (module rows). */
  moduleId?: string
}
/** 全部 / 代理集合 / 规则集合 / 模块 / 脚本: one table, filtered by type. */
const kindFilter = ref<'all' | ResourceKind>('all')
const onlyNotReady = ref(false)
const STATUS_TEXT: Record<ResourceStatus, string> = { ready: t('localNodes.ready'), updating: t('geodata.updating'), failed: t('common.failed'), pending: t('resources.notLoaded') }

function declaredUrl(kind: ResourceKind, name: string): string {
  const list = kind === 'proxy' ? providers.providerCatalog.proxy : providers.providerCatalog.rule
  return list.find((entry) => entry.name === name)?.url ?? ''
}
function rowStatus(kind: 'proxy' | 'rule', name: string, updatedAt: string | undefined): ResourceStatus {
  const op = providers.opOf(name, kind)
  if (op.refreshing) return 'updating'
  if (op.error) return 'failed'
  return updatedAt ? 'ready' : 'pending'
}
const rows = computed<ResourceRow[]>(() => [
  ...providers.remoteProxyProviders.map((item) => ({
    key: `proxy\0${item.name}`, kind: 'proxy' as const, name: item.name,
    count: t('resources.nodeCount', [item.proxies?.length ?? 0]), updatedAt: item.updatedAt,
    url: declaredUrl('proxy', item.name), status: rowStatus('proxy', item.name, item.updatedAt),
    error: providers.opOf(item.name, 'proxy').error ?? null
  })),
  ...providers.remoteRuleProviders.map((item) => ({
    key: `rule\0${item.name}`, kind: 'rule' as const, name: item.name,
    count: t('resources.ruleCount', [item.ruleCount ?? 0]), updatedAt: item.updatedAt,
    url: declaredUrl('rule', item.name), status: rowStatus('rule', item.name, item.updatedAt),
    error: providers.opOf(item.name, 'rule').error ?? null
  })),
  ...remoteModules.value.map((module) => ({
    key: `module\0${module.id}`, kind: 'module' as const, name: module.name,
    count: t('resources.ruleCount', [module.ruleCount]), updatedAt: module.updatedAt ? new Date(module.updatedAt).toISOString() : undefined,
    url: module.url ?? '', moduleId: module.id,
    status: (mitm.busy === `update-${module.id}` ? 'updating' : module.error ? 'failed' : 'ready') as ResourceStatus,
    error: module.error
  })),
  ...moduleScripts.value.map((script) => ({
    key: `script\0${script.url}`, kind: 'script' as const, name: script.name || scriptFileName(script.url),
    count: script.sources.join(t('common.listSeparator')), updatedAt: script.updatedAt ? new Date(script.updatedAt).toISOString() : undefined,
    url: script.url,
    status: (mitm.busy === `script-${script.url}` ? 'updating' : script.error ? 'failed' : script.cached ? 'ready' : 'pending') as ResourceStatus,
    error: script.error
  }))
])
const visibleRows = computed(() => rows.value.filter((row) =>
  (kindFilter.value === 'all' || row.kind === kindFilter.value) && (!onlyNotReady.value || row.status !== 'ready')
))
const kindTabs = computed(() => [
  { value: 'all' as const, label: t('common.all'), count: rows.value.length },
  { value: 'proxy' as const, label: t('resources.proxyProviders'), count: providers.remoteProxyProviders.length },
  { value: 'rule' as const, label: t('resources.ruleProviders'), count: providers.remoteRuleProviders.length },
  ...(remoteModules.value.length ? [{ value: 'module' as const, label: t('resources.modules'), count: remoteModules.value.length }] : []),
  ...(moduleScripts.value.length ? [{ value: 'script' as const, label: t('resources.scripts'), count: moduleScripts.value.length }] : [])
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
  if (seconds < 60) return t('common.justNow')
  if (seconds < 3600) return t('resources.minutesAgo', [Math.floor(seconds / 60)])
  if (seconds < 86_400) return t('resources.hoursAgo', [Math.floor(seconds / 3600)])
  return t('resources.daysAgo', [Math.floor(seconds / 86_400)])
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

async function updateMitmRow(row: ResourceRow): Promise<string | null> {
  const error = row.kind === 'module' && row.moduleId ? await mitm.updateModule(row.moduleId) : await mitm.updateScript(row.url)
  return error ?? null
}

/** Modules and scripts refresh one at a time (each is a plain download). */
async function refreshMitmRows(kinds: ResourceKind[]): Promise<{ updated: number; failed: number }> {
  let updated = 0
  let failed = 0
  for (const row of rows.value.filter((item) => kinds.includes(item.kind))) {
    if (await updateMitmRow(row)) failed += 1
    else updated += 1
  }
  return { updated, failed }
}

/** 全部更新 follows the type filter: 代理集合 / 规则集合 only refresh that section. */
async function refreshAll(): Promise<{ updated: number; failed: number }> {
  if (kindFilter.value === 'proxy') return providers.refreshAllProxyProviders()
  if (kindFilter.value === 'rule') return providers.refreshAllRuleProviders()
  if (kindFilter.value === 'module' || kindFilter.value === 'script') return refreshMitmRows([kindFilter.value])
  const [base, extra] = await Promise.all([providers.refreshAllProviders(), refreshMitmRows(['module', 'script'])])
  return { updated: base.updated + extra.updated, failed: base.failed + extra.failed }
}
function refreshRow(row: ResourceRow): void {
  if (row.kind === 'proxy') void providers.refreshProxyProvider(row.name)
  else if (row.kind === 'rule') void providers.refreshRuleProvider(row.name)
  else void updateMitmRow(row).then((error) => { if (error) toast.error(t('common.updateFailed'), error) })
}
function rowRefreshing(row: ResourceRow): boolean {
  return row.kind === 'proxy' || row.kind === 'rule' ? providers.opOf(row.name, row.kind).refreshing : row.status === 'updating'
}
function rowFailed(row: ResourceRow): boolean {
  return row.kind === 'proxy' || row.kind === 'rule' ? Boolean(providers.opOf(row.name, row.kind).error) : row.status === 'failed'
}

onMounted(() => { void load(); void mitm.refresh() })
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
  if (!seconds || seconds <= 0) return t('resources.notDeclared')
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return t('resources.hours', [hours])
  }
  return t('resources.seconds', [seconds])
}

function expireText(expire: number | undefined): string {
  if (!expire) return '—'
  return new Date(expire * 1000).toLocaleString(locale.value, { hour12: false })
}

function vehicleText(provider: MihomoProxyProvider | MihomoRuleProvider | null): string {
  return provider?.vehicleType ?? '—'
}

function updatedAtText(provider: MihomoProxyProvider | MihomoRuleProvider | null): string {
  const updatedAt = provider?.updatedAt
  if (!updatedAt) return '—'
  return new Date(updatedAt).toLocaleString(locale.value, { hour12: false })
}

function subscriptionText(provider: MihomoProxyProvider | null): string {
  const info = provider?.subscriptionInfo
  if (!info) return '—'
  const parts = [t('resources.used', [formatBytes((info.Upload ?? 0) + (info.Download ?? 0))]), t('resources.totalQuota', [formatBytes(info.Total ?? 0)])]
  if (info.Expire) parts.push(t('resources.expires', [expireText(info.Expire)]))
  return parts.join(' · ')
}
</script>

<template><div class="page-shell feature-page">
  <header class="feature-header">
    <div><h1>{{ t('resources.title') }}</h1><p>{{ t('resources.intro') }}</p></div>
  </header>
  <p v-if="kernel.status.phase !== 'running'" class="inline-note">{{ t('resources.needCore') }}</p>
  <section v-else class="surface-card resource-table-card" :aria-label="t('resources.remoteLabel')">
    <div class="resource-table-toolbar">
      <div class="resource-table-filter" role="group" :aria-label="t('resources.kindLabel')">
        <button v-for="tab in kindTabs" :key="tab.value" type="button" :class="{ selected: kindFilter === tab.value }" :aria-pressed="kindFilter === tab.value" @click="kindFilter = tab.value">{{ tab.label }}<span>{{ tab.count }}</span></button>
      </div>
      <div class="resource-table-actions">
        <div class="resource-only-pending" @click="onlyNotReady = !onlyNotReady">
          <span>{{ t('resources.onlyNotReady') }}<em v-if="notReadyCount">{{ notReadyCount }}</em></span>
          <button type="button" class="switch" :class="{ on: onlyNotReady }" role="switch" :aria-checked="onlyNotReady" :aria-label="t('resources.onlyNotReadyLabel')" />
        </div>
        <RefreshAllButton :run="refreshAll" :disabled="providers.batchRefreshing || !total" />
      </div>
    </div>
    <div class="resource-table" role="table" :aria-label="t('resources.listLabel')">
      <div class="resource-tr resource-th" role="row">
        <span role="columnheader">{{ t('common.type') }}</span><span role="columnheader">{{ t('common.name') }}</span><span role="columnheader">{{ t('resources.lastUpdated') }}</span><span role="columnheader">{{ t('groupWizard.path') }}</span><span role="columnheader">{{ t('common.status') }}</span><span role="columnheader" class="sr-only">{{ t('resources.actions') }}</span>
      </div>
      <div v-for="row in visibleRows" :key="row.key" class="resource-tr" role="row" :class="`status-${row.status}`">
        <span role="cell" class="resource-kind">{{ KIND_TEXT[row.kind] }}</span>
        <span v-if="row.kind === 'module' || row.kind === 'script'" role="cell" class="resource-name" :title="row.error ?? `${row.name}${row.count ? ` · ${row.count}` : ''}`"><strong>{{ row.name }}</strong><small>{{ row.count }}</small></span>
        <button v-else role="cell" type="button" class="resource-name" :aria-label="row.kind === 'proxy' ? t('resources.viewProxyConfig') : t('resources.viewRuleConfig')" :title="row.error ?? row.name" @click="viewing = { kind: row.kind as 'proxy' | 'rule', name: row.name }"><strong>{{ row.name }}</strong><small>{{ row.count }}</small></button>
        <span role="cell" class="resource-updated" :title="row.kind === 'module' || row.kind === 'script' ? (row.updatedAt ?? undefined) : updatedAtText(row.kind === 'proxy' ? providers.proxyProviders[row.name] ?? null : providers.ruleProviders[row.name] ?? null)">{{ relativeTime(row.updatedAt) }}</span>
        <span role="cell" class="resource-path" :title="row.url || t('resources.noRemoteUrl')"><span>{{ pathParts(row.url).head }}</span><span v-if="pathParts(row.url).tail">{{ pathParts(row.url).tail }}</span></span>
        <span role="cell" class="resource-status" :title="row.error ?? undefined"><i />{{ STATUS_TEXT[row.status] }}</span>
        <span role="cell" class="resource-actions">
          <button v-if="row.kind === 'proxy' || row.kind === 'rule'" class="icon-control" type="button" :aria-label="row.kind === 'proxy' ? t('resources.viewProxyContent') : t('resources.viewRuleContent')" :title="t('resources.viewContent')" @click="viewingContent = { kind: row.kind, name: row.name }"><AppIcon name="eye" :size="15" /></button>
          <button class="icon-control refresh-control" type="button" :disabled="rowRefreshing(row)" :aria-label="rowRefreshing(row) ? t('geodata.updating') : t('resources.updateKind', [KIND_TEXT[row.kind]])" :title="t('common.update')" @click="refreshRow(row)"><RefreshIndicator :busy="rowRefreshing(row)" :failed="rowFailed(row)" :size="15" /></button>
        </span>
      </div>
      <p v-if="!visibleRows.length" class="resource-table-empty">{{ onlyNotReady ? t('resources.allReady') : total ? t('resources.noneOfKind') : t('resources.noProviders') }}</p>
    </div>
  </section>
  <GeodataSettingsPanel />
  <ConfigInspectionCard section="geodata" title="Geodata" />

  <DetailDrawer :open="Boolean(viewing)" :title="viewTitle" :subtitle="t('resources.configSubtitle')" @close="viewing = null">
    <div v-if="viewing" class="provider-config-detail">
      <dl class="detail-list">
        <div class="detail-item"><dt>{{ t('common.type') }}</dt><dd>{{ vehicleText(viewTarget) }}</dd></div>
        <div class="detail-item"><dt>{{ t('resources.remoteUrl') }}</dt><dd class="break-all">{{ viewConfig?.url ?? t('resources.notDeclaredLocal') }}</dd></div>
        <div class="detail-item"><dt>{{ t('groupWizard.updateInterval') }}</dt><dd>{{ intervalText(viewConfig?.interval) }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.behavior"><dt>behavior</dt><dd>{{ viewConfig.behavior }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.format"><dt>format</dt><dd>{{ viewConfig.format }}</dd></div>
        <div class="detail-item" v-if="viewConfig?.testUrl"><dt>{{ t('resources.healthCheckUrl') }}</dt><dd class="break-all">{{ viewConfig.testUrl }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'rule'"><dt>{{ t('resources.ruleTotal') }}</dt><dd>{{ (viewTarget as MihomoRuleProvider | null)?.ruleCount ?? 0 }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'proxy'"><dt>{{ t('resources.nodeTotal') }}</dt><dd>{{ (viewTarget as MihomoProxyProvider | null)?.proxies?.length ?? 0 }}</dd></div>
        <div class="detail-item"><dt>{{ t('resources.recentUpdate') }}</dt><dd>{{ updatedAtText(viewTarget) }}</dd></div>
        <div class="detail-item" v-if="providers.opOf(viewing.name, viewing.kind).error"><dt>{{ t('resources.recentError') }}</dt><dd class="row-error">{{ providers.opOf(viewing.name, viewing.kind).error }}</dd></div>
        <div class="detail-item" v-if="viewing.kind === 'proxy'"><dt>{{ t('resources.subscriptionInfo') }}</dt><dd>{{ subscriptionText(viewTarget as MihomoProxyProvider | null) }}</dd></div>
      </dl>
      <p class="detail-note">{{ t('resources.footnote') }}</p>
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
.resource-table-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4); padding: 10px 14px; }
.resource-table-filter { display: flex; gap: var(--space-2); }
.resource-table-actions { display: flex; align-items: center; gap: var(--space-6); margin-left: auto; }
.resource-table-filter button { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 26px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); cursor: pointer; }
.resource-table-filter button span { color: var(--app-faint, var(--app-muted)); font-variant-numeric: tabular-nums; }
.resource-table-filter button.selected { background: var(--app-fill); color: var(--app-text); font-weight: var(--font-weight-medium); }
.resource-table { display: flex; flex-direction: column; min-width: 0; border-top: 1px solid var(--app-divider); }
.resource-tr { display: grid; grid-template-columns: 64px minmax(120px, 1fr) 80px minmax(160px, 1.6fr) 60px 60px; align-items: center; gap: var(--space-4); min-height: 40px; padding: 0 14px; border-bottom: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.resource-tr:nth-child(odd):not(.resource-th) { background: color-mix(in srgb, var(--app-fill-subtle) 60%, transparent); }
.resource-tr:not(.resource-th):hover { background: var(--app-fill-subtle); }
.resource-th { min-height: 30px; color: var(--app-muted); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); }
.resource-kind { color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; }
.resource-name { display: flex; align-items: baseline; gap: var(--space-3); min-width: 0; overflow: hidden; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--font-size-sm); text-align: left; cursor: pointer; }
span.resource-name { cursor: default; }
.resource-name strong { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: inherit; font-weight: var(--font-weight-medium); }
.resource-name small { flex: 0 10 auto; min-width: 0; overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
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
.resource-table-empty { margin: 0; padding: 26px 14px; color: var(--app-muted); font-size: var(--font-size-sm); line-height: 20px; text-align: center; }
.resource-only-pending { display: inline-flex; align-items: center; gap: var(--space-3); color: var(--app-muted); font-size: var(--font-size-xs); cursor: pointer; user-select: none; }
.resource-only-pending em { margin-left: 5px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--app-danger) 12%, transparent); color: var(--app-danger); font-style: normal; font-variant-numeric: tabular-nums; }
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
