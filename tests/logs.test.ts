import { describe, expect, it } from 'vitest'
import { normalizeLogMessage, redactLogText, serializeLogs } from '../src/renderer/src/lib/logs'

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
    const text = serializeLogs([{ id: 1, time: '2026-01-01T00:00:00.000Z', level: 'info', message: 'password=hunter2' }])
    expect(text).not.toContain('hunter2')
    expect(text).toContain('password=[REDACTED]')
  })
})
