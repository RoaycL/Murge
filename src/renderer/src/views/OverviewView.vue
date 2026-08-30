<script setup lang="ts">
import { computed, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import { useKernelStore } from '../stores/kernel'
import { useSystemProxyStore } from '../stores/system-proxy'
import { useTunStore } from '../stores/tun'

const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const tun = useTunStore()
const actionError = ref('')
const busy = computed(() => kernel.status.phase === 'starting' || kernel.status.phase === 'stopping')
const running = computed(() => kernel.status.phase === 'running')

async function toggleKernel(): Promise<void> {
  actionError.value = ''
  try {
    if (running.value) await kernel.stop()
    else await kernel.start()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
}

const sp = computed(() => systemProxy.status)
const spBusy = computed(() => sp.value.phase === 'enabling' || sp.value.phase === 'restoring')
const spEnabled = computed(() => sp.value.phase === 'enabled')
// Enabling requires a running kernel + ready controller; disabling an owned
// proxy is always allowed (even if the kernel just stopped), so a stale proxy can
// always be turned off.
const spSwitchDisabled = computed(
  () => spBusy.value || !sp.value.supported || (!spEnabled.value && !running.value)
)
const spPhaseLabel = computed(() => {
  switch (sp.value.phase) {
    case 'enabled':
      return `已启用 · ${sp.value.address ?? '127.0.0.1'}${sp.value.port ? `:${sp.value.port}` : ''}`
    case 'enabling':
      return '正在启用系统代理…'
    case 'disabled':
      return sp.value.errorMessage ?? (running.value ? '未启用' : '未启用 · 需先启动内核')
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
    if (spEnabled.value) await systemProxy.disable()
    else await systemProxy.enable()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
}

const tunActive = computed(() => tun.status.phase === 'active')
const tunBusy = computed(() => tun.status.phase === 'starting' || tun.status.phase === 'restoring')
const tunSwitchDisabled = computed(() => tunBusy.value || !tun.status.supported || (!tunActive.value && (running.value || spEnabled.value)))
const tunPhaseLabel = computed(() => {
  switch (tun.status.phase) {
    case 'active': return '已启用 · mihomo 正在接管 TUN、路由与 DNS'
    case 'starting': return '正在启动特权服务与 TUN…'
    case 'restoring': return '正在停止 TUN 并恢复网络…'
    case 'configured': return '未启用（需要手动开启）'
    case 'failed': return tun.status.errorMessage ?? 'TUN 启动失败'
    case 'restore-failed': return tun.status.errorMessage ?? 'TUN 停止未确认，请勿退出或卸载'
    case 'conflict': return tun.status.conflictDetail ?? 'TUN 进程所有权冲突，已拒绝继续操作'
    case 'unsupported': return '仅安装了服务组件的 Windows 版本支持'
    default: return '未知状态'
  }
})

async function toggleTun(): Promise<void> {
  actionError.value = ''
  try {
    if (tunActive.value) await tun.disable()
    else await tun.enable()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>内核</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>安全直连内核</h3><p>仅启动本机 mihomo 与回环控制器；不会启用系统代理、TUN 或 DNS 接管。</p></div><button type="button" class="primary-button" :disabled="busy" @click="toggleKernel">{{ busy ? '处理中…' : running ? '停止' : '启动' }}</button></div><div class="setting-status"><i :class="{ active: running }" />{{ running ? `运行中 · PID ${kernel.status.pid ?? '—'}` : kernel.status.phase === 'starting' ? '正在校验并准备内置内核…' : kernel.status.phase === 'stopping' ? '正在停止内核…' : kernel.status.phase === 'failed' ? '启动失败' : '未运行（需手动启动）' }}</div><p v-if="actionError || kernel.status.lastError" class="inline-error">{{ actionError || kernel.status.lastError }}</p></SurfaceCard>
    </div></section>
    <section><h2>网络接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>系统代理</h3><p>大多数应用的流量可以通过将系统代理指向本应用，具有最佳的兼容性和性能。</p></div><button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" aria-label="切换系统代理" @click="toggleSystemProxy" /></div><div class="setting-status"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</div><p v-if="actionError" class="inline-error">{{ actionError }}</p></SurfaceCard>
      <SurfaceCard><div class="setting-head"><div><h3>TUN 模式</h3><p>由特权服务托管 mihomo；mihomo 单独负责 Wintun、路由与 DNS，需先停止安全内核和系统代理。</p></div><button type="button" class="switch" :class="{ on: tunActive }" :aria-checked="tunActive" :disabled="tunSwitchDisabled" aria-label="切换 TUN 模式" @click="toggleTun" /></div><div class="setting-status"><i :class="{ active: tunActive }" />{{ tunPhaseLabel }}</div><p v-if="tun.status.errorMessage" class="inline-error">{{ tun.status.errorMessage }}</p></SurfaceCard>
    </div></section>
    <section><h2>局域网设备接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>HTTP & SOCKS5 代理</h3><p>安全直连配置强制只监听本机；开放局域网将在独立安全阶段实现。</p></div><button class="switch" disabled aria-label="局域网接管尚未实现" /></div><div class="setting-status"><i />未开放局域网；启动后仅监听 127.0.0.1</div></SurfaceCard>
    </div></section>
  </div>
</template>
