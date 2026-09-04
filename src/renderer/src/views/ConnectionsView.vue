<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConnectionsStore } from '../stores/connections'
import { formatBytes } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import AppSelect from '../components/AppSelect.vue'

const store = useConnectionsStore()
const { status, lastError, search, visibleConnections, selectedConnection, selectedId, closingIds, closingMany, actionError, sort, summary } = storeToRefs(store)
const confirmClose = ref(false)
const drawerOpen = computed(() => Boolean(selectedConnection.value))
const SORT_OPTIONS = [
  { value: 'traffic', label: '按流量' }, { value: 'started', label: '按建立时间' },
  { value: 'process', label: '按进程' }, { value: 'host', label: '按主机' }
] as const

function endpoint(connection: (typeof visibleConnections.value)[number]): string {
  return connection.metadata.host || connection.metadata.destinationIP || '未知目标'
}

onMounted(store.connect)
onUnmounted(store.disconnect)
</script>

<template>
  <div class="page-shell connections-view">
    <header class="connections-header">
      <div><h1>连接</h1><p>{{ status === 'live' ? '实时' : status === 'loading' ? '连接中' : '已断开' }} · {{ visibleConnections.length }} 条</p></div>
      <div class="connection-totals" aria-label="连接累计流量">
        <span><AppIcon name="upload" :size="14" />{{ formatBytes(summary?.uploadTotal ?? 0) }}</span>
        <span><AppIcon name="download" :size="14" />{{ formatBytes(summary?.downloadTotal ?? 0) }}</span>
      </div>
    </header>
    <div class="connections-toolbar">
      <label class="search-control"><AppIcon name="search" :size="15" /><input v-model="search" type="search" placeholder="进程、域名、IP 或策略" aria-label="筛选连接" /></label>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" label="连接排序" />
      <button type="button" class="danger-button" :disabled="closingMany || !visibleConnections.length" @click="confirmClose = true">
        <AppIcon name="close" :size="14" />{{ closingMany ? '正在关闭…' : search ? '关闭筛选结果' : '关闭全部' }}
      </button>
    </div>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p>
    <p v-if="actionError" class="inline-error">{{ actionError }}</p>
    <section class="surface-card connection-list full-width-list" aria-label="活动连接">
        <button v-for="connection in visibleConnections" :key="connection.id" type="button" class="connection-row" :class="{ selected: selectedId === connection.id }" @click="store.select(connection.id)">
          <span class="connection-process">{{ connection.metadata.process || '未知进程' }}<small>{{ endpoint(connection) }}</small></span>
          <span>{{ formatBytes(connection.download + connection.upload) }}<small>{{ connection.chains.join(' → ') || 'DIRECT' }}</small></span>
        </button>
        <div v-if="!visibleConnections.length" class="connection-empty">{{ status === 'loading' ? '正在载入连接…' : '没有匹配的连接' }}</div>
    </section>
    <DetailDrawer :open="drawerOpen" title="连接详情" :subtitle="selectedConnection ? `${selectedConnection.metadata.process || '未知进程'} · ${endpoint(selectedConnection)}` : ''" @close="store.select(null)">
      <section class="connection-detail drawer-detail">
        <template v-if="selectedConnection">
          <header><div><span>连接详情</span><h2>{{ selectedConnection.metadata.process || '未知进程' }}</h2></div><button type="button" class="danger-button" :disabled="closingIds.includes(selectedConnection.id)" @click="store.close(selectedConnection.id)">{{ closingIds.includes(selectedConnection.id) ? '正在关闭…' : '关闭连接' }}</button></header>
          <dl>
            <div><dt>目标</dt><dd>{{ endpoint(selectedConnection) }}</dd></div>
            <div><dt>地址</dt><dd>{{ selectedConnection.metadata.destinationIP || '—' }}:{{ selectedConnection.metadata.destinationPort || '—' }}</dd></div>
            <div><dt>网络</dt><dd>{{ selectedConnection.metadata.network || '—' }}</dd></div>
            <div><dt>规则</dt><dd>{{ selectedConnection.rule }} {{ selectedConnection.rulePayload }}</dd></div>
            <div><dt>策略链</dt><dd>{{ selectedConnection.chains.join(' → ') || 'DIRECT' }}</dd></div>
            <div><dt>上传 / 下载</dt><dd>{{ formatBytes(selectedConnection.upload) }} / {{ formatBytes(selectedConnection.download) }}</dd></div>
            <div><dt>开始时间</dt><dd>{{ selectedConnection.start || '—' }}</dd></div>
          </dl>
        </template>
        <div v-else class="connection-empty">连接已关闭</div>
      </section>
    </DetailDrawer>
    <ConfirmModal :open="confirmClose" title="关闭这些连接？" description="这会立即中断当前列表中的网络连接，应用可能会自动重新建立连接。" confirm-label="确认关闭" :busy="closingMany" @close="confirmClose = false" @confirm="store.closeMany(visibleConnections.map((item) => item.id)).finally(() => { confirmClose = false })" />
  </div>
</template>
