import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOCAL_BYPASS_ENTRIES,
  EMPTY_PROXY_BYPASS_POLICY,
  MAX_CUSTOM_BYPASS_ENTRIES,
  MAX_CUSTOM_BYPASS_ENTRY_LENGTH,
  coerceProxyBypassPolicy
} from '../src/shared/proxy-bypass'

describe('proxy-bypass model', () => {
  describe('constants', () => {
    it('defaults to a non-empty local bypass list', () => {
      expect(Array.isArray(DEFAULT_LOCAL_BYPASS_ENTRIES)).toBe(true)
      expect(DEFAULT_LOCAL_BYPASS_ENTRIES.length).toBeGreaterThan(0)
      expect(DEFAULT_LOCAL_BYPASS_ENTRIES).toContain('<local>')
      expect(DEFAULT_LOCAL_BYPASS_ENTRIES).toContain('localhost')
      expect(DEFAULT_LOCAL_BYPASS_ENTRIES).toContain('127.*')
      for (let octet = 16; octet <= 31; octet += 1) {
        expect(DEFAULT_LOCAL_BYPASS_ENTRIES).toContain(`172.${octet}.*` as (typeof DEFAULT_LOCAL_BYPASS_ENTRIES)[number])
      }
    })

    it('caps custom entries and per-entry length', () => {
      expect(MAX_CUSTOM_BYPASS_ENTRIES).toBeGreaterThan(0)
      expect(MAX_CUSTOM_BYPASS_ENTRY_LENGTH).toBeGreaterThan(0)
    })

    it('EMPTY policy is frozen, disabled, with no entries', () => {
      expect(EMPTY_PROXY_BYPASS_POLICY).toMatchObject({ enabled: false, customEntries: [] })
      expect(Object.isFrozen(EMPTY_PROXY_BYPASS_POLICY)).toBe(true)
    })
  })

  describe('coerceProxyBypassPolicy', () => {
    it('returns the EMPTY policy for non-object input', () => {
      expect(coerceProxyBypassPolicy(null)).toMatchObject({ enabled: false, customEntries: [] })
      expect(coerceProxyBypassPolicy(undefined)).toMatchObject({ enabled: false, customEntries: [] })
      expect(coerceProxyBypassPolicy('nope')).toMatchObject({ enabled: false, customEntries: [] })
      expect(coerceProxyBypassPolicy([1, 2, 3])).toMatchObject({ enabled: false, customEntries: [] })
    })

    it('coerces a valid policy, normalizing entries', () => {
      const out = coerceProxyBypassPolicy({ enabled: true, customEntries: [' a.com ', 'a.com', 'b.com'] })
      expect(out).toMatchObject({ enabled: true, customEntries: ['a.com', 'b.com'] })
    })

    it('treats enabled as a strict boolean', () => {
      expect(coerceProxyBypassPolicy({ enabled: 1 } as unknown).enabled).toBe(false)
      expect(coerceProxyBypassPolicy({ enabled: true }).enabled).toBe(true)
    })

    it('coerces a top-level enabled-only object (missing customEntries)', () => {
      expect(coerceProxyBypassPolicy({ enabled: true })).toMatchObject({ enabled: true, customEntries: [] })
    })

    it('trims whitespace and drops blank entries', () => {
      const out = coerceProxyBypassPolicy({ enabled: true, customEntries: ['  *.example.com  ', '   ', ''] })
      expect(out.customEntries).toEqual(['*.example.com'])
    })

    it('drops over-length entries', () => {
      const tooLong = 'a'.repeat(MAX_CUSTOM_BYPASS_ENTRY_LENGTH + 1)
      const out = coerceProxyBypassPolicy({ enabled: true, customEntries: ['ok.com', tooLong] })
      expect(out.customEntries).toEqual(['ok.com'])
    })

    it('caps the count at MAX_CUSTOM_BYPASS_ENTRIES', () => {
      const entries = Array.from({ length: MAX_CUSTOM_BYPASS_ENTRIES + 50 }, (_, i) => `e${i}.com`)
      const out = coerceProxyBypassPolicy({ enabled: true, customEntries: entries })
      expect(out.customEntries.length).toBe(MAX_CUSTOM_BYPASS_ENTRIES)
      expect(out.customEntries[0]).toBe('e0.com')
    })

    it('skips non-string entries', () => {
      const out = coerceProxyBypassPolicy({ enabled: true, customEntries: ['a.com', 42, null, 'b.com'] as unknown })
      expect(out.customEntries).toEqual(['a.com', 'b.com'])
    })
  })
})
