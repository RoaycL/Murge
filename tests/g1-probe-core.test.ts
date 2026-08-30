/**
 * Unit tests for the G1 probe core (`src/main/tun/g1-probe.ts`).
 *
 * These are pure, zero-side-effect tests against a fake driver: no Wintun DLL is
 * loaded, no mihomo is spawned and no OS/network API is touched. They cover every
 * hard gate denial, the a–j success path, the corrected observation order, the
 * exact-creator-handle cleanup contract (P1-2), the read-only conflict preflight
 * (P1-6), accurate error-code mapping (P1-7) and every a–j fault boundary (P1-5).
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

describe('runG1Probe gate denial', () => {
  it('returns gateDenied immediately, with no driver primitive touched', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts(false))
    expect(evidence.probeExecuted).toBe(false)
    expect(evidence.errorCode).toBe(G1ErrorCode.gateDenied)
    expect(state.calls).toEqual([])
    expect(state.creatorCreated).toBe(false)
    expect(state.mihomoStarted).toBe(false)
  })
})

describe('runG1Probe hard gates', () => {
  it('aborts before load/creation when the pinned DLL digest does not verify', async () => {
    const { driver, state } = createFakeG1Driver({ dllVerified: false })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.dllHashMismatch)
    expect(evidence.probeExecuted).toBe(true)
    expect(evidence.wintunDllSha256Verified).toBe(false)
    expect(state.createdTarget).toBeNull()
    expect(state.creatorCreated).toBe(false)
    expect(state.mihomoStarted).toBe(false)
    expect(evidence.cleanupSucceeded).toBeNull()
  })

  it('aborts with zero change on a read-only conflict preflight BEFORE any creation', async () => {
    const { driver, state } = createFakeG1Driver({
      preflightConflict: {
        conflict: true,
        reason: 'same-name adapter present',
        sameNameCount: 1,
        sameGuidCount: 0,
        namePrefixCount: 0,
        leftoverProbeResources: 0
      }
    })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.conflictPreflight)
    expect(evidence.conflictReason).toBe('same-name adapter present')
    expect(evidence.probeExecuted).toBe(true)
    expect(state.createdTarget).toBeNull()
    expect(state.creatorCreated).toBe(false)
    expect(state.mihomoStarted).toBe(false)
    expect(state.calls).not.toContain('createAdapter')
    expect(evidence.cleanupSucceeded).toBeNull()
  })
})

describe('runG1Probe a–j success path', () => {
  it('runs the corrected observation order (preflight -> create -> observe-after-close -> teardown)', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts())

    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.probeExecuted).toBe(true)

    // The preflight check precedes creation, and the final capture+diff runs once.
    expect(state.calls[0]).toBe('captureNetworkSnapshot')
    expect(state.createdTarget?.name).toBe('ProductTunProbeTemp')

    // Relative order of every distinct boundary in one pass.
    const order = [
      'preflightConflictCheck',
      'loadPinnedWintun',
      'createAdapter',
      'readAdapterIdentity',
      'startMihomoProbe',
      'matchingAdapterCount',
      'pollMihomoReuse',
      'closeCreatorHandle',
      'adapterStillPresent',
      'mihomoSessionActive',
      'mihomoStillBoundTo',
      'stopMihomoProbe',
      'liveAdapterIdentity',
      'networkDiff'
    ]
    const idx = order.map((name) => state.calls.indexOf(name))
    expect(idx.every((i) => i >= 0)).toBe(true)
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1])
    }
  })

  it('closes the EXACT handle create returned, exactly once, and never double-closes', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    // The handle closed at step (g) is the very handle createAdapter returned.
    expect(state.closeTargetHandles).toHaveLength(1)
    expect(state.closeTargetHandles[0]).toBe(state.creatorHandle)
    expect(state.closeCount).toBe(1)
    // The finally teardown must NOT re-close an already-closed handle.
    expect(evidence.creatorHandleClosed).toBe(true)
    expect(state.creatorClosed).toBe(true)
  })

  it('records Observed A when the adapter is gone after the creator handle close', async () => {
    const { driver, state } = createFakeG1Driver({ adapterStillPresent: false })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.observed).toBe('A')
    expect(evidence.adapterGone).toBe(true)
  })

  it('records Observed B only when creator closed AND session still active AND same GUID+LUID', async () => {
    const { driver, state } = createFakeG1Driver({ adapterStillPresent: true })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.observed).toBe('B')
    expect(evidence.adapterGone).toBe(false)
    expect(evidence.creatorHandleClosed).toBe(true)
    expect(evidence.mihomoSessionActiveAfterClose).toBe(true)
    expect(evidence.mihomoStillSameGuidLuidAfterClose).toBe(true)
    // The finally teardown still succeeds: mihomo was reached and stopped, the
    // creator handle is closed, and the (isolated) adapter surviving does not
    // change the cleanup verdict.
    expect(evidence.cleanupSucceeded).toBe(true)
  })

  it('rejects Observed B when the session is no longer active after the close', async () => {
    const { driver, state } = createFakeG1Driver({
      adapterStillPresent: true,
      mihomoSessionActive: false
    })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.observed).toBe('A')
    expect(evidence.adapterGone).toBe(false)
    expect(evidence.mihomoSessionActiveAfterClose).toBe(false)
  })

  it('rejects Observed B when mihomo is no longer bound to the same GUID+LUID', async () => {
    const { driver, state } = createFakeG1Driver({
      adapterStillPresent: true,
      mihomoStillBoundTo: false
    })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.observed).toBe('A')
    expect(evidence.mihomoStillSameGuidLuidAfterClose).toBe(false)
    expect(evidence.mihomoReusedSameGuidLuid).toBe(true)
  })
})

describe('runG1Probe conflict and failure codes', () => {
  it('fails closed to conflictDuplicate when more than one matching adapter exists', async () => {
    const { driver, state } = createFakeG1Driver({ matchingCount: 2 })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.conflictDuplicate)
    expect(evidence.matchingAdapterCount).toBe(2)
    // The finally still tears down: the adapter we created is safe to close.
    expect(state.closeTargetHandles[0]).toBe(state.creatorHandle)
    expect(evidence.cleanupSucceeded).toBe(true)
  })

  it('fails closed to g1Failed with zero matching adapters', async () => {
    const { driver, state } = createFakeG1Driver({ matchingCount: 0 })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.g1Failed)
    expect(evidence.matchingAdapterCount).toBe(0)
    expect(evidence.cleanupSucceeded).toBe(true)
  })

  it('fails closed to g1Failed when mihomo does not reuse the SAME adapter with a live session', async () => {
    const { driver, state } = createFakeG1Driver({ reuse: false })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.g1Failed)
    expect(evidence.mihomoReusedSameGuidLuid).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.cleanupSucceeded).toBe(true)
  })
})

describe('runG1Probe identity-conflict cleanup rule (P1-2 / P1-5)', () => {
  it('refuses to tear down when the live identity no longer matches our recorded one', async () => {
    const mismatch: G1AdapterIdentity = {
      name: 'ForeignAdapter',
      requestedGuid: '00000000-0000-0000-0000-000000000000',
      canonicalLuid: '0x0'
    }
    const { driver, state } = createFakeG1Driver({ faultAt: 'pollMihomoReuse', liveIdentity: mismatch })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.identityConflict)
    // We did NOT delete an adapter we could not prove is ours.
    expect(state.closeTargetHandles).toHaveLength(0)
    expect(state.creatorClosed).toBe(false)
    expect(evidence.cleanupSucceeded).toBe(false)
  })

  it('fails closed when the created adapter identity could never be read', async () => {
    const { driver, state } = createFakeG1Driver({ faultAt: 'readAdapterIdentity' })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.identityConflict)
    // We refuse to delete an adapter whose identity we could not confirm.
    expect(state.closeTargetHandles).toHaveLength(0)
    expect(state.creatorClosed).toBe(false)
    expect(evidence.cleanupSucceeded).toBe(false)
  })
})

describe('runG1Probe network snapshot diff', () => {
  it('reports networkMutated when the post-run snapshot differs from the baseline', async () => {
    const { driver, state } = createFakeG1Driver({ networkAfterChanged: true })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.networkMutated)
    expect(evidence.probeExecuted).toBe(true)
  })

  it('leaves the diff unverifiable (null) when the snapshot helper faults', async () => {
    const { driver, state } = createFakeG1Driver({ faultAt: 'captureNetworkSnapshot' })
    const evidence = await runG1Probe(driver, makeOpts())
    // A snapshot fault never fails the probe: it merely records that the network
    // diff could not be verified.
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.probeExecuted).toBe(true)
    expect(evidence.networkUnchanged).toBeNull()
  })
})

describe('runG1Probe fault boundaries (P1-5 residual-process + accurate codes)', () => {
  const preCreation: Array<[keyof G1ProbeDriver, G1ErrorCode]> = [
    ['preflightConflictCheck', G1ErrorCode.crash],
    ['loadPinnedWintun', G1ErrorCode.crash],
    ['createAdapter', G1ErrorCode.crash],
    ['readAdapterIdentity', G1ErrorCode.identityConflict],
    ['startMihomoProbe', G1ErrorCode.crash],
    ['matchingAdapterCount', G1ErrorCode.crash],
    ['pollMihomoReuse', G1ErrorCode.crash],
    ['stopMihomoProbe', G1ErrorCode.crash],
    ['closeCreatorHandle', G1ErrorCode.crash],
    ['adapterStillPresent', G1ErrorCode.crash],
    ['mihomoSessionActive', G1ErrorCode.crash],
    ['mihomoStillBoundTo', G1ErrorCode.crash]
  ]

  it.each(preCreation)('survives a fault at %s with probeExecuted:true and an accurate code', async (faultAt, expected) => {
    const { driver, state } = createFakeG1Driver({ faultAt })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(expected)
    expect(evidence.probeExecuted).toBe(true)
    // The finally teardown always finishes by re-snapshoting the read-only diff.
    expect(state.calls).toContain('captureNetworkSnapshot')
  })

  it('throws no residual mihomo after every fault boundary that follows startMihomoProbe', async () => {
    const postStart: Array<keyof G1ProbeDriver> = [
      'startMihomoProbe',
      'matchingAdapterCount',
      'pollMihomoReuse',
      'closeCreatorHandle',
      'adapterStillPresent',
      'mihomoSessionActive',
      'mihomoStillBoundTo'
    ]
    for (const faultAt of postStart) {
      const { driver, state } = createFakeG1Driver({ faultAt })
      const evidence = await runG1Probe(driver, makeOpts())
      // The orchestrator MUST have attempted the bounded mihomo stop in the finally
      // for every boundary after the mihomo process was (or may have been) started.
      expect(state.calls, faultAt as string).toContain('stopMihomoProbe')
      expect(state.mihomoStopped, faultAt as string).toBe(true)
      expect(evidence.probeExecuted, faultAt as string).toBe(true)
    }
  })

  it('closes the creator handle once in the finally after a post-create mid-sequence fault', async () => {
    const { driver, state } = createFakeG1Driver({ faultAt: 'matchingAdapterCount' })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.crash)
    // Step (g) never ran, so the finally must perform the single exact close.
    expect(state.closeTargetHandles).toHaveLength(1)
    expect(state.closeTargetHandles[0]).toBe(state.creatorHandle)
    expect(state.closeCount).toBe(1)
    expect(evidence.cleanupSucceeded).toBe(true)
  })

  it('degrades gracefully when the live-identity read itself faults', async () => {
    const { driver, state } = createFakeG1Driver({ faultAt: 'liveAdapterIdentity' })
    const evidence = await runG1Probe(driver, makeOpts())
    expect(evidence.errorCode).toBe(G1ErrorCode.none)
    expect(evidence.probeExecuted).toBe(true)
    // In this path the handle was already closed at step (g), so a failed live
    // re-read cannot create a leftover adapter.
    expect(evidence.cleanupSucceeded).toBe(true)
  })
})

describe('runG1Probe evidence invariants', () => {
  it('never leaks a secret-like value into the rendered evidence', async () => {
    const { driver, state } = createFakeG1Driver()
    const evidence = await runG1Probe(driver, makeOpts())
    const rendered = JSON.stringify(evidence)
    expect(rendered).not.toMatch(/[A-Z0-9]{32,}/)
    expect(rendered).not.toContain('I AUTHORIZE MURGE G1 WINTUN PROBE')
    expect(rendered).not.toContain('I AUTHORIZE')
  })
})

describe('cleanupAllowed', () => {
  it('requires a non-null live identity to match an existing recorded one', () => {
    const identity: G1AdapterIdentity = {
      name: 'ProductTunProbeTemp',
      requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
      canonicalLuid: '0x1234567890abcdef'
    }
    expect(cleanupAllowed(identity, identity)).toBe(true)
    expect(cleanupAllowed(identity, null)).toBe(false)
    expect(cleanupAllowed(null, identity)).toBe(false)
    expect(cleanupAllowed(null, null)).toBe(false)
  })
})

describe('canonicalizeGuid', () => {
  it('lowercases and strips braces', () => {
    expect(canonicalizeGuid('{01234567-89AB-4CDE-8F01-23456789ABCD}')).toBe('01234567-89ab-4cde-8f01-23456789abcd')
  })
})
