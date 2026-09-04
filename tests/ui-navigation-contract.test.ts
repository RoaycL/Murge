import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Surge-inspired UI navigation contract', () => {
  it('keeps feature areas separate and gives every sidebar destination a semantic icon', () => {
    const sidebar = read('src/renderer/src/components/AppSidebar.vue')
    for (const route of ['/activity', '/overview', '/connections', '/policies', '/rules', '/profiles', '/overrides', '/resources']) {
      expect(sidebar).toContain(`to: '${route}'`)
    }
    expect(sidebar).toContain('<AppIcon :name="item.icon"')
    expect(sidebar).not.toContain("label: '客户端'")
    expect(sidebar).not.toContain("to: '/processes'")
    expect(sidebar).toContain("to: '/devices'")
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

  it('uses the shared visual select and semantic icons instead of native controls', () => {
    const files = [
      'views/ConfigView.vue', 'views/ConnectionsView.vue', 'views/DeviceListView.vue',
      'views/DnsView.vue', 'views/GeneralView.vue', 'views/LogsView.vue',
      'views/ProcessListView.vue', 'components/CoreSettingsPanel.vue',
      'components/DnsSettingsPanel.vue', 'components/GeodataSettingsPanel.vue',
      'components/OverridesPanel.vue', 'components/TunConfigPanel.vue',
      'components/UsageHistoryPanel.vue'
    ]
    const source = files.map((file) => read(`src/renderer/src/${file}`)).join('\n')
    expect(source).not.toContain('<select')
    expect(source).not.toMatch(/window\.(?:alert|confirm|prompt)\(/)
    expect(source).not.toMatch(/>[✕✎↑↓]</)
    expect(source).toContain('<AppSelect')

    const visualSelect = read('src/renderer/src/components/AppSelect.vue')
    expect(visualSelect).toContain('role="listbox"')
    expect(visualSelect).toContain("event.key === 'Escape'")
    expect(visualSelect).toContain("event.key === 'ArrowDown'")
  })

  it('mounts one global feedback host and provides actionable empty states', () => {
    expect(read('src/renderer/src/App.vue')).toContain('<ToastHost />')
    const profiles = read('src/renderer/src/views/ConfigView.vue')
    expect(profiles).toContain('<EmptyState')
    expect(profiles).toContain('action-label="添加配置"')
    expect(profiles).toContain("toast.success('远程配置已添加'")
  })

  it('guards route changes when settings contain unsaved edits', () => {
    expect(read('src/renderer/src/router.ts')).toContain('hasUnsavedChanges.value')
    const app = read('src/renderer/src/App.vue')
    expect(app).toContain('放弃未保存的修改？')
    expect(app).toContain('discardAndNavigate')
    const dns = read('src/renderer/src/components/DnsSettingsPanel.vue')
    expect(dns).toContain("useUnsavedChanges('dns-enhancement'")
    expect(dns).toContain('store.busy || !dirty')
  })

  it('consolidates connection navigation and moves activity details to their data surfaces', () => {
    const connections = read('src/renderer/src/views/ConnectionsView.vue')
    expect(connections).toContain('活动中')
    expect(connections).toContain('已关闭')
    expect(connections).toContain('<ProcessIcon')
    expect(read('src/renderer/src/components/ProcessIcon.vue')).toContain('getProcessIcon')
    const activity = read('src/renderer/src/views/ActivityView.vue')
    expect(activity).not.toContain('DHCP 设备')
    expect(activity).not.toContain('activity-entry-grid')
    expect(activity).toContain('class="topology-inline"')
    expect(activity).toContain('class="total-bar total-history-link"')
  })

  it('keeps providers out of policy selection and shows groups before members', () => {
    const policy = read('src/renderer/src/views/PolicyView.vue')
    expect(policy).not.toContain('useProvidersStore')
    expect(policy).not.toContain('机场订阅')
    expect(policy).toContain('class="policy-group-grid"')
    expect(policy.indexOf('策略组')).toBeLessThan(policy.indexOf('class="node-grid"'))
  })

  it('prevents accidental page text selection while preserving editable fields', () => {
    const css = read('src/renderer/src/styles/base.css')
    expect(css).toContain('.app-window,.app-frame,.app-sidebar,.app-content{user-select:none')
    expect(css).toContain('input,textarea,[contenteditable="true"],code,pre{user-select:text')
  })
})
