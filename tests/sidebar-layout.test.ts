import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_GROUPS, defaultSidebarLayout, hiddenSidebarItems, isDefaultSidebarLayout, moveWithinGroup,
  normalizeSidebarLayout, parseSidebarLayout, setItemVisible, visibleSidebarGroups
} from '../src/renderer/src/lib/sidebar-layout'

const ids = (entries: Array<{ id: string }>): string[] => entries.map((entry) => entry.id)

describe('sidebar layout', () => {
  it('defaults to the shipped sidebar with 设备 and Sub-Store kept in 更多', () => {
    const groups = visibleSidebarGroups(defaultSidebarLayout())
    expect(groups.map((group) => ids(group.items))).toEqual([
      ['activity', 'overview', 'connections', 'processes'],
      ['policies', 'rules'],
      ['mitm', 'rewrite'],
      ['profiles', 'overrides', 'resources']
    ])
    expect(ids(hiddenSidebarItems(defaultSidebarLayout()))).toEqual(['devices', 'substore'])
    expect(isDefaultSidebarLayout(defaultSidebarLayout())).toBe(true)
  })

  it('fails closed to defaults for missing or malformed storage', () => {
    expect(parseSidebarLayout(null)).toEqual(defaultSidebarLayout())
    expect(parseSidebarLayout('{bad')).toEqual(defaultSidebarLayout())
    expect(parseSidebarLayout('[1,2]')).toEqual(defaultSidebarLayout())
  })

  it('never lets an item move into another group, even from edited storage', () => {
    const layout = normalizeSidebarLayout({
      proxy: [{ id: 'activity', visible: true }, { id: 'rules', visible: false }, { id: 'rules', visible: true }, { id: 'bogus' }],
      client: 'nope'
    })
    expect(ids(layout.proxy)).toEqual(['rules', 'policies'])
    expect(layout.proxy[0].visible).toBe(false)
    expect(ids(layout.client)).toEqual(['activity', 'overview', 'connections', 'processes', 'devices'])
    for (const group of SIDEBAR_GROUPS) {
      expect(new Set(ids(layout[group.id]))).toEqual(new Set(group.items.map((item) => item.id)))
    }
  })

  it('appends items added in a newer version with their default visibility', () => {
    const layout = parseSidebarLayout(JSON.stringify({ config: [{ id: 'resources', visible: true }, { id: 'profiles', visible: true }] }))
    expect(layout.config).toEqual([
      { id: 'resources', visible: true }, { id: 'profiles', visible: true },
      { id: 'overrides', visible: true }, { id: 'substore', visible: false }
    ])
  })

  it('reorders only inside a group and shows Sub-Store in the sidebar when enabled', () => {
    let layout = moveWithinGroup(defaultSidebarLayout(), 'client', 0, 2)
    expect(ids(layout.client).slice(0, 3)).toEqual(['overview', 'connections', 'activity'])
    expect(moveWithinGroup(layout, 'client', 0, 9)).toBe(layout)
    layout = setItemVisible(layout, 'substore', true)
    layout = setItemVisible(layout, 'mitm', false)
    layout = setItemVisible(layout, 'rewrite', false)
    const groups = visibleSidebarGroups(layout)
    expect(groups.map((group) => group.id)).toEqual(['client', 'proxy', 'config'])
    expect(ids(groups[2].items)).toEqual(['profiles', 'overrides', 'resources', 'substore'])
    expect(ids(hiddenSidebarItems(layout))).toEqual(['devices', 'mitm', 'rewrite'])
    expect(isDefaultSidebarLayout(layout)).toBe(false)
  })
})
