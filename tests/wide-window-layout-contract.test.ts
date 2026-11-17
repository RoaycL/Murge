import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(path, 'utf8')

describe('wide window layout', () => {
  it('lets card and list pages follow the window width', async () => {
    const tokens = await read('src/renderer/src/styles/tokens.css')
    expect(tokens).toMatch(/--content-max-width:\s*none/)
    expect(tokens).toMatch(/--content-readable-width:\s*880px/)
    const css = await read('src/renderer/src/styles/base.css')
    // Overview cards add columns instead of stretching two cards across the window.
    expect(css).toMatch(/\.overview-grid\s*\{[^}]*repeat\(auto-fill, minmax\(min\(var\(--card-min\), 100%\), 1fr\)\)/)
    expect(css).toMatch(/\.page-shell\.page-readable\s*\{\s*max-width:\s*var\(--content-readable-width\)/)
  })

  it('keeps settings forms at a readable width', async () => {
    for (const view of ['GeneralView', 'AppearanceView', 'AboutView', 'DnsView', 'DnsSnifferView', 'NetworkSettingsView', 'KernelSettingsView', 'ProviderSettingsView']) {
      expect(await read(`src/renderer/src/views/${view}.vue`), view).toMatch(/class="page-shell[^"]*page-readable/)
    }
    for (const view of ['PolicyView', 'OverviewView', 'ConfigView', 'ConnectionsView', 'ProcessListView', 'DeviceListView', 'ResourcesView', 'RulesView', 'MitmView', 'OverridesView', 'RewriteView']) {
      expect(await read(`src/renderer/src/views/${view}.vue`), view).not.toMatch(/page-readable/)
    }
  })

  it('splits the rewrite page into rules and modules columns on wide windows', async () => {
    const view = await read('src/renderer/src/views/RewriteView.vue')
    expect(view).toMatch(/<div class="rewrite-layout">\s*<div class="rewrite-rules-column">/)
    expect(view).toMatch(/\.rewrite-view \{ container: rewrite-page \/ inline-size; \}/)
    expect(view).toMatch(/@container rewrite-page \(min-width: 1180px\)/)
  })
})
