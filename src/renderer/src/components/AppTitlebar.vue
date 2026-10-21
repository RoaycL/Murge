<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { TAURI_WINDOW_IPC, type TauriWindowCloseResult } from '@shared/ipc'
import { detectShell } from '../platform/desktop-contract'

const isTauri = detectShell().kind === 'tauri'
const maximized = ref(false)
const error = ref('')
const disposers: UnlistenFn[] = []
let disposed = false

async function control(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  error.value = ''
  try {
    if (action === 'close') await invoke<TauriWindowCloseResult>('desktop_ipc', { channel: TAURI_WINDOW_IPC.close, payload: [] })
    else if (action === 'minimize') await getCurrentWindow().minimize()
    else await getCurrentWindow().toggleMaximize()
  } catch {
    error.value = '窗口操作失败，请重试'
  }
}

function retain(unlisten: UnlistenFn): void {
  if (disposed) unlisten()
  else disposers.push(unlisten)
}

onMounted(async () => {
  if (!isTauri) return
  const current = getCurrentWindow()
  try {
    // Listen before reading state so a maximize during setup is observed.
    retain(await current.onResized(async () => { maximized.value = await current.isMaximized() }))
    retain(await current.onCloseRequested((event) => {
      event.preventDefault()
      void control('close')
    }))
    maximized.value = await current.isMaximized()
  } catch {
    error.value = '窗口状态读取失败，请重试'
  }
})

onBeforeUnmount(() => {
  disposed = true
  for (const unlisten of disposers.splice(0)) unlisten()
})
</script>

<template>
  <Teleport v-if="isTauri" to="body">
    <div class="tauri-titlebar">
      <!-- Tauri handles dragging and double-click maximize on this region. -->
      <div class="tauri-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <div class="tauri-window-controls" aria-label="窗口控制">
        <button type="button" class="tauri-caption-button" aria-label="最小化" title="最小化" @click="control('minimize')">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
        </button>
        <button type="button" class="tauri-caption-button" :aria-label="maximized ? '还原' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="control('maximize')">
          <svg v-if="maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z" /></svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5h9v9h-9z" /></svg>
        </button>
        <button type="button" class="tauri-caption-button tauri-caption-close" aria-label="关闭" title="关闭" @click="control('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m.5.5 9 9m0-9-9 9" /></svg>
        </button>
      </div>
      <span v-if="error" class="tauri-titlebar-error" role="alert">{{ error }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
/* Match Electron titleBarOverlay.symbolColor in both themes and focus states. */
.tauri-titlebar { --caption-hover: rgba(0, 0, 0, 0.06); --caption-pressed: rgba(0, 0, 0, 0.04); position: fixed; z-index: 100; inset: 0 0 auto; height: 34px; display: flex; color: #858b95; user-select: none; }
:global(:root[data-theme="dark"]) .tauri-titlebar { --caption-hover: rgba(255, 255, 255, 0.06); --caption-pressed: rgba(255, 255, 255, 0.04); }
.tauri-titlebar-drag { flex: 1; min-width: 0; height: 100%; touch-action: none; }
.tauri-window-controls { display: flex; flex: 0 0 138px; height: 34px; }
.tauri-caption-button { display: grid; place-items: center; width: 46px; height: 34px; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; -webkit-app-region: no-drag; }
.tauri-caption-button svg { fill: none; stroke: currentColor; stroke-width: 1; pointer-events: none; }
.tauri-caption-button:hover { background: var(--caption-hover); }
.tauri-caption-button:active { background: var(--caption-pressed); }
.tauri-caption-button:focus-visible { outline-offset: -3px; }
.tauri-caption-close:hover { background: #c42b1c; color: #fff; }
.tauri-caption-close:active { background: #b02518; color: #fff; }
.tauri-titlebar-error { position: absolute; right: 8px; top: 38px; padding: 6px 10px; color: var(--app-danger); background: var(--app-surface-solid); border-radius: var(--radius-sm); font-size: var(--font-size-xs); }
</style>
