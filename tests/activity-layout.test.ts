import { describe, expect, it } from 'vitest'
import {
  activityPlacement, cardPosition, defaultActivityLayout, isDefaultActivityLayout, moveActivityCard,
  normalizeActivityLayout, parseActivityLayout
} from '../src/renderer/src/lib/activity-layout'

describe('activity card layout', () => {
  it('defaults to the Surge arrangement: horizontal cards left, speed and the square traffic card right', () => {
    const layout = defaultActivityLayout()
    expect(layout).toEqual({ left: ['latency', 'connections', 'total'], right: ['speed', 'traffic'] })
    expect(activityPlacement(layout)).toEqual({
      latency: { gridColumn: '1', gridRow: '1 / span 1' },
      connections: { gridColumn: '1', gridRow: '2 / span 1' },
      total: { gridColumn: '1', gridRow: '3 / span 1' },
      speed: { gridColumn: '2', gridRow: '1 / span 1' },
      traffic: { gridColumn: '2', gridRow: '2 / span 2' }
    })
    expect(isDefaultActivityLayout(layout)).toBe(true)
  })

  it('fails closed to defaults for missing or malformed storage', () => {
    expect(parseActivityLayout(null)).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('{bad')).toEqual(defaultActivityLayout())
    expect(parseActivityLayout('[1]')).toEqual(defaultActivityLayout())
  })

  it('drops unknown and duplicate cards and puts missing ones in the shorter column', () => {
    const layout = normalizeActivityLayout({ left: ['traffic', 'bogus', 'traffic', 'latency'], right: ['total'] })
    expect(layout.left).toEqual(['traffic', 'latency'])
    // right (1 row) is shorter than left (3 rows): speed goes right, then connections (right 2 < left 3).
    expect(layout.right).toEqual(['total', 'speed', 'connections'])
  })

  it('moves a card within a column and across columns', () => {
    let layout = moveActivityCard(defaultActivityLayout(), 'total', 'left', 0)
    expect(layout.left).toEqual(['total', 'latency', 'connections'])
    layout = moveActivityCard(layout, 'traffic', 'left', 1)
    expect(layout).toEqual({ left: ['total', 'traffic', 'latency', 'connections'], right: ['speed'] })
    expect(cardPosition(layout, 'traffic')).toEqual({ column: 'left', index: 1 })
    expect(activityPlacement(layout).latency).toEqual({ gridColumn: '1', gridRow: '4 / span 1' })
    expect(moveActivityCard(layout, 'speed', 'left', 99).left.at(-1)).toBe('speed')
    expect(isDefaultActivityLayout(layout)).toBe(false)
  })
})
