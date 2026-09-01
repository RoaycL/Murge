import { describe, expect, it } from 'vitest'
import { parseUsageWindow, parseUsageRanking, parseUsageRankLimit } from '../src/shared/schemas/ipc'
import { ProtocolError } from '../src/shared/protocol-errors'
import { USAGE_MAX_BUCKETS } from '../src/shared/usage'

describe('usage-history schema', () => {
  describe('parseUsageWindow', () => {
    it('accepts the four window lenses', () => {
      expect(parseUsageWindow('1h')).toBe('1h')
      expect(parseUsageWindow('24h')).toBe('24h')
      expect(parseUsageWindow('7d')).toBe('7d')
      expect(parseUsageWindow('30d')).toBe('30d')
    })

    it('rejects an unknown window', () => {
      expect(() => parseUsageWindow('90d')).toThrowError(ProtocolError)
      expect(() => parseUsageWindow(1)).toThrowError(ProtocolError)
      expect(() => parseUsageWindow(null)).toThrowError(ProtocolError)
    })
  })

  describe('parseUsageRanking', () => {
    it('accepts the four ranking metrics', () => {
      expect(parseUsageRanking('down')).toBe('down')
      expect(parseUsageRanking('up')).toBe('up')
      expect(parseUsageRanking('total')).toBe('total')
      expect(parseUsageRanking('count')).toBe('count')
    })

    it('rejects an unknown ranking metric', () => {
      expect(() => parseUsageRanking('bytes')).toThrowError(ProtocolError)
      expect(() => parseUsageRanking({})).toThrowError(ProtocolError)
    })
  })

  describe('parseUsageRankLimit', () => {
    it('returns undefined when omitted', () => {
      expect(parseUsageRankLimit(undefined)).toBeUndefined()
    })

    it('accepts a positive integer within the cap', () => {
      expect(parseUsageRankLimit(1)).toBe(1)
      expect(parseUsageRankLimit(USAGE_MAX_BUCKETS)).toBe(USAGE_MAX_BUCKETS)
    })

    it('rejects zero, negatives, non-integers, and oversized values', () => {
      expect(() => parseUsageRankLimit(0)).toThrowError(ProtocolError)
      expect(() => parseUsageRankLimit(-1)).toThrowError(ProtocolError)
      expect(() => parseUsageRankLimit(1.5)).toThrowError(ProtocolError)
      expect(() => parseUsageRankLimit(USAGE_MAX_BUCKETS + 1)).toThrowError(ProtocolError)
      expect(() => parseUsageRankLimit('3')).toThrowError(ProtocolError)
    })
  })
})
