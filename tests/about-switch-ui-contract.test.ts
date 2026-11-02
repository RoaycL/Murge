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
