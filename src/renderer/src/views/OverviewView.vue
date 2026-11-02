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
import { useCoreSettingsStore } from '../stores/core-settings'
import { useLanStore } from '../stores/lan'
import { lanAddresses } from '@shared/lan'

const router = useRouter()
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const sniffer = useSnifferEnhancementStore()
const dns = useDnsEnhancementStore()
const core = useCoreSettingsStore()
const lan = useLanStore()
const actionError = ref('')
const busy = computed(() => kernel.status.phase === 'starting' || kernel.status.phase === 'stopping')

/** The 覆写 quick switches hydrate the persisted models once on page open. */
onMounted(() => {
  void sniffer.refresh()
  void dns.refresh()
  void core.refresh()
  void lan.refresh()
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
      // Another program (another proxy client, a VPN…) rewrote the WinINET
      // proxy. The app never fights that on its own; switching on is the
      // explicit take-over. The changed keys stay in the hover title.
      return '已被其他程序接管，打开开关可重新接管'
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
      // The backend owns the atomic start-then-enable sequence. Keeping it out
      // of the renderer also covers tray/startup callers and preserves the real
      // kernel-start error (for example, a port takeover failure).
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
const snifferBusy = computed(() => sniffer.busy || !sniffer.hydrated)
async function toggleSniffer(): Promise<void> {
  if (!sniffer.hydrated || sniffer.busy) return
  await sniffer.save({ ...sniffer.enhancement, enabled: !snifferEnabled.value })
}
const dnsEnabled = computed(() => dns.enhancement.enabled)
const dnsBusy = computed(() => dns.busy || !dns.hydrated)
async function toggleDns(): Promise<void> {
  if (!dns.hydrated || dns.busy) return
  await dns.save({ ...dns.enhancement, enabled: !dnsEnabled.value })
}

// 局域网设备接管 — the HTTP & SOCKS5 card is mihomo's allow-lan: the mixed
// port (HTTP + SOCKS5 on one port) starts listening on every interface. The
// backend applies the switch live (PATCH /configs re-creates the listeners),
// so neither the kernel nor TUN restarts.
const lanHosts = computed(() => lanAddresses(lan.addresses))
const primaryLan = computed(() => lanHosts.value[0]?.address ?? null)
const allowLan = computed(() => core.settings.allowLan)
const allowLanBusy = computed(() => core.busy || !core.hydrated)
const lanError = ref('')
const lanStatus = computed(() => {
  if (!core.hydrated) return '正在读取…'
  if (!allowLan.value) return '未启用'
  if (!primaryLan.value) return '已允许局域网连接 · 未检测到局域网地址'
  return `代理监听在 ${primaryLan.value}:${core.settings.mixedPort}`
})
/** Every LAN address and listener, for the hover title. */
const lanStatusDetail = computed(() => {
  if (!allowLan.value || !lanHosts.value.length) return undefined
  const ports = [`HTTP / SOCKS5 混合端口 ${core.settings.mixedPort}`]
  if (core.settings.enabled) ports.push(`HTTP ${core.settings.httpPort}`, `SOCKS5 ${core.settings.socksPort}`)
  return `${lanHosts.value.map((entry) => `${entry.name}：${entry.address}`).join('\n')}\n${ports.join(' · ')}`
})
async function toggleAllowLan(): Promise<void> {
  if (allowLanBusy.value) return
  lanError.value = ''
  const saved = await core.save({ ...core.settings, allowLan: !allowLan.value })
  if (!saved) lanError.value = core.lastError ?? '切换失败'
  void lan.refresh()
}

// 网关模式 — mihomo has no DHCP server, so the app cannot hand out leases the way
// Surge does. With TUN on and Windows IP forwarding enabled, a device whose
// gateway is set to this PC by hand is routed into the TUN adapter, where
// mihomo takes over its traffic (DNS included, via dns-hijack).
const gatewayReady = computed(() => tunActive.value && Boolean(primaryLan.value))
const gatewayStatus = computed(() => {
  if (!tunActive.value) return '需先开启 TUN 模式'
  return primaryLan.value ? `网关地址 ${primaryLan.value}` : 'TUN 已启用 · 未检测到局域网地址'
})

// 二级设置页：卡片点击直接跳转「更多」里对应的设置页（网络 / DNS 与嗅探），
// 那里已有完整的面板与说明，概览不再重复承载抽屉表单。
const SETTINGS_ROUTES = {
  'system-proxy': '/network',
  tun: '/network',
  lan: '/kernel-settings',
  gateway: '/network',
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
            <span class="setting-status" :title="sp.phase === 'conflict' ? sp.conflictDetail ?? undefined : undefined"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</span>
            <button type="button" class="setting-nav" aria-label="打开系统代理设置" @click="openSettings('system-proxy')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
          <p v-else-if="spEnabled && sp.errorMessage" class="inline-error">{{ sp.errorMessage }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>TUN 模式</h3>
              <p>虚拟网卡接管全部流量，由系统服务负责运行。</p>
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
      <h2>局域网设备接管</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>HTTP 与 SOCKS5 代理</h3>
              <p>允许局域网内的其他设备把本机用作标准的 HTTP 与 SOCKS5 代理服务器。</p>
            </div>
            <button type="button" class="switch" :class="{ on: allowLan }" :aria-checked="allowLan" :disabled="allowLanBusy" aria-label="切换局域网 HTTP 与 SOCKS5 代理" @click.stop="toggleAllowLan" />
          </div>
          <div class="setting-body">
            <span class="setting-status" :title="lanStatusDetail"><i :class="{ active: allowLan && Boolean(primaryLan) }" />{{ lanStatus }}</span>
            <button type="button" class="setting-nav" aria-label="打开局域网代理端口设置" @click="openSettings('lan')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="lanError" class="inline-error" role="alert">{{ lanError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>网关模式</h3>
              <p>把其他设备的网关指向本机，由 TUN 接管它们的全部流量。mihomo 不提供 DHCP 服务，需在设备上手动设置。</p>
            </div>
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: gatewayReady }" />{{ gatewayStatus }}</span>
            <button type="button" class="setting-nav" aria-label="查看网关模式设置方法" @click="openSettings('gateway')"><AppIcon name="next" :size="14" /></button>
          </div>
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
            <span class="setting-status"><i :class="{ active: snifferEnabled }" />{{ snifferBusy ? '正在应用…' : snifferEnabled ? '已启用' : '未启用' }}</span>
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
            <span class="setting-status"><i :class="{ active: dnsEnabled }" />{{ dnsBusy ? '正在应用…' : dnsEnabled ? '已启用' : '未启用' }}</span>
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
  gap: var(--space-4);
  margin-top: auto;
  min-height: 32px;
}
.setting-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  overflow: hidden;
  color: var(--app-muted);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setting-nav {
  display: grid;
  place-items: center;
  align-self: flex-end;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  margin: 0 -7px -7px 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.setting-nav:hover { background: var(--app-fill); color: var(--app-text); }
.setting-nav:focus-visible { outline: 2px solid var(--app-blue); outline-offset: 1px; }
.setting-card { gap: var(--space-3); }
.inline-error { margin-top: 8px; color: var(--app-danger); font-size: var(--font-size-sm); }
</style>
