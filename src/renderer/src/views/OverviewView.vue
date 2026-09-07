<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import AppIcon from '../components/AppIcon.vue'
import { useRouter } from 'vue-router'
import { useKernelStore } from '../stores/kernel'
import { useSystemProxyStore } from '../stores/system-proxy'
import { useTunStore } from '../stores/tun'
import { useSnifferEnhancementStore } from '../stores/sniffer-enhancement'
import { useDnsEnhancementStore } from '../stores/dns-enhancement'
import { TUN_DATA_PLANE_UNCONFIRMED, TUN_UI_COPY } from '@shared/tun'
import { formatSystemProxyEndpoint } from '@shared/system-proxy'

const router = useRouter()
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
  if (tun.status.phase === 'active' && tun.status.errorMessage === TUN_DATA_PLANE_UNCONFIRMED) {
    return 'TUN 已启用（连通性未确认）'
  }
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

// 二级设置页：卡片点击直接跳转「更多」里对应的设置页（网络 / DNS 与嗅探），
// 那里已有完整的面板与说明，概览不再重复承载抽屉表单。
const SETTINGS_ROUTES = {
  'system-proxy': '/network',
  tun: '/network',
  sniffer: '/dns-sniffer',
  dns: '/dns-sniffer'
} as const
type SettingKey = keyof typeof SETTINGS_ROUTES
function openSettings(key: SettingKey): void {
  void router.push(SETTINGS_ROUTES[key])
}
</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section>
      <h2>网络管理</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>系统代理</h3>
              <p>将系统 HTTP 代理指向内核 mixed-port。</p>
            </div>
            <button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" aria-label="切换系统代理" @click.stop="toggleSystemProxy" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</span>
            <button type="button" class="setting-nav" aria-label="打开系统代理设置" @click="openSettings('system-proxy')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>TUN 模式</h3>
              <p>虚拟网卡接管全部流量，需管理员服务。</p>
            </div>
            <button type="button" class="switch" :class="{ on: tunActive }" :aria-checked="tunActive" :disabled="tunSwitchDisabled" aria-label="切换 TUN 模式" @click.stop="toggleTun" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: tunActive }" />{{ tunPhaseLabel }}</span>
            <button type="button" class="setting-nav" aria-label="打开 TUN 模式设置" @click="openSettings('tun')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="tun.actionError" class="inline-error" role="alert">{{ tun.actionError }}</p>
        </SurfaceCard>
      </div>
    </section>
    <section>
      <h2>覆写</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>嗅探覆写</h3>
              <p>域名嗅探、端口与跳过/强制域名规则。</p>
            </div>
            <button type="button" class="switch" :class="{ on: snifferEnabled }" :aria-checked="snifferEnabled" :disabled="snifferBusy" aria-label="切换嗅探覆写" @click.stop="toggleSniffer" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: snifferEnabled }" />{{ snifferBusy ? '正在保存…' : snifferEnabled ? '已启用 · 下次启动内核生效' : '未启用' }}</span>
            <button type="button" class="setting-nav" aria-label="打开嗅探覆写设置" @click="openSettings('sniffer')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="sniffer.lastError" class="inline-error" role="alert">{{ sniffer.lastError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>DNS 覆写</h3>
              <p>Fake-IP、解析服务器与分流策略。</p>
            </div>
            <button type="button" class="switch" :class="{ on: dnsEnabled }" :aria-checked="dnsEnabled" :disabled="dnsBusy" aria-label="切换 DNS 覆写" @click.stop="toggleDns" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: dnsEnabled }" />{{ dnsBusy ? '正在保存…' : dnsEnabled ? '已启用 · 下次启动内核生效' : '未启用' }}</span>
            <button type="button" class="setting-nav" aria-label="打开 DNS 覆写设置" @click="openSettings('dns')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="dns.lastError" class="inline-error" role="alert">{{ dns.lastError }}</p>
        </SurfaceCard>
      </div>
    </section>
  </div>
</template>

<style scoped>
.setting-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  min-height: 32px;
}
.setting-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  min-width: 0;
  margin-top: 0;
  padding-top: 0;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setting-nav {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  margin: 0 -7px 0 0;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.setting-nav:hover { background: rgba(127, 127, 127, 0.1); color: var(--app-text); }
.setting-nav:focus-visible { outline: 2px solid var(--app-blue); outline-offset: 1px; }
.setting-card { gap: 8px; }
.inline-error { margin-top: 8px; color: var(--app-danger, #d64f4f); font-size: 12px; }
</style>
