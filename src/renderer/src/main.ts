/**
 * Shell bootstrap for the renderer (Phase 2).
 *
 * In the Tauri shell the `window.desktop` bridge must be installed BEFORE Vue
 * mounts (same guarantee the Electron preload gives). This module is the only
 * shell-aware entry: it detects the shell, installs the Tauri bridge when
 * running under Tauri, then mounts the app. Views/stores keep importing
 * `window.desktop` and stay shell-agnostic.
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { detectShell } from './platform/desktop-contract'
import { createDesktopApi } from './platform/generated/desktop-api'
import './styles/tokens.css'
import './styles/base.css'

const shell = detectShell()

if (shell.kind === 'tauri') {
  // Under Tauri the bridge is not preinstalled; install it before mount.
  if (!shell.hasDesktopBridge) {
    window.desktop = createDesktopApi()
  }
} else if (shell.kind === 'browser') {
  // Neither preload nor bridge: fail loudly instead of rendering a dead UI.
  console.error('[shell] no desktop bridge detected; rendering is not supported outside a desktop shell')
}

createApp(App).use(createPinia()).use(router).mount('#app')
