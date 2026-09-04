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
    // 最小窗口锁在 280px 列宽；Surge 横卡比例修正后 640px 高即可完整展示。
    expect(main).toMatch(/minWidth:\s*848,\s*\n\s*minHeight:\s*640,/)
    expect(main).toMatch(/titleBarStyle:\s*'hidden'/)
    expect(main).toMatch(/titleBarOverlay:\s*\{[^}]*height:\s*34/s)
    expect(tokens).toMatch(/--sidebar-width:\s*205px/)
    expect(css).toMatch(/\.app-window\s*\{[^}]*height:\s*100%;\s*overflow:\s*hidden;/)
    expect(css).not.toMatch(/\.app-window\s*\{[^}]*padding:/)
    // 完全流式仪表盘：弹性列 + 居中内容壳，禁止回到写死列宽。
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*width:\s*100%/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*margin:\s*6px auto 0/)
    // Surge 实图：左列横卡约 2.1:1；上传/下载和跨两行流量卡约 1:1。
    expect(css).toMatch(/\.latency-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.connections-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.total-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.speed-card\s*\{[^}]*aspect-ratio:\s*1 \/ 1/)
    expect(css).toMatch(/\.traffic-card\s*\{[^}]*aspect-ratio:\s*1 \/ 1/)
    // 卡片到达最小尺寸后网格不再压缩（与 848px 最小窗口互为兜底）。
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*min-width:\s*calc\(2 \* var\(--card-min\) \+ 15px\)/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*min-width:\s*calc\(2 \* var\(--card-min\) \+ 15px\)/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*max-width:\s*none/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*padding-left:\s*5px/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*padding-right:\s*35px/)
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
