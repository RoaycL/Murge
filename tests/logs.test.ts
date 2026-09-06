import { describe, expect, it } from 'vitest'
import { normalizeLogMessage, redactLogText, serializeLogs } from '../src/renderer/src/lib/logs'
import { formatWallClock, resolveSystemTimeZone } from '../src/renderer/src/lib/format'

describe('renderer log safety', () => {
  it('redacts authorization, URL credentials and sensitive query values', () => {
    const input = 'Authorization: Bearer abc.def Cookie: session=xyz https://user:pass@example.test/x?token=secret&mode=rule api_key=123'
    const value = redactLogText(input)
    expect(value).not.toContain('abc.def')
    expect(value).not.toContain('user:pass')
    expect(value).not.toContain('session=xyz')
    expect(value).not.toContain('token=secret')
    expect(value).not.toContain('api_key=123')
    expect(value).toContain('mode=rule')
  })

  it('normalizes alternate message and level fields before retention', () => {
    expect(normalizeLogMessage({ level: 'warn', message: 'token=hidden' }, 7, new Date('2026-01-01T00:00:00Z'))).toEqual({
      id: 7,
      time: '2026-01-01T00:00:00.000Z',
      level: 'warning',
      message: 'token=[REDACTED]'
    })
  })

  it('redacts again at the export boundary', () => {
    const text = serializeLogs([{ id: 1, time: '2026-01-01T00:00:00.000Z', level: 'info', message: 'password=hunter2' }], 'UTC')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('password=[REDACTED]')
    // 导出的时间列是本地墙钟且只到秒，不再是 ISO 的 T/Z 形态。
    expect(text).toContain('2026-01-01 00:00:00\tINFO')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/)
  })
})

describe('formatWallClock', () => {
  it('formats standard wall-clock time in the given zone, to the second by default', () => {
    expect(formatWallClock('2026-01-01T00:00:00.250Z', { timeZone: 'UTC' })).toBe('2026-01-01 00:00:00')
    expect(formatWallClock('2026-06-15T12:34:56.789Z', { timeZone: 'Asia/Shanghai' })).toBe('2026-06-15 20:34:56')
    expect(formatWallClock('2026-01-01T23:59:59.001Z', { timeZone: 'America/New_York' })).toBe('2026-01-01 18:59:59')
  })

  it('appends zone-independent milliseconds on request (连接详情抽屉精度)', () => {
    expect(formatWallClock('2026-01-01T00:00:00.250Z', { timeZone: 'UTC', milliseconds: true })).toBe('2026-01-01 00:00:00.250')
    expect(formatWallClock('2026-06-15T12:34:56.789Z', { timeZone: 'Asia/Shanghai', milliseconds: true })).toBe('2026-06-15 20:34:56.789')
  })

  it('falls back to Beijing time (UTC+8) when no system zone resolves', () => {
    expect(formatWallClock('2026-01-01T00:00:00.250Z', { timeZone: null })).toBe('2026-01-01 08:00:00')
    expect(formatWallClock('2026-12-31T23:00:00.000Z', { timeZone: null, milliseconds: true })).toBe('2027-01-01 07:00:00.000')
  })

  it('keeps midnight as 00 and returns invalid input unchanged', () => {
    expect(formatWallClock('2026-01-01T00:00:00Z', { timeZone: 'Asia/Shanghai' })).toBe('2026-01-01 08:00:00')
    expect(formatWallClock('not-a-date', { timeZone: 'UTC' })).toBe('not-a-date')
  })

  it('resolves the system zone for default rendering', () => {
    const zone = resolveSystemTimeZone()
    const formatted = formatWallClock('2026-01-01T00:00:00.000Z')
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 默认渲染路径使用的时区就是系统解析结果（或其北京兜底）。
    expect(formatted).toBe(formatWallClock('2026-01-01T00:00:00.000Z', { timeZone: zone }))
  })
})
