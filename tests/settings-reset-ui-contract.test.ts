import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (name: string): string => readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components', name),
  'utf8'
)

describe('settings reset UI contract', () => {
  it('persists defaults behind confirmation in every settings panel that exposes reset', () => {
    const panels = [
      'DnsSettingsPanel.vue',
      'SnifferSettingsPanel.vue',
      'GeodataSettingsPanel.vue',
      'TunConfigPanel.vue',
      'CoreSettingsPanel.vue',
      'ProxyBypassPanel.vue'
    ]

    for (const panel of panels) {
      const source = read(panel)
      expect(source).toContain('ConfirmModal')
      expect(source).toContain('requestReset')
      expect(source).toContain('confirmReset')
      expect(source).toContain('restoreSaved')
      expect(source).toContain('撤销更改')
      expect(source).toMatch(/v-if="dirty"[^>]*[\s\S]{0,260}撤销更改[\s\S]{0,260}恢复默认/)
      expect(source).toMatch(/confirmReset[\s\S]*store\.save\(/)
      expect(source).toContain('恢复默认')
      expect(source).not.toContain('resetFromStore')
    }
  })

  it('uses manual port entry and exposes the requested controller controls', () => {
    const source = read('CoreSettingsPanel.vue')
    expect(source).not.toMatch(/aria-label="(?:mixed|socks|http|controller)-port"[^>]*type="number"/)
    for (const field of ['controllerHost', 'controllerSecret', 'controllerPanel', 'allowLan']) {
      expect(source).toContain(`form.${field}`)
    }
    expect(source).toContain('AppIcon name="eye"')
  })
})
