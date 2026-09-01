import { describe, it, expect } from 'vitest'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import {
  buildWrittenState,
  mergeLocalBypass,
  mergeProxyOverride,
  resolveProxyOverride
} from '../src/main/system-proxy/policy'
import type { RegistryValue, SystemProxyRegistryState } from '../src/main/system-proxy/types'
import { DEFAULT_LOCAL_BYPASS_ENTRIES, EMPTY_PROXY_BYPASS_POLICY } from '../src/shared/proxy-bypass'
import type { ProxyBypassPolicy } from '../src/shared/proxy-bypass'

const ABSENT: RegistryValue = { exists: false, type: 'none', value: null }
const str = (value: string): RegistryValue => ({ exists: true, type: 'REG_SZ', value })

const TARGET = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

const state = (overrides: Partial<SystemProxyRegistryState> = {}): SystemProxyRegistryState => ({
  proxyEnable: { ...ABSENT },
  proxyServer: { ...ABSENT },
  proxyOverride: { ...ABSENT },
  ...overrides
})

const LOCAL = DEFAULT_LOCAL_BYPASS_ENTRIES.join(';')

describe('proxy-bypass policy', () => {
  describe('mergeLocalBypass', () => {
    it('produces the local list with no custom entries', () => {
      expect(mergeLocalBypass([])).toBe(LOCAL)
    })

    it('appends custom entries after the local list', () => {
      expect(mergeLocalBypass(['*.example.com', '10.0.0.1'])).toBe(`${LOCAL};*.example.com;10.0.0.1`)
    })

    it('de-duplicates entries already in the local list', () => {
      expect(mergeLocalBypass(['localhost', '127.*', 'custom.com'])).toBe(`${LOCAL};custom.com`)
    })
  })

  describe('resolveProxyOverride', () => {
    it('uses local entries alone when no policy is present', () => {
      expect(resolveProxyOverride(undefined, null)).toBe(LOCAL)
    })

    it('preserves existing entries when the policy is disabled', () => {
      expect(resolveProxyOverride({ ...EMPTY_PROXY_BYPASS_POLICY }, '*.example.com')).toBe(
        `${LOCAL};*.example.com`
      )
    })

    it('is authoritative (local + custom) when the policy is enabled', () => {
      const policy: ProxyBypassPolicy = { enabled: true, customEntries: ['*.example.com'] }
      expect(resolveProxyOverride(policy, 'someone-elses.entry')).toBe(`${LOCAL};*.example.com`)
    })
  })

  describe('buildWrittenState with policy', () => {
    it('writes the merged value when the policy is enabled', () => {
      const policy: ProxyBypassPolicy = { enabled: true, customEntries: ['*.example.com', 'internal.corp'] }
      const written = buildWrittenState(TARGET, state({ proxyOverride: str('pre-existing') }), policy)
      expect(written.proxyOverride).toEqual({
        exists: true,
        type: 'REG_SZ',
        value: `${LOCAL};*.example.com;internal.corp`
      })
      expect(written.proxyEnable.value).toBe(1)
    })

    it('preserves the OS override when the policy is disabled', () => {
      const written = buildWrittenState(TARGET, state({ proxyOverride: str('keep.me') }), { ...EMPTY_PROXY_BYPASS_POLICY })
      expect(written.proxyOverride.value).toBe(`${LOCAL};keep.me`)
    })
  })

  describe('back-compat mergeProxyOverride', () => {
    it('still merges local entries with the original', () => {
      expect(mergeProxyOverride('*.example.com;<local>;10.0.0.1')).toBe(`${LOCAL};*.example.com;10.0.0.1`)
    })
  })
})
