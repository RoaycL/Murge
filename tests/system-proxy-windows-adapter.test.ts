import { describe, it, expect } from 'vitest'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { WindowsSystemProxyAdapter, type RunResult } from '../src/main/system-proxy/adapters/windows-adapter'
import type { SystemProxyWrittenState } from '../src/main/system-proxy/types'
import { PROXY_ENABLE_VALUE, PROXY_SERVER_VALUE, PROXY_OVERRIDE_VALUE } from '../src/main/system-proxy/adapters/windows-helpers'

/** A configurable command runner that records every invocation. */
function makeRunner(handlers: Record<string, () => RunResult | Promise<RunResult>> = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args })
    const handler = handlers[command]
    if (handler) return await handler()
    throw new Error(`no handler for command ${command}`)
  }
  return { runner, calls }
}

const ok = (stdout = ''): RunResult => ({ stdout, stderr: '', code: 0 })
const exit = (code: number, stderr = ''): RunResult => ({ stdout: '', stderr, code })

const WRITTEN: SystemProxyWrittenState = {
  proxyEnable: { exists: true, type: 'REG_DWORD', value: 1 },
  proxyServer: { exists: true, type: 'REG_SZ', value: 'http=127.0.0.1:7890' },
  proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>' }
}

describe('WindowsSystemProxyAdapter', () => {
  describe('readValue / read', () => {
    it('parses an existing REG_DWORD into a typed value', async () => {
      const { runner } = makeRunner({
        reg: () => ok('    ProxyEnable    REG_DWORD    0x1')
      })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.readValue(PROXY_ENABLE_VALUE)).resolves.toEqual({ exists: true, type: 'REG_DWORD', value: 1 })
    })

    it('treats exit code 1 as an absent value (never a phantom typed value)', async () => {
      const { runner } = makeRunner({ reg: () => exit(1) })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.readValue(PROXY_ENABLE_VALUE)).resolves.toEqual({ exists: false, type: 'none', value: null })
    })

    it('surfaces a non-zero, non-1 exit as a typed error instead of "absent"', async () => {
      const { runner } = makeRunner({ reg: () => exit(2, 'boom') })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.readValue(PROXY_ENABLE_VALUE)).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED
      })
    })

    it('surfaces an access-denied exit as an authorization error', async () => {
      const { runner } = makeRunner({
        reg: () => exit(5, 'ERROR: Access is denied.')
      })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.readValue(PROXY_ENABLE_VALUE)).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED
      })
    })

    it('surfaces a transport failure (reg.exe not executable) as a typed error', async () => {
      const { runner } = makeRunner({})
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED })
    })
  })

  describe('apply', () => {
    it('writes all three values via reg add', async () => {
      const { runner, calls } = makeRunner({ reg: () => ok() })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await adapter.apply(WRITTEN)
      expect(calls.map((c) => c.command).every((c) => c === 'reg')).toBe(true)
      expect(calls.length).toBe(3)
    })

    it('raises a typed ENABLE_FAILED when any write exits non-zero', async () => {
      const { runner } = makeRunner({ reg: () => exit(1, 'denied') })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.apply(WRITTEN)).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED
      })
    })
  })

  describe('restore', () => {
    it('deletes an absent previous value and re-adds present ones with their exact type', async () => {
      const { runner, calls } = makeRunner({ reg: () => ok() })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await adapter.restore({
        proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 },
        proxyServer: { exists: true, type: 'REG_EXPAND_SZ', value: '%PATH%' },
        proxyOverride: { exists: false, type: 'none', value: null }
      })
      expect(calls.length).toBe(3)
      // proxyOverride is absent → delete, not add.
      expect(calls[2].args.find((a) => a === 'delete')).toBe('delete')
      // proxyServer must keep REG_EXPAND_SZ (never downgraded to REG_SZ).
      expect(calls[1].args).toContain('REG_EXPAND_SZ')
    })

    it('raises a typed RESTORE_FAILED on a non-zero restore exit', async () => {
      const { runner } = makeRunner({ reg: () => exit(1, 'boom') })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(
        adapter.restore({ proxyEnable: { exists: false, type: 'none', value: null }, proxyServer: { exists: false, type: 'none', value: null }, proxyOverride: { exists: false, type: 'none', value: null } })
      ).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
    })
  })

  describe('refresh', () => {
    it('succeeds when PowerShell returns exit 0', async () => {
      const { runner } = makeRunner({ powershell: () => ok() })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.refresh()).resolves.toBeUndefined()
    })

    it('raises RESTORE_FAILED when WinINet reports a failure (non-zero exit)', async () => {
      const { runner } = makeRunner({ powershell: () => exit(2, 'InternetSetOption failed') })
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.refresh()).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED
      })
    })

    it('raises RESTORE_FAILED when PowerShell cannot run at all', async () => {
      const { runner } = makeRunner({})
      const adapter = new WindowsSystemProxyAdapter(runner)
      await expect(adapter.refresh()).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED
      })
    })
  })
})
