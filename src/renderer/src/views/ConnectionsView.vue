<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConnectionsStore } from '../stores/connections'
import { formatBytes, formatWallClock } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import AppSelect from '../components/AppSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import ProcessIcon from '../components/ProcessIcon.vue'
import ConnectionRulePanel from '../components/ConnectionRulePanel.vue'
import ConnectionDiagnosisPanel from '../components/ConnectionDiagnosisPanel.vue'
import TopologyPanel from '../components/TopologyPanel.vue'
import { formatConnectionChain } from '@shared/connection-chain'
import { usePoliciesStore } from '../stores/policies'
import { useLocalStore } from '../stores/local'
import { processBrand, proxyTypeBrand, type BrandIconName } from '../lib/brand-icons'

const store = useConnectionsStore()
const { status, lastError, search, visibleConnections, selectedConnection, selectedId, closingIds, closingMany, actionError, sort, summary, view, closedConnections } = storeToRefs(store)
const confirmClose = ref(false)
const topologyOpen = ref(false)
const drawerOpen = computed(() => Boolean(selectedConnection.value))
const SORT_OPTIONS = [{ value: 'traffic', label: t('connections.sortTraffic') }, { value: 'started', label: t('connections.sortTime') }, { value: 'process', label: t('connections.sortProcess') }, { value: 'host', label: t('connections.sortHost') }] as const

const policies = usePoliciesStore()
const local = useLocalStore()
/** Connections leaving through a Tailscale or WireGuard node show that mark. */
function brandOf(connection: (typeof visibleConnections.value)[number]): BrandIconName | null {
  const own = processBrand(connection.metadata.process, connection.metadata.processPath)
  if (own) return own
  for (const hop of connection.chains ?? []) {
    const type = policies.proxies?.proxies?.[hop]?.type ?? local.settings.nodes.find((node) => node.config.name === hop)?.config.type
    const brand = proxyTypeBrand(type)
    if (brand) return brand
  }
  return null
}
function endpoint(connection: (typeof visibleConnections.value)[number]): string { return connection.metadata.host || connection.metadata.destinationIP || t('diagnosis.unknownTarget') }
function mitmLabel(connection: (typeof visibleConnections.value)[number]): string { if (connection.chains?.some((name) => name.endsWith('-MITM'))) return t('connections.decrypted'); return connection.metadata.sourceIP === '127.0.0.2' ? t('connections.decryptReturn') : '' }
function elapsed(value?: string): string {
  if (!value) return t('common.justNow')
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return t('common.justNow')
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return t('connections.secondsAgo', [seconds || 1])
  if (seconds < 3600) return t('common.minutesAgo', [Math.floor(seconds / 60)])
  return t('common.hoursAgo', [Math.floor(seconds / 3600)])
}
</script>

<template>
  <div class="page-shell connections-view">
    <header class="connections-header"><div><h1>{{ t('nav.connections') }}</h1><p v-if="status !== 'live'">{{ status === 'loading' ? t('common.connecting') : t('common.disconnected') }}</p></div><div class="connections-header-side"><button type="button" class="secondary-button topology-entry" @click="topologyOpen = true"><AppIcon name="connections" :size="14" />{{ t('topology.title') }}</button><div class="connection-totals" :aria-label="t('connections.totalLabel')"><span><AppIcon name="upload" :size="14" />{{ formatBytes(summary?.uploadTotal ?? 0) }}</span><span><AppIcon name="download" :size="14" />{{ formatBytes(summary?.downloadTotal ?? 0) }}</span></div></div></header>
    <div class="connection-view-tabs" role="tablist" :aria-label="t('connections.statusLabel')"><button type="button" :class="{ selected: view === 'active' }" @click="store.setView('active')">{{ t('connections.active') }} <span>{{ summary?.totalConnections ?? 0 }}</span></button><button type="button" :class="{ selected: view === 'closed' }" @click="store.setView('closed')">{{ t('connections.closed') }} <span>{{ closedConnections.length }}</span></button></div>
    <div class="connections-toolbar"><label class="search-control"><AppIcon name="search" :size="15" /><input v-model="search" type="search" :placeholder="t('connections.filterPlaceholder')" :aria-label="t('connections.filterLabel')" /></label><AppSelect v-model="sort" :options="SORT_OPTIONS" :label="t('connections.sortLabel')" /><button v-if="view === 'active'" type="button" class="danger-button connection-toolbar-action" :disabled="closingMany || !visibleConnections.length" @click="confirmClose = true"><AppIcon name="close" :size="14" />{{ closingMany ? t('connections.closing') : t('connections.closeAll') }}</button><button v-else type="button" class="secondary-button connection-toolbar-action" :disabled="!closedConnections.length" @click="store.clearClosed"><AppIcon name="delete" :size="14" />{{ t('common.clear') }}</button></div>
    <p v-if="lastError" class="inline-error">{{ lastError }}</p><p v-if="actionError" class="inline-error">{{ actionError }}</p>
    <section class="connection-list full-width-list" :aria-label="view === 'active' ? t('common.activeConnections') : t('connections.closedConnections')">
      <article v-for="connection in visibleConnections" :key="connection.id" class="connection-card" :class="{ selected: selectedId === connection.id }"><button type="button" class="connection-card-main" @click="store.select(connection.id)"><ProcessIcon :path="connection.metadata.processPath" :name="connection.metadata.process" :brand="brandOf(connection)" :size="22" /><span class="connection-identity"><strong>{{ connection.metadata.process || t('common.unknownProcess') }} <i>→</i> {{ endpoint(connection) }}</strong><small><b>{{ connection.metadata.network || 'TCP' }}</b><b>{{ formatConnectionChain(connection.chains) }}</b><b v-if="mitmLabel(connection)" class="connection-mitm">{{ mitmLabel(connection) }}</b><b>↑ {{ formatBytes(connection.upload) }} ↓ {{ formatBytes(connection.download) }}</b></small></span><time>{{ elapsed(view === 'closed' ? connection.closedAt : connection.start) }}</time><AppIcon name="next" :size="15" /></button><button v-if="view === 'active'" type="button" class="connection-close" :disabled="closingIds.includes(connection.id)" :aria-label="t('connections.closeOne')" @click="store.close(connection.id)"><AppIcon name="close" :size="17" /></button></article>
      <EmptyState v-if="!visibleConnections.length && status !== 'loading'" icon="connections" :title="search ? t('connections.noMatch') : view === 'closed' ? t('connections.noClosed') : t('connections.noActive')" :detail="search ? t('connections.adjustFilter') : view === 'closed' ? t('connections.closedHint') : t('connections.activeHint')" /><div v-else-if="!visibleConnections.length" class="connection-empty">{{ t('connections.loading') }}</div>
    </section>
    <DetailDrawer :open="drawerOpen" :title="t('connections.detailTitle')" :subtitle="selectedConnection ? `${selectedConnection.metadata.process || t('common.unknownProcess')} · ${endpoint(selectedConnection)}` : ''" @close="store.select(null)"><section class="connection-detail drawer-detail"><template v-if="selectedConnection"><header><div><span>{{ selectedConnection.closedAt ? t('connections.closed') : t('connections.active') }}</span><h2>{{ selectedConnection.metadata.process || t('common.unknownProcess') }}</h2></div><button v-if="!selectedConnection.closedAt" type="button" class="danger-button" :disabled="closingIds.includes(selectedConnection.id)" @click="store.close(selectedConnection.id)">{{ closingIds.includes(selectedConnection.id) ? t('connections.closing') : t('connections.closeOne') }}</button></header><dl><div><dt>{{ t('diagnosis.target') }}</dt><dd>{{ endpoint(selectedConnection) }}</dd></div><div><dt>{{ t('common.address') }}</dt><dd>{{ selectedConnection.metadata.destinationIP || '—' }}:{{ selectedConnection.metadata.destinationPort || '—' }}</dd></div><div><dt>{{ t('connections.network') }}</dt><dd>{{ selectedConnection.metadata.network || '—' }}</dd></div><div><dt>{{ t('common.rule') }}</dt><dd>{{ selectedConnection.rule }} {{ selectedConnection.rulePayload }}</dd></div><div><dt>{{ t('connections.chain') }}</dt><dd>{{ formatConnectionChain(selectedConnection.chains) }}</dd></div><div v-if="mitmLabel(selectedConnection)"><dt>{{ t('common.httpsDecryption') }}</dt><dd>{{ mitmLabel(selectedConnection) === t('connections.decrypted') ? t('connections.decryptedHint') : t('connections.decryptReturnHint') }}</dd></div><div><dt>{{ t('connections.upDown') }}</dt><dd>{{ formatBytes(selectedConnection.upload) }} / {{ formatBytes(selectedConnection.download) }}</dd></div><div><dt>{{ t('connections.startTime') }}</dt><dd>{{ selectedConnection.start ? formatWallClock(selectedConnection.start, { milliseconds: true }) : '—' }}</dd></div></dl><ConnectionDiagnosisPanel :connection="selectedConnection" /><ConnectionRulePanel :connection="selectedConnection" /></template><div v-else class="connection-empty">{{ t('connections.missing') }}</div></section></DetailDrawer>
    <DetailDrawer :open="topologyOpen" :title="t('topology.title')" :subtitle="t('connections.summary', [summary?.distinctProcesses ?? 0, summary?.totalConnections ?? 0])" @close="topologyOpen = false"><TopologyPanel v-if="topologyOpen" /></DetailDrawer>
    <ConfirmModal :open="confirmClose" :title="t('connections.closeAllTitle')" :description="t('connections.closeAllDescription')" :confirm-label="t('connections.closeAllConfirm')" :busy="closingMany" @close="confirmClose = false" @confirm="store.closeMany(visibleConnections.map((item) => item.id)).finally(() => { confirmClose = false })" />
  </div>
</template>

<style scoped>
.connections-header-side { display: flex; align-items: center; gap: var(--space-5); }
.topology-entry { display: inline-flex; align-items: center; gap: var(--space-2); height: 28px; padding: 0 10px; border-radius: var(--radius-control); font-size: var(--font-size-xs); white-space: nowrap; }
.topology-card { padding: 15px 16px; width: 100%; }
</style>
