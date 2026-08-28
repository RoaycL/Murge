import { describe, it, expect } from 'vitest'
import {
  WIN_INTERNET_SETTINGS_KEY,
  PROXY_ENABLE_VALUE,
  PROXY_SERVER_VALUE,
  PROXY_OVERRIDE_VALUE,
  regQueryValueArgs,
  regAddDwordArgs,
  regAddStringArgs,
  regAddExpandStringArgs,
  regAddBinaryArgs,
  regAddArgsFor,
  regDeleteValueArgs,
  parseRegQueryValue,
  buildWinInetRefreshScript
} from '../src/main/system-proxy/adapters/windows-helpers'
import type { RegistryValue } from '../src/main/system-proxy/types'

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

    it('builds a REG_EXPAND_SZ add argv', () => {
      expect(regAddExpandStringArgs(PROXY_SERVER_VALUE, '%PATH%\\p')).toEqual([
        'add',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_SERVER_VALUE,
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        '%PATH%\\p',
        '/f'
      ])
    })

    it('builds a REG_BINARY add argv', () => {
      expect(regAddBinaryArgs(PROXY_SERVER_VALUE, 'DEADBEEF')).toEqual([
        'add',
        WIN_INTERNET_SETTINGS_KEY,
        '/v',
        PROXY_SERVER_VALUE,
        '/t',
        'REG_BINARY',
        '/d',
        'DEADBEEF',
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

    it('maps a RegistryValue to the restore argv that preserves its exact type', () => {
      const value = (v: RegistryValue): string[] => regAddArgsFor(PROXY_ENABLE_VALUE, v)
      expect(value({ exists: false, type: 'none', value: null })).toEqual(regDeleteValueArgs(PROXY_ENABLE_VALUE))
      expect(value({ exists: true, type: 'REG_DWORD', value: 1 })).toEqual(regAddDwordArgs(PROXY_ENABLE_VALUE, 1))
      expect(value({ exists: true, type: 'REG_SZ', value: 'x' })).toEqual(regAddStringArgs(PROXY_ENABLE_VALUE, 'x'))
      expect(value({ exists: true, type: 'REG_EXPAND_SZ', value: '%x%' })).toEqual(
        regAddExpandStringArgs(PROXY_ENABLE_VALUE, '%x%')
      )
      expect(value({ exists: true, type: 'REG_BINARY', value: 'FF' })).toEqual(regAddBinaryArgs(PROXY_ENABLE_VALUE, 'FF'))
      // An unrestorable type must never silently downgrade; it throws.
      expect(() => value({ exists: true, type: 'REG_MULTI_SZ', value: 'a;b' })).toThrow()
    })
  })

  describe('parseRegQueryValue', () => {
    it('parses a REG_DWORD hex value into a number, preserving the type', () => {
      const value = parseRegQueryValue(`    ProxyEnable    REG_DWORD    0x1`)
      expect(value).toEqual({ exists: true, type: 'REG_DWORD', value: 1 })
    })

    it('parses a REG_SZ value into a string, preserving the type', () => {
      const value = parseRegQueryValue(`    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890`)
      expect(value).toEqual({
        exists: true,
        type: 'REG_SZ',
        value: 'http=127.0.0.1:7890;https=127.0.0.1:7890'
      })
    })

    it('preserves REG_EXPAND_SZ (never collapses it to plain REG_SZ)', () => {
      const value = parseRegQueryValue(`    ProxyOverride    REG_EXPAND_SZ    <local>`)
      expect(value).toEqual({ exists: true, type: 'REG_EXPAND_SZ', value: '<local>' })
    })

    it('preserves REG_BINARY as a hex string without parsing it', () => {
      const value = parseRegQueryValue(`    SomeValue    REG_BINARY    DEADBEEF`)
      expect(value).toEqual({ exists: true, type: 'REG_BINARY', value: 'DEADBEEF' })
    })

    it('preserves the empty string for an empty REG_SZ (not a missing value)', () => {
      const value = parseRegQueryValue(`    ProxyOverride    REG_SZ    `)
      expect(value).toEqual({ exists: true, type: 'REG_SZ', value: '' })
    })

    it('reports a value-not-found line as absent', () => {
      expect(parseRegQueryValue('ERROR: The system was unable to find the specified registry key or value.')).toEqual({
        exists: false,
        type: 'none',
        value: null
      })
    })

    it('defaults an unparseable dword to 0 instead of NaN', () => {
      const value = parseRegQueryValue(`    ProxyEnable    REG_DWORD    0xzz`)
      expect(value).toEqual({ exists: true, type: 'REG_DWORD', value: 0 })
    })
  })

  describe('buildWinInetRefreshScript', () => {
    it('signals WinINet to reload the per-user proxy settings', () => {
      const script = buildWinInetRefreshScript()
      expect(script).toContain('InternetSetOption')
      expect(script).toContain('39')
      expect(script).toContain('37')
    })

    it('reports failure (non-zero exit) when InternetSetOption returns false or last-error is non-zero', () => {
      const script = buildWinInetRefreshScript()
      // It must P/Invoke the real WinINet entry point (never the fragile
      // [type]::GetType("Microsoft.Win32.NativeMethods")), capture the bool result
      // and the Win32 last-error per call, and surface failure via a non-zero exit
      // rather than always exiting 0.
      expect(script).toContain('[SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)')
      expect(script).toContain('[SystemProxy.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)')
      expect(script).toContain('GetLastWin32Error')
      expect(script).toContain('$e1 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()')
      expect(script).toContain('$e2 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()')
      expect(script).toContain('exit 2')
      expect(script).toContain('exit 0')
      expect(script).toContain('Write-Error')
      // The last-error must be read per call (inside the branch where THAT call
      // returned false) — never cached after a successful call.
      expect(script).not.toContain('$e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()')
      expect(script).toContain('if (-not $b1)')
      expect(script).toContain('if (-not $b2)')
    })
  })

  describe('WinINet refresh script parity with the standalone recovery helper', () => {
    it('is byte-identical to scripts/recover-system-proxy.mjs buildRefreshScript() (via subprocess)', async () => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { fileURLToPath } = await import('node:url')
      const path = await import('node:path')
      const execFileAsync = promisify(execFile)
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      const { stdout } = await execFileAsync(
        process.execPath,
        ['scripts/recover-system-proxy.mjs', '--print-refresh-script'],
        { cwd: repoRoot }
      )
      expect(buildWinInetRefreshScript()).toBe(stdout)
    })
  })
})
