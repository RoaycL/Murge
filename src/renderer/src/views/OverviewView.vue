<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import AppIcon from '../components/AppIcon.vue'
import ProxyBypassPanel from '../components/ProxyBypassPanel.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import { useKernelStore } from '../stores/kernel'
import { useSystemProxyStore } from '../stores/system-proxy'
import { useTunStore } from '../stores/tun'
import { useSnifferEnhancementStore } from '../stores/sniffer-enhancement'
import { useDnsEnhancementStore } from '../stores/dns-enhancement'
import { TUN_UI_COPY } from '@shared/tun'
import { formatSystemProxyEndpoint } from '@shared/system-proxy'

const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const sniffer = useSnifferEnhancementStore()
const dns = useDnsEnhancementStore()
const actionError = ref('')
const busy = computed(() => kernel.status.phase === 'starting' || kernel.status.phase === 'stopping')
const running = computed(() => kernel.status.phase === 'running')

/** The 覆写 quick switches hydrate the persisted models once on page open. */
onMounted(() => {
  void sniffer.refresh()
  void dns.refresh()
})

const sp = computed(() => systemProxy.status)
// The 系统代理 switch drives the whole turn-on: if the kernel is not yet
// running it is auto-started first, so the switch is always actionable (when
// supported and not mid-operation). Busy also folds in the kernel's own
// start/stop phases so the switch cannot be re-toggled mid-autostart.
const spBusy = computed(() => sp.value.phase === 'enabling' || sp.value.phase === 'restoring' || busy.value)
const spEnabled = computed(() => sp.value.phase === 'enabled')
// Enabling auto-starts the kernel; disabling an owned proxy is always allowed
// (even if the kernel just stopped), so a stale proxy can always be turned off.
const spSwitchDisabled = computed(() => spBusy.value || !sp.value.supported)
const spPhaseLabel = computed(() => {
  switch (sp.value.phase) {
    case 'enabled':
      return `已启用 · ${formatSystemProxyEndpoint(sp.value)}`
    case 'enabling':
      return '正在启用系统代理…'
    case 'disabled':
      return sp.value.errorMessage ?? '未启用'
    case 'restoring':
      return '正在还原系统代理…'
    case 'restore-failed':
      return '系统代理还原失败'
    case 'conflict':
      return sp.value.conflictDetail ?? '系统代理状态与外部冲突'
    case 'unsupported':
      return sp.value.errorMessage ?? '仅 Windows 支持接管系统代理'
    default:
      return '未知状态'
  }
})

async function toggleSystemProxy(): Promise<void> {
  actionError.value = ''
  try {
    if (spEnabled.value) {
      await systemProxy.disable()
    } else {
      // Turning on the system proxy points it at whichever mihomo host is live
      // over the fixed mixed-port. When a TUN session is active that is the
      // elevated child and the kernel store already reports running (single
      // logical kernel), so this is a no-op; when TUN is off, auto-start the
      // ordinary kernel first, as before. The backend probe still guards the
      // actual enable against a genuinely dead host.
      if (!running.value && !tunActive.value) await kernel.start()
      await systemProxy.enable()
    }
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
}

// The TUN switch mirrors the privileged TUN lifecycle. It is only actionable
// when the current build actually supports the TUN service (packaged Windows);
// in dev/non-Windows the platform reports unsupported and the switch stays
// disabled. The backend coordinator owns the single-kernel mode switch (the
// unified ports are rebound rather than going dead); the system proxy is allowed
// alongside TUN, so the UI simply reflects the authoritative phase.
const tunActive = computed(() => tun.status.phase === 'active')
const tunBusy = computed(() => tun.busy || tun.status.phase === 'starting' || tun.status.phase === 'restoring')
const tunSwitchDisabled = computed(() => tunBusy.value || !tun.status.supported)
const tunPhaseLabel = computed(() => {
  if (!tun.status.supported) return '当前平台不支持 TUN（需打包后的 Windows 版本）'
  return TUN_UI_COPY[tun.status.phase] ?? tun.status.phase
})

async function toggleTun(): Promise<void> {
  if (tunActive.value) await tun.disable()
  else await tun.enable()
}

// 覆写 quick switches persist the master switch on the spot (clash-party's
// card toggles); the full model is edited in the secondary drawer.
const snifferEnabled = computed(() => sniffer.enhancement.enabled)
const snifferBusy = computed(() => sniffer.busy)
async function toggleSniffer(): Promise<void> {
  await sniffer.save({ ...sniffer.enhancement, enabled: !snifferEnabled.value })
}
const dnsEnabled = computed(() => dns.enhancement.enabled)
const dnsBusy = computed(() => dns.busy)
async function toggleDns(): Promise<void> {
  await dns.save({ ...dns.enhancement, enabled: !dnsEnabled.value })
}

// 二级设置抽屉：one drawer, four pages, mirroring clash-party's 系统代理 /
// 虚拟网卡 / 嗅探覆写 / DNS 覆写 secondary screens. Panels self-hydrate on
// mount, so v-if keeps their loads off the overview until actually opened.
const settingsDrawer = ref<'system-proxy' | 'tun' | 'sniffer' | 'dns' | null>(null)
const DRAWER_TITLES = {
  'system-proxy': '系统代理设置',
  tun: 'TUN 模式设置',
  sniffer: '嗅探覆写',
  dns: 'DNS 覆写'
} as const
const drawerTitle = computed(() => (settingsDrawer.value ? DRAWER_TITLES[settingsDrawer.value] : ''))
</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>运行状态</h2><div class="runtime-summary surface-card"><div><span>内核</span><strong>{{ running ? '运行中' : kernel.status.phase }}</strong></div><div><span>系统代理</span><strong>{{ spEnabled ? '已启用' : '未启用' }}</strong></div><div><span>TUN</span><strong>{{ tunActive ? '已启用' : '未启用' }}</strong></div></div></section>
    <section>
      <h2>网络管理</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <!-- 标注区（标题 + 开关）不触发抽屉；点卡片其余区域弹出二级设置。 -->
          <div class="setting-head" @click.stop>
            <div>
              <h3>系统代理</h3>
              <p>将系统 HTTP 代理指向内核 mixed-port。</p>
            </div>
            <button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" aria-label="切换系统代理" @click.stop="toggleSystemProxy" />
          </div>
          <button type="button" class="setting-body" aria-label="打开系统代理二级设置" @click="settingsDrawer = 'system-proxy'">
            <span class="setting-status"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</span>
            <AppIcon class="setting-arrow" name="next" :size="14" />
          </button>
          <p v-if="actionError" class="inline-error" role="alert" @click="settingsDrawer = 'system-proxy'">{{ actionError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head" @click.stop>
            <div>
              <h3>TUN 模式</h3>
              <p>虚拟网卡接管全部流量，需管理员服务。</p>
            </div>
            <button type="button" class="switch" :class="{ on: tunActive }" :aria-checked="tunActive" :disabled="tunSwitchDisabled" aria-label="切换 TUN 模式" @click.stop="toggleTun" />
          </div>
          <button type="button" class="setting-body" aria-label="打开 TUN 模式二级设置" @click="settingsDrawer = 'tun'">
            <span class="setting-status"><i :class="{ active: tunActive }" />{{ tunPhaseLabel }}</span>
            <AppIcon class="setting-arrow" name="next" :size="14" />
          </button>
          <p v-if="tun.actionError" class="inline-error" role="alert" @click="settingsDrawer = 'tun'">{{ tun.actionError }}</p>
        </SurfaceCard>
      </div>
    </section>
    <section>
      <h2>覆写</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head" @click.stop>
            <div>
              <h3>嗅探覆写</h3>
              <p>域名嗅探、端口与跳过/强制域名规则。</p>
            </div>
            <button type="button" class="switch" :class="{ on: snifferEnabled }" :aria-checked="snifferEnabled" :disabled="snifferBusy" aria-label="切换嗅探覆写" @click.stop="toggleSniffer" />
          </div>
          <button type="button" class="setting-body" aria-label="打开嗅探覆写二级设置" @click="settingsDrawer = 'sniffer'">
            <span class="setting-status"><i :class="{ active: snifferEnabled }" />{{ snifferBusy ? '正在保存…' : snifferEnabled ? '已启用 · 下次启动内核生效' : '未启用' }}</span>
            <AppIcon class="setting-arrow" name="next" :size="14" />
          </button>
          <p v-if="sniffer.lastError" class="inline-error" role="alert" @click="settingsDrawer = 'sniffer'">{{ sniffer.lastError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head" @click.stop>
            <div>
              <h3>DNS 覆写</h3>
              <p>Fake-IP、解析服务器与分流策略。</p>
            </div>
            <button type="button" class="switch" :class="{ on: dnsEnabled }" :aria-checked="dnsEnabled" :disabled="dnsBusy" aria-label="切换 DNS 覆写" @click.stop="toggleDns" />
          </div>
          <button type="button" class="setting-body" aria-label="打开 DNS 覆写二级设置" @click="settingsDrawer = 'dns'">
            <span class="setting-status"><i :class="{ active: dnsEnabled }" />{{ dnsBusy ? '正在保存…' : dnsEnabled ? '已启用 · 下次启动内核生效' : '未启用' }}</span>
            <AppIcon class="setting-arrow" name="next" :size="14" />
          </button>
          <p v-if="dns.lastError" class="inline-error" role="alert" @click="settingsDrawer = 'dns'">{{ dns.lastError }}</p>
        </SurfaceCard>
      </div>
    </section>

    <DetailDrawer :open="Boolean(settingsDrawer)" :title="drawerTitle" @close="settingsDrawer = null">
      <ProxyBypassPanel v-if="settingsDrawer === 'system-proxy'" />
      <TunConfigPanel v-else-if="settingsDrawer === 'tun'" />
      <SnifferSettingsPanel v-else-if="settingsDrawer === 'sniffer'" />
      <DnsSettingsPanel v-else-if="settingsDrawer === 'dns'" />
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* 卡片主体（状态行 + 右侧箭头）整体可点，弹出二级设置抽屉。 */
.setting-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  margin-top: auto;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.setting-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setting-arrow { flex-shrink: 0; color: var(--app-muted); }
.setting-body:hover .setting-arrow { color: var(--app-text); }
.setting-card .setting-head { cursor: default; }
.setting-card { gap: 8px; }
.inline-error { margin-top: 8px; color: var(--app-danger, #d64f4f); font-size: 12px; }
</style>
