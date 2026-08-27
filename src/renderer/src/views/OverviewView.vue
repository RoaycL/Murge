<script setup lang="ts">
import { computed, ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import { useKernelStore } from '../stores/kernel'

const kernel = useKernelStore()
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
</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>内核</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>安全直连内核</h3><p>仅启动本机 mihomo 与回环控制器；不会启用系统代理、TUN 或 DNS 接管。</p></div><button type="button" class="primary-button" :disabled="busy" @click="toggleKernel">{{ busy ? '处理中…' : running ? '停止' : '启动' }}</button></div><div class="setting-status"><i :class="{ active: running }" />{{ running ? `运行中 · PID ${kernel.status.pid ?? '—'}` : kernel.status.phase === 'failed' ? '启动失败' : '未运行（需手动启动）' }}</div><p v-if="actionError" class="inline-error">{{ actionError }}</p></SurfaceCard>
    </div></section>
    <section><h2>网络接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>系统代理</h3><p>大多数应用的流量可以通过将系统代理指向本应用，具有最佳的兼容性和性能。</p></div><button class="switch" disabled aria-label="系统代理尚未实现" /></div><div class="setting-status"><i />阶段 8 尚未实现，当前未启用</div></SurfaceCard>
      <SurfaceCard><div class="setting-head"><div><h3>TUN 模式</h3><p>接管不遵循系统代理设置的应用流量，需要系统权限和正确安装的服务组件。</p></div><button class="switch" disabled aria-label="TUN 模式尚未实现" /></div><div class="setting-status"><i />阶段 9 尚未实现，当前未启用</div></SurfaceCard>
    </div></section>
    <section><h2>局域网设备接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>HTTP & SOCKS5 代理</h3><p>安全直连配置强制只监听本机；开放局域网将在独立安全阶段实现。</p></div><button class="switch" disabled aria-label="局域网接管尚未实现" /></div><div class="setting-status"><i />未开放局域网；启动后仅监听 127.0.0.1</div></SurfaceCard>
    </div></section>
  </div>
</template>
