<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useDialogFocus } from '../composables/use-dialog-focus'
import { useUpdatesStore } from '../stores/updates'
import type { UpdateProduct } from '@shared/updates'

/**
 * Pops up once per offered update with its release notes, then follows the
 * download through to "重启并安装". "稍后" hides it for that version only; the
 * update still installs on quit and stays visible in 关于.
 */
const updates = useUpdatesStore()
const dialog = ref<HTMLElement | null>(null)
const DISMISSED_KEY = 'update-dialog-dismissed'
const PRODUCT_LABELS: Record<UpdateProduct, string> = { electron: '稳定版', tauri: '实验版' }

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISSED_KEY) } catch { return null }
}
const dismissed = ref<string | null>(readDismissed())

const offerKey = computed<string | null>(() => {
  const { availableVersion, availableProduct } = updates.state
  return availableVersion ? `${availableProduct ?? ''}@${availableVersion}` : null
})

const open = computed<boolean>(() => {
  const phase = updates.state.phase
  return (phase === 'available' || phase === 'downloading' || phase === 'downloaded') &&
    offerKey.value !== null && offerKey.value !== dismissed.value
})

const switching = computed<boolean>(() =>
  updates.state.availableProduct !== null && updates.state.availableProduct !== updates.state.currentProduct)

const title = computed<string>(() => {
  const version = updates.state.availableVersion ?? ''
  const product = updates.state.availableProduct
  if (switching.value && product) return `切换到${PRODUCT_LABELS[product]} v${version}`
  return `发现新版本 v${version}`
})

/** Published notes are Markdown, or HTML from older feeds; shown as plain text. */
const notes = computed<string>(() => {
  const raw = updates.state.releaseNotes ?? ''
  return raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').trim()
})

const percent = computed<number>(() => updates.state.progress?.percent ?? 0)

const statusLine = computed<string>(() => {
  switch (updates.state.phase) {
    case 'available': return '正在准备下载…'
    case 'downloading': return `正在下载 ${percent.value.toFixed(0)}%`
    case 'downloaded': return switching.value ? '已下载并校验。安装会替换当前版本，配置和数据保留。' : '已下载并校验，退出应用时也会自动安装。'
    default: return ''
  }
})

function later(): void {
  dismissed.value = offerKey.value
  try { if (offerKey.value) window.localStorage.setItem(DISMISSED_KEY, offerKey.value) } catch { /* per-viewer convenience only */ }
}

useDialogFocus(open, dialog, later)

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = updates.subscribe()
  void updates.refresh()
})
onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-shade update-dialog-shade" role="presentation" @click.self="later">
      <section ref="dialog" class="confirm-modal update-dialog" role="dialog" aria-modal="true" :aria-label="title">
        <header>
          <h2>{{ title }}</h2>
          <button type="button" class="icon-control" aria-label="关闭" @click="later"><AppIcon name="close" /></button>
        </header>
        <small class="update-dialog-version">当前版本 v{{ updates.state.currentVersion ?? '—' }}</small>
        <div class="update-dialog-notes" tabindex="0" aria-label="更新内容">{{ notes || '本次发布未附更新说明。' }}</div>
        <div v-if="updates.state.phase === 'downloading'" class="update-dialog-bar"><div :style="{ width: `${percent}%` }"></div></div>
        <p class="update-dialog-status">{{ statusLine }}</p>
        <footer>
          <button type="button" class="secondary-button" @click="later">稍后</button>
          <button type="button" class="primary-button" :disabled="!updates.state.canInstall" @click="updates.install()">
            {{ updates.state.canInstall ? '重启并安装' : '下载中…' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* It takes focus when it opens, so it must also be the visible top modal. */
.update-dialog-shade { z-index: 71; }
.update-dialog { width: min(520px, calc(100vw - 48px)); }
.update-dialog-version { display: block; margin-top: var(--space-2); color: var(--app-muted); }
.update-dialog-notes {
  max-height: 280px;
  margin: 14px 0 12px;
  padding: 12px;
  overflow: auto;
  border-radius: var(--radius-control);
  background: var(--app-fill);
  color: var(--app-text);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.update-dialog-bar { height: 6px; border-radius: var(--radius-xs); background: var(--app-divider); overflow: hidden; }
.update-dialog-bar > div { height: 100%; background: var(--app-blue); transition: width 0.2s ease; }
.confirm-modal p.update-dialog-status { margin: 10px 0 16px; }
</style>
