import { describe, expect, it } from 'vitest'
import { trafficChartScale } from '../src/renderer/src/lib/traffic-chart-scale'

describe('trafficChartScale', () => {
  it('uses a small readable scale for idle and low traffic', () => {
    expect(trafficChartScale([])).toEqual({ ceiling: 1024, middle: 512 })
    expect(trafficChartScale([1024, 2048])).toEqual({ ceiling: 4096, middle: 2048 })
  })

  it('moves through binary-friendly KiB and MiB steps', () => {
    expect(trafficChartScale([300 * 1024])).toEqual({ ceiling: 512 * 1024, middle: 256 * 1024 })
    expect(trafficChartScale([1024 * 1024])).toEqual({ ceiling: 2 * 1024 * 1024, middle: 1024 * 1024 })
  })

  it('always leaves headroom above every valid sample', () => {
    const samples = [Number.NaN, -20, 37_000, Number.POSITIVE_INFINITY]
    const scale = trafficChartScale(samples)
    expect(scale.ceiling).toBeGreaterThan(37_000)
    expect(scale.middle).toBe(scale.ceiling / 2)
  })
})
