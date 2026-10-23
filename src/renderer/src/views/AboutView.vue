<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppInfo } from '@shared/app-info'
import type { BrandConfig } from '@shared/brand'
import { downloadDiagnosticReport } from '../lib/diagnostic-export'
import { useUpdatesStore } from '../stores/updates'
import { useAppSettingsStore } from '../stores/app-settings'
import type { UpdateChannel } from '@shared/app-settings'
import BrandMark from '../components/BrandMark.vue'

const brand = ref<BrandConfig | null>(null)
const info = ref<AppInfo | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const updates = useUpdatesStore()
const appSettings = useAppSettingsStore()

const CHANNELS: ReadonlyArray<{ value: UpdateChannel; label: string }> = [
  { value: 'stable', label: '稳定版' },
  { value: 'experimental', label: '实验版' }
]

const channelHelp = computed<string>(() => appSettings.settings.updateChannel === 'experimental'
  ? '实验版是新的 Tauri 版本，更轻但仍在测试。切回稳定版会重新安装 Electron 版本，配置和数据保留。'
  : '稳定版是当前的 Electron 版本。选择实验版会下载并安装 Tauri 版本，配置和数据保留，随时可以切回。')

async function selectChannel(channel: UpdateChannel): Promise<void> {
  if (channel === appSettings.settings.updateChannel) return
  await appSettings.set({ updateChannel: channel })
}

// The system browser opens links in both shells; Tauri has no handler for a
// `target="_blank"` window and would open a bare WebView2 window instead.
async function openLink(url: string): Promise<void> {
  error.value = null
  try { await window.desktop.subStore.openExternal(url) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}

// Vue registers lifecycle hooks synchronously during setup; registering
// `onUnmounted` from inside an async `onMounted` callback (after an `await`)
// has no effect, so the subscription would never be cleaned up. Hold the
// unsubscribe handle here and register the cleanup at the top level instead.
let unsubscribeUpdates: (() => void) | null = null

onMounted(async () => {
  unsubscribeUpdates = updates.subscribe()
  try {
    ;[brand.value, info.value] = await Promise.all([window.desktop.app.getBrand(), window.desktop.app.getInfo()])
    await Promise.all([updates.refresh(), appSettings.refresh()])
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

async function checkUpdates(): Promise<void> {
  busy.value = true; error.value = null
  try { await updates.check() } finally { busy.value = false }
}

async function exportDiagnostics(): Promise<void> {
  busy.value = true; error.value = null
  try {
    await downloadDiagnosticReport()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
</script>

<template><div class="page-shell about-view"><h1>关于</h1>
  <section class="surface-card about-product"><div class="about-product-title"><BrandMark :size="38" /><strong>{{ brand?.productName ?? '—' }}</strong></div><span>版本 {{ info?.version ?? '—' }} · {{ info?.platform ?? '—' }} / {{ info?.arch ?? '—' }}</span><p>{{ brand?.description }}</p></section>
  <section><h2>更新</h2><div class="surface-card general-info">
    <div v-if="updates.state.channelsSupported" class="update-row"><span><strong>更新通道</strong><small>{{ channelHelp }}</small></span><div class="segmented" role="group" aria-label="更新通道"><button v-for="channel in CHANNELS" :key="channel.value" type="button" :class="{ selected: appSettings.settings.updateChannel === channel.value }" :aria-pressed="appSettings.settings.updateChannel === channel.value" :disabled="appSettings.busy" @click="selectChannel(channel.value)">{{ channel.label }}</button></div></div>
    <p v-if="appSettings.errorMessage" class="inline-error">{{ appSettings.errorMessage }}</p>
    <div class="update-row"><span><strong>检查并安装更新</strong><small>发布新版本后会自动推送，也可在此手动检查。</small></span><button type="button" :disabled="busy || updates.state.phase === 'checking' || updates.state.phase === 'downloading'" @click="checkUpdates">检查更新</button></div>
    <p v-if="statusText" class="update-status" :class="statusClass">{{ statusText }}</p>
    <div v-if="updates.state.canInstall" class="update-row"><span><strong>已就绪</strong></span><button type="button" @click="updates.install">重启并安装</button></div>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div></section>
  <section><h2>支持</h2><div class="surface-card preference-list">
    <a v-if="brand?.repositoryUrl" :href="brand.repositoryUrl" rel="noreferrer" @click.prevent="openLink(brand.repositoryUrl)"><span><strong>源代码仓库</strong><small>{{ brand.repositoryUrl }}</small></span><b>打开</b></a>
    <a v-if="brand?.supportUrl" :href="brand.supportUrl" rel="noreferrer" @click.prevent="openLink(brand.supportUrl)"><span><strong>问题与支持</strong><small>{{ brand.supportUrl }}</small></span><b>打开</b></a>
  </div></section>
  <section><h2>诊断</h2><div class="surface-card general-info"><p>导出启动耗时、运行与系统状态、端口归属和错误类别；不会包含原始日志、配置、订阅、控制器地址、密钥或用户路径。文件仅保存在本机。</p><button type="button" :disabled="busy" @click="exportDiagnostics">导出诊断报告</button></div><p v-if="error" class="inline-error">{{ error }}</p></section>
  <small class="about-copyright">{{ brand?.copyright }}</small>
</div></template>

<style scoped>
.about-product-title { display: flex; align-items: center; gap: var(--space-4); margin-bottom: 4px; }
.about-product-title strong { font-size: var(--font-size-title); }
.update-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-7); }
.update-row span { display: flex; flex-direction: column; gap: 0.25rem; }
.update-status { margin: 0.5rem 0 0; color: var(--app-muted); }
.update-status.muted { color: var(--app-muted); }
/* The page-wide `.about-view .general-info button` look is for action buttons only. */
.update-row + .update-row { margin-top: 14px; }
.update-row > button { flex: 0 0 auto; margin-top: 0; }
.update-row .segmented { flex: 0 0 auto; }
.update-row .segmented button { width: 64px; min-height: 0; height: 24px; margin-top: 0; padding: 0; border-radius: var(--radius-sm); background: transparent; color: inherit; }
.update-row .segmented button.selected { color: white; background: var(--app-control-selected); }
</style>
