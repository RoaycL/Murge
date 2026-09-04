import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Surge-inspired UI navigation contract', () => {
  it('keeps feature areas separate and gives every sidebar destination a semantic icon', () => {
    const sidebar = read('src/renderer/src/components/AppSidebar.vue')
    for (const route of ['/activity', '/overview', '/connections', '/processes', '/devices', '/policies', '/rules', '/profiles', '/overrides', '/resources']) {
      expect(sidebar).toContain(`to: '${route}'`)
    }
    expect(sidebar).toContain('<AppIcon :name="item.icon"')
    expect(sidebar).not.toMatch(/icon:\s*'[⌁⌘▣▤⑂☷]'/)
  })

  it('uses overlay drawers instead of permanent master-detail columns', () => {
    for (const view of ['ConnectionsView.vue', 'ProcessListView.vue', 'DeviceListView.vue']) {
      const source = read(`src/renderer/src/views/${view}`)
      expect(source).toContain('<DetailDrawer')
      expect(source).not.toContain('list-detail-grid')
    }
    const css = read('src/renderer/src/styles/base.css')
    expect(css).toMatch(/\.detail-drawer\{[^}]*width:360px/)
  })

  it('keeps runtime settings out of the profile page surface', () => {
    const profiles = read('src/renderer/src/views/ConfigView.vue')
    expect(profiles).not.toContain('<tun-config-panel')
    expect(profiles).not.toContain('<dns-settings-panel')
    expect(profiles).not.toContain('<core-settings-panel')
    expect(profiles).toContain("importSource === 'url'")
    expect(profiles).toContain("importSource === 'file'")
    expect(profiles).toContain("importSource === 'manual'")
    expect(profiles).toContain('activate: false')
    expect(profiles).not.toContain('prompt(')
  })
})
