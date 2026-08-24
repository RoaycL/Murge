<script setup lang="ts">
import { computed, onMounted } from 'vue'
import SpeedSparkline from '../components/SpeedSparkline.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import { useTrafficStore } from '../stores/traffic'
import { useConnectionsStore } from '../stores/connections'
import { useRuntimeStore } from '../stores/runtime'
import { useKernelStore } from '../stores/kernel'
import { formatBytes, formatBytesParts, formatRate } from '../lib/format'
import { brand } from '@shared/brand'

const traffic = useTrafficStore()
const connections = useConnectionsStore()
const runtime = useRuntimeStore()
const kernel = useKernelStore()

onMounted(() => {
  kernel.connect()
  traffic.connect()
  connections.connect()
  void runtime.refresh()
})

const up = computed(() => formatRate(traffic.current?.up ?? 0))
const down = computed(() => formatRate(traffic.current?.down ?? 0))
const activeCount = computed(() => connections.summary?.totalConnections ?? 0)
const processCount = computed(() => connections.summary?.distinctProcesses ?? 0)
const deviceCount = computed(() => connections.summary?.distinctDevices ?? 0)
const topProcesses = computed(() => connections.summary?.topProcesses ?? [])
const directBytes = computed(() => connections.summary?.directDownload ?? 0)
const proxyBytes = computed(() => connections.summary?.proxyDownload ?? 0)
const direct = computed(() => formatBytesParts(directBytes.value))
const proxy = computed(() => formatBytesParts(proxyBytes.value))
// 总计 is the same cumulative source as DIRECT + 代理 so the breakdown always
// reconciles to the headline figure (any residual is per-part rounding only).
const total = computed(() => formatBytesParts(directBytes.value + proxyBytes.value))
const directPct = computed(() => {
  const totalBytes = directBytes.value + proxyBytes.value
  return totalBytes ? Math.round((directBytes.value / totalBytes) * 100) : 0
})

const modeLabel = computed(() => {
  const map = { rule: '规则判定', global: '全局', direct: '直连' } as const
  return map[runtime.summary?.mode ?? 'rule']
})

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

// Placeholder fallbacks keep the layout stable while the store is empty.
const bars = [18, 29, 52, 63, 48, 36, 20, 25, 31, 82, 15, 13, 12, 9, 10, 6, 5, 8, 7, 6, 7, 8, 7]
</script>

<template>
  <div class="activity-view page-shell">
    <header class="activity-header">
      <h1>活动</h1>
    </header>

    <section class="runtime-context" aria-label="运行上下文">
      <div><span>网络</span><strong>{{ runtime.summary?.networkName ?? '以太网' }}</strong></div>
      <div><span>配置</span><strong>{{ runtime.summary?.profileName ?? brand.defaultProfileName }}</strong></div>
      <div><span>出站模式</span><strong>{{ modeLabel }}</strong></div>
      <div><span>外部 IP⌄</span><strong>{{ runtime.summary?.externalIp ?? '—' }}</strong></div>
    </section>

    <section class="dashboard-grid">
      <SurfaceCard class="latency-card">
        <span class="metric-label">INTERNET 延迟　↻</span>
        <button type="button" class="quiet-button">网络诊断</button>
        <div class="large-metric">6<span>ms</span></div>
        <div class="latency-breakdown">
          <div><span>路由</span><strong>≤1 ms</strong></div>
          <div><span>DNS</span><strong>11 ms</strong></div>
          <div><span>Hong Kong 01</span><strong>73 ms</strong></div>
        </div>
      </SurfaceCard>

      <div class="speed-grid">
        <SpeedSparkline kind="upload" title="上传" :value="up.value" :unit="up.unit" ceiling="1.0 MB/s" middle="524 KB/s" :series="traffic.uploadSeries" />
        <SpeedSparkline kind="download" title="下载" :value="down.value" :unit="down.unit" ceiling="2.1 MB/s" middle="1.0 MB/s" :series="traffic.downloadSeries" />
      </div>

      <SurfaceCard class="connections-card">
        <span class="metric-label">活动连接<span v-if="connStateLabel" class="stream-state">{{ connStateLabel }}</span></span><i :class="connDotClass" />
        <div class="large-metric">{{ activeCount }}</div>
        <div class="connection-breakdown">
          <div><strong>{{ processCount }}</strong><span>进程</span></div>
          <div><strong>{{ deviceCount }}</strong><span>设备</span></div>
          <div><strong>1</strong><span>DHCP 设备</span></div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="traffic-card">
        <div class="card-title-row"><span class="metric-label">流量</span><div class="segmented"><button class="selected">全部</button><button>仅代理</button></div></div>
        <div class="bar-chart" aria-label="每小时流量">
          <i v-for="(height, index) in bars" :key="index" :style="{ height: `${height}%` }" />
        </div>
        <div class="chart-axis"><span>12AM</span><span>6AM</span><span>12PM</span><span>6PM</span></div>
        <div class="rank-tabs"><button class="selected">进程与设备</button><button>域名</button><button>策略</button></div>
        <div class="rank-list">
          <div v-for="item in topProcesses" :key="item.name" class="rank-row">
            <span class="rank-icon">{{ item.name.slice(0, 2) }}</span>
            <div><span>{{ item.name }}</span><i><b :style="{ width: `${item.width}%` }" /></i></div>
            <strong>{{ formatBytes(item.download) }}</strong>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="total-card">
        <div class="card-title-row"><span class="metric-label">总计</span><div class="segmented"><button class="selected">今日</button><button>本月</button></div></div>
        <div class="large-metric">{{ total.value }}<span>{{ total.unit }}</span></div>
        <div class="total-labels"><div><span>DIRECT</span><strong>{{ direct.value }} {{ direct.unit }}</strong></div><div><span>代理</span><strong>{{ proxy.value }} {{ proxy.unit }}</strong></div></div>
        <div class="total-bar"><i :style="{ width: `${directPct}%` }" /><i :style="{ width: `${100 - directPct}%` }" /></div>
      </SurfaceCard>
    </section>
  </div>
</template>

<style scoped>
.stream-state {
  margin-left: 6px;
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
</style>
