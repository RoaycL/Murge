/**
 * Unit tests for the real G1 driver seam (`src/main/tun/g1-driver.ts`).
 *
 * The driver is constructed WITHOUT a native binding and with an intentionally
 * unpopulated pinned manifest, so it fails closed: no Wintun DLL is loaded, no
 * mihomo is spawned and no network/OS mutation is attempted. These tests prove
 * that default fail-closed behaviour plus the generate -> validate ->
 * parse-back-assert pipeline for the isolated mihomo probe config (P1-4).
 */

import { describe, it, expect } from 'vitest'
import {
  createRealG1ProbeDriver,
  PINNED_WINTUN_MANIFEST,
  G1_MIHOMO_TOP_KEYS,
  G1_MIHOMO_TUN_KEYS,
  G1_MIHOMO_DNS_KEYS,
  buildIsolatedMihomoConfig,
  assertG1MihomoConfig,
  g1MihomoConfigErrors,
  parseBackG1MihomoConfig,
  captureNetworkSnapshot,
  networkDiff,
  guidToLittleEndianBytes,
  type G1AdapterIdentity
} from '../src/main/tun/g1-driver'
import { G1ErrorCode, type G1ProbeError } from '../src/main/tun/g1-probe'

const identity: G1AdapterIdentity = {
  name: 'ProductTunProbeTemp',
  requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
  canonicalLuid: '0x1234567890abcdef'
}

/** Assert a synchronous call throws a G1ProbeError carrying the given code. */
function expectCode(fn: () => unknown, code: G1ErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as G1ProbeError).code).toBe(code)
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
    ).rejects.toMatchObject({ code: G1ErrorCode.unsupported })
  })

  it('refuses to spawn the mihomo probe (unsupported) without a native binding', async () => {
    const driver = createRealG1ProbeDriver()
    await expect(driver.startMihomoProbe(identity)).rejects.toMatchObject({ code: G1ErrorCode.unsupported })
  })

  it('never spawns any network/OS command on non-Windows (read-only placeholder snapshot)', async () => {
    if (process.platform === 'win32') return // read-only netsh/PowerShell capture is Windows-only
    const before = await captureNetworkSnapshot()
    const after = await captureNetworkSnapshot()
    expect(before.ipv4DefaultRoute).toContain('N/A (non-Windows)')
    expect(networkDiff(before, after)).toEqual([])
  })
})

describe('buildIsolatedMihomoConfig (P1-4 official keys only)', () => {
  it('emits an officially-keyed, route/DNS/proxy-neutral config that round-trips', () => {
    const config = buildIsolatedMihomoConfig(identity)
    // Only the exact allow-listed top-level keys may ever appear.
    const topKeys = g1MihomoConfigErrors(config, identity.name)
    expect(topKeys).toEqual([])

    const parsed = parseBackG1MihomoConfig(config)
    expect(parsed.allowLan).toBe(false)
    expect(parsed.mode).toBe('direct')
    expect(parsed.tunEnable).toBe(true)
    expect(parsed.tunStack).toBe('system')
    expect(parsed.tunDevice).toBe(identity.name)
    expect(parsed.autoRoute).toBe(false)
    expect(parsed.autoDetectInterface).toBe(false)
    expect(parsed.strictRoute).toBe(false)
    expect(parsed.dnsEnable).toBe(false)
  })

  it('passes the strict validator, the repo validator and the parse-back assert', () => {
    const config = buildIsolatedMihomoConfig(identity)
    expect(() => assertG1MihomoConfig(config, identity.name)).not.toThrow()
  })

  it('uses the official kebab-case keys — never the underscore variants', () => {
    const config = buildIsolatedMihomoConfig(identity)
    for (const key of G1_MIHOMO_TUN_KEYS) {
      expect(config).toContain('  ' + key + ':')
    }
    expect(config).not.toContain('auto_route')
    expect(config).not.toContain('strict_route')
    expect(config).not.toContain('auto_detect_interface')
  })
})

describe('g1MihomoConfigErrors (strict probe-config validator)', () => {
  it('rejects an unknown/underscored tun key', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  auto-route: false',
      '  auto_route: false'
    )
    const errors = g1MihomoConfigErrors(bad, identity.name)
    expect(errors).toContainEqual(expect.stringMatching(/unknown|unexpected|key/i))
  })

  it('rejects a top-level inbound block (not an official probe-config key)', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      'allow-lan: false',
      'allow-lan: false\ninbound:\n  port: 43210'
    )
    const errors = g1MihomoConfigErrors(bad, identity.name)
    expect(errors).toContainEqual(expect.stringMatching(/unknown top-level key.*inbound/i))
  })

  it('rejects any TUN safety field that is not false (auto-route, strict-route)', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  strict-route: false',
      '  strict-route: true'
    )
    const errors = g1MihomoConfigErrors(bad, identity.name)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects a config that enables DNS hijacking', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  enable: false',
      '  enable: true'
    )
    const errors = g1MihomoConfigErrors(bad, identity.name)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects a device that does not match the probe adapter name', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  device: ' + identity.name,
      '  device: SomeOtherAdapter'
    )
    const errors = g1MihomoConfigErrors(bad, identity.name)
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('assertG1MihomoConfig', () => {
  it('throws before mihomo starts on a config with an unsafe/rewritten critical field', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  auto-route: false',
      '  auto-route: true'
    )
    expectCode(() => assertG1MihomoConfig(bad, identity.name), G1ErrorCode.g1Failed)
  })

  it('rejects a config that auto-rewrites `device` to something other than the probe adapter', () => {
    const bad = buildIsolatedMihomoConfig(identity).replace(
      '  device: ' + identity.name,
      '  device: wintun'
    )
    expectCode(() => assertG1MihomoConfig(bad, identity.name), G1ErrorCode.g1Failed)
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
