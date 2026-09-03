<script setup lang="ts">
import { computed, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import { useKernelStore } from '../stores/kernel'
import { useSystemProxyStore } from '../stores/system-proxy'
import { useTunStore } from '../stores/tun'
import { TUN_UI_COPY } from '@shared/tun'

const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const actionError = ref('')
const busy = computed(() => kernel.status.phase === 'starting' || kernel.status.phase === 'stopping')
const running = computed(() => kernel.status.phase === 'running')

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
      return `已启用 · ${sp.value.address ?? '127.0.0.1'}${sp.value.port ? `:${sp.value.port}` : ''}`
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

</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>网络接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>系统代理</h3><p>将系统代理指向当前正在接管网络的内核（端口固定：系统代理与内核始终指向同一个混合端口，无论当前是普通模式还是 TUN）。未接管时首次开启会自动启动内核，兼容性和性能最佳。</p></div><button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" aria-label="切换系统代理" @click="toggleSystemProxy" /></div><div class="setting-status"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</div><p v-if="actionError" class="inline-error">{{ actionError }}</p></SurfaceCard>
      <SurfaceCard><div class="setting-head"><div><h3>TUN 模式</h3><p>接管全部流量（包括不遵循系统代理的程序）。使用当前激活的订阅与分流规则，并且可与系统代理同时开启（两者指向同一内核：系统代理指向其混合端口，TUN 接管全部流量）；启用时会自动以特权方式重启同一内核，无需手动处理，禁用后由 mihomo 自动恢复网络设置。</p></div><button type="button" class="switch" :class="{ on: tunActive }" :aria-checked="tunActive" :disabled="tunSwitchDisabled" aria-label="切换 TUN 模式" @click="toggleTun" /></div><div class="setting-status"><i :class="{ active: tunActive }" />{{ tunPhaseLabel }}</div><p v-if="tun.actionError" class="inline-error">{{ tun.actionError }}</p></SurfaceCard>
    </div></section>
    <section><h2>局域网设备接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>HTTP & SOCKS5 代理</h3><p>内核配置强制只监听本机；开放局域网将在独立安全阶段实现。</p></div><button class="switch" disabled aria-label="局域网接管尚未实现" /></div><div class="setting-status"><i />未开放局域网；启动后仅监听 127.0.0.1</div></SurfaceCard>
    </div></section>
  </div>
</template>
