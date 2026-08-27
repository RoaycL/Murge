import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron preload build path', () => {
  it('keeps BrowserWindow and the sandbox-compatible preload output aligned', async () => {
    const source = await readFile(resolve('src/main/index.ts'), 'utf8')
    const buildConfig = await readFile(resolve('electron.vite.config.ts'), 'utf8')
    expect(source).toContain("join(__dirname, '../preload/index.js')")
    expect(buildConfig).toContain("format: 'cjs'")
    expect(buildConfig).toContain("entryFileNames: 'index.js'")
  })
})
