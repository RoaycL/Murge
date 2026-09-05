<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SpeedSparkline from '../components/SpeedSparkline.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import AppIcon from '../components/AppIcon.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import UsageHistoryPanel from '../components/UsageHistoryPanel.vue'
import NetworkMetadataPanel from '../components/NetworkMetadataPanel.vue'
import TopologyPanel from '../components/TopologyPanel.vue'
import { useTrafficStore } from '../stores/traffic'
import { useConnectionsStore } from '../stores/connections'
import { useRuntimeStore } from '../stores/runtime'
import { useKernelStore } from '../stores/kernel'
import { useNetworkMetadataStore } from '../stores/network-metadata'
import { useLatencyStore } from '../stores/latency'
import { formatBytes, formatBytesParts, formatRate } from '../lib/format'
import { brand } from '@shared/brand'
import { useRouter } from 'vue-router'
import { usePoliciesStore } from '../stores/policies'
import AppSelect from '../components/AppSelect.vue'

const traffic = useTrafficStore()
const connections = useConnectionsStore()
const runtime = useRuntimeStore()
const kernel = useKernelStore()
const networkMeta = useNetworkMetadataStore()
const latency = useLatencyStore()
const router = useRouter()
const policies = usePoliciesStore()
const summaryDrawer = ref<'network' | 'usage' | 'topology' | null>(null)

// The card samples itself once a minute so the numbers never go stale.
const LATENCY_REFRESH_MS = 60_000
let latencyTimer: number | null = null

// 每一格：实测到显示（ms 保留整数；未测到显示 em dash）。
function delayText(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}`
}
const gatewayText = computed(() => delayText(latency.gatewayMs))
const dnsText = computed(() => delayText(latency.dnsMs))
const proxyText = computed(() => delayText(latency.proxyMs))
const headlineText = computed(() => (latency.state === 'idle' || latency.state === 'probing' ? '···' : proxyText.value))
const diagnosisButtonLabel = computed(() => (latency.state === 'probing' ? '检测中…' : '网络诊断'))

onMounted(() => {
  kernel.connect()
  traffic.connect()
  connections.connect()
  void runtime.refresh()
  void policies.load()
  void networkMeta.init()
  latency.init()
  // Keep the card honest without hammering the controller: one sample a minute
  // plus the manual refresh button.
  latencyTimer = window.setInterval(() => void latency.probe(), LATENCY_REFRESH_MS)
})

// Same lifecycle contract as ConnectionsView / LogsView / ProcessListView:
// drop the push subscriptions when the view unmounts so an inactive page
// stops accumulating snapshots. The main-process streams stay shared (the
// IPC forwarder keeps them alive), only this window's listeners detach.
onUnmounted(() => {
  traffic.disconnect()
  connections.disconnect()
  if (latencyTimer != null) {
    window.clearInterval(latencyTimer)
    latencyTimer = null
  }
})

const up = computed(() => formatRate(traffic.current?.up ?? 0))
const down = computed(() => formatRate(traffic.current?.down ?? 0))
const activeCount = computed(() => connections.summary?.totalConnections ?? 0)
const processCount = computed(() => connections.summary?.distinctProcesses ?? 0)
const directBytes = computed(() => connections.summary?.directDownload ?? 0)
const proxyBytes = computed(() => connections.summary?.proxyDownload ?? 0)

// 全部/仅代理 scope lives in the store so every ranking slot stays consistent.
const rankScope = computed(() => connections.rankScope)
// Which dimension the rank list groups by (进程与设备 / 域名 / 策略).
const rankDimension = ref<'process' | 'host' | 'policy'>('process')
const rankedList = computed(() => {
  if (rankDimension.value === 'host') return connections.topHosts
  if (rankDimension.value === 'policy') return connections.topPolicies
  return connections.topProcesses
})

// 总计: 当前 = sum of live connections (DIRECT + 代理); 历史 = kernel-lifetime
// cumulative byte counter from the /traffic stream. The DIRECT/代理 split keeps
// using the live connection ratio so both figures always reconcile to the total.
const totalScope = ref<'current' | 'history'>('current')
const currentTotalBytes = computed(() => directBytes.value + proxyBytes.value)
const displayedTotalBytes = computed(() =>
  totalScope.value === 'history' ? traffic.totalDownload : currentTotalBytes.value
)
const directRatio = computed(() => {
  const totalBytes = currentTotalBytes.value
  return totalBytes ? directBytes.value / totalBytes : 0
})
const directDisplayed = computed(() => Math.round(displayedTotalBytes.value * directRatio.value))
const proxyDisplayed = computed(() => displayedTotalBytes.value - directDisplayed.value)
const total = computed(() => formatBytesParts(displayedTotalBytes.value))
const direct = computed(() => formatBytesParts(directDisplayed.value))
const proxy = computed(() => formatBytesParts(proxyDisplayed.value))
const directPct = computed(() =>
  displayedTotalBytes.value ? Math.round((directDisplayed.value / displayedTotalBytes.value) * 100) : 0
)

const modeLabel = computed(() => {
  const map = { rule: '规则判定', global: '全局代理', direct: '直接连接' } as const
  return map[policies.mode]
})
const modeOptions = [
  { value: 'rule', label: '规则判定' },
  { value: 'global', label: '全局代理' },
  { value: 'direct', label: '直接连接' }
]
const selectedMode = computed({
  get: () => policies.mode,
  set: (value: string) => {
    void policies.setMode(value as 'rule' | 'global' | 'direct').then(() => runtime.refresh())
  }
})
const externalIpText = computed(() => networkMeta.ipText)

const connStatus = computed(() => connections.status)
const connDotClass = computed(() => {
  if (connStatus.value === 'live') return 'online-dot'
  if (connStatus.value === 'loading') return 'online-dot pending'
  return 'online-dot offline'
})
const connStateLabel = computed(() => {
  if (connStatus.value === 'loading') return '载入中'
  if (connStatus.value === 'disconnected') return '已断开'
  if (connStatus.value === 'error') return '数据异常'
  return ''
})

// The chart reflects the live /traffic stream rather than inventing history:
// the most recent samples make the card come alive while the kernel is running.
const chartBars = computed<number[]>(() => {
  const samples = traffic.samples.slice(-23)
  if (!samples.length) return Array.from({ length: 23 }, () => 0)
  const max = Math.max(...samples.map((sample) => sample.down), 1)
  return samples.map((sample) => Math.round((sample.down / max) * 100))
})
</script>

<template>
  <div class="activity-view page-shell">
    <header class="activity-header">
      <h1>活动</h1>
    </header>

    <section class="runtime-context" aria-label="运行上下文">
      <div><span>网络</span><strong>{{ runtime.summary?.networkName ?? '以太网' }}</strong></div>
      <div><span>配置</span><strong>{{ runtime.summary?.profileName ?? brand.defaultProfileName }}</strong></div>
      <div class="runtime-mode-picker"><span>出站模式</span><AppSelect v-model="selectedMode" :options="modeOptions" :label="`出站模式：${modeLabel}`" plain /></div>
      <button type="button" class="runtime-detail-link" aria-label="查看网络信息" @click="summaryDrawer = 'network'"><span>外部 IP</span><strong>{{ externalIpText }}</strong><AppIcon name="next" :size="14" /></button>
    </section>

    <section class="dashboard-grid">
      <SurfaceCard class="latency-card">
        <div class="card-title-row">
          <span class="metric-label">INTERNET 延迟<button type="button" class="latency-refresh" :disabled="latency.state === 'probing'" aria-label="重新测速" @click="latency.probe()"><AppIcon name="refresh" :size="12" /></button></span>
          <button type="button" class="quiet-button" @click="summaryDrawer = 'network'">{{ diagnosisButtonLabel }}</button>
        </div>
        <div class="large-metric" :class="{ 'metric-dimmed': headlineText === '—' }">{{ headlineText }}<span>ms</span></div>
        <div class="latency-breakdown">
          <div><span>路由</span><strong>{{ gatewayText }}<i v-if="gatewayText !== '—'" class="delay-unit">ms</i></strong></div>
          <div><span>DNS</span><strong>{{ dnsText }}<i v-if="dnsText !== '—'" class="delay-unit">ms</i></strong></div>
          <div><span>{{ latency.proxyNode ?? '当前策略' }}</span><strong>{{ proxyText }}<i v-if="proxyText !== '—'" class="delay-unit">ms</i></strong></div>
        </div>
      </SurfaceCard>

      <div class="speed-grid">
        <SpeedSparkline kind="upload" title="上传" :value="up.value" :unit="up.unit" ceiling="1.0 MB/s" middle="524 KB/s" :series="traffic.uploadSeries" />
        <SpeedSparkline kind="download" title="下载" :value="down.value" :unit="down.unit" ceiling="2.1 MB/s" middle="1.0 MB/s" :series="traffic.downloadSeries" />
      </div>

      <SurfaceCard class="connections-card">
        <div class="card-title-row"><span class="metric-label">活动连接<span v-if="connStateLabel" class="stream-state">{{ connStateLabel }}</span></span><i :class="connDotClass" /></div>
        <button type="button" class="connections-summary-link" @click="router.push('/connections')"><strong>{{ activeCount }}</strong><span>查看连接</span><AppIcon name="next" :size="15" /></button>
        <button type="button" class="topology-inline" @click="summaryDrawer = 'topology'"><AppIcon name="connections" :size="16" /><span><strong>活动拓扑</strong><small>{{ processCount }} 个进程 · {{ activeCount }} 条连接</small></span><AppIcon name="next" :size="14" /></button>
      </SurfaceCard>

      <SurfaceCard class="traffic-card">
        <div class="card-title-row"><span class="metric-label">流量</span><div class="segmented" role="group" aria-label="流量范围"><button type="button" :class="{ selected: rankScope === 'all' }" :aria-pressed="rankScope === 'all'" @click="connections.setRankScope('all')">全部</button><button type="button" :class="{ selected: rankScope === 'proxy' }" :aria-pressed="rankScope === 'proxy'" @click="connections.setRankScope('proxy')">仅代理</button></div></div>
        <div class="bar-chart" aria-label="最近流量">
          <i v-for="(height, index) in chartBars" :key="index" :style="{ height: `${height}%` }" />
        </div>
        <div class="chart-axis"><span>最近</span><span>1 分钟</span></div>
        <div class="rank-tabs" role="group" aria-label="流量排行维度"><button type="button" :class="{ selected: rankDimension === 'process' }" :aria-pressed="rankDimension === 'process'" @click="rankDimension = 'process'">进程与设备</button><button type="button" :class="{ selected: rankDimension === 'host' }" :aria-pressed="rankDimension === 'host'" @click="rankDimension = 'host'">域名</button><button type="button" :class="{ selected: rankDimension === 'policy' }" :aria-pressed="rankDimension === 'policy'" @click="rankDimension = 'policy'">策略</button></div>
        <div class="rank-list">
          <div v-for="item in rankedList" :key="item.name" class="rank-row">
            <span class="rank-icon">{{ item.name.slice(0, 2) }}</span>
            <div><span>{{ item.name }}</span><i><b :style="{ width: `${item.width}%` }" /></i></div>
            <strong>{{ formatBytes(item.download) }}</strong>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="total-card">
        <div class="card-title-row"><span class="metric-label">总计</span><div class="segmented" role="group" aria-label="总计时间范围"><button type="button" :class="{ selected: totalScope === 'current' }" :aria-pressed="totalScope === 'current'" @click="totalScope = 'current'">当前</button><button type="button" :class="{ selected: totalScope === 'history' }" :aria-pressed="totalScope === 'history'" @click="totalScope = 'history'">历史</button></div></div>
        <div class="large-metric">{{ total.value }}<span>{{ total.unit }}</span></div>
        <div class="total-labels"><div><span>DIRECT</span><strong>{{ direct.value }} {{ direct.unit }}</strong></div><div><span>代理</span><strong>{{ proxy.value }} {{ proxy.unit }}</strong></div></div>
        <button type="button" class="total-bar total-history-link" aria-label="查看用量历史" @click="summaryDrawer = 'usage'"><i :style="{ width: `${directPct}%` }" /><i :style="{ width: `${100 - directPct}%` }" /></button>
      </SurfaceCard>

    </section>
    <DetailDrawer :open="Boolean(summaryDrawer)" :title="summaryDrawer === 'network' ? '网络信息' : summaryDrawer === 'usage' ? '用量历史' : '连接拓扑'" @close="summaryDrawer = null"><NetworkMetadataPanel v-if="summaryDrawer === 'network'" /><UsageHistoryPanel v-else-if="summaryDrawer === 'usage'" /><TopologyPanel v-else-if="summaryDrawer === 'topology'" /></DetailDrawer>
  </div>
</template>

<style scoped>
.stream-state {
  margin-left: 6px;
}
/* 标题旁的小刷新按钮：静默重测当前三格延迟。 */
.latency-refresh {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 2px;
  border: 0;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.latency-refresh:hover:not(:disabled) {
  color: var(--app-fg, inherit);
}
.latency-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.delay-unit {
  margin-left: 3px;
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
  color: var(--app-muted);
}
.metric-dimmed {
  color: var(--app-muted);
}
.online-dot.pending {
  background: #c9a227 !important;
}
.online-dot.offline {
  background: var(--app-danger, #d64f4f) !important;
}
.pill-dim {
  background: #b7bcc4 !important;
}
.usage-history-card {
  grid-column: 1 / -1;
  padding: 15px 16px;
  width: 100%;
}
.network-metadata-card {
  grid-column: 1 / -1;
  padding: 15px 16px;
  width: 100%;
}
.topology-card {
  grid-column: 1 / -1;
  padding: 15px 16px;
  width: 100%;
}
</style>
