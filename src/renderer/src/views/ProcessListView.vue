<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useConnectionsStore } from '../stores/connections'
import { groupConnectionsByProcess } from '../lib/connection-groups'
import { formatBytes } from '../lib/format'

const store = useConnectionsStore()
const selectedKey = ref<string | null>(null)
const sort = ref<'traffic' | 'name'>('traffic')
const groups = computed(() => {
  const rows = groupConnectionsByProcess(store.snapshot?.connections ?? [])
  return sort.value === 'name' ? [...rows].sort((a, b) => a.label.localeCompare(b.label)) : rows
})
const selected = computed(() => groups.value.find((group) => group.key === selectedKey.value) ?? null)
onMounted(store.connect)
onUnmounted(store.disconnect)
</script>
<template><div class="page-shell list-detail-page"><header class="page-toolbar"><div><h1>进程</h1><small aria-live="polite">{{ store.status === 'live' ? `${groups.length} 个活动进程` : '正在连接' }}</small></div><select v-model="sort" aria-label="进程排序方式"><option value="traffic">按流量排序</option><option value="name">按名称排序</option></select></header><div class="list-detail-grid"><div class="entity-list"><button v-for="group in groups" :key="group.key" type="button" class="entity-row" :class="{ selected: selectedKey === group.key }" :aria-pressed="selectedKey === group.key" @click="selectedKey = group.key"><i>{{ group.label.slice(0, 2) }}</i><span>{{ group.label }}<small>{{ group.subtitle }}</small></span><strong>{{ formatBytes(group.upload + group.download) }}<small>{{ group.connections.length }} 个连接</small></strong></button><p v-if="!groups.length" class="entity-empty">暂无活动进程</p></div><div class="empty-detail entity-detail"><template v-if="selected"><h2>{{ selected.label }}</h2><p>{{ selected.subtitle }}</p><dl><div><dt>活动连接</dt><dd>{{ selected.connections.length }}</dd></div><div><dt>上传</dt><dd>{{ formatBytes(selected.upload) }}</dd></div><div><dt>下载</dt><dd>{{ formatBytes(selected.download) }}</dd></div></dl><h3>目标</h3><ul><li v-for="connection in selected.connections" :key="connection.id"><span>{{ connection.metadata.host || connection.metadata.destinationIP || '未知目标' }}</span><small>{{ connection.chains.join(' → ') || 'DIRECT' }}</small></li></ul></template><p v-else>选择一个进程以查看详情</p></div></div><footer class="inline-setting"><button type="button" class="switch" aria-label="计费网络模式（尚未支持）" disabled /><strong>计费网络模式</strong><p>尚未实现；当前页面只显示 mihomo 报告的实时连接。</p></footer></div></template>
