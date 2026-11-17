import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(path, 'utf8')

describe('wide window layout', () => {
  it('lets card and list pages follow the window width', async () => {
    const tokens = await read('src/renderer/src/styles/tokens.css')
    expect(tokens).toMatch(/--content-max-width:\s*none/)
    const css = await read('src/renderer/src/styles/base.css')
    // Overview cards add columns instead of stretching two cards across the window.
    expect(css).toMatch(/\.overview-grid\s*\{[^}]*repeat\(auto-fill, minmax\(min\(var\(--card-min\), 100%\), 1fr\)\)/)
  })

  it('keeps theme preview cards from stretching', async () => {
    const css = await read('src/renderer/src/styles/base.css')
    expect(css).toMatch(/\.theme-options\s*\{[^}]*max-width:\s*calc\(3 \* 260px/)
  })

  it('lets settings pages follow the window width too', async () => {
    for (const view of ['GeneralView', 'AppearanceView', 'AboutView', 'DnsView', 'DnsSnifferView', 'NetworkSettingsView', 'KernelSettingsView', 'ProviderSettingsView', 'PolicyView', 'OverviewView', 'ConfigView', 'ConnectionsView', 'ResourcesView', 'MitmView', 'OverridesView', 'RewriteView']) {
      const source = await read(`src/renderer/src/views/${view}.vue`)
      expect(source, view).not.toMatch(/page-shell[^{]*\{[^}]*max-width:\s*\d/)
    }
  })

  it('splits the rewrite page into rules and modules columns on wide windows', async () => {
    const view = await read('src/renderer/src/views/RewriteView.vue')
    expect(view).toMatch(/<div class="rewrite-layout">\s*<div class="rewrite-rules-column">/)
    expect(view).toMatch(/\.rewrite-view \{ container: rewrite-page \/ inline-size; \}/)
    expect(view).toMatch(/@container rewrite-page \(min-width: 1180px\)/)
  })
})
