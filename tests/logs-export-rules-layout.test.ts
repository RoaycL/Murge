import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('log / diagnostic export goes through the native save dialog', () => {
  it('never relies on <a download> blob links, which WebView2 ignores in the Tauri shell', () => {
    for (const path of ['src/renderer/src/views/LogsView.vue', 'src/renderer/src/lib/diagnostic-export.ts']) {
      const source = read(path)
      expect(source).not.toContain('createObjectURL')
      expect(source).not.toMatch(/\.download\s*=/)
    }
  })

  it('wires logs.saveText end to end and reports failures', () => {
    expect(read('src/shared/ipc.ts')).toContain("logsSaveText: 'logs:save-text'")
    expect(read('src/bridge/desktop-surface.ts')).toContain('saveText: (fileName, contents) => invoke(IPC.logsSaveText, fileName, contents)')
    expect(read('src/renderer/src/platform/generated/desktop-api.ts')).toContain('"logs:save-text"')
    expect(read('src-tauri/src/ipc.rs')).toContain('"logs:save-text" =>')
    const view = read('src/renderer/src/views/LogsView.vue')
    expect(view).toContain("toast.error('日志导出失败'")
    expect(view).toContain("toast.error('诊断报告导出失败'")
  })
})

describe('rules table layout', () => {
  it('uses a fixed layout so long payloads cannot push 使用计数 / 来源 out of the frame', () => {
    const css = read('src/renderer/src/styles/base.css')
    expect(css).toMatch(/\.rules-view table\s*\{[^}]*table-layout:\s*fixed/)
    expect(css).toMatch(/\.rules-view\.page-shell\s*\{\s*max-width:\s*none/)
    expect(css).not.toContain('width: 33.33%')
  })
})
