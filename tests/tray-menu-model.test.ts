import { describe, expect, it } from 'vitest'
import {
  focusable, iconFor, isSegmented, isSwitch, normalizeModel, pageHeight, resolvePage, splitLabel,
  HEADER_HEIGHT, PANEL_PADDING, ROW_HEIGHT, SEPARATOR_HEIGHT, type TrayItem
} from '../src/renderer/src/tray-menu/model'

const row = (id: string, extra: Partial<TrayItem> = {}): TrayItem => ({
  id, label: id, enabled: true, checked: false, kind: 'normal', children: [], ...extra
})

describe('tray popup model', () => {
  it('splits a label into text and trailing detail', () => {
    expect(splitLabel('出站模式 · 规则')).toEqual({ text: '出站模式', detail: '规则' })
    expect(splitLabel('Proxy · 香港 · 01')).toEqual({ text: 'Proxy', detail: '香港 · 01' })
    expect(splitLabel('显示主窗口')).toEqual({ text: '显示主窗口', detail: '' })
  })

  it('matches the Rust row metrics for the root height', () => {
    const items = [row('show'), row('', { kind: 'separator' }), row('tun', { kind: 'checkbox' })]
    expect(pageHeight(items)).toBe(HEADER_HEIGHT + PANEL_PADDING * 2 + ROW_HEIGHT * 2 + SEPARATOR_HEIGHT)
  })

  it('draws toggles as switches, the mode as a segmented control, quit with an icon', () => {
    expect(isSwitch(row('system-proxy', { kind: 'checkbox' }))).toBe(true)
    expect(isSwitch(row('profile:a', { kind: 'radio' }))).toBe(false)
    expect(isSegmented(row('outbound-mode', { kind: 'submenu' }))).toBe(true)
    expect(iconFor(row('quit'))).toBe('quit')
    expect(iconFor(row('force-quit'))).toBe('quit')
    expect(iconFor(row('group:Proxy'))).toBe('group')
  })

  it('keyboard focus skips separators, disabled rows and the segmented mode', () => {
    const items = [
      row('outbound-mode', { kind: 'submenu' }), row('', { kind: 'separator' }),
      row('network-quality', { enabled: false }), row('quit')
    ]
    expect(focusable(items).map((item) => item.id)).toEqual(['quit'])
  })

  it('falls back to the deepest valid page when a submenu disappears', () => {
    const tree = [row('configuration', { kind: 'submenu', children: [row('reload-config')] })]
    expect(resolvePage(tree, ['configuration']).items.map((item) => item.id)).toEqual(['reload-config'])
    expect(resolvePage(tree, ['group:Gone']).items).toBe(tree)
  })

  it('normalizes a malformed snapshot to an empty light menu', () => {
    expect(normalizeModel(null).items).toEqual([])
    expect(normalizeModel({ theme: 'dark', items: 'x' })).toMatchObject({ theme: 'dark', items: [] })
  })
})
