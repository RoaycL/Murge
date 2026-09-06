<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import GeodataSettingsPanel from '../components/GeodataSettingsPanel.vue'
import { useKernelStore } from '../stores/kernel'
import { useProvidersStore } from '../stores/providers'
import { formatBytes } from '../lib/format'
import type { MihomoProxyProvider, MihomoRuleProvider } from '@shared/mihomo-api'
import type { ProfileProviderConfig } from '@shared/profiles'

const kernel = useKernelStore()
const providers = useProvidersStore()
const refreshing = ref(false)
const refreshingProxy = ref(false)
const refreshingRule = ref(false)
const total = computed(() => providers.remoteProxyProviders.length + providers.remoteRuleProviders.length)

/** Row currently opened in the 集合配置 viewer (null = closed). */
const viewing = ref<{ kind: 'proxy' | 'rule'; name: string } | null>(null)

async function load(): Promise<void> {
  if (kernel.status.phase !== 'running') return
  await Promise.all([providers.loadProxyProviders(), providers.loadRuleProviders(), providers.loadProviderCatalog()])
}

async function refreshAll(): Promise<void> { refreshing.value = true; try { await providers.refreshAllProviders() } finally { refreshing.value = false } }
async function refreshAllProxy(): Promise<void> { refreshingProxy.value = true; try { await providers.refreshAllProxyProviders() } finally { refreshingProxy.value = false } }
async function refreshAllRule(): Promise<void> { refreshingRule.value = true; try { await providers.refreshAllRuleProviders() } finally { refreshingRule.value = false } }

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
    <div><h1>外部资源</h1><p>集中查看代理集合、规则集合与地理数据库。</p></div>
    <button type="button" class="secondary-button" :disabled="refreshing || kernel.status.phase !== 'running' || !total" @click="refreshAll">{{ refreshing ? '更新中…' : '全部更新' }}</button>
  </header>
  <p v-if="kernel.status.phase !== 'running'" class="inline-note">启动内核后即可读取和更新集合。</p>
  <section v-else class="resource-page-groups">
    <article class="surface-card resource-page-card">
      <header class="resource-card-head">
        <h2>代理集合 <small>{{ providers.remoteProxyProviders.length }}</small></h2>
        <button type="button" class="quiet-button" :disabled="refreshingProxy || !providers.remoteProxyProviders.length" @click="refreshAllProxy">{{ refreshingProxy ? '更新中…' : '全部更新' }}</button>
      </header>
      <div v-for="item in providers.remoteProxyProviders" :key="item.name" class="resource-page-row" :class="{ 'row-failed': providers.opOf(item.name, 'proxy').error, 'row-updating': providers.opOf(item.name, 'proxy').refreshing }">
        <button type="button" class="resource-row-main" @click="viewing = { kind: 'proxy', name: item.name }">
          <strong>{{ item.name }}</strong>
          <small>{{ item.proxies?.length ?? 0 }} 个节点</small>
          <small v-if="providers.opOf(item.name, 'proxy').error" class="row-error" role="alert">{{ providers.opOf(item.name, 'proxy').error }}</small>
        </button>
        <span class="row-actions">
          <button class="icon-control" type="button" aria-label="查看代理集合配置" title="查看配置" @click="viewing = { kind: 'proxy', name: item.name }"><AppIcon name="eye" :size="16" /></button>
          <button class="icon-control" type="button" :class="{ spinning: providers.opOf(item.name, 'proxy').refreshing }" :disabled="providers.opOf(item.name, 'proxy').refreshing" :aria-label="providers.opOf(item.name, 'proxy').refreshing ? '更新中' : '更新代理集合'" @click="providers.refreshProxyProvider(item.name)"><AppIcon name="refresh" :size="16" /></button>
        </span>
      </div>
      <p v-if="!providers.remoteProxyProviders.length">当前配置没有远程代理集合。</p>
    </article>
    <article class="surface-card resource-page-card">
      <header class="resource-card-head">
        <h2>规则集合 <small>{{ providers.remoteRuleProviders.length }}</small></h2>
        <button type="button" class="quiet-button" :disabled="refreshingRule || !providers.remoteRuleProviders.length" @click="refreshAllRule">{{ refreshingRule ? '更新中…' : '全部更新' }}</button>
      </header>
      <div v-for="item in providers.remoteRuleProviders" :key="item.name" class="resource-page-row" :class="{ 'row-failed': providers.opOf(item.name, 'rule').error, 'row-updating': providers.opOf(item.name, 'rule').refreshing }">
        <button type="button" class="resource-row-main" @click="viewing = { kind: 'rule', name: item.name }">
          <strong>{{ item.name }}</strong>
          <small>{{ item.ruleCount ?? 0 }} 条规则</small>
          <small v-if="providers.opOf(item.name, 'rule').error" class="row-error" role="alert">{{ providers.opOf(item.name, 'rule').error }}</small>
        </button>
        <span class="row-actions">
          <button class="icon-control" type="button" aria-label="查看规则集合配置" title="查看配置" @click="viewing = { kind: 'rule', name: item.name }"><AppIcon name="eye" :size="16" /></button>
          <button class="icon-control" type="button" :class="{ spinning: providers.opOf(item.name, 'rule').refreshing }" :disabled="providers.opOf(item.name, 'rule').refreshing" :aria-label="providers.opOf(item.name, 'rule').refreshing ? '更新中' : '更新规则集合'" @click="providers.refreshRuleProvider(item.name)"><AppIcon name="refresh" :size="16" /></button>
        </span>
      </div>
      <p v-if="!providers.remoteRuleProviders.length">当前配置没有远程规则集合。</p>
    </article>
  </section>
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
        <div class="detail-item" v-if="viewing.kind === 'proxy'"><dt>订阅信息</dt><dd>{{ subscriptionText(viewTarget as MihomoProxyProvider | null) }}</dd></div>
      </dl>
      <p class="detail-note">远程地址与间隔来自当前配置文件的集合声明；运行状态来自控制器。</p>
    </div>
  </DetailDrawer>
</div></template>

<style scoped>
.resource-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.resource-row-main { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.resource-row-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-row-main small { color: var(--app-muted); font-size: 11px; }
.row-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.row-error { color: var(--app-danger, #d64f4f); }
.row-failed .resource-row-main strong { color: var(--app-danger, #d64f4f); }
/* 批量更新时当前正在拉取的那一行轻微高亮，配合旋转图标指示进度。 */
.row-updating .resource-row-main strong { color: var(--app-purple); }
.detail-list { display: grid; gap: 0; margin: 0; }
.detail-item { display: flex; justify-content: space-between; gap: 14px; padding: 8px 0; border-top: 1px solid var(--app-divider); font-size: 12px; }
.detail-item:first-child { border-top: 0; }
.detail-item dt { color: var(--app-muted); flex-shrink: 0; }
.detail-item dd { margin: 0; text-align: right; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.break-all { word-break: break-all; }
.detail-note { margin: 14px 0 0; color: var(--app-muted); font-size: 11px; }
.inline-error { margin-top: 8px; color: var(--app-danger, #d64f4f); font-size: 12px; }
.quiet-button { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.quiet-button:disabled { opacity: 0.5; }
</style>
