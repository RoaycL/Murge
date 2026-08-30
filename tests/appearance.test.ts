import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, parseAppearancePreference, resolvedTheme } from '../src/renderer/src/stores/appearance'

describe('appearance preference contract', () => {
  it('fails closed to defaults for missing, malformed or unknown values', () => {
    expect(parseAppearancePreference(null)).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearancePreference('{bad')).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearancePreference(JSON.stringify({ theme: 'neon', highContrast: 'yes', reduceMotion: 1 }))).toEqual(DEFAULT_APPEARANCE)
  })

  it('retains only supported theme and boolean preferences', () => {
    expect(parseAppearancePreference(JSON.stringify({ theme: 'dark', highContrast: true, reduceMotion: true, extra: 'ignored' }))).toEqual({ theme: 'dark', highContrast: true, reduceMotion: true })
  })

  it('resolves system mode without changing explicit selections', () => {
    expect(resolvedTheme('system', true)).toBe('dark')
    expect(resolvedTheme('system', false)).toBe('light')
    expect(resolvedTheme('light', true)).toBe('light')
    expect(resolvedTheme('dark', false)).toBe('dark')
  })
})
