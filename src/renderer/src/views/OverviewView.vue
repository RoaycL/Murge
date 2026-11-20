<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref, watch } from 'vue'
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
import { brand } from '@shared/brand'
import { useTunConfigStore } from '../stores/tun-config'

const router = useRouter()
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const sniffer = useSnifferEnhancementStore()
const dns = useDnsEnhancementStore()
const core = useCoreSettingsStore()
const lan = useLanStore()
const tunConfig = useTunConfigStore()
const actionError = ref('')
const busy = computed(() => kernel.status.phase === 'starting' || kernel.status.phase === 'stopping')

/** The 覆写 quick switches hydrate the persisted models once on page open. */
onMounted(() => {
  void sniffer.refresh()
  void dns.refresh()
  void core.refresh()
  void lan.refresh()
  void lan.refreshGateway()
  void tunConfig.refresh()
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
      return t('overview.enabledWith', [formatSystemProxyEndpoint(sp.value)])
    case 'enabling':
      return t('overview.proxyEnabling')
    case 'disabled':
      return sp.value.errorMessage ?? t('common.notEnabled')
    case 'restoring':
      return t('overview.proxyRestoring')
    case 'restore-failed':
      return t('overview.proxyRestoreFailed')
    case 'conflict':
      // Another program (another proxy client, a VPN…) rewrote the WinINET
      // proxy. The app never fights that on its own; switching on is the
      // explicit take-over. The changed keys stay in the hover title.
      return t('overview.proxyConflict')
    case 'unsupported':
      return sp.value.errorMessage ?? t('overview.proxyUnsupported')
    default:
      return t('overview.unknownState')
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
  if (!tun.status.supported) return t('overview.tunUnsupported')
  if (tun.status.phase === 'active' && tun.status.errorMessage === TUN_DATA_PLANE_UNCONFIRMED) {
    return t('overview.tunUnverified')
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
  if (!core.hydrated) return t('common.reading')
  if (!allowLan.value) return t('common.notEnabled')
  if (!primaryLan.value) return t('overview.lanNoAddress')
  return t('overview.lanListening', [primaryLan.value, core.settings.mixedPort])
})
/** Every LAN address and listener, for the hover title. */
const lanStatusDetail = computed(() => {
  if (!allowLan.value || !lanHosts.value.length) return undefined
  const ports = [t('overview.mixedPort', [core.settings.mixedPort])]
  if (core.settings.enabled) ports.push(`HTTP ${core.settings.httpPort}`, `SOCKS5 ${core.settings.socksPort}`)
  return `${lanHosts.value.map((entry) => t('common.labelValue', [entry.name, entry.address])).join('\n')}\n${ports.join(' · ')}`
})
async function toggleAllowLan(): Promise<void> {
  if (allowLanBusy.value) return
  lanError.value = ''
  const saved = await core.save({ ...core.settings, allowLan: !allowLan.value })
  if (!saved) lanError.value = core.lastError ?? t('common.switchFailed')
  void lan.refresh()
}

// 网关模式 — mihomo has no DHCP server, so the app cannot hand out leases the way
// Surge does. With TUN on and Windows IP forwarding enabled, a device whose
// gateway is set to this PC by hand is routed into the TUN adapter, where
// mihomo takes over its traffic (DNS included, via dns-hijack). The switch
// turns the forwarding on: the privileged TUN service applies it (and keeps it
// across TUN adapter rebuilds); without the service a UAC prompt asks once.
const gatewayEnabled = computed(() => lan.gateway?.enabled ?? false)
const gatewayBusy = computed(() => lan.gatewayBusy)
const gatewayDevice = computed(() => tunConfig.config.device === 'Mihomo' ? `${brand.shortName} TUN` : tunConfig.config.device)
const gatewayReady = computed(() => gatewayEnabled.value && tunActive.value && Boolean(primaryLan.value))
const gatewayStatus = computed(() => {
  if (!gatewayEnabled.value) return tunActive.value ? t('common.notEnabled') : t('overview.gatewayNeedTun')
  if (!tunActive.value) return t('overview.gatewayWaitingTun')
  return primaryLan.value ? t('lanGateway.gatewayAddress', [primaryLan.value]) : t('overview.gatewayNoAddress')
})
/** Which adapters forward right now, for the hover title. */
const gatewayStatusDetail = computed(() => {
  const interfaces = lan.gateway?.interfaces ?? []
  if (!gatewayEnabled.value || !interfaces.length) return undefined
  return interfaces.map((entry) => t('common.labelValue', [entry.name, entry.forwarding ? t('overview.forwardingOn') : t('overview.forwardingOff')])).join('\n')
})
async function toggleGateway(): Promise<void> {
  if (gatewayBusy.value) return
  await lan.setGateway(!gatewayEnabled.value, gatewayDevice.value)
}
// The service applies forwarding a moment after the TUN adapter appears.
watch(tunActive, () => { setTimeout(() => { void lan.refreshGateway() }, 4000) })

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
    <h1>{{ t('overview.title') }}</h1>
    <section>
      <h2>{{ t('overview.networkTitle') }}</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('common.systemProxy') }}</h3>
              <p>{{ t('overview.systemProxyHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" :aria-label="t('overview.toggleSystemProxy')" @click.stop="toggleSystemProxy" />
          </div>
          <div class="setting-body">
            <span class="setting-status" :title="sp.phase === 'conflict' ? sp.conflictDetail ?? undefined : undefined"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openSystemProxy')" @click="openSettings('system-proxy')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
          <p v-else-if="spEnabled && sp.errorMessage" class="inline-error">{{ sp.errorMessage }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('common.tunMode') }}</h3>
              <p>{{ t('overview.tunHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: tunActive }" :aria-checked="tunActive" :disabled="tunSwitchDisabled" :aria-label="t('overview.toggleTun')" @click.stop="toggleTun" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: tunActive }" />{{ tunPhaseLabel }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openTun')" @click="openSettings('tun')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="tun.actionError" class="inline-error" role="alert">{{ tun.actionError }}</p>
        </SurfaceCard>
      </div>
    </section>
    <section>
      <h2>{{ t('overview.lanTitle') }}</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('overview.lanProxy') }}</h3>
              <p>{{ t('overview.lanProxyHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: allowLan }" :aria-checked="allowLan" :disabled="allowLanBusy" :aria-label="t('overview.toggleLanProxy')" @click.stop="toggleAllowLan" />
          </div>
          <div class="setting-body">
            <span class="setting-status" :title="lanStatusDetail"><i :class="{ active: allowLan && Boolean(primaryLan) }" />{{ lanStatus }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openLanProxy')" @click="openSettings('lan')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="lanError" class="inline-error" role="alert">{{ lanError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('lanGateway.title') }}</h3>
              <p>{{ t('overview.gatewayHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: gatewayEnabled }" :aria-checked="gatewayEnabled" :disabled="gatewayBusy" :aria-label="t('overview.toggleGateway')" @click.stop="toggleGateway" />
          </div>
          <div class="setting-body">
            <span class="setting-status" :title="gatewayStatusDetail"><i :class="{ active: gatewayReady }" />{{ gatewayStatus }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openGateway')" @click="openSettings('gateway')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="lan.gatewayError" class="inline-error" role="alert">{{ lan.gatewayError }}</p>
        </SurfaceCard>
      </div>
    </section>
    <section>
      <h2>{{ t('overview.overridesTitle') }}</h2>
      <div class="overview-grid">
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('overview.sniffer') }}</h3>
              <p>{{ t('overview.snifferHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: snifferEnabled }" :aria-checked="snifferEnabled" :disabled="snifferBusy" :aria-label="t('overview.toggleSniffer')" @click.stop="toggleSniffer" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: snifferEnabled }" />{{ snifferBusy ? t('overview.applying') : snifferEnabled ? t('common.enabled') : t('common.notEnabled') }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openSniffer')" @click="openSettings('sniffer')"><AppIcon name="next" :size="14" /></button>
          </div>
          <p v-if="sniffer.lastError" class="inline-error" role="alert">{{ sniffer.lastError }}</p>
        </SurfaceCard>
        <SurfaceCard class="setting-card">
          <div class="setting-head">
            <div>
              <h3>{{ t('overview.dns') }}</h3>
              <p>{{ t('overview.dnsHint') }}</p>
            </div>
            <button type="button" class="switch" :class="{ on: dnsEnabled }" :aria-checked="dnsEnabled" :disabled="dnsBusy" :aria-label="t('overview.toggleDns')" @click.stop="toggleDns" />
          </div>
          <div class="setting-body">
            <span class="setting-status"><i :class="{ active: dnsEnabled }" />{{ dnsBusy ? t('overview.applying') : dnsEnabled ? t('common.enabled') : t('common.notEnabled') }}</span>
            <button type="button" class="setting-nav" :aria-label="t('overview.openDns')" @click="openSettings('dns')"><AppIcon name="next" :size="14" /></button>
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
  min-height: 22px;
}
.setting-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  overflow: hidden;
  color: var(--app-text);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setting-nav {
  display: grid;
  place-items: center;
  align-self: flex-end;
  flex: 0 0 26px;
  width: 26px;
  height: 22px;
  margin: 0 -7px -7px 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.setting-nav:hover { background: var(--app-fill); color: var(--app-text); }
.setting-nav:focus-visible { outline: 2px solid var(--app-blue); outline-offset: 1px; }
.setting-card { gap: var(--space-2); }
.inline-error { margin-top: 8px; color: var(--app-danger); font-size: var(--font-size-sm); }
</style>
