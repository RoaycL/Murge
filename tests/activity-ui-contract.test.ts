import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Activity fluid-layout UI contract', () => {
  it('opens on the 934x672 reference viewport while allowing a smaller fluid minimum', async () => {
    const [main, tokens, css] = await Promise.all([
      read('src/main/index.ts'),
      read('src/renderer/src/styles/tokens.css'),
      read('src/renderer/src/styles/base.css')
    ])

    expect(main).toMatch(/width:\s*934,\s*\n\s*height:\s*672,\s*\n\s*useContentSize:\s*true/)
    expect(main).toMatch(/minWidth:\s*760,\s*\n\s*minHeight:\s*560,/)
    expect(main).toMatch(/titleBarStyle:\s*'hidden'/)
    expect(main).toMatch(/titleBarOverlay:\s*\{[^}]*height:\s*34/s)
    expect(tokens).toMatch(/--sidebar-width:\s*205px/)
    expect(css).toMatch(/\.app-window\s*\{[^}]*height:\s*100%;\s*overflow:\s*hidden;/)
    expect(css).not.toMatch(/\.app-window\s*\{[^}]*padding:/)
    // 完全流式仪表盘：弹性列 + 规范行高 + 居中内容壳，禁止回到写死列宽。
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-rows:\s*166px 165px 165px/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*width:\s*100%/)
    expect(css).toMatch(/\.page-shell\s*\{[^}]*max-width:\s*var\(--content-max-width\)/)
    expect(css).toMatch(/\.page-shell\s*\{[^}]*margin:\s*0 auto/)
    // 所有者要求：任何宽度下都保持规范的双列仪表盘，不做单列降级。
    expect(css).not.toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('renders both speed metrics through the same card surface as the other Activity cards', async () => {
    const [component, css, tokens] = await Promise.all([
      read('src/renderer/src/components/SpeedSparkline.vue'),
      read('src/renderer/src/styles/base.css'),
      read('src/renderer/src/styles/tokens.css')
    ])

    expect(component).toContain("import SurfaceCard from './SurfaceCard.vue'")
    expect(component).toContain('<SurfaceCard class="speed-card">')
    expect(css).toMatch(/\.surface-card\s*\{[^}]*border:\s*1px solid var\(--app-surface-border\)/)
    expect(tokens).toContain('--app-surface-border: rgba(255, 255, 255, 0.05);')
  })
})
