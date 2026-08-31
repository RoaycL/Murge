<script setup lang="ts">
import { computed, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import { useKernelStore } from '../stores/kernel'
import { useSystemProxyStore } from '../stores/system-proxy'

const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
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
      // Turning on the system proxy auto-starts the kernel (which also awaits a
      // ready loopback controller) before pointing the registry at its
      // mixed-port. The backend probe still guards the actual enable, so the
      // loopback-only safety boundary and the TUN mutual-exclusion invariants
      // are unchanged.
      if (!running.value) await kernel.start()
      await systemProxy.enable()
    }
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
}

</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>内核</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>安全直连内核</h3><p>仅启动本机 mihomo 与回环控制器，不接管系统网络；系统代理开关可自动完成这一步，且默认在启动应用后自动运行（可在通用设置中关闭）。</p></div><button type="button" class="primary-button" :disabled="busy" @click="toggleKernel">{{ busy ? '处理中…' : running ? '停止' : '启动' }}</button></div><div class="setting-status"><i :class="{ active: running }" />{{ running ? `运行中 · PID ${kernel.status.pid ?? '—'}` : kernel.status.phase === 'starting' ? '正在校验并准备内置内核…' : kernel.status.phase === 'stopping' ? '正在停止内核…' : kernel.status.phase === 'failed' ? '启动失败' : '未运行（可在设置中开启“启动时自动启动内核”，或用右侧按钮手动启动）' }}</div><p v-if="actionError || kernel.status.lastError" class="inline-error">{{ actionError || kernel.status.lastError }}</p></SurfaceCard>
    </div></section>
    <section><h2>网络接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>系统代理</h3><p>将系统代理指向本应用的内核，不必先手动启动内核；首次开启会自动启动内核。兼容性和性能最佳。</p></div><button type="button" class="switch" :class="{ on: spEnabled }" :aria-checked="spEnabled" :disabled="spSwitchDisabled" aria-label="切换系统代理" @click="toggleSystemProxy" /></div><div class="setting-status"><i :class="{ active: spEnabled }" />{{ spPhaseLabel }}</div><p v-if="actionError" class="inline-error">{{ actionError }}</p></SurfaceCard>
    </div></section>
    <section><h2>局域网设备接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>HTTP & SOCKS5 代理</h3><p>安全直连配置强制只监听本机；开放局域网将在独立安全阶段实现。</p></div><button class="switch" disabled aria-label="局域网接管尚未实现" /></div><div class="setting-status"><i />未开放局域网；启动后仅监听 127.0.0.1</div></SurfaceCard>
    </div></section>
  </div>
</template>
