<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import SpeedSparkline from '../components/SpeedSparkline.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import AppIcon from '../components/AppIcon.vue'
import RefreshIndicator from '../components/RefreshIndicator.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import UsageHistoryPanel from '../components/UsageHistoryPanel.vue'
import NetworkMetadataPanel from '../components/NetworkMetadataPanel.vue'
import { useTrafficStore } from '../stores/traffic'
import { useConnectionsStore } from '../stores/connections'
import { useRuntimeStore } from '../stores/runtime'
import { useNetworkMetadataStore } from '../stores/network-metadata'
import { useLatencyStore } from '../stores/latency'
import { formatBytes, formatBytesParts, formatRate } from '../lib/format'
import { brand } from '@shared/brand'
import { useRouter } from 'vue-router'
import { usePoliciesStore } from '../stores/policies'
import AppSelect from '../components/AppSelect.vue'
import ProcessIcon from '../components/ProcessIcon.vue'
import CachedRemoteIcon from '../components/CachedRemoteIcon.vue'
import { useSystemProxyStore } from '../stores/system-proxy'
import { useTunStore } from '../stores/tun'
import { useKernelStore } from '../stores/kernel'
import { resolveRuntimeAccent } from '@shared/runtime-accent'
import { networkMetadataMaskIpMiddle } from '@shared/network-metadata'
import { useProfilesStore } from '../stores/profiles'
import { useToast } from '../composables/use-toast'
import PopoverMenu from '../components/PopoverMenu.vue'
import { useActivityLayout } from '../composables/use-activity-layout'
import { cardPosition, type ActivityCardId, type ActivityColumn } from '../lib/activity-layout'
import ActivityOverviewCard from '../components/activity/ActivityOverviewCard.vue'
import NetworkCard from '../components/activity/NetworkCard.vue'
import BandwidthCard from '../components/activity/BandwidthCard.vue'
import ExternalIpCard from '../components/activity/ExternalIpCard.vue'
import DnsCard from '../components/activity/DnsCard.vue'
import UsagePeriodCard from '../components/activity/UsagePeriodCard.vue'
import TrafficRankCard from '../components/activity/TrafficRankCard.vue'
import PolicyLatencyCard from '../components/activity/PolicyLatencyCard.vue'
import EventsCard from '../components/activity/EventsCard.vue'

// 卡片排列：长按任一卡片进入整理模式（卡片晃动，像 iOS 主屏幕），再拖到两列中的任意位置；
// 「完成」、Esc 或点卡片外面退出。普通按住拖动/滚动不受影响。右键卡片可上移/下移/换列/恢复默认。
const dashboard = ref<HTMLElement | null>(null)
const {
  layout: cardLayout, isDefault: cardLayoutDefault, visible: cardVisible, dragging: cardDragging, editing: cardEditing, startEditing: startCardEditing, stopEditing: stopCardEditing, cardStyle,
  onPointerDown: onCardPointerDown, onClickCapture: onCardClickCapture, moveBy: moveCardBy, moveAcross: moveCardAcross, hide: hideCard, show: showCard, reset: resetCards
} = useActivityLayout(dashboard)
// 「添加卡片」: hidden cards, listed by name, put back at the end of the shorter column.
const addMenu = ref<{ x: number; y: number } | null>(null)
function openAddMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  addMenu.value = { x: rect.left, y: rect.bottom + 4 }
}
function cardName(id: ActivityCardId): string {
  const names: Record<ActivityCardId, string> = {
    latency: t('widgets.card.latency'),
    upload: t('widgets.card.upload'),
    download: t('widgets.card.download'),
    connections: t('widgets.card.connections'),
    traffic: t('widgets.card.traffic'),
    total: t('widgets.card.total'),
    activity: t('widgets.card.activity'),
    network: t('widgets.card.network'),
    dns: t('widgets.card.dns'),
    bandwidth: t('widgets.card.bandwidth'),
    externalIp: t('widgets.card.externalIp'),
    usage: t('widgets.card.usage'),
    ranking: t('widgets.card.ranking'),
    policyLatency: t('widgets.card.policyLatency'),
    events: t('widgets.card.events')
  }
  return names[id]
}
const cardMenu = ref<{ id: ActivityCardId; x: number; y: number; column: ActivityColumn; canUp: boolean; canDown: boolean } | null>(null)

function onCardContext(event: MouseEvent): void {
  const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-card]')
  if (!card) return
  event.preventDefault()
  const id = card.dataset.card as ActivityCardId
  const { column, index } = cardPosition(cardLayout.value, id)
  cardMenu.value = { id, x: event.clientX, y: event.clientY, column, canUp: index > 0, canDown: index < cardLayout.value[column].length - 1 }
}

const traffic = useTrafficStore()
const connections = useConnectionsStore()
const runtime = useRuntimeStore()
const networkMeta = useNetworkMetadataStore()
const latency = useLatencyStore()
const router = useRouter()
const policies = usePoliciesStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const kernel = useKernelStore()
const summaryDrawer = ref<'network' | 'usage' | null>(null)

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
const diagnosisButtonLabel = computed(() => (latency.state === 'probing' ? t('netMeta.detecting') : t('activity.networkDiagnosis')))

function openNetworkDiagnostics(): void {
  summaryDrawer.value = 'network'
  void latency.probe()
}

onMounted(() => {
  void runtime.refresh()
  void policies.load()
  void policies.syncMode()
  void networkMeta.init()
  void profilesStore.load().catch(() => undefined)
  // On a cold app start this page mounts before the kernel is up, so a probe
  // here could only fail (controller unreachable) and the card stayed at "—"
  // until the next minute tick or a manual refresh. Probe now only if the
  // kernel is already running; otherwise the phase watcher below does it.
  if (kernel.status.phase === 'running') latency.init()
  // Keep the card honest without hammering the controller: one sample a minute
  // plus the manual refresh button.
  latencyTimer = window.setInterval(() => {
    void latency.probe()
    // Also picks up a network switch (网线 ↔ Wi-Fi) for the 网络 label.
    void runtime.refresh()
  }, LATENCY_REFRESH_MS)
})

// A kernel restart (crash recovery, profile switch from the tray) replaces the
// groups, the active profile and possibly the mode; reload what this page shows.
watch(() => kernel.status.phase, (phase, previous) => {
  if (phase !== 'running' || previous === 'running') return
  void latency.probeAfterKernelStart()
  void profilesStore.load().catch(() => undefined)
  void runtime.refresh()
  void policies.load()
  void policies.syncMode()
})

onUnmounted(() => {
  if (ipRevealTimer != null) window.clearTimeout(ipRevealTimer)
  if (latencyTimer != null) {
    window.clearInterval(latencyTimer)
    latencyTimer = null
  }
})

const up = computed(() => formatRate(traffic.current?.up ?? 0))
const down = computed(() => formatRate(traffic.current?.down ?? 0))
const activeCount = computed(() => connections.summary?.totalConnections ?? 0)
const processCount = computed(() => connections.summary?.distinctProcesses ?? 0)
const deviceCount = computed(() => connections.summary?.distinctDevices ?? 0)
const hostCount = computed(() => connections.summary?.distinctHosts ?? 0)
const directBytes = computed(() => connections.summary?.directBytes ?? 0)
const proxyBytes = computed(() => connections.summary?.proxyBytes ?? 0)

// 全部/仅代理 scope lives in the store so every ranking slot stays consistent.
const rankScope = computed(() => connections.rankScope)
// Which dimension the rank list groups by (进程与设备 / 域名 / 策略).
const rankDimension = ref<'process' | 'host' | 'policy'>('process')
const rankedList = computed(() => {
  if (rankDimension.value === 'host') return connections.topHosts
  if (rankDimension.value === 'policy') return connections.topPolicies
  return connections.topProcesses
})
const policyIcons = computed<Record<string, string>>(() => Object.fromEntries(
  policies.groups.flatMap((group) => group.icon ? [[group.name, group.icon] as const] : [])
))

// The card is an exact snapshot of current live connections. Persisted history
// has different dimensions and lives in UsageHistoryPanel; do not extrapolate a
// historical DIRECT/proxy split from the current connection ratio.
const currentTotalBytes = computed(() => directBytes.value + proxyBytes.value)
const total = computed(() => formatBytesParts(currentTotalBytes.value))
const direct = computed(() => formatBytesParts(directBytes.value))
const proxy = computed(() => formatBytesParts(proxyBytes.value))
const directPct = computed(() =>
  currentTotalBytes.value ? Math.round((directBytes.value / currentTotalBytes.value) * 100) : 0
)

const modeLabel = computed(() => {
  const map = { rule: t('activity.modeRule'), global: t('activity.modeGlobal'), direct: t('activity.modeDirect') } as const
  return map[policies.mode]
})
const modeOptions = [
  { value: 'rule', label: t('activity.modeRule') },
  { value: 'global', label: t('activity.modeGlobal') },
  { value: 'direct', label: t('activity.modeDirect') }
]
const modePicker = ref<HTMLElement | null>(null)
const profilePicker = ref<HTMLElement | null>(null)
// 与 Surge 一致：可切换的标签（出站模式、配置）后面带小箭头，点标签也能展开菜单。
function openPicker(host: HTMLElement | null): void {
  host?.querySelector<HTMLButtonElement>('.app-select-trigger')?.click()
}
function toggleModePicker(): void {
  openPicker(modePicker.value)
}

// 配置：与出站模式一样可直接切换当前配置。
const profilesStore = useProfilesStore()
const toast = useToast()
const profileOptions = computed(() => profilesStore.ordered.map((meta) => ({ value: meta.id, label: meta.name })))
const profileName = computed(() => runtime.summary?.profileName ?? profilesStore.active?.name ?? brand.defaultProfileName)
const selectedProfile = computed({
  get: () => profilesStore.active?.id ?? '',
  set: (id: string) => {
    if (!id || id === profilesStore.active?.id) return
    void profilesStore.activate(id)
      .then(() => {
        toast.success(t('activity.profileActivated'))
        return runtime.refresh()
      })
      .catch(() => toast.error(t('activity.profileActivateFailed'), profilesStore.lastError ?? undefined))
  }
})
const selectedMode = computed({
  get: () => policies.mode,
  set: (value: string) => {
    void policies.setMode(value as 'rule' | 'global' | 'direct').then(() => runtime.refresh())
  }
})
// 外部 IP 默认隐藏中间部分；点击数值显示完整地址，10 秒后自动重新隐藏，
// 避免截图或共享屏幕时一直暴露。
const ipRevealed = ref(false)
let ipRevealTimer: number | null = null
function toggleIpReveal(): void {
  ipRevealed.value = !ipRevealed.value
  if (ipRevealTimer != null) window.clearTimeout(ipRevealTimer)
  ipRevealTimer = ipRevealed.value ? window.setTimeout(() => { ipRevealed.value = false; ipRevealTimer = null }, 10_000) : null
}
const externalIpText = computed(() => {
  const ip = networkMeta.metadata?.ip
  if (!ip) return networkMeta.ipText
  return ipRevealed.value ? ip : networkMetadataMaskIpMiddle(ip)
})

const connStatus = computed(() => connections.status)
const connDotClass = computed(() => {
  const accent = resolveRuntimeAccent(systemProxy.status.phase, tun.status.phase)
  return ['online-dot', `runtime-${accent}`, { pending: connStatus.value === 'loading', offline: connStatus.value === 'disconnected' || connStatus.value === 'error' }]
})
const connStateLabel = computed(() => {
  if (connStatus.value === 'loading') return t('activity.loading')
  if (connStatus.value === 'disconnected') return t('activity.disconnected')
  if (connStatus.value === 'error') return t('activity.dataError')
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
      <h1>{{ t('nav.activity') }}</h1>
      <div v-if="cardEditing" class="activity-arrange-actions">
        <button v-if="cardLayout.hidden.length" type="button" class="activity-arrange-add" @click="openAddMenu"><AppIcon name="add" :size="14" />{{ t('widgets.addCard') }}</button>
        <button type="button" class="activity-arrange-done" @click="stopCardEditing">{{ t('activity.cardDone') }}</button>
      </div>
    </header>

    <section class="runtime-context" :aria-label="t('activity.contextLabel')">
      <div><span>{{ t('activity.network') }}</span><strong>{{ runtime.summary?.networkName ?? t('activity.ethernet') }}</strong></div>
      <div v-if="profilesStore.active" ref="profilePicker" class="runtime-mode-picker runtime-profile-picker"><span class="runtime-detail-label" @pointerdown.stop @click="openPicker(profilePicker)">{{ t('activity.profile') }}<AppIcon name="chevron-down" :size="12" /></span><AppSelect v-model="selectedProfile" :options="profileOptions" :label="t('activity.profileTitle', [profileName])" plain /></div>
      <div v-else><span>{{ t('activity.profile') }}</span><strong>{{ profileName }}</strong></div>
      <div ref="modePicker" class="runtime-mode-picker"><span class="runtime-detail-label" @pointerdown.stop @click="toggleModePicker">{{ t('activity.outboundMode') }}<AppIcon name="chevron-down" :size="12" /></span><AppSelect v-model="selectedMode" :options="modeOptions" :label="t('activity.modeTitle', [modeLabel])" plain /></div>
      <div class="runtime-ip"><button type="button" class="runtime-detail-label runtime-detail-link" :aria-label="t('activity.viewNetworkInfo')" @click="summaryDrawer = 'network'">{{ t('activity.externalIp') }}<AppIcon name="chevron-down" :size="12" /></button><button type="button" class="runtime-ip-value" :aria-pressed="ipRevealed" :aria-label="ipRevealed ? t('activity.hideIp') : t('activity.showIp')" :title="ipRevealed ? t('activity.clickHide') : t('activity.clickShow')" @click="toggleIpReveal"><strong>{{ externalIpText }}</strong></button></div>
    </section>

    <section ref="dashboard" class="dashboard-grid" :class="{ 'is-dragging': Boolean(cardDragging), 'is-editing': cardEditing }" @pointerdown="onCardPointerDown" @click.capture="onCardClickCapture" @contextmenu="onCardContext">
      <SurfaceCard class="latency-card" v-if="cardVisible.has('latency')" data-card="latency" :class="{ 'card-lifted': cardDragging === 'latency' }" :style="cardStyle('latency')">
        <div class="card-title-row">
          <span class="metric-label latency-label">{{ t('activity.latency') }}<button type="button" class="latency-refresh refresh-control" :disabled="latency.state === 'probing'" :aria-label="t('activity.retest')" @click="latency.probe()"><RefreshIndicator :busy="latency.state === 'probing'" :failed="latency.state === 'error'" :size="12" /></button></span>
          <button type="button" class="quiet-button" @click="openNetworkDiagnostics">{{ diagnosisButtonLabel }}</button>
        </div>
        <div class="large-metric" :class="{ 'metric-dimmed': headlineText === '—' }">{{ headlineText }}<span>ms</span></div>
        <div class="latency-breakdown">
          <div><span>{{ t('activity.route') }}</span><strong>{{ gatewayText }}<i v-if="gatewayText !== '—'" class="delay-unit">ms</i></strong></div>
          <div><span>DNS</span><strong>{{ dnsText }}<i v-if="dnsText !== '—'" class="delay-unit">ms</i></strong></div>
          <div><span>{{ latency.proxyNode ?? t('activity.currentPolicy') }}</span><strong>{{ proxyText }}<i v-if="proxyText !== '—'" class="delay-unit">ms</i></strong></div>
        </div>
      </SurfaceCard>

      <SpeedSparkline v-if="cardVisible.has('upload')" kind="upload" data-card="upload" :class="{ 'card-lifted': cardDragging === 'upload' }" :style="cardStyle('upload')" :title="t('common.upload')" :value="up.value" :unit="up.unit" :series="traffic.uploadSeries" />
      <SpeedSparkline v-if="cardVisible.has('download')" kind="download" data-card="download" :class="{ 'card-lifted': cardDragging === 'download' }" :style="cardStyle('download')" :title="t('common.download')" :value="down.value" :unit="down.unit" :series="traffic.downloadSeries" />

      <SurfaceCard class="connections-card" v-if="cardVisible.has('connections')" data-card="connections" :class="{ 'card-lifted': cardDragging === 'connections' }" :style="cardStyle('connections')">
        <div class="card-title-row"><span class="metric-label">{{ t('activity.activeConnections') }}<span v-if="connStateLabel" class="stream-state">{{ connStateLabel }}</span></span><i :class="connDotClass" /></div>
        <button type="button" class="connections-summary-link" @click="router.push('/connections')"><strong>{{ activeCount }}</strong><span>{{ t('activity.viewConnections') }}</span><AppIcon name="next" :size="15" /></button>
        <div class="connections-breakdown">
          <button type="button" :aria-label="t('activity.viewProcesses')" @click="router.push('/processes')"><strong>{{ processCount }}</strong><span>{{ t('nav.processes') }}</span></button>
          <button type="button" :aria-label="t('activity.viewDevices')" @click="router.push('/devices')"><strong>{{ deviceCount }}</strong><span>{{ t('activity.devices') }}</span></button>
          <button type="button" :aria-label="t('activity.viewConnections')" @click="router.push('/connections')"><strong>{{ hostCount }}</strong><span>{{ t('activity.domains') }}</span></button>
        </div>
      </SurfaceCard>

      <SurfaceCard class="traffic-card" v-if="cardVisible.has('traffic')" data-card="traffic" :class="{ 'card-lifted': cardDragging === 'traffic' }" :style="cardStyle('traffic')">
        <div class="card-title-row"><span class="metric-label">{{ t('stats.traffic') }}</span><div class="segmented" role="group" :aria-label="t('activity.trafficScope')"><button type="button" :class="{ selected: rankScope === 'all' }" :aria-pressed="rankScope === 'all'" @click="connections.setRankScope('all')">{{ t('common.all') }}</button><button type="button" :class="{ selected: rankScope === 'proxy' }" :aria-pressed="rankScope === 'proxy'" @click="connections.setRankScope('proxy')">{{ t('activity.proxyOnly') }}</button></div></div>
        <div class="bar-chart" :aria-label="t('activity.recentLabel')">
          <i v-for="(height, index) in chartBars" :key="index" :style="{ height: `${height}%` }" />
        </div>
        <div class="chart-axis"><span>{{ t('activity.recent') }}</span><span>{{ t('activity.oneMinute') }}</span></div>
        <div class="rank-tabs" role="group" :aria-label="t('activity.rankingLabel')"><button type="button" :class="{ selected: rankDimension === 'process' }" :aria-pressed="rankDimension === 'process'" @click="rankDimension = 'process'">{{ t('activity.processesAndDevices') }}</button><button type="button" :class="{ selected: rankDimension === 'host' }" :aria-pressed="rankDimension === 'host'" @click="rankDimension = 'host'">{{ t('sniffer.domains') }}</button><button type="button" :class="{ selected: rankDimension === 'policy' }" :aria-pressed="rankDimension === 'policy'" @click="rankDimension = 'policy'">{{ t('common.policy') }}</button></div>
        <div class="rank-list">
          <div v-for="item in rankedList" :key="item.name" class="rank-row">
            <ProcessIcon v-if="rankDimension === 'process'" class="rank-process-icon" :path="item.iconPath" :name="item.name" :size="12" />
            <span v-else class="rank-icon"><CachedRemoteIcon v-if="rankDimension === 'policy' && policyIcons[item.name]" :src="policyIcons[item.name]" :cache-key="`policy:${item.name}`" /><template v-else>{{ item.name.slice(0, 2) }}</template></span>
            <div><span>{{ item.name }}</span><i><b :style="{ width: `${item.width}%` }" /></i></div>
            <strong>{{ formatBytes(item.bytes) }}</strong>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="total-card" v-if="cardVisible.has('total')" data-card="total" :class="{ 'card-lifted': cardDragging === 'total' }" :style="cardStyle('total')">
        <div class="card-title-row"><span class="metric-label">{{ t('stats.total') }}</span><button type="button" class="quiet-button" @click="summaryDrawer = 'usage'">{{ t('activity.viewHistory') }}</button></div>
        <div class="large-metric">{{ total.value }}<span>{{ total.unit }}</span></div>
        <div class="total-labels"><div><span>DIRECT</span><strong>{{ direct.value }} {{ direct.unit }}</strong></div><div><span>{{ t('activity.proxy') }}</span><strong>{{ proxy.value }} {{ proxy.unit }}</strong></div></div>
        <button type="button" class="total-bar total-history-link" :aria-label="t('activity.viewUsage')" @click="summaryDrawer = 'usage'"><i :style="{ width: `${directPct}%` }" /><i :style="{ width: `${100 - directPct}%` }" /></button>
      </SurfaceCard>

      <ActivityOverviewCard v-if="cardVisible.has('activity')" data-card="activity" :class="{ 'card-lifted': cardDragging === 'activity' }" :style="cardStyle('activity')" />
      <NetworkCard v-if="cardVisible.has('network')" data-card="network" :class="{ 'card-lifted': cardDragging === 'network' }" :style="cardStyle('network')" />
      <DnsCard v-if="cardVisible.has('dns')" data-card="dns" :class="{ 'card-lifted': cardDragging === 'dns' }" :style="cardStyle('dns')" />
      <BandwidthCard v-if="cardVisible.has('bandwidth')" data-card="bandwidth" :class="{ 'card-lifted': cardDragging === 'bandwidth' }" :style="cardStyle('bandwidth')" />
      <ExternalIpCard v-if="cardVisible.has('externalIp')" data-card="externalIp" :class="{ 'card-lifted': cardDragging === 'externalIp' }" :style="cardStyle('externalIp')" @details="summaryDrawer = 'network'" />
      <UsagePeriodCard v-if="cardVisible.has('usage')" data-card="usage" :class="{ 'card-lifted': cardDragging === 'usage' }" :style="cardStyle('usage')" @history="summaryDrawer = 'usage'" />
      <TrafficRankCard v-if="cardVisible.has('ranking')" data-card="ranking" :class="{ 'card-lifted': cardDragging === 'ranking' }" :style="cardStyle('ranking')" />
      <PolicyLatencyCard v-if="cardVisible.has('policyLatency')" data-card="policyLatency" :class="{ 'card-lifted': cardDragging === 'policyLatency' }" :style="cardStyle('policyLatency')" />
      <EventsCard v-if="cardVisible.has('events')" data-card="events" :class="{ 'card-lifted': cardDragging === 'events' }" :style="cardStyle('events')" />
    </section>
    <PopoverMenu :open="!!cardMenu" :x="cardMenu?.x ?? 0" :y="cardMenu?.y ?? 0" :label="t('activity.cardMenu')" @close="cardMenu = null">
      <template v-if="cardMenu">
        <button type="button" class="popover-item" role="menuitem" :disabled="!cardMenu.canUp" @click="moveCardBy(cardMenu.id, -1)">{{ t('activity.cardMoveUp') }}</button>
        <button type="button" class="popover-item" role="menuitem" :disabled="!cardMenu.canDown" @click="moveCardBy(cardMenu.id, 1)">{{ t('activity.cardMoveDown') }}</button>
        <button type="button" class="popover-item" role="menuitem" @click="moveCardAcross(cardMenu.id)">{{ cardMenu.column === 'left' ? t('activity.cardMoveRight') : t('activity.cardMoveLeft') }}</button>
        <button type="button" class="popover-item" role="menuitem" @click="hideCard(cardMenu.id); cardMenu = null">{{ t('widgets.hideCard') }}</button>
        <div class="popover-sep" />
        <button v-if="!cardEditing" type="button" class="popover-item" role="menuitem" @click="cardMenu = null; startCardEditing()">{{ t('activity.cardArrange') }}</button>
        <button type="button" class="popover-item" role="menuitem" :disabled="cardLayoutDefault" @click="resetCards">{{ t('activity.cardReset') }}</button>
      </template>
    </PopoverMenu>
    <PopoverMenu :open="!!addMenu" :x="addMenu?.x ?? 0" :y="addMenu?.y ?? 0" :label="t('widgets.addCard')" @close="addMenu = null">
      <button v-for="id in cardLayout.hidden" :key="id" type="button" class="popover-item" role="menuitem" @click="showCard(id); if (!cardLayout.hidden.length) addMenu = null">{{ cardName(id) }}</button>
    </PopoverMenu>
    <DetailDrawer :open="Boolean(summaryDrawer)" :title="summaryDrawer === 'network' ? t('activity.networkInfo') : t('activity.usageHistory')" @close="summaryDrawer = null">
      <template v-if="summaryDrawer === 'network'" #actions><button type="button" class="drawer-probe-button" :disabled="latency.state === 'probing'" @click="latency.probe()">{{ latency.state === 'probing' ? t('netMeta.detecting') : t('activity.recheck') }}</button></template>
      <NetworkMetadataPanel v-if="summaryDrawer === 'network'" /><UsageHistoryPanel v-else-if="summaryDrawer === 'usage'" />
    </DetailDrawer>
  </div>
</template>

<style scoped>
.activity-arrange-actions { display: flex; align-items: center; gap: 8px; }
.activity-arrange-add { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 12px; border: 1px solid var(--app-divider); border-radius: 14px; background: var(--app-surface); color: var(--app-blue); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); cursor: pointer; }
.stream-state {
  margin-left: 6px;
}
/* 标题旁的小刷新按钮：静默重测当前三格延迟。 */
.latency-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 16px;
}
.latency-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  line-height: 0;
  border: 0;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.latency-refresh :deep(svg) {
  display: block;
}
.latency-refresh:hover:not(:disabled) {
  color: var(--app-text);
}
.latency-refresh:disabled {
  opacity: 1;
  cursor: progress;
}
.delay-unit {
  margin-left: 3px;
  font-style: normal;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--app-muted);
}
.metric-dimmed {
  color: var(--app-muted);
}
.drawer-probe-button {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.drawer-probe-button:disabled { opacity: 0.5; cursor: default; }
.online-dot.pending { opacity: 0.72; }
.online-dot.offline { opacity: 0.48; animation: none; }
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
</style>
