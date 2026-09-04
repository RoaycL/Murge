<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppInfo } from '@shared/app-info'
import type { BrandConfig } from '@shared/brand'
import { serializeDiagnosticBundle, type DiagnosticInput } from '../lib/diagnostics'
import { useUpdatesStore } from '../stores/updates'

const brand = ref<BrandConfig | null>(null)
const info = ref<AppInfo | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const updates = useUpdatesStore()

// Vue registers lifecycle hooks synchronously during setup; registering
// `onUnmounted` from inside an async `onMounted` callback (after an `await`)
// has no effect, so the subscription would never be cleaned up. Hold the
// unsubscribe handle here and register the cleanup at the top level instead.
let unsubscribeUpdates: (() => void) | null = null

onMounted(async () => {
  unsubscribeUpdates = updates.subscribe()
  try {
    ;[brand.value, info.value] = await Promise.all([window.desktop.app.getBrand(), window.desktop.app.getInfo()])
    await updates.refresh()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
})

onUnmounted(() => {
  unsubscribeUpdates?.()
  unsubscribeUpdates = null
})

const statusText = computed<string | null>(() => {
  switch (updates.state.phase) {
    case 'idle': return '尚未检查更新。'
    case 'checking': return '正在检查更新…'
    case 'available': return `发现新版本 ${updates.state.availableVersion ?? ''}，正在准备下载。`
    case 'downloading': return `正在下载更新${updates.state.availableVersion ? ` ${updates.state.availableVersion}` : ''}…`
    case 'downloaded': return `新版本 ${updates.state.availableVersion ?? ''} 已就绪，重启应用后生效。`
    case 'not-available': return '已是最新版本。'
    case 'error': return updates.state.error ?? '检查更新失败。'
    default: return null
  }
})

const statusClass = computed<string>(() => (updates.state.phase === 'error' || updates.state.phase === 'not-available' ? 'muted' : ''))

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

async function checkUpdates(): Promise<void> {
  busy.value = true; error.value = null
  try { await updates.check() } finally { busy.value = false }
}

async function exportDiagnostics(): Promise<void> {
  if (!brand.value || !info.value) return
  busy.value = true; error.value = null
  try {
    const settled = await Promise.allSettled([
      window.desktop.kernel.getStatus(), window.desktop.systemProxy.getStatus(), window.desktop.startup.getStatus(), window.desktop.tun.getStatus()
    ])
    const value = <T,>(index: number): T | null => settled[index].status === 'fulfilled' ? settled[index].value as T : null
    const input: DiagnosticInput = { brand: brand.value, app: info.value, kernel: value(0), systemProxy: value(1), startup: value(2), tun: value(3), kernelVersion: null }
    const blob = new Blob([serializeDiagnosticBundle(input)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${brand.value.executableName}-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click(); URL.revokeObjectURL(url)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
</script>

<template><div class="page-shell about-view"><h1>关于</h1>
  <section class="surface-card about-product"><strong>{{ brand?.productName ?? '—' }}</strong><span>版本 {{ info?.version ?? '—' }} · {{ info?.platform ?? '—' }} / {{ info?.arch ?? '—' }}</span><p>{{ brand?.description }}</p></section>
  <section><h2>更新</h2><div class="surface-card general-info">
    <div class="update-row"><span><strong>检查并安装更新</strong><small>发布新版本后会自动推送，也可在此手动检查。</small></span><button type="button" :disabled="busy || updates.state.phase === 'checking' || updates.state.phase === 'downloading'" @click="checkUpdates">检查更新</button></div>
    <p v-if="statusText" class="update-status" :class="statusClass">{{ statusText }}</p>
    <div v-if="updates.state.phase === 'downloading' && updates.state.progress" class="progress"><div class="progress-fill" :style="{ width: `${updates.state.progress.percent}%` }"></div><span v-if="progressLabel" class="progress-label">{{ progressLabel }}</span></div>
    <div v-if="updates.state.canInstall" class="update-row"><span><strong>已就绪</strong></span><button type="button" @click="updates.install">重启并安装</button></div>
    <p v-if="error || updates.state.error" class="inline-error">{{ error ?? updates.state.error }}</p>
  </div></section>
  <section><h2>支持</h2><div class="surface-card preference-list">
    <a v-if="brand?.repositoryUrl" :href="brand.repositoryUrl" target="_blank" rel="noreferrer"><span><strong>源代码仓库</strong><small>{{ brand.repositoryUrl }}</small></span><b>打开</b></a>
    <a v-if="brand?.supportUrl" :href="brand.supportUrl" target="_blank" rel="noreferrer"><span><strong>问题与支持</strong><small>{{ brand.supportUrl }}</small></span><b>打开</b></a>
  </div></section>
  <section><h2>诊断</h2><div class="surface-card general-info"><p>诊断包仅包含版本、平台和功能状态；不会包含配置、订阅、控制器地址、密钥、日志或用户路径。</p><button type="button" :disabled="busy || !info" @click="exportDiagnostics">导出诊断包</button></div><p v-if="error" class="inline-error">{{ error }}</p></section>
  <small class="about-copyright">{{ brand?.copyright }}</small>
</div></template>

<style scoped>
.update-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.update-row span { display: flex; flex-direction: column; gap: 0.25rem; }
.update-status { margin: 0.5rem 0 0; color: var(--fg-secondary, #889); }
.update-status.muted { color: var(--fg-muted, #99a); }
.progress { position: relative; height: 12px; margin-top: 0.75rem; border-radius: 6px; background: var(--bg-muted, #e6e6ee); overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent, #4a7) ; transition: width 0.2s ease; }
.progress-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; }
</style>
