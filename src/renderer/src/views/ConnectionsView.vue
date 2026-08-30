<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useConnectionsStore } from '../stores/connections'
import { formatBytes } from '../lib/format'

const store = useConnectionsStore()
const { status, lastError, search, visibleConnections, selectedConnection, selectedId, closingIds, actionError } = storeToRefs(store)

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
      <input v-model="search" type="search" placeholder="进程、域名、IP 或策略" aria-label="筛选连接" />
    </header>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p>
    <p v-if="actionError" class="inline-error">{{ actionError }}</p>
    <div class="connections-layout">
      <section class="surface-card connection-list" aria-label="活动连接">
        <button v-for="connection in visibleConnections" :key="connection.id" type="button" class="connection-row" :class="{ selected: selectedId === connection.id }" @click="store.select(connection.id)">
          <span class="connection-process">{{ connection.metadata.process || '未知进程' }}<small>{{ endpoint(connection) }}</small></span>
          <span>{{ formatBytes(connection.download + connection.upload) }}<small>{{ connection.chains.join(' → ') || 'DIRECT' }}</small></span>
        </button>
        <div v-if="!visibleConnections.length" class="connection-empty">{{ status === 'loading' ? '正在载入连接…' : '没有匹配的连接' }}</div>
      </section>
      <section class="surface-card connection-detail">
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
        <div v-else class="connection-empty">选择一条连接以查看详情</div>
      </section>
    </div>
  </div>
</template>

