import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, frostedWindow, nativeWindowTheme, parseAppearancePreference, resolvedTheme, windowBackdrop } from '../src/renderer/src/stores/appearance'

describe('appearance preference contract', () => {
  it('fails closed to defaults for missing, malformed or unknown values', () => {
    expect(parseAppearancePreference(null)).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearancePreference('{bad')).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearancePreference(JSON.stringify({ theme: 'neon', highContrast: 'yes', reduceMotion: 1 }))).toEqual(DEFAULT_APPEARANCE)
  })

  it('retains only supported theme and boolean preferences', () => {
    expect(parseAppearancePreference(JSON.stringify({ theme: 'dark', highContrast: true, reduceMotion: true, extra: 'ignored' }))).toEqual({ theme: 'dark', highContrast: true, reduceMotion: true, translucent: true })
    expect(parseAppearancePreference(JSON.stringify({ translucent: false })).translucent).toBe(false)
    expect(parseAppearancePreference(JSON.stringify({ translucent: 'no' })).translucent).toBe(true)
  })

  it('resolves system mode without changing explicit selections', () => {
    expect(resolvedTheme('system', true)).toBe('dark')
    expect(resolvedTheme('system', false)).toBe('light')
    expect(resolvedTheme('light', true)).toBe('light')
    expect(resolvedTheme('dark', false)).toBe('dark')
  })

  it('releases the native window theme in system mode so the OS theme is visible again', () => {
    expect(nativeWindowTheme('system', 'dark')).toBeNull()
    expect(nativeWindowTheme('system', 'light')).toBeNull()
    expect(nativeWindowTheme('dark', 'dark')).toBe('dark')
    expect(nativeWindowTheme('light', 'light')).toBe('light')
  })

  it('reads only the backdrops the shell can apply', () => {
    expect(windowBackdrop({ __MURGE_BACKDROP__: 'acrylic' })).toBe('acrylic')
    expect(windowBackdrop({ __MURGE_BACKDROP__: 'mica' })).toBe('mica')
    expect(windowBackdrop({ __MURGE_BACKDROP__: 'blur' })).toBe('none')
    expect(windowBackdrop({})).toBe('none')
  })

  it('stays opaque without a backdrop, when switched off, or in high contrast', () => {
    expect(frostedWindow('acrylic', { translucent: true, highContrast: false })).toBe(true)
    expect(frostedWindow('mica', { translucent: true, highContrast: false })).toBe(true)
    expect(frostedWindow('none', { translucent: true, highContrast: false })).toBe(false)
    expect(frostedWindow('acrylic', { translucent: false, highContrast: false })).toBe(false)
    expect(frostedWindow('acrylic', { translucent: true, highContrast: true })).toBe(false)
  })
})
