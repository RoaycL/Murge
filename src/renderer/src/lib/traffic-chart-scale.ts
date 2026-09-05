export interface TrafficChartScale {
  ceiling: number
  middle: number
}

const KIB = 1024
const HEADROOM = 1.15

/**
 * Build a stable, readable Y axis for the one-minute traffic sparkline.
 * The ceiling is a power-of-two KiB step above the recent peak, so labels stay
 * compact (1/2/4/8 KiB, MiB, GiB...) and the trace always has headroom.
 */
export function trafficChartScale(series: readonly number[]): TrafficChartScale {
  const peak = series.reduce((largest, value) =>
    Number.isFinite(value) && value > largest ? value : largest, 0)
  const target = Math.max(KIB, peak * HEADROOM)
  const exponent = Math.max(0, Math.ceil(Math.log2(target / KIB)))
  const ceiling = KIB * (2 ** exponent)
  return { ceiling, middle: ceiling / 2 }
}
