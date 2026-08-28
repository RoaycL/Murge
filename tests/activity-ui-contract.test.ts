import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Activity reference-size UI contract', () => {
  it('keeps the approved 934x672 content viewport and Surge-derived grid geometry', async () => {
    const [main, tokens, css] = await Promise.all([
      read('src/main/index.ts'),
      read('src/renderer/src/styles/tokens.css'),
      read('src/renderer/src/styles/base.css')
    ])

    expect(main).toMatch(/width:\s*934,\s*\n\s*height:\s*672,\s*\n\s*useContentSize:\s*true/)
    expect(main).toMatch(/titleBarStyle:\s*'hidden'/)
    expect(main).toMatch(/titleBarOverlay:\s*\{[^}]*height:\s*34/s)
    expect(tokens).toMatch(/--sidebar-width:\s*205px/)
    expect(css).toMatch(/\.app-window\s*\{[^}]*height:\s*100%;\s*overflow:\s*hidden;/)
    expect(css).not.toMatch(/\.app-window\s*\{[^}]*padding:/)
    expect(css).toMatch(/grid-template-columns:\s*347px 347px/)
    expect(css).toMatch(/grid-template-rows:\s*166px 165px 165px/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*width:\s*709px/)
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
