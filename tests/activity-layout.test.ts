import { describe, expect, it } from 'vitest'
import {
  activityPlacement, cardPosition, defaultActivityLayout, isDefaultActivityLayout, moveActivityCard,
  normalizeActivityLayout, parseActivityLayout
} from '../src/renderer/src/lib/activity-layout'

describe('activity card layout', () => {
  it('defaults to the Surge arrangement: horizontal cards left, upload/download side by side and the square traffic card right', () => {
    const layout = defaultActivityLayout()
    expect(layout).toEqual({ left: ['latency', 'connections', 'total'], right: ['upload', 'download', 'traffic'] })
    expect(activityPlacement(layout)).toEqual({
      latency: { gridColumn: '1 / span 2', gridRow: '1 / span 1' },
      connections: { gridColumn: '1 / span 2', gridRow: '2 / span 1' },
      total: { gridColumn: '1 / span 2', gridRow: '3 / span 1' },
      upload: { gridColumn: '3', gridRow: '1 / span 1' },
      download: { gridColumn: '4', gridRow: '1 / span 1' },
      traffic: { gridColumn: '3 / span 2', gridRow: '2 / span 2' }
    })
    expect(isDefaultActivityLayout(layout)).toBe(true)
  })

  it('fails closed to defaults for missing or malformed storage', () => {
    expect(parseActivityLayout(null)).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('{bad')).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('[1]')).toEqual(defaultActivityLayout())
  })

  it('splits the old combined speed card into upload and download where it was', () => {
    expect(parseActivityLayout(JSON.stringify({ left: ['speed', 'latency', 'connections', 'total'], right: ['traffic'] })))
      .toEqual({ left: ['upload', 'download', 'latency', 'connections', 'total'], right: ['traffic'] })
    expect(parseActivityLayout(JSON.stringify({ left: ['latency', 'connections', 'total'], right: ['speed', 'traffic'] })))
      .toEqual(defaultActivityLayout())
  })

  it('drops unknown and duplicate cards and puts missing ones in the shorter column', () => {
    const layout = normalizeActivityLayout({ left: ['traffic', 'bogus', 'traffic', 'latency'], right: ['total'] })
    expect(layout.left).toEqual(['traffic', 'latency'])
    // right (1 row) is shorter than left (3 rows): upload goes right, download shares its row,
    // then connections (right 2 < left 3).
    expect(layout.right).toEqual(['total', 'upload', 'download', 'connections'])
  })

  it('moves a card within a column and across columns', () => {
    let layout = moveActivityCard(defaultActivityLayout(), 'total', 'left', 0)
    expect(layout.left).toEqual(['total', 'latency', 'connections'])
    layout = moveActivityCard(layout, 'traffic', 'left', 1)
    expect(layout).toEqual({ left: ['total', 'traffic', 'latency', 'connections'], right: ['upload', 'download'] })
    expect(cardPosition(layout, 'traffic')).toEqual({ column: 'left', index: 1 })
    expect(activityPlacement(layout).latency).toEqual({ gridColumn: '1 / span 2', gridRow: '4 / span 1' })
    expect(isDefaultActivityLayout(layout)).toBe(false)
  })

  it('moves upload and download separately; a lone half card takes the left half of its own row', () => {
    const layout = moveActivityCard(defaultActivityLayout(), 'download', 'left', 1)
    expect(layout).toEqual({ left: ['latency', 'download', 'connections', 'total'], right: ['upload', 'traffic'] })
    const placement = activityPlacement(layout)
    expect(placement.download).toEqual({ gridColumn: '1', gridRow: '2 / span 1' })
    expect(placement.connections).toEqual({ gridColumn: '1 / span 2', gridRow: '3 / span 1' })
    expect(placement.upload).toEqual({ gridColumn: '3', gridRow: '1 / span 1' })
    expect(placement.traffic).toEqual({ gridColumn: '3 / span 2', gridRow: '2 / span 2' })
    // Swapping their order swaps their halves.
    const swapped = moveActivityCard(defaultActivityLayout(), 'download', 'right', 0)
    expect(activityPlacement(swapped).download).toEqual({ gridColumn: '3', gridRow: '1 / span 1' })
    expect(activityPlacement(swapped).upload).toEqual({ gridColumn: '4', gridRow: '1 / span 1' })
  })
})
