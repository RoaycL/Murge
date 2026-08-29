/**
 * Unit tests for the G1 probe core (`src/main/tun/g1-probe.ts`).
 *
 * These are pure, zero-side-effect tests against a fake driver: no Wintun DLL is
 * loaded, no mihomo is spawned and no OS/network API is touched. They cover every
 * hard gate denial, the success path, every a–j fault boundary, the strict
 * identity-match cleanup rule, and the no-secret evidence invariant.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateG1Gates,
  cleanupAllowed,
  canonicalizeGuid,
  runG1Probe,
  G1ErrorCode,
  type G1AdapterIdentity,
  type G1GateInput,
  type G1ProbeDriver,
  type G1RunOptions
} from '../src/main/tun/g1-probe'
import { createFakeG1Driver } from './g1-probe-fakes'

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z')

function gateEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MURGE_RUN_REAL_TUN: '1',
    MURGE_TUN_ACKNOWLEDGEMENT: 'I AUTHORIZE MURGE G1 WINTUN PROBE',
    MURGE_TUN_LAB_RUNNER: 'murge-tun-lab',
    MURGE_TUN_AUTHORIZATION_REF: 'auth-ref-1',
    MURGE_TUN_TARGET_ASSET_ID: 'asset-1',
    MURGE_TUN_SNAPSHOT_ID: 'snap-1',
    MURGE_TUN_RECOVERY_METHOD: 'recovery-1',
    ...overrides
  }
}

function gatesInput(overrides: Partial<G1GateInput> = {}): G1GateInput {
  return {
    argv: ['--execute-g1-probe'],
    platform: 'win32',
    env: gateEnv(),
    ...overrides
  }
}

function makeOpts(gatesAllowed = true): G1RunOptions {
  return {
    gates: { allowed: gatesAllowed, deniedReason: gatesAllowed ? null : 'test denial' },
    identifiers: {
      authorizationRef: 'auth-ref-1',
      targetAssetId: 'asset-1',
      snapshotId: 'snap-1',
      recoveryMethod: 'recovery-1'
    },
    target: { name: 'ProductTunProbeTemp', requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd' },
    tunnelType: 'WireGuard',
    reuseTimeoutMs: 20_000,
    now: () => FIXED_NOW
  }
}

describe('evaluateG1Gates', () => {
  it('allows only when every gate is satisfied', () => {
    expect(evaluateG1Gates(gatesInput()).allowed).toBe(true)
  })

  it.each([
    ['missing --execute-g1-probe flag', { argv: [] }, 'missing --execute-g1-probe'],
    ['non-win32 platform', { platform: 'linux' }, 'not-win32'],
    ['MURGE_RUN_REAL_TUN != 1', { env: gateEnv({ MURGE_RUN_REAL_TUN: '0' }) }, 'MURGE_RUN_REAL_TUN != 1'],
    ['missing MURGE_RUN_REAL_TUN', { env: gateEnv({ MURGE_RUN_REAL_TUN: undefined }) }, 'MURGE_RUN_REAL_TUN != 1'],
    ['missing exact ack', { env: gateEnv({ MURGE_TUN_ACKNOWLEDGEMENT: 'nope' }) }, 'missing exact G1 acknowledgement'],
    ['not the protected lab', { env: gateEnv({ MURGE_TUN_LAB_RUNNER: 'ubuntu-latest' }) }, 'not the murge-tun-lab self-hosted lab'],
    ['invalid authorizationRef', { env: gateEnv({ MURGE_TUN_AUTHORIZATION_REF: 'bad id!' }) }, 'invalid authorizationRef'],
    ['invalid targetAssetId', { env: gateEnv({ MURGE_TUN_TARGET_ASSET_ID: '' }) }, 'invalid targetAssetId'],
    ['invalid snapshotId', { env: gateEnv({ MURGE_TUN_SNAPSHOT_ID: '..' }) }, 'invalid snapshotId'],
    ['invalid recoveryMethod', { env: gateEnv({ MURGE_TUN_RECOVERY_METHOD: undefined }) }, 'invalid recoveryMethod']
  ])('denies on %s', (_name, over, reason) => {
    const input = gatesInput(over as Partial<G1GateInput>)
    const result = evaluateG1Gates(input)
    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe(reason)
  })

  it('is pure: never touches env/argv objects passed in', () => {
    const argv = ['--execute-g1-probe']
    const env = gateEnv()
    evaluateG1Gates({ argv, platform: 'win32', env })
    expect(argv).toEqual(['--execute-g1-probe'])
  })
})

describe('canonicalizeGuid', () => {
  it('canonicalizes a valid GUID to lowercase', () => {
    expect(canonicalizeGuid('01234567-89AB-4CDE-8F01-23456789ABCD')).toBe('01234567-89ab-4cde-8f01-23456789abcd')
  })
  it('rejects malformed or non-canonical GUIDs', () => {
    expect(canonicalizeGuid('not-a-guid')).toBeNull()
    expect(canonicalizeGuid('01234567-89ab-4cde-8f01-23456789abc')).toBeNull()
    expect(canonicalizeGuid('01234567-89ab-6cde-8f01-23456789abcd')).toBeNull() // version 6 not valid for Wintun
    expect(canonicalizeGuid('01234567-89ab-4cde-7f01-23456789abcd')).toBeNull() // variant 7 invalid
  })
})

describe('cleanupAllowed', () => {
  const recorded: G1AdapterIdentity = {
    name: 'ProductTunProbeTemp',
    requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
    canonicalLuid: '0x1234567890abcdef'
  }
  it('matches when Name + GUID + LUID all agree (GUID case-insensitive)', () => {
    const live = { ...recorded, requestedGuid: recorded.requestedGuid.toUpperCase() }
    expect(cleanupAllowed(live, recorded)).toBe(true)
  })
  it('rejects a same-name but different-GUID adapter (never deletes a stranger)', () => {
    expect(cleanupAllowed({ ...recorded, requestedGuid: '11111111-2222-4333-8444-555555555555' }, recorded)).toBe(false)
  })
  it('rejects a same-name+guid but different-LUID adapter', () => {
    expect(cleanupAllowed({ ...recorded, canonicalLuid: '0xffffffffffffffff' }, recorded)).toBe(false)
  })
  it('rejects when either side is missing', () => {
    expect(cleanupAllowed(null, recorded)).toBe(false)
    expect(cleanupAllowed(recorded, null)).toBe(false)
    expect(cleanupAllowed(null, null)).toBe(false)
  })
})

describe('runG1Probe', () => {
  it('returns a gate-denied record immediately, calling NO driver primitive', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts(false))
    expect(evidence.probeExecuted).toBe(false)
    expect(evidence.errorCode).toBe(G1ErrorCode.gateDenied)
    expect(state.calls).toEqual([]) // zero side effects
  })

  it('runs the a–j lifecycle to completion (Observed A) when everything matches', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.probeExecuted).toBe(true)
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.observed).toBe('A')
    expect(evidence.adapterGone).toBe(true)
    expect(evidence.creatorHandleClosed).toBe(true)
    expect(evidence.cleanupSucceeded).toBe(true)
    expect(evidence.networkUnchanged).toBe(true)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.pinnedWintunVersion).toBe('0.14.1')
    expect(evidence.adapterName).toBe('ProductTunProbeTemp')
    expect(evidence.mihomoReusedSameGuidLuid).toBe(true)
    expect(evidence.canonicalLuid).toBe('0x1234567890abcdef')
    expect(evidence.authorizationRef).toBe('auth-ref-1')

    // strict a–j order (finally still records cleanup + a second snapshot)
    const calls = state.calls
    const order = ['loadPinnedWintun', 'createAdapter', 'readAdapterIdentity', 'startMihomoProbe', 'matchingAdapterCount', 'pollMihomoReuse', 'stopMihomoProbe', 'closeCreatorHandle', 'adapterStillPresent', 'liveAdapterIdentity', 'cleanup']
    let lastIdx = -1
    for (const name of order) {
      const idx = calls.indexOf(name)
      expect(idx).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('records Observed B when the adapter survives the creator-handle close', async () => {
    const { driver } = createFakeG1Driver({ adapterStillPresent: true })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.observed).toBe('B')
    expect(evidence.adapterGone).toBe(false)
  })

  it('fails closed on a DLL hash mismatch BEFORE the loader is reached (no adapter, no mihomo)', async () => {
    const { driver, state } = createFakeG1Driver({ dllVerified: false, dllDigest: 'b2'.repeat(32) })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.dllHashMismatch)
    expect(evidence.wintunDllSha256Verified).toBe(false)
    expect(evidence.probeExecuted).toBe(true)
    // No adapter was ever created and mihomo was never started.
    expect(state.createdTarget).toBeNull()
    expect(state.mihomoStarted).toBe(false)
    // But the finally-cleanup still ran.
    expect(state.cleanupCalled).toBe(true)
    expect(state.cleanupMatch).toBe(false)
  })

  it('fails with conflict-duplicate when more than one matching adapter exists', async () => {
    const { driver } = createFakeG1Driver({ matchingCount: 2 })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.conflictDuplicate)
  })

  it('fails with g1-failed when zero matching adapters exist', async () => {
    const { driver } = createFakeG1Driver({ matchingCount: 0 })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.g1Failed)
  })

  it('fails with g1-failed (never dual-owns) when mihomo does not reuse the same adapter', async () => {
    const { driver, state } = createFakeG1Driver({ reuse: false })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.g1Failed)
    // mihomo was never given the chance to create a second adapter: single create.
    expect(state.createdTarget).not.toBeNull()
  })

  it('flags network mutation when the after snapshot differs from before', async () => {
    const { driver } = createFakeG1Driver({ networkAfterChanged: true })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.networkUnchanged).toBe(false)
    expect(evidence.errorCode).toBe(G1ErrorCode.networkMutated)
  })

  it('never writes a secret into the evidence blob', async () => {
    const { driver } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts())
    const blob = JSON.stringify(evidence)
    for (const forbidden of ['Bearer', 'subscription', 'SECRET', 'token=', 'controller', 'private-key']) {
      expect(blob.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('runG1Probe fault injection', () => {
  // For each a–j boundary we throw, assert the orchestrator always reaches the
  // finally-cleanup and records a fail-closed terminal code.
  const cases: Array<[keyof G1ProbeDriver, string]> = [
    ['loadPinnedWintun', G1ErrorCode.crash],
    ['createAdapter', G1ErrorCode.crash],
    ['startMihomoProbe', G1ErrorCode.crash],
    ['matchingAdapterCount', G1ErrorCode.crash],
    ['pollMihomoReuse', G1ErrorCode.crash],
    ['stopMihomoProbe', G1ErrorCode.crash],
    ['closeCreatorHandle', G1ErrorCode.crash],
    ['adapterStillPresent', G1ErrorCode.crash]
  ]

  it.each(cases)('fault at %s still runs cleanup and fails closed (%s)', async (faultAt, expected) => {
    const { driver, state } = createFakeG1Driver({ faultAt })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.probeExecuted).toBe(true)
    expect(evidence.errorCode).toBe(expected)
    expect(state.cleanupCalled).toBe(true)
    expect(state.calls).toContain('cleanup')
  })

  it('fails closed to identity-conflict when the live identity cannot be confirmed as ours', async () => {
    // A fault after creation leaves the creator handle open; the live identity no
    // longer matches the recorded one, so the probe refuses to delete it.
    const liveIdentity: G1AdapterIdentity = {
      name: 'ProductTunProbeTemp',
      requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
      canonicalLuid: '0xdeadbeefdeadbeef'
    }
    const { driver, state } = createFakeG1Driver({ faultAt: 'pollMihomoReuse', liveIdentity })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.identityConflict)
    expect(state.cleanupMatch).toBe(false) // we did NOT tear down a mismatched adapter
    expect(evidence.cleanupSucceeded).toBe(false)
  })

  it('fails closed to crash when the created adapter identity could never be read', async () => {
    const { driver, state } = createFakeG1Driver({ faultAt: 'readAdapterIdentity' })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.identityConflict)
    // We refuse to delete an adapter whose identity we could not confirm.
    expect(state.cleanupMatch).toBe(false)
    expect(evidence.cleanupSucceeded).toBe(false)
  })
})
