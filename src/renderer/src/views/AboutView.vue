<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppInfo } from '@shared/app-info'
import type { BrandConfig } from '@shared/brand'
import { downloadDiagnosticReport } from '../lib/diagnostic-export'
import { useUpdatesStore } from '../stores/updates'
import { useAppSettingsStore } from '../stores/app-settings'
import BrandMark from '../components/BrandMark.vue'

const brand = ref<BrandConfig | null>(null)
const info = ref<AppInfo | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const updates = useUpdatesStore()
const appSettings = useAppSettingsStore()

async function toggleBeta(): Promise<void> {
  await appSettings.set({ updateIncludeBeta: !appSettings.settings.updateIncludeBeta })
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
    case 'idle': return t('about.notChecked')
    case 'checking': return t('about.checking')
    case 'available': return t('about.available', [updates.state.availableVersion ?? ''])
    case 'downloading': return t('about.downloading', [updates.state.availableVersion ? ` ${updates.state.availableVersion}` : ''])
    case 'downloaded': return t('about.ready', [updates.state.availableVersion ?? ''])
    case 'not-available': return t('about.upToDate')
    case 'error': return updates.state.error ?? t('about.checkFailed')
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

<template><div class="page-shell about-view"><h1>{{ t('about.title') }}</h1>
  <section class="surface-card about-product"><div class="about-product-title"><BrandMark :size="38" /><strong>{{ brand?.productName ?? '—' }}</strong></div><span>{{ t('about.versionLine', [info?.version ?? '—', info?.platform ?? '—', info?.arch ?? '—']) }}</span><p>{{ brand?.description }}</p></section>
  <section><h2>{{ t('about.update') }}</h2><div class="surface-card general-info">
    <div class="update-row"><span><strong>{{ t('about.checkInstall') }}</strong><small>{{ t('about.checkInstallHint') }}</small></span><button type="button" :disabled="busy || updates.state.phase === 'checking' || updates.state.phase === 'downloading'" @click="checkUpdates">{{ t('common.checkUpdate') }}</button></div>
    <div v-if="updates.state.channelsSupported" class="update-row"><span><strong>{{ t('about.includeBeta') }}</strong><small>{{ t('about.includeBetaHint') }}</small></span><button type="button" class="switch" :class="{ on: appSettings.settings.updateIncludeBeta }" role="switch" :aria-checked="appSettings.settings.updateIncludeBeta" :disabled="appSettings.busy" :aria-label="t('about.includeBeta')" @click="toggleBeta" /></div>
    <p v-if="appSettings.errorMessage" class="inline-error">{{ appSettings.errorMessage }}</p>
    <p v-if="statusText" class="update-status" :class="statusClass">{{ statusText }}</p>
    <div v-if="updates.state.canInstall" class="update-row"><span><strong>{{ t('about.readyLabel') }}</strong></span><button type="button" @click="updates.install">{{ t('common.restartInstall') }}</button></div>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div></section>
  <section><h2>{{ t('about.support') }}</h2><div class="surface-card preference-list">
    <a v-if="brand?.repositoryUrl" :href="brand.repositoryUrl" rel="noreferrer" @click.prevent="openLink(brand.repositoryUrl)"><span><strong>{{ t('about.repository') }}</strong><small>{{ brand.repositoryUrl }}</small></span><b>{{ t('common.open') }}</b></a>
    <a v-if="brand?.supportUrl" :href="brand.supportUrl" rel="noreferrer" @click.prevent="openLink(brand.supportUrl)"><span><strong>{{ t('about.issues') }}</strong><small>{{ brand.supportUrl }}</small></span><b>{{ t('common.open') }}</b></a>
  </div></section>
  <section><h2>{{ t('about.diagnostics') }}</h2><div class="surface-card general-info"><p>{{ t('about.diagnosticsHint') }}</p><button type="button" :disabled="busy" @click="exportDiagnostics">{{ t('about.exportDiagnostics') }}</button></div><p v-if="error" class="inline-error">{{ error }}</p></section>
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
