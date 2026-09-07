<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useAppSettingsStore } from '../stores/app-settings'
import { useSubStoreStore } from '../stores/substore'
import { subStoreMergedOrigin, subStoreMergedUrl } from '@shared/substore'

const appSettings = useAppSettingsStore()
const subStore = useSubStoreStore()

const subStoreUrl = computed(() =>
  subStore.state.phase === 'running' && subStore.state.port
    ? subStoreMergedUrl(subStore.state.port)
    : null
)
const subStoreOrigin = computed(() =>
  subStore.state.phase === 'running' && subStore.state.port
    ? subStoreMergedOrigin(subStore.state.port)
    : null
)
const versionText = computed(() => {
  const version = subStore.state.version
  return version ? `后端 ${version.backend} · 前端 ${version.frontend}` : '正在准备默认资源'
})
const phaseText = computed(() => {
  switch (subStore.state.phase) {
    case 'running': return `运行中 · 端口 ${subStore.state.port}`
    case 'starting': return '正在启动…'
    case 'downloading': return '正在下载资源…'
    case 'error': return subStore.state.error ?? '启动失败'
    default: return subStore.state.assetsReady ? '已就绪（未运行）' : '等待下载'
  }
})

async function initialize(): Promise<void> {
  await subStore.refresh()
  // Sub-Store is a built-in configuration tool: entering its dedicated page
  // also migrates the former opt-in default and downloads the verified assets.
  if (!subStore.state.enabled) {
    await appSettings.set({ subStoreEnabled: true })
    await subStore.refresh()
  }
  await subStore.ensureRunning()
}

async function toggleProxy(): Promise<void> {
  await appSettings.set({ subStoreUseProxy: !subStore.state.useProxy })
  await subStore.refresh()
  if (subStore.state.phase === 'running') await subStore.ensureRunning()
}

onMounted(() => void initialize())
</script>

<template>
  <div class="page-shell feature-page substore-view">
    <header class="feature-header">
      <div>
        <h1>Sub-Store</h1>
        <p>订阅转换、合并与配置链接管理。</p>
      </div>
      <span class="substore-phase">{{ phaseText }}</span>
    </header>

    <section class="surface-card substore-card">
      <header class="substore-head">
        <p>{{ versionText }}</p>
        <span class="substore-actions">
          <button
            type="button"
            class="quiet-button"
            :disabled="!subStoreUrl || subStore.busy"
            @click="subStoreOrigin && subStore.openExternal(subStoreUrl ?? subStoreOrigin)"
          >在浏览器中打开</button>
          <button type="button" class="quiet-button" :disabled="subStore.busy" @click="subStore.checkUpdate()">
            {{ subStore.busy ? '处理中…' : '检查更新' }}
          </button>
        </span>
      </header>
      <p class="substore-meta">
        <button type="button" class="substore-inline-toggle" @click="toggleProxy">
          订阅更新{{ subStore.state.useProxy ? '走内核代理' : '直连' }}
        </button>
      </p>
      <p v-if="subStore.errorMessage || subStore.state.error" class="inline-error" role="alert">
        {{ subStore.errorMessage ?? subStore.state.error }}
      </p>
      <div v-if="subStoreUrl" class="substore-frame-wrap">
        <iframe
          :src="subStoreUrl"
          class="substore-frame"
          title="Sub-Store"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.substore-view { min-height: 100%; }
.substore-phase { align-self: center; color: var(--app-muted); font-size: 11px; white-space: nowrap; }
.substore-card { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 420px; }
.substore-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.substore-head p, .substore-meta { margin: 0; color: var(--app-muted); font-size: 11px; }
.substore-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.quiet-button { min-height: 28px; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: transparent; color: var(--app-muted); font-size: 11px; white-space: nowrap; }
.quiet-button:disabled { opacity: .5; }
.substore-inline-toggle { border: 0; padding: 0; background: transparent; color: var(--app-accent, #7c6cf4); font-size: 11px; cursor: pointer; text-decoration: underline; }
.inline-error { margin: 0; color: var(--app-danger, #d64f4f); font-size: 12px; }
.substore-frame-wrap { flex: 1; margin-top: 4px; }
.substore-frame { display: block; width: 100%; height: min(72vh, 760px); min-height: 390px; border: 1px solid var(--app-divider); border-radius: 10px; background: #fff; }
</style>
