import { describe, it, expect } from 'vitest'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import {
  formatAddress,
  buildProxyServerValue,
  mergeProxyOverride,
  buildWrittenState,
  differingKeys,
  isOwned,
  conflictDetail,
  matchesPrevious,
  sameRegistryValue,
  validateRestorable,
  validateTarget
} from '../src/main/system-proxy/policy'
import type {
  RegistryValue,
  SystemProxyRegistryState,
  SystemProxyWrittenState
} from '../src/main/system-proxy/types'

const ABSENT: RegistryValue = { exists: false, type: 'none', value: null }
const dword = (value: number): RegistryValue => ({ exists: true, type: 'REG_DWORD', value })
const str = (value: string): RegistryValue => ({ exists: true, type: 'REG_SZ', value })
const expandStr = (value: string): RegistryValue => ({ exists: true, type: 'REG_EXPAND_SZ', value })
const bin = (value: string): RegistryValue => ({ exists: true, type: 'REG_BINARY', value })

const TARGET = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

const state = (overrides: Partial<SystemProxyRegistryState> = {}): SystemProxyRegistryState => ({
  proxyEnable: { ...ABSENT },
  proxyServer: { ...ABSENT },
  proxyOverride: { ...ABSENT },
  ...overrides
})

describe('system-proxy policy', () => {
  describe('formatAddress', () => {
    it('formats a target as host:port', () => {
      expect(formatAddress(TARGET)).toBe('127.0.0.1:7890')
    })
  })

  describe('buildProxyServerValue', () => {
    it('references the same loopback host:port for every scheme', () => {
      expect(buildProxyServerValue(TARGET)).toBe('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890')
    })
  })

  describe('mergeProxyOverride', () => {
    it('always keeps the mandatory local bypass list', () => {
      expect(mergeProxyOverride(null)).toBe('<local>;localhost;127.*;10.*;172.16.*;192.168.*')
    })

    it('preserves and de-duplicates an existing value', () => {
      const merged = mergeProxyOverride('*.example.com;<local>;10.0.0.1')
      expect(merged).toBe('<local>;localhost;127.*;10.*;172.16.*;192.168.*;*.example.com;10.0.0.1')
    })

    it('drops empty segments', () => {
      expect(mergeProxyOverride(';;a.com;;')).toBe('<local>;localhost;127.*;10.*;172.16.*;192.168.*;a.com')
    })
  })

  describe('differingKeys / isOwned', () => {
    const written: SystemProxyWrittenState = {
      proxyEnable: dword(1),
      proxyServer: str('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890'),
      proxyOverride: str(mergeProxyOverride(null))
    }

    it('reports an exact match as owned', () => {
      const observed = state({
        proxyEnable: dword(1),
        proxyServer: str(written.proxyServer.value as string),
        proxyOverride: str(written.proxyOverride.value as string)
      })
      expect(isOwned(observed, written)).toBe(true)
      expect(differingKeys(observed, written)).toEqual([])
    })

    it('flags each mutated key independently', () => {
      const observed = state({
        proxyEnable: dword(0),
        proxyServer: str('http=9.9.9.9:1'),
        proxyOverride: str('something-else')
      })
      expect(isOwned(observed, written)).toBe(false)
      expect(differingKeys(observed, written)).toEqual(['ProxyEnable', 'ProxyServer', 'ProxyOverride'])
      expect(conflictDetail(observed, written)).toBe('注册表项被外部修改：ProxyEnable、ProxyServer、ProxyOverride')
    })

    it('treats an absent key as not matching a written key', () => {
      const observed = state() // all absent
      expect(isOwned(observed, written)).toBe(false)
      expect(differingKeys(observed, written)).toEqual(['ProxyEnable', 'ProxyServer', 'ProxyOverride'])
    })
  })

  describe('matchesPrevious', () => {
    it('matches when the registry returned to the pre-enable snapshot', () => {
      const previous = state({ proxyEnable: dword(0) })
      const observed = state({ proxyEnable: dword(0) })
      expect(matchesPrevious(observed, previous)).toBe(true)
    })

    it('does not match after an external mutation', () => {
      const previous = state({ proxyEnable: dword(0) })
      const observed = state({ proxyEnable: dword(1) })
      expect(matchesPrevious(observed, previous)).toBe(false)
    })
  })

  describe('buildWrittenState', () => {
    it('derives the override from the observed value', () => {
      const written = buildWrittenState(TARGET, state({ proxyOverride: str('a.com') }))
      expect(written.proxyEnable).toEqual(dword(1))
      expect(written.proxyServer.value).toBe('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890')
      expect(written.proxyOverride.value).toBe(mergeProxyOverride('a.com'))
    })
  })

  describe('sameRegistryValue', () => {
    it('requires exists, type and value to all match', () => {
      expect(sameRegistryValue(str('x'), str('x'))).toBe(true)
      expect(sameRegistryValue(str('x'), { ...str('x'), value: 'y' })).toBe(false)
      // REG_EXPAND_SZ is not REG_SZ even with the same bytes.
      expect(sameRegistryValue(expandStr('%PATH%'), str('%PATH%'))).toBe(false)
      expect(sameRegistryValue(bin('DEADBEEF'), str('DEADBEEF'))).toBe(false)
      // Absent values only match when both sides are the `none` triple.
      expect(sameRegistryValue(ABSENT, { exists: false, type: 'none', value: null })).toBe(true)
      expect(sameRegistryValue(ABSENT, { exists: false, type: 'REG_SZ', value: null })).toBe(false)
      expect(sameRegistryValue(ABSENT, { exists: true, type: 'none', value: null })).toBe(false)
    })
  })

  describe('validateRestorable', () => {
    it('accepts a state where every present value has a restorable type and shape', () => {
      expect(() =>
        validateRestorable(
          state({
            proxyEnable: dword(0),
            proxyServer: str('http=127.0.0.1:1'),
            proxyOverride: expandStr('')
          })
        )
      ).not.toThrow()
      // An empty REG_SZ is valid (must not be rejected as "missing").
      expect(() => validateRestorable(state({ proxyOverride: str('') }))).not.toThrow()
    })

    it('rejects an unrestorable type (REG_MULTI_SZ) before anything is written', () => {
      expect(() =>
        validateRestorable(state({ proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } }))
      ).toThrow(ProtocolError)
    })

    it('rejects a structurally inconsistent value (present but typed none)', () => {
      expect(() =>
        validateRestorable(state({ proxyEnable: { exists: true, type: 'none', value: null } }))
      ).toThrow(ProtocolError)
    })

    it('rejects a present value with a null string value', () => {
      expect(() =>
        validateRestorable(state({ proxyOverride: { exists: true, type: 'REG_SZ', value: null } }))
      ).toThrow(ProtocolError)
    })

    it('rejects an absent value that carries a non-none type', () => {
      expect(() =>
        validateRestorable(state({ proxyServer: { exists: false, type: 'REG_SZ', value: null } }))
      ).toThrow(ProtocolError)
    })
  })

  describe('validateTarget', () => {
    it('accepts a loopback target', () => {
      expect(validateTarget(TARGET)).toBe(TARGET)
    })

    it('rejects a non-loopback host', () => {
      try {
        validateTarget({ host: '0.0.0.0', port: 7890 })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError)
        expect((error as ProtocolError).code).toBe(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      }
    })

    it('rejects an out-of-range port', () => {
      for (const port of [0, -1, 65536, 1.5, NaN]) {
        expect(() => validateTarget({ host: SYSTEM_PROXY_LOOPBACK_HOST, port })).toThrow(ProtocolError)
      }
    })
  })
})
