import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

// Longer translations (English) must widen or ellipsize a segment, never wrap it.
describe('segmented controls fit longer labels', () => {
  const base = read('src/renderer/src/styles/base.css')

  it('sizes .segmented segments to the longest label instead of a fixed width', () => {
    expect(rule(base, '.segmented')).toMatch(/grid-auto-columns:\s*1fr/)
    const button = rule(base, '.segmented button')
    expect(button).toMatch(/white-space:\s*nowrap/)
    expect(button).not.toMatch(/(?:^|[\s;])width:/)
  })

  it('keeps the ranking tabs on one line', () => {
    const button = rule(base, '.rank-tabs button')
    expect(button).toMatch(/white-space:\s*nowrap/)
    expect(button).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('does not pin fixed widths on page-level segmented buttons', () => {
    expect(read('src/renderer/src/components/UiStyleSection.vue')).not.toMatch(/\.font-scale button \{[^}]*(?:^|[\s;{])width:/)
    expect(read('src/renderer/src/views/AboutView.vue')).not.toMatch(/\.update-row \.segmented button \{[^}]*(?:^|[\s;{])width:/)
  })
})
