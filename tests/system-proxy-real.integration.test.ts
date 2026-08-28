import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { WindowsSystemProxyAdapter } from '../src/main/system-proxy/adapters/windows-adapter'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FileSystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import { captureNetworkSnapshot } from './real-network-snapshot'
import type { SystemProxyTarget } from '../src/main/system-proxy/types'

/**
 * Real system-proxy enable/restore against a live Windows HKCU Internet Settings
 * key. Gated behind MURGE_RUN_REAL_SYSTEM_PROXY=1 AND the win32 platform so it
 * never runs in the default `npm test`; it is only meant for the disposable CI
 * Windows runner (or an explicitly opted-in local Windows box). A `finally`
 * block always restores the exact original values so a failing assertion can
 * never leave the host's proxy changed.
 *
 * The system proxy here is *registered* (ProxyServer/ProxyEnable/ProxyOverride)
 * but NOT served — no socket is bound, so no real traffic is proxied. The only
 * observable effect is the per-user registry, which the finally block resets.
 */
const enabled = process.env.MURGE_RUN_REAL_SYSTEM_PROXY === '1' && process.platform === 'win32'
const run = enabled ? describe : describe.skip

const TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

run('real Windows system-proxy enable/restore (gated)', () => {
  it('enables, proves only the proxy fields changed, then restores them', async () => {
    const adapter = new WindowsSystemProxyAdapter()
    const tempDir = await mkdtemp(join(tmpdir(), 'murge-sysproxy-real-'))
    const backup = FileSystemProxyBackupStore.forAppDataBase(tempDir)
    const service = new SystemProxyService({
      adapter,
      probe: new StaticSystemProxyProbe(TARGET),
      backup,
      instanceId: 'real-windows-test'
    })

    const before = await adapter.read()
    const beforeSnap = await captureNetworkSnapshot()

    try {
      const status = await service.enable()
      expect(status.phase).toBe('enabled')
      expect(status.address).toBe('127.0.0.1:7890')
      expect(status.port).toBe(7890)

      // The registry now points at the loopback target.
      const now = await adapter.read()
      expect(now.proxyEnable).toEqual({ exists: true, type: 'dword', value: 1 })
      expect(now.proxyServer.value).toBe('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890')

      // Enabling the per-user proxy must NOT have touched WinHTTP, routes, DNS,
      // adapters or any firewall profile — only the HKCU Internet Settings proxy.
      const duringSnap = await captureNetworkSnapshot()
      const changed = Object.keys(duringSnap).filter((key) => duringSnap[key] !== beforeSnap[key])
      expect(changed).toEqual(['internetSettingsProxy'])
    } finally {
      // Restore BEFORE the assertion can propagate, even on a throw above.
      await service.restoreBeforeKernelUnavailable().catch(() => {})
      // Hard fallback: put back the exact original values regardless of ownership.
      await adapter.restore(before).catch(() => {})
      await rm(tempDir, { recursive: true, force: true })
    }

    const after = await adapter.read()
    expect(after).toEqual(before)
    const afterSnap = await captureNetworkSnapshot()
    expect(afterSnap).toEqual(beforeSnap)
  })
})
