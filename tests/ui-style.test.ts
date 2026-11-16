import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASE_FONT_SIZES,
  DEFAULT_UI_STYLE,
  MAX_CUSTOM_CSS_LENGTH,
  UI_STYLE_VARIABLES,
  isDefaultUiStyle,
  normalizeAccent,
  normalizeFontFamily,
  onAccentColor,
  parseUiStyle,
  uiStyleVariablesCss
} from '../src/shared/ui-style'
import { effectiveCustomCss, isSafeModeShortcut } from '../src/renderer/src/stores/ui-style'

const tokens = readFileSync(new URL('../src/renderer/src/styles/tokens.css', import.meta.url), 'utf8')

describe('ui style model', () => {
  it('falls back to defaults for missing or malformed documents', () => {
    expect(parseUiStyle(null)).toEqual(DEFAULT_UI_STYLE)
    expect(parseUiStyle('{bad')).toEqual(DEFAULT_UI_STYLE)
    expect(parseUiStyle([1])).toEqual(DEFAULT_UI_STYLE)
    expect(parseUiStyle({ accent: 'red', fontScale: 'huge', customCss: 3, customCssEnabled: 'yes' })).toEqual(DEFAULT_UI_STYLE)
    expect(isDefaultUiStyle(parseUiStyle(undefined))).toBe(true)
  })

  it('keeps valid values and normalizes them', () => {
    expect(parseUiStyle(JSON.stringify({ accent: '#E0443E', fontFamily: '  "MiSans",   sans-serif ', fontScale: 'large', customCss: 'a{}', customCssEnabled: true, extra: 1 }))).toEqual({
      accent: '#e0443e', fontFamily: '"MiSans", sans-serif', fontScale: 'large', customCss: 'a{}', customCssEnabled: true
    })
    expect(normalizeAccent('#abc')).toBe('#aabbcc')
    expect(normalizeAccent('#abcd')).toBe('')
  })

  it('never lets the font family escape its declaration', () => {
    for (const bad of ['a; } body { display: none', 'x{', 'url (http://x)', '"unclosed', 'a\\b', '</style>', 'a'.repeat(201)]) {
      expect(normalizeFontFamily(bad), bad).toBe('')
    }
  })

  it('caps custom CSS at the shared limit', () => {
    expect(parseUiStyle({ customCss: 'a'.repeat(MAX_CUSTOM_CSS_LENGTH + 5) }).customCss).toHaveLength(MAX_CUSTOM_CSS_LENGTH)
  })

  it('emits no overrides for the default style', () => {
    expect(uiStyleVariablesCss(DEFAULT_UI_STYLE)).toBe('')
  })

  it('maps accent, font and size onto the existing tokens', () => {
    const css = uiStyleVariablesCss({ ...DEFAULT_UI_STYLE, accent: '#e8b21c', fontFamily: 'Inter', fontScale: 'large' })
    expect(css).toContain('--app-font: Inter;')
    expect(css).toContain('--app-blue: #e8b21c;')
    expect(css).toContain('--app-accent: #e8b21c;')
    expect(css).toContain('--app-on-accent: #000000;')
    expect(css).toContain('--font-size-body: 15px;')
    expect(css.startsWith('html:root {')).toBe(true)
  })

  it('picks readable text on the accent', () => {
    expect(onAccentColor('#1587f8')).toBe('#ffffff')
    expect(onAccentColor('#e8b21c')).toBe('#000000')
    expect(onAccentColor('#8c8c91')).toBe('#ffffff')
    expect(onAccentColor('#d0d0d0')).toBe('#000000')
    expect(onAccentColor('#e0443e')).toBe('#ffffff')
  })

  it('documents only variables that tokens.css really defines', () => {
    for (const { name } of UI_STYLE_VARIABLES) expect(tokens, name).toContain(`${name}:`)
    for (const [name, size] of Object.entries(BASE_FONT_SIZES)) expect(tokens).toContain(`--font-size-${name}: ${size}px;`)
  })
})

describe('custom CSS safety', () => {
  const saved = { ...DEFAULT_UI_STYLE, customCss: 'saved{}', customCssEnabled: true }

  it('prefers the trial, then the saved CSS, and nothing in safe mode', () => {
    expect(effectiveCustomCss(saved, null, false)).toBe('saved{}')
    expect(effectiveCustomCss({ ...saved, customCssEnabled: false }, null, false)).toBe('')
    expect(effectiveCustomCss(saved, 'trial{}', false)).toBe('trial{}')
    expect(effectiveCustomCss(saved, 'trial{}', true)).toBe('')
    expect(effectiveCustomCss(saved, null, true)).toBe('')
  })

  it('recognizes only the exact safe-mode shortcut', () => {
    const base = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, code: 'KeyC' }
    expect(isSafeModeShortcut(base)).toBe(true)
    expect(isSafeModeShortcut({ ...base, altKey: false })).toBe(false)
    expect(isSafeModeShortcut({ ...base, code: 'KeyV' })).toBe(false)
  })

  it('is part of the configuration backup', () => {
    const archive = readFileSync(new URL('../src-tauri/src/backup/archive.rs', import.meta.url), 'utf8')
    expect(archive).toContain('"ui-style.json",')
  })
})
