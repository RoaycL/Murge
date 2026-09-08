import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('kernel and refresh UI contract', () => {
  it('keeps the kernel app-owned and exposes stable, preview, Smart and specific choices', async () => {
    const [kernel, general] = await Promise.all([
      read('src/renderer/src/views/KernelSettingsView.vue'),
      read('src/renderer/src/views/GeneralView.vue')
    ])
    expect(kernel).toMatch(/启用 Smart 内核/)
    for (const channel of ['stable', 'preview', 'smart', 'specific']) {
      expect(kernel).toContain(`value: '${channel}'`)
    }
    expect(general).not.toMatch(/启动时自动启动内核/)
  })

  it('shows consistent pending and refresh feedback', async () => {
    const [base, config, resources] = await Promise.all([
      read('src/renderer/src/styles/base.css'),
      read('src/renderer/src/views/ConfigView.vue'),
      read('src/renderer/src/views/ResourcesView.vue')
    ])
    expect(base).toMatch(/\.unsaved-indicator\{[^}]*min-width:58px[^}]*min-height:32px/)
    expect(base).toMatch(/\.icon-button\.spinning > svg/)
    expect(config).toMatch(/spinning: updatingId === meta\.id/)
    expect(resources).toMatch(/\.quiet-button \{ width: 102px; min-height: 30px/)
  })
})
