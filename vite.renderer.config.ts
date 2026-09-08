import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Standalone renderer build for the Tauri shell (Phase 2).
 *
 * The Electron flow keeps using `electron.vite.config.ts` (which bundles
 * main + preload + renderer). The Tauri flow needs ONLY the renderer: the
 * same root, aliases and plugins, served on a fixed port for `tauri dev` and
 * emitted into the shared `out/renderer` directory that
 * `src-tauri/tauri.conf.json` points at. Shell-specific behavior lives in the
 * renderer's platform seam (`src/renderer/src/platform/`), not here.
 */
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true
  }
})
