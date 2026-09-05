<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConnectionsStore } from '../stores/connections'
import { formatBytes } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import AppSelect from '../components/AppSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import ProcessIcon from '../components/ProcessIcon.vue'
import { formatConnectionChain } from '@shared/connection-chain'

const store = useConnectionsStore()
const { status, lastError, search, visibleConnections, selectedConnection, selectedId, closingIds, closingMany, actionError, sort, summary, view, closedConnections } = storeToRefs(store)
const confirmClose = ref(false)
const drawerOpen = computed(() => Boolean(selectedConnection.value))
const SORT_OPTIONS = [{ value: 'traffic', label: '按流量' }, { value: 'started', label: '按建立时间' }, { value: 'process', label: '按进程' }, { value: 'host', label: '按主机' }] as const

function endpoint(connection: (typeof visibleConnections.value)[number]): string { return connection.metadata.host || connection.metadata.destinationIP || '未知目标' }
function elapsed(value?: string): string {
  if (!value) return '刚刚'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '刚刚'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds || 1} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}
onMounted(store.connect)
onUnmounted(store.disconnect)
</script>

<template>
  <div class="page-shell connections-view">
    <header class="connections-header"><div><h1>连接</h1><p v-if="status !== 'live'">{{ status === 'loading' ? '连接中' : '已断开' }}</p></div><div class="connection-totals" aria-label="连接累计流量"><span><AppIcon name="upload" :size="14" />{{ formatBytes(summary?.uploadTotal ?? 0) }}</span><span><AppIcon name="download" :size="14" />{{ formatBytes(summary?.downloadTotal ?? 0) }}</span></div></header>
    <div class="connection-view-tabs" role="tablist" aria-label="连接状态"><button type="button" :class="{ selected: view === 'active' }" @click="store.setView('active')">活动中 <span>{{ summary?.totalConnections ?? 0 }}</span></button><button type="button" :class="{ selected: view === 'closed' }" @click="store.setView('closed')">已关闭 <span>{{ closedConnections.length }}</span></button></div>
    <div class="connections-toolbar"><label class="search-control"><AppIcon name="search" :size="15" /><input v-model="search" type="search" placeholder="进程、域名、IP 或策略" aria-label="筛选连接" /></label><AppSelect v-model="sort" :options="SORT_OPTIONS" label="连接排序" /><button v-if="view === 'active'" type="button" class="danger-button" :disabled="closingMany || !visibleConnections.length" @click="confirmClose = true"><AppIcon name="close" :size="14" />{{ closingMany ? '正在关闭…' : '关闭全部' }}</button><button v-else type="button" class="secondary-button" :disabled="!closedConnections.length" @click="store.clearClosed"><AppIcon name="delete" :size="14" />清空</button></div>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p><p v-if="actionError" class="inline-error">{{ actionError }}</p>
    <section class="connection-list full-width-list" :aria-label="view === 'active' ? '活动连接' : '已关闭连接'">
      <article v-for="connection in visibleConnections" :key="connection.id" class="connection-card" :class="{ selected: selectedId === connection.id }"><button type="button" class="connection-card-main" @click="store.select(connection.id)"><ProcessIcon :path="connection.metadata.processPath" :name="connection.metadata.process" :size="22" /><span class="connection-identity"><strong>{{ connection.metadata.process || '未知进程' }} <i>→</i> {{ endpoint(connection) }}</strong><small><b>{{ connection.metadata.network || 'TCP' }}</b><b>{{ formatConnectionChain(connection.chains) }}</b><b>↑ {{ formatBytes(connection.upload) }} ↓ {{ formatBytes(connection.download) }}</b></small></span><time>{{ elapsed(view === 'closed' ? connection.closedAt : connection.start) }}</time><AppIcon name="next" :size="15" /></button><button v-if="view === 'active'" type="button" class="connection-close" :disabled="closingIds.includes(connection.id)" aria-label="关闭连接" @click="store.close(connection.id)"><AppIcon name="close" :size="17" /></button></article>
      <EmptyState v-if="!visibleConnections.length && status !== 'loading'" icon="connections" :title="search ? '没有匹配的连接' : view === 'closed' ? '没有已关闭连接' : '暂无活动连接'" :detail="search ? '请调整筛选条件。' : view === 'closed' ? '本次运行中结束的连接会保留在这里。' : '应用产生网络请求后，连接会实时显示在这里。'" /><div v-else-if="!visibleConnections.length" class="connection-empty">正在载入连接…</div>
    </section>
    <DetailDrawer :open="drawerOpen" title="连接详情" :subtitle="selectedConnection ? `${selectedConnection.metadata.process || '未知进程'} · ${endpoint(selectedConnection)}` : ''" @close="store.select(null)"><section class="connection-detail drawer-detail"><template v-if="selectedConnection"><header><div><span>{{ selectedConnection.closedAt ? '已关闭' : '活动中' }}</span><h2>{{ selectedConnection.metadata.process || '未知进程' }}</h2></div><button v-if="!selectedConnection.closedAt" type="button" class="danger-button" :disabled="closingIds.includes(selectedConnection.id)" @click="store.close(selectedConnection.id)">{{ closingIds.includes(selectedConnection.id) ? '正在关闭…' : '关闭连接' }}</button></header><dl><div><dt>目标</dt><dd>{{ endpoint(selectedConnection) }}</dd></div><div><dt>地址</dt><dd>{{ selectedConnection.metadata.destinationIP || '—' }}:{{ selectedConnection.metadata.destinationPort || '—' }}</dd></div><div><dt>网络</dt><dd>{{ selectedConnection.metadata.network || '—' }}</dd></div><div><dt>规则</dt><dd>{{ selectedConnection.rule }} {{ selectedConnection.rulePayload }}</dd></div><div><dt>策略链</dt><dd>{{ formatConnectionChain(selectedConnection.chains) }}</dd></div><div><dt>上传 / 下载</dt><dd>{{ formatBytes(selectedConnection.upload) }} / {{ formatBytes(selectedConnection.download) }}</dd></div><div><dt>开始时间</dt><dd>{{ selectedConnection.start || '—' }}</dd></div></dl></template><div v-else class="connection-empty">连接记录不存在</div></section></DetailDrawer>
    <ConfirmModal :open="confirmClose" title="关闭这些连接？" description="这会立即中断当前列表中的网络连接，应用可能会自动重新建立连接。" confirm-label="确认关闭" :busy="closingMany" @close="confirmClose = false" @confirm="store.closeMany(visibleConnections.map((item) => item.id)).finally(() => { confirmClose = false })" />
  </div>
</template>
