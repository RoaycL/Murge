<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useUpdatesStore } from '../stores/updates'

const updates = useUpdatesStore()

const visible = computed(() => {
  const phase = updates.state.phase
  return phase === 'available' || phase === 'downloading' || phase === 'downloaded'
})

const title = computed<string>(() => {
  switch (updates.state.phase) {
    case 'available': return `发现新版本 v${updates.state.availableVersion ?? ''}`
    case 'downloading': return `正在下载更新 v${updates.state.availableVersion ?? ''}…`
    case 'downloaded': return `新版本 v${updates.state.availableVersion ?? ''} 已就绪`
    default: return ''
  }
})

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

const progressLabel = computed<string | null>(() => {
  const progress = updates.state.progress
  if (!progress) return null
  return `${progress.percent.toFixed(0)}% · ${formatBytes(progress.transferred)}${progress.total ? ` / ${formatBytes(progress.total)}` : ''}`
})

const body = computed<string>(() => {
  switch (updates.state.phase) {
    case 'available': return '正在后台下载，退出应用时自动安装。'
    case 'downloaded': return '退出应用时自动安装，或点击右侧按钮立即安装。'
    default: return ''
  }
})

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = updates.subscribe()
})
onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <div v-if="visible" class="update-banner" :class="`is-${updates.state.phase}`" role="status">
    <div class="update-banner-text">
      <strong>{{ title }}</strong>
      <span v-if="progressLabel" class="update-banner-progress">{{ progressLabel }}</span>
      <span v-else-if="body" class="update-banner-body">{{ body }}</span>
    </div>
    <div class="update-banner-actions">
      <div v-if="updates.state.phase === 'downloading' && updates.state.progress" class="update-banner-bar">
        <div class="update-banner-bar-fill" :style="{ width: `${updates.state.progress.percent}%` }"></div>
      </div>
      <button v-else-if="updates.state.canInstall" type="button" @click="updates.install()">重启并安装</button>
    </div>
  </div>
</template>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 1.25rem;
  padding: 0.75rem 1rem;
  border-radius: var(--radius-control);
  background: var(--app-surface);
  border: 1px solid var(--app-surface-border);
  box-shadow: var(--app-shadow);
}
.update-banner.is-downloaded { border-color: var(--app-green); }
.update-banner-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.update-banner-text strong { font-size: 0.95rem; color: var(--app-text); }
.update-banner-body, .update-banner-progress { font-size: 0.8rem; color: var(--app-muted); }
.update-banner-actions { display: flex; align-items: center; flex: 0 0 auto; }
.update-banner-bar { width: 120px; height: 8px; border-radius: 4px; background: var(--app-divider); overflow: hidden; }
.update-banner-bar-fill { height: 100%; background: var(--app-blue); transition: width 0.2s ease; }
</style>
