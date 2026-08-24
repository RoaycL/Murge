<script setup lang="ts">
import SpeedSparkline from '../components/SpeedSparkline.vue'
import SurfaceCard from '../components/SurfaceCard.vue'

const bars = [18, 29, 52, 63, 48, 36, 20, 25, 31, 82, 15, 13, 12, 9, 10, 6, 5, 8, 7, 6, 7, 8, 7]
const ranks = [
  { icon: 'PC', name: 'DESKTOP', amount: '3.43 GB', width: 100 },
  { icon: '>_', name: 'curl', amount: '466.9 MB', width: 42 },
  { icon: '◎', name: 'Browser', amount: '271.3 MB', width: 29 },
  { icon: 'O', name: 'Terminal', amount: '151.0 MB', width: 21 },
  { icon: 'M', name: 'Mail', amount: '95.3 MB', width: 14 }
]
</script>

<template>
  <div class="activity-view page-shell">
    <header class="activity-header">
      <h1>活动</h1>
      <div class="status-pills" aria-label="网络接管状态">
        <span class="status-pill"><i />系统代理</span>
        <span class="status-pill"><i />TUN 模式</span>
      </div>
    </header>

    <section class="runtime-context" aria-label="运行上下文">
      <div><span>网络</span><strong>以太网</strong></div>
      <div><span>配置</span><strong>Default</strong></div>
      <div><span>出站模式</span><strong>规则判定</strong></div>
      <div><span>外部 IP⌄</span><strong>116.149.199.179</strong></div>
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
        <SpeedSparkline kind="upload" title="上传" value="15" unit="KB/s" ceiling="1.0 MB/s" middle="524 KB/s" />
        <SpeedSparkline kind="download" title="下载" value="81" unit="KB/s" ceiling="2.1 MB/s" middle="1.0 MB/s" />
      </div>

      <SurfaceCard class="connections-card">
        <span class="metric-label">活动连接</span><i class="online-dot" />
        <div class="large-metric">120</div>
        <div class="connection-breakdown">
          <div><strong>25</strong><span>进程</span></div>
          <div><strong>1</strong><span>设备</span></div>
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
          <div v-for="item in ranks" :key="item.name" class="rank-row">
            <span class="rank-icon">{{ item.icon }}</span>
            <div><span>{{ item.name }}</span><i><b :style="{ width: `${item.width}%` }" /></i></div>
            <strong>{{ item.amount }}</strong>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="total-card">
        <div class="card-title-row"><span class="metric-label">总计</span><div class="segmented"><button class="selected">今日</button><button>本月</button></div></div>
        <div class="large-metric">5.04<span>GB</span></div>
        <div class="total-labels"><div><span>DIRECT</span><strong>3.54 GB</strong></div><div><span>代理</span><strong>1.50 GB</strong></div></div>
        <div class="total-bar"><i /><i /></div>
      </SurfaceCard>
    </section>
  </div>
</template>
