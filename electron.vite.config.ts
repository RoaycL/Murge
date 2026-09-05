import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '../../../resources/mihomo-assets.json': resolve(existsSync('resources/mihomo-resolved.json') ? 'resources/mihomo-resolved.json' : 'resources/mihomo-assets.json'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // BrowserWindow uses Electron's sandboxed preload runtime. Keep that
    // security boundary and emit a single CommonJS-compatible .js preload;
    // sandboxed preloads do not execute the ESM .mjs artifact.
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.js'
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()]
  }
})
