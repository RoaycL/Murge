import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
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
