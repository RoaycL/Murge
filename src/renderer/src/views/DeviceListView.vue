<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useConnectionsStore } from '../stores/connections'
import { groupConnectionsByDevice } from '../lib/connection-groups'
import { formatBytes } from '../lib/format'

const store = useConnectionsStore()
const selectedKey = ref<string | null>(null)
const sort = ref<'address' | 'traffic'>('address')
const groups = computed(() => {
  const rows = groupConnectionsByDevice(store.snapshot?.connections ?? [])
  return sort.value === 'address' ? [...rows].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })) : rows
})
const selected = computed(() => groups.value.find((group) => group.key === selectedKey.value) ?? null)
onMounted(store.connect)
onUnmounted(store.disconnect)
</script>
<template><div class="page-shell list-detail-page"><header class="page-toolbar"><div><h1>设备</h1><small aria-live="polite">{{ store.status === 'live' ? `${groups.length} 个活动地址` : '正在连接' }}</small></div><select v-model="sort" aria-label="设备排序方式"><option value="address">按 IP 排序</option><option value="traffic">按流量排序</option></select></header><div class="list-detail-grid"><div class="entity-list"><button v-for="group in groups" :key="group.key" type="button" class="entity-row" :class="{ selected: selectedKey === group.key }" :aria-pressed="selectedKey === group.key" @click="selectedKey = group.key"><i>IP</i><span>{{ group.label }}<small>{{ group.subtitle }}</small></span><strong>{{ formatBytes(group.upload + group.download) }}<small>{{ group.connections.length }} 个连接</small></strong></button><p v-if="!groups.length" class="entity-empty">暂无活动设备</p></div><div class="empty-detail entity-detail"><template v-if="selected"><h2>{{ selected.label }}</h2><p>{{ selected.subtitle }}</p><dl><div><dt>活动连接</dt><dd>{{ selected.connections.length }}</dd></div><div><dt>上传</dt><dd>{{ formatBytes(selected.upload) }}</dd></div><div><dt>下载</dt><dd>{{ formatBytes(selected.download) }}</dd></div></dl><h3>进程</h3><ul><li v-for="connection in selected.connections" :key="connection.id"><span>{{ connection.metadata.process || '未知进程' }}</span><small>{{ connection.metadata.host || connection.metadata.destinationIP || '未知目标' }}</small></li></ul></template><p v-else>选择一个设备以查看详情</p></div></div><footer class="inline-setting"><button type="button" class="switch" aria-label="允许局域网连接（尚未支持）" disabled /><strong>允许局域网连接</strong><p>由已验证的运行配置决定；此处暂不提供未经确认的开关。</p></footer></div></template>
