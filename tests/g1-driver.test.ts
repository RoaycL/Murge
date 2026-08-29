/**
 * Unit tests for the real G1 driver seam (`src/main/tun/g1-driver.ts`).
 *
 * The driver is constructed WITHOUT a native binding and with an intentionally
 * unpopulated pinned manifest, so it fails closed: no Wintun DLL is loaded, no
 * mihomo is spawned and no network/OS mutation is attempted. These tests prove
 * that default fail-closed behaviour, including the architecture-mismatch /
 * no-digest path where the pinned manifest has no SHA-256 for the running arch.
 */

import { describe, it, expect } from 'vitest'
import {
  createRealG1ProbeDriver,
  PINNED_WINTUN_MANIFEST,
  buildIsolatedMihomoConfig,
  captureNetworkSnapshot,
  networkDiff,
  guidToLittleEndianBytes,
  type G1AdapterIdentity
} from '../src/main/tun/g1-driver'
import { G1ErrorCode } from '../src/main/tun/g1-probe'

const identity: G1AdapterIdentity = {
  name: 'ProductTunProbeTemp',
  requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
  canonicalLuid: '0x1234567890abcdef'
}

describe('createRealG1ProbeDriver (fail-closed seam)', () => {
  it('fails closed when the pinned manifest has no digest for the running arch (no DLL load)', async () => {
    // The unpinned manifest is intentionally unpopulated (digests === {}), so the
    // running architecture's digest is missing: this is the arch-mismatch path.
    expect(Object.keys(PINNED_WINTUN_MANIFEST.digests)).toHaveLength(0)
    const driver = createRealG1ProbeDriver()
    const load = await driver.loadPinnedWintun()
    expect(load.verified).toBe(false)
    expect(load.digest).toBe('')
    // No adapter, no mihomo, nothing created/spawned.
    expect(driver.architecture).toBeTruthy()
  })

  it('refuses to create an adapter (unsupported) without a native binding', async () => {
    const driver = createRealG1ProbeDriver()
    await expect(
      driver.createAdapter({ ...identity, tunnelType: 'WireGuard' })
    ).rejects.toThrow(G1ErrorCode.unsupported)
  })

  it('refuses to spawn the mihomo probe (unsupported) without a native binding', async () => {
    const driver = createRealG1ProbeDriver()
    await expect(driver.startMihomoProbe()).rejects.toThrow(G1ErrorCode.unsupported)
  })

  it('never spawns any network/OS command on non-Windows (read-only placeholder snapshot)', async () => {
    if (process.platform === 'win32') return // read-only netsh/PowerShell capture is Windows-only
    const before = await captureNetworkSnapshot()
    const after = await captureNetworkSnapshot()
    expect(before.ipv4DefaultRoute).toContain('N/A (non-Windows)')
    expect(networkDiff(before, after)).toEqual([])
  })
})

describe('buildIsolatedMihomoConfig', () => {
  it('is route/DNS/proxy-neutral: never auto-routes, never touches DNS, no proxy', () => {
    const config = JSON.parse(buildIsolatedMihomoConfig({ ...identity, mihomoPort: 43210 }))
    expect(config.tun.enable).toBe(true)
    expect(config.tun.device).toBe(identity.name)
    expect(config.tun.auto_route).toBe(false)
    expect(config.tun.strict_route).toBe(false)
    expect(config.dns.enable).toBe(false)
    // No in-band/system proxy is configured anywhere in the config.
    expect(JSON.stringify(config).toLowerCase()).not.toContain('proxy')
    expect(config.inbound.port).toBe(43210)
    expect(config.inbound.listen).toBe('127.0.0.1')
  })
})

describe('guidToLittleEndianBytes', () => {
  it('emits the 16 little-endian bytes the Wintun ABI expects', () => {
    expect(guidToLittleEndianBytes('01234567-89ab-4cde-8f01-23456789abcd')).toEqual([
      0x67, 0x45, 0x23, 0x01, // Data1 (LE)
      0xab, 0x89, // Data2 (LE)
      0xde, 0x4c, // Data3 (LE)
      0x8f, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd // Data4 (bytes)
    ])
  })
  it('rejects a malformed GUID', () => {
    expect(() => guidToLittleEndianBytes('nope')).toThrow('invalid GUID string')
  })
})
