<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import GeodataSettingsPanel from '../components/GeodataSettingsPanel.vue'
import { useKernelStore } from '../stores/kernel'
import { useProvidersStore } from '../stores/providers'

const kernel = useKernelStore()
const providers = useProvidersStore()
const refreshing = ref(false)
const total = computed(() => providers.remoteProxyProviders.length + providers.remoteRuleProviders.length)
async function load(): Promise<void> {
  if (kernel.status.phase !== 'running') return
  await Promise.all([providers.loadProxyProviders(), providers.loadRuleProviders()])
}
async function refreshAll(): Promise<void> { refreshing.value = true; try { await providers.refreshAllProviders() } finally { refreshing.value = false } }
onMounted(() => void load())
watch(() => kernel.status.phase, (phase) => { if (phase === 'running') void load() })
</script>

<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>外部资源</h1><p>集中查看代理 Provider、规则 Provider 与地理数据库。</p></div><button type="button" class="secondary-button" :disabled="refreshing || kernel.status.phase !== 'running' || !total" @click="refreshAll"><AppIcon name="refresh" :size="15" />{{ refreshing ? '更新中…' : '全部更新' }}</button></header><p v-if="kernel.status.phase !== 'running'" class="inline-note">启动内核后即可读取和更新 Provider。</p><section v-else class="resource-page-groups"><article class="surface-card resource-page-card"><h2>代理 Provider <small>{{ providers.remoteProxyProviders.length }}</small></h2><div v-for="item in providers.remoteProxyProviders" :key="item.name" class="resource-page-row"><span><strong>{{ item.name }}</strong><small>{{ item.proxies?.length ?? 0 }} 个节点</small></span><button class="icon-control" type="button" aria-label="更新代理 Provider" @click="providers.refreshProxyProvider(item.name)"><AppIcon name="refresh" :size="16" /></button></div><p v-if="!providers.remoteProxyProviders.length">当前配置没有远程代理 Provider。</p></article><article class="surface-card resource-page-card"><h2>规则 Provider <small>{{ providers.remoteRuleProviders.length }}</small></h2><div v-for="item in providers.remoteRuleProviders" :key="item.name" class="resource-page-row"><span><strong>{{ item.name }}</strong><small>{{ item.ruleCount ?? 0 }} 条规则</small></span><button class="icon-control" type="button" aria-label="更新规则 Provider" @click="providers.refreshRuleProvider(item.name)"><AppIcon name="refresh" :size="16" /></button></div><p v-if="!providers.remoteRuleProviders.length">当前配置没有远程规则 Provider。</p></article></section><GeodataSettingsPanel /></div></template>
