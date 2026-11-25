import { describe, expect, it } from 'vitest'
import {
  activityPlacement, cardPosition, defaultActivityLayout, hideActivityCard, isDefaultActivityLayout, moveActivityCard,
  normalizeActivityLayout, parseActivityLayout, showActivityCard, type ActivityLayout
} from '../src/renderer/src/lib/activity-layout'

/** The six cards from before the Surge widgets, for the older migration/move cases. */
const CLASSIC = ['latency', 'upload', 'download', 'connections', 'traffic', 'total']
const classic = (layout: ActivityLayout): { left: string[]; right: string[] } => ({
  left: layout.left.filter((id) => CLASSIC.includes(id)),
  right: layout.right.filter((id) => CLASSIC.includes(id))
})
const base = (): ActivityLayout => ({ left: ['latency', 'connections', 'total'], right: ['upload', 'download', 'traffic'], hidden: [] })

describe('activity card layout', () => {
  it('defaults to the Surge arrangement: horizontal cards left, half cards paired and square cards right', () => {
    const layout = defaultActivityLayout()
    expect(layout).toEqual({
      left: ['latency', 'connections', 'total', 'network', 'externalIp', 'usage', 'policyLatency'],
      right: ['upload', 'download', 'traffic', 'dns', 'bandwidth', 'activity', 'ranking', 'events'],
      hidden: []
    })
    expect(activityPlacement(layout)).toEqual({
      latency: { gridColumn: '1 / span 2', gridRow: '1 / span 1' },
      connections: { gridColumn: '1 / span 2', gridRow: '2 / span 1' },
      total: { gridColumn: '1 / span 2', gridRow: '3 / span 1' },
      network: { gridColumn: '1 / span 2', gridRow: '4 / span 1' },
      externalIp: { gridColumn: '1 / span 2', gridRow: '5 / span 1' },
      usage: { gridColumn: '1 / span 2', gridRow: '6 / span 2' },
      policyLatency: { gridColumn: '1 / span 2', gridRow: '8 / span 2' },
      upload: { gridColumn: '3', gridRow: '1 / span 1' },
      download: { gridColumn: '4', gridRow: '1 / span 1' },
      traffic: { gridColumn: '3 / span 2', gridRow: '2 / span 2' },
      dns: { gridColumn: '3', gridRow: '4 / span 1' },
      bandwidth: { gridColumn: '4', gridRow: '4 / span 1' },
      activity: { gridColumn: '3 / span 2', gridRow: '5 / span 2' },
      ranking: { gridColumn: '3 / span 2', gridRow: '7 / span 2' },
      events: { gridColumn: '3 / span 2', gridRow: '9 / span 1' }
    })
    expect(isDefaultActivityLayout(layout)).toBe(true)
  })

  it('adds the Surge widgets to a layout saved before they existed, pairing DNS with Bandwidth', () => {
    const layout = parseActivityLayout(JSON.stringify({ left: ['latency', 'connections', 'total'], right: ['upload', 'download', 'traffic'] }))
    expect(layout).toEqual({
      left: ['latency', 'connections', 'total', 'activity', 'externalIp', 'ranking', 'events'],
      right: ['upload', 'download', 'traffic', 'network', 'dns', 'bandwidth', 'usage', 'policyLatency'],
      hidden: []
    })
    const placement = activityPlacement(layout)
    expect(placement.dns).toEqual({ gridColumn: '3', gridRow: '5 / span 1' })
    expect(placement.bandwidth).toEqual({ gridColumn: '4', gridRow: '5 / span 1' })
  })

  it('hides cards and adds them back, keeping hidden ones out of the page and out of migration', () => {
    let layout = hideActivityCard(defaultActivityLayout(), 'events')
    layout = hideActivityCard(layout, 'dns')
    expect(layout.hidden).toEqual(['events', 'dns'])
    expect(layout.right).not.toContain('events')
    expect(activityPlacement(layout).events).toBeUndefined()
    // bandwidth now sits alone on the left half of its row.
    expect(activityPlacement(layout).bandwidth).toEqual({ gridColumn: '3', gridRow: '4 / span 1' })
    // Hidden cards survive a reload and are not re-added as "new".
    expect(parseActivityLayout(JSON.stringify(layout))).toEqual(layout)
    expect(isDefaultActivityLayout(layout)).toBe(false)
    // Adding back: a half card fills an open half if there is one, else the shorter column.
    const shown = showActivityCard(layout, 'dns')
    expect(shown.hidden).toEqual(['events'])
    expect(shown.right.includes('dns') || shown.left.includes('dns')).toBe(true)
    const open = showActivityCard(hideActivityCard(hideActivityCard(defaultActivityLayout(), 'bandwidth'), 'dns'), 'dns')
    expect(open.right).toContain('dns')
    // Moving a hidden card (drag) also brings it back.
    expect(moveActivityCard(layout, 'events', 'left', 0).left[0]).toBe('events')
  })

  it('fails closed to defaults for missing or malformed storage', () => {
    expect(parseActivityLayout(null)).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('{bad')).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('[1]')).toEqual(defaultActivityLayout())
  })

  it('splits the old combined speed card into upload and download where it was', () => {
    expect(classic(parseActivityLayout(JSON.stringify({ left: ['speed', 'latency', 'connections', 'total'], right: ['traffic'] }))))
      .toEqual({ left: ['upload', 'download', 'latency', 'connections', 'total'], right: ['traffic'] })
    expect(classic(parseActivityLayout(JSON.stringify({ left: ['latency', 'connections', 'total'], right: ['speed', 'traffic'] }))))
      .toEqual({ left: base().left, right: base().right })
  })

  it('drops unknown and duplicate cards and puts missing ones in the shorter column', () => {
    const layout = normalizeActivityLayout({ left: ['traffic', 'bogus', 'traffic', 'latency'], right: ['total'] })
    expect(layout.left.slice(0, 2)).toEqual(['traffic', 'latency'])
    // right (1 row) is shorter than left (3 rows): upload goes right, download shares its row,
    // then connections (right 2 < left 3).
    expect(layout.right.slice(0, 4)).toEqual(['total', 'upload', 'download', 'connections'])
    expect(new Set([...layout.left, ...layout.right]).size).toBe(15)
  })

  it('moves a card within a column and across columns', () => {
    let layout = moveActivityCard(base(), 'total', 'left', 0)
    expect(layout.left).toEqual(['total', 'latency', 'connections'])
    layout = moveActivityCard(layout, 'traffic', 'left', 1)
    expect(layout).toEqual({ left: ['total', 'traffic', 'latency', 'connections'], right: ['upload', 'download'], hidden: [] })
    expect(cardPosition(layout, 'traffic')).toEqual({ column: 'left', index: 1 })
    expect(activityPlacement(layout).latency).toEqual({ gridColumn: '1 / span 2', gridRow: '4 / span 1' })
    expect(isDefaultActivityLayout(layout)).toBe(false)
  })

  it('moves upload and download separately; a lone half card takes the left half of its own row', () => {
    const layout = moveActivityCard(base(), 'download', 'left', 1)
    expect(layout).toEqual({ left: ['latency', 'download', 'connections', 'total'], right: ['upload', 'traffic'], hidden: [] })
    const placement = activityPlacement(layout)
    expect(placement.download).toEqual({ gridColumn: '1', gridRow: '2 / span 1' })
    expect(placement.connections).toEqual({ gridColumn: '1 / span 2', gridRow: '3 / span 1' })
    expect(placement.upload).toEqual({ gridColumn: '3', gridRow: '1 / span 1' })
    expect(placement.traffic).toEqual({ gridColumn: '3 / span 2', gridRow: '2 / span 2' })
    // Swapping their order swaps their halves.
    const swapped = moveActivityCard(base(), 'download', 'right', 0)
    expect(activityPlacement(swapped).download).toEqual({ gridColumn: '3', gridRow: '1 / span 1' })
    expect(activityPlacement(swapped).upload).toEqual({ gridColumn: '4', gridRow: '1 / span 1' })
  })
})
