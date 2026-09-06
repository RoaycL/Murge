/** Compact, stable human-readable byte/rate formatting used across the UI. */

export interface RateText {
  value: string
  unit: string
}

export interface ByteText {
  value: string
  unit: string
}

export function formatBytes(bytes: number): string {
  const { value, unit } = formatBytesParts(bytes)
  return `${value} ${unit}`
}

export function formatBytesParts(bytes: number): ByteText {
  const value = Math.max(0, bytes)
  if (value < 1024) return { value: `${Math.round(value)}`, unit: 'B' }
  if (value < 1024 * 1024) return { value: `${Math.round(value / 1024)}`, unit: 'KB' }
  if (value < 1024 * 1024 * 1024) return { value: `${(value / (1024 * 1024)).toFixed(1)}`, unit: 'MB' }
  return { value: `${(value / (1024 * 1024 * 1024)).toFixed(2)}`, unit: 'GB' }
}

export function formatRate(bytesPerSecond: number): RateText {
  const value = Math.max(0, bytesPerSecond)
  if (value < 1024) return { value: `${Math.round(value)}`, unit: 'B/s' }
  if (value < 1024 * 1024) return { value: `${Math.round(value / 1024)}`, unit: 'KB/s' }
  if (value < 1024 * 1024 * 1024) return { value: `${(value / (1024 * 1024)).toFixed(1)}`, unit: 'MB/s' }
  return { value: `${(value / (1024 * 1024 * 1024)).toFixed(1)}`, unit: 'GB/s' }
}

/** Fixed UTC offset (in minutes) for the Beijing fallback zone. */
const BEIJING_OFFSET_MINUTES = 8 * 60

let cachedTimeZone: string | null | undefined

/**
 * The system IANA time zone (`Intl`), or `null` when it cannot be resolved.
 * A missing ICU/time-zone database must never surface as UTC silently: the
 * formatter falls back to Beijing time (UTC+8) instead.
 */
export function resolveSystemTimeZone(): string | null {
  cachedTimeZone ??= (() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return typeof zone === 'string' && zone.length > 0 ? zone : null
    } catch {
      return null
    }
  })()
  return cachedTimeZone
}

export interface WallClockOptions {
  /** Override the resolved system zone; `null` forces the Beijing fallback. */
  timeZone?: string | null
  /** Append `.SSS` milliseconds (zone-independent) after the seconds. */
  milliseconds?: boolean
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * Format one timestamp as standard wall-clock `YYYY-MM-DD HH:mm:ss`
 * (`+ .SSS` when `milliseconds` is set) in the system time zone; when the
 * system zone cannot be resolved, fall back to Beijing time (UTC+8). An
 * unparseable input is returned unchanged so malformed data never renders as
 * an empty time column.
 */
export function formatWallClock(input: string | Date, options: WallClockOptions = {}): string {
  const timeZone = options.timeZone !== undefined ? options.timeZone : resolveSystemTimeZone()
  const withMs = options.milliseconds ?? false
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return typeof input === 'string' ? input : ''

  const join = (year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number): string => {
    const base = `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`
    return withMs ? `${base}.${pad(ms, 3)}` : base
  }

  if (timeZone) {
    // `hourCycle: 'h23'` keeps midnight as `00` instead of `24`; formatToParts
    // applies the zone's real UTC offset (DST included) rather than a guess.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date)
    const get = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value)
    return join(
      get('year'),
      get('month'),
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
      date.getMilliseconds()
    )
  }

  // No resolvable zone: apply the fixed Beijing offset arithmetically.
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MINUTES * 60_000)
  return join(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds()
  )
}
