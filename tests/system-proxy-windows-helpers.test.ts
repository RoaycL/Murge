import { describe, it, expect } from 'vitest'
import {
  WIN_INTERNET_SETTINGS_KEY,
  PROXY_ENABLE_VALUE,
  PROXY_SERVER_VALUE,
  PROXY_OVERRIDE_VALUE,
  regQueryValueArgs,
  regAddDwordArgs,
  regAddStringArgs,
  regDeleteValueArgs,
  parseRegQueryValue,
  buildWinInetRefreshScript
} from '../src/main/system-proxy/adapters/windows-helpers'

describe('windows system-proxy helpers', () => {
  it('targets the HKCU Internet Settings key and exposes its value names', () => {
    expect(WIN_INTERNET_SETTINGS_KEY).toBe(String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`)
    expect(PROXY_ENABLE_VALUE).toBe('ProxyEnable')
    expect(PROXY_SERVER_VALUE).toBe('ProxyServer')
    expect(PROXY_OVERRIDE_VALUE).toBe('ProxyOverride')
  })

  describe('reg.exe argv builders', () => {
    it('builds a query argv', () => {
      expect(regQueryValueArgs(PROXY_ENABLE_VALUE)).toEqual([
        'query',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_ENABLE_VALUE
      ])
    })

    it('builds a REG_DWORD add argv with the value as a string and force flag', () => {
      expect(regAddDwordArgs(PROXY_ENABLE_VALUE, 1)).toEqual([
        'add',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_ENABLE_VALUE,
        '/t',
        'REG_DWORD',
        '/d',
        '1',
        '/f'
      ])
    })

    it('builds a REG_SZ add argv', () => {
      expect(regAddStringArgs(PROXY_SERVER_VALUE, 'http=127.0.0.1:7890')).toEqual([
        'add',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_SERVER_VALUE,
        '/t',
        'REG_SZ',
        '/d',
        'http=127.0.0.1:7890',
        '/f'
      ])
    })

    it('builds a delete argv that removes the value entirely', () => {
      expect(regDeleteValueArgs(PROXY_OVERRIDE_VALUE)).toEqual([
        'delete',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_OVERRIDE_VALUE,
        '/f'
      ])
    })
  })

  describe('parseRegQueryValue', () => {
    it('parses a REG_DWORD hex value into a number', () => {
      const value = parseRegQueryValue(`    ProxyEnable    REG_DWORD    0x1`)
      expect(value).toEqual({ exists: true, type: 'dword', value: 1 })
    })

    it('parses a REG_SZ value into a string', () => {
      const value = parseRegQueryValue(`    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890`)
      expect(value).toEqual({
        exists: true,
        type: 'string',
        value: 'http=127.0.0.1:7890;https=127.0.0.1:7890'
      })
    })

    it('treats REG_EXPAND_SZ as a string', () => {
      const value = parseRegQueryValue(`    ProxyOverride    REG_EXPAND_SZ    <local>`)
      expect(value).toEqual({ exists: true, type: 'string', value: '<local>' })
    })

    it('surfaces binary values without parsing them', () => {
      const value = parseRegQueryValue(`    SomeValue    REG_BINARY    DEADBEEF`)
      expect(value).toEqual({ exists: true, type: 'binary', value: 'DEADBEEF' })
    })

    it('reports a missing value as absent', () => {
      expect(parseRegQueryValue('ERROR: The system was unable to find the specified registry key or value.')).toEqual({
        exists: false,
        type: 'none',
        value: null
      })
    })

    it('defaults an unparseable dword to 0 instead of NaN', () => {
      const value = parseRegQueryValue(`    ProxyEnable    REG_DWORD    0xzz`)
      expect(value).toEqual({ exists: true, type: 'dword', value: 0 })
    })
  })

  describe('buildWinInetRefreshScript', () => {
    it('signals WinINet to reload the per-user proxy settings and exits 0', () => {
      const script = buildWinInetRefreshScript()
      expect(script).toContain('InternetSetOption')
      expect(script).toContain('39')
      expect(script).toContain('37')
      expect(script).toContain('exit 0')
    })
  })
})
