import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('caption buttons after hiding the window', () => {
  it('drops the leftover hover look until the pointer moves again', async () => {
    const source = await readFile('src/renderer/src/components/AppTitlebar.vue', 'utf8')
    expect(source).toMatch(/if \(action !== 'maximize'\) staleHover\.value = true/)
    expect(source).toMatch(/document\.visibilityState === 'hidden'\) staleHover\.value = true/)
    expect(source).toMatch(/addEventListener\('pointermove', clearStaleHover/)
    expect(source).toMatch(/\.tauri-window-controls\.stale-hover \.tauri-caption-button:hover \{ background: transparent; color: inherit; \}/)
  })
})
