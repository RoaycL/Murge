import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function view(name: string): Promise<string> {
  return readFile(path.join(root, 'src/renderer/src/views', name), 'utf8')
}

describe('frozen RC accessibility contracts', () => {
  it('does not use placeholders as the only accessible name for profile controls', async () => {
    const [config, provider] = await Promise.all([view('ConfigView.vue'), view('ProviderSettingsView.vue')])
    expect(config).toContain('aria-label="订阅地址"')
    expect(config).toContain('aria-label="mihomo 配置 YAML"')
    expect(config).toContain('role="alert"')
    expect(provider).toContain('aria-label="mixed-port"')
  })

  it('exposes search, selection and static segmented state to assistive technology', async () => {
    const [rules, processes, devices, activity] = await Promise.all([
      view('RulesView.vue'), view('ProcessListView.vue'), view('DeviceListView.vue'), view('ActivityView.vue')
    ])
    expect(rules).toContain('aria-label="搜索规则"')
    // The rules table no longer has a selection checkbox column (v0.5.7):
    // assert the per-row checkbox really is gone.
    expect(rules).not.toContain('选择规则')
    for (const source of [processes, devices]) {
      expect(source).toContain(':aria-pressed="selectedKey === group.key"')
      expect(source).toContain('aria-live="polite"')
    }
    expect(activity).toContain('aria-label="流量范围"')
    expect(activity).toContain('aria-label="流量排行维度"')
    expect(activity).toContain(':aria-pressed=')
  })
})
