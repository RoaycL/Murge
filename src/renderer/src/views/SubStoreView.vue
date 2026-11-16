<script setup lang="ts">
import { t } from '@shared/i18n'
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
const proxyLabel = computed(() =>
  subStore.state.useProxy ? t('subStore.viaProxy') : t('subStore.direct')
)
const errorText = computed(() => subStore.errorMessage ?? subStore.state.error)

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
    <header class="feature-header substore-header">
      <div>
        <h1>Sub-Store</h1>
        <p>{{ t('subStore.intro') }}</p>
      </div>
      <span class="substore-actions">
        <button type="button" class="quiet-button" :disabled="subStore.busy" @click="toggleProxy">
          {{ proxyLabel }}
        </button>
        <button
          type="button"
          class="quiet-button"
          :disabled="!subStoreUrl || subStore.busy"
          :title="t('subStore.openTitle')"
          @click="subStoreOrigin && subStore.openExternal(subStoreUrl ?? subStoreOrigin)"
        >{{ t('subStore.openInBrowser') }}</button>
        <button type="button" class="quiet-button" :disabled="subStore.busy" @click="subStore.checkUpdate()">
          {{ subStore.busy ? t('common.processing') : t('common.checkUpdate') }}
        </button>
      </span>
    </header>

    <p v-if="errorText" class="substore-error" role="alert">{{ errorText }}</p>

    <!-- 内嵌区独占页头以下全部剩余高度，随窗口缩放（保留卡片描边）。 -->
    <div v-if="subStoreUrl" class="substore-frame-wrap">
      <iframe
        :src="subStoreUrl"
        class="substore-frame"
        title="Sub-Store"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  </div>
</template>

<style scoped>
/* The embedded Sub-Store page IS the page: the shell must resolve to a real
   height so the frame's flex fill tracks the window size. The 709px content
   column would keep the iframe under Sub-Store's own 768px wide-screen
   breakpoint (its side nav never appears); break out of it like the activity
   view so the embedded page gets the window's full content width. */
.substore-view.page-shell { height: 100%; max-width: none; padding-bottom: 30px; }
.substore-header { margin-bottom: 14px; flex-shrink: 0; }
.substore-header p { margin: 3px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.substore-actions { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); }
.quiet-button { float: none; width: auto; height: auto; min-height: 28px; margin: 0; padding: 0 10px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: transparent; color: var(--app-muted); font-size: var(--font-size-xs); white-space: nowrap; flex-shrink: 0; }
.quiet-button:disabled { opacity: .5; }
.substore-error { flex-shrink: 0; margin: 0 0 8px; color: var(--app-danger); font-size: var(--font-size-sm); }
.substore-frame-wrap { flex: 1; min-height: 320px; }
.substore-frame { display: block; width: 100%; height: 100%; border: 1px solid var(--app-surface-border, var(--app-divider)); border-radius: var(--radius-large); background: transparent; }
</style>
