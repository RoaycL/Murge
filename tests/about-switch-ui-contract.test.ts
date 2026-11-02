import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('About page switch UI contract', () => {
  it('keeps the 包括 Beta 版本 switch out of the blue action-button style', async () => {
    const css = await readFile(new URL('../src/renderer/src/styles/base.css', import.meta.url), 'utf8')
    // 关于页的操作按钮样式（蓝底、30px 高、内边距）曾经盖住 .switch，导致开关尺寸变形、开关状态不变色。
    expect(css).toContain('.about-view .general-info button:not(.switch) {')
    expect(css).not.toMatch(/\.about-view \.general-info button \{/)
  })
})

describe('Layered content panel and switch color', () => {
  it('floats the content area as a rounded panel and turns switches blue when on', async () => {
    const css = await readFile(new URL('../src/renderer/src/styles/base.css', import.meta.url), 'utf8')
    const tokens = await readFile(new URL('../src/renderer/src/styles/tokens.css', import.meta.url), 'utf8')
    // 所有者要求（2026-11-02）：参考 Surge 的叠加层增加层次感；开关打开统一为蓝色。
    expect(css).toMatch(/\.app-content\s*\{[^}]*border-radius:\s*var\(--content-panel-radius\)[^}]*background:\s*var\(--content-panel\)/)
    expect(tokens).toMatch(/--content-panel-inset:\s*8px/)
    expect(css).toMatch(/\.switch\.on\s*\{\s*background:\s*var\(--app-blue\)/)
  })
})

describe('Flat surface on the card home pages', () => {
  it('drops the layered panel on 活动 / 概览 / 配置 so the window is one continuous background', async () => {
    const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
    const css = await readFile(new URL('../src/renderer/src/styles/base.css', import.meta.url), 'utf8')
    // 所有者要求（2026-11-02）：这三页与 Surge 一致，除卡片外背景是一整块；其他页面用叠加层。
    expect(app).toContain("const FLAT_SURFACE_ROUTES = ['/activity', '/overview', '/profiles']")
    expect(app).toContain(':data-surface="contentSurface"')
    expect(css).toMatch(/\.app-frame\[data-surface="flat"\] \.app-content[^{]*\{[^}]*background:\s*transparent/)
  })
})
