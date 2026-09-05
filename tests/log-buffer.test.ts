import { describe, it, expect } from 'vitest'
import { MihomoLogBuffer } from '../src/main/services/log-buffer'
import type { MihomoLogMessage } from '../src/shared/mihomo-api'

function msg(payload: string): MihomoLogMessage {
  return { type: 'info', payload }
}

describe('MihomoLogBuffer', () => {
  it('assigns strictly monotonic seq and stamps it onto the retained message', () => {
    const buffer = new MihomoLogBuffer()
    const a = msg('a')
    const b = msg('b')
    const c = msg('c')
    expect(buffer.append(a)).toBe(1)
    expect(buffer.append(b)).toBe(2)
    expect(buffer.append(c)).toBe(3)
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(c.seq).toBe(3)
    expect(buffer.lastSeq).toBe(3)
  })

  it('returns the whole ring when asked with the default cursor', () => {
    const buffer = new MihomoLogBuffer()
    buffer.append(msg('a'))
    buffer.append(msg('b'))
    const all = buffer.snapshot()
    expect(all.map((entry) => entry.payload)).toEqual(['a', 'b'])
    expect(all.every((entry) => typeof entry.seq === 'number')).toBe(true)
  })

  it('returns only entries past afterSeq, ascending', () => {
    const buffer = new MihomoLogBuffer()
    for (let i = 0; i < 5; i++) buffer.append(msg(`m${i}`))
    expect(buffer.snapshot(2).map((entry) => entry.payload)).toEqual(['m2', 'm3', 'm4'])
    expect(buffer.snapshot(4).map((entry) => entry.payload)).toEqual(['m4'])
    expect(buffer.snapshot(5)).toEqual([])
    expect(buffer.snapshot(999)).toEqual([])
  })

  it('keeps the most recent capacity entries (FIFO eviction)', () => {
    const buffer = new MihomoLogBuffer(3)
    for (let i = 0; i < 5; i++) buffer.append(msg(`m${i}`))
    expect(buffer.snapshot().map((entry) => entry.payload)).toEqual(['m2', 'm3', 'm4'])
    expect(buffer.lastSeq).toBe(5)
    // The snapshot cursor is honored against the surviving tail.
    expect(buffer.snapshot(3).map((entry) => entry.payload)).toEqual(['m3', 'm4'])
  })

  it('continues numbering after clear so seq stays a stable dedup key', () => {
    const buffer = new MihomoLogBuffer()
    buffer.append(msg('a'))
    buffer.append(msg('b'))
    expect(buffer.clear()).toBe(2)
    expect(buffer.snapshot()).toEqual([])
    expect(buffer.lastSeq).toBe(2)
    // Next assignment continues past the cleared set — never reuses 1/2.
    expect(buffer.append(msg('c'))).toBe(3)
    expect(buffer.snapshot().map((entry) => entry.seq)).toEqual([3])
  })

  it('rejects a non-positive capacity', () => {
    expect(() => new MihomoLogBuffer(0)).toThrow()
    expect(() => new MihomoLogBuffer(1.5)).toThrow()
  })
})
