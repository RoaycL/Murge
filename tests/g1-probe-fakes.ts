/**
 * Test double for the G1 probe driver. Lets the pure orchestrator
 * (`src/main/tun/g1-probe.ts`) be exercised with deterministic, zero-side-effect
 * behavior and fault injection at any a–j boundary.
 */

import type {
  G1AdapterIdentity,
  G1NetworkSnapshot,
  G1ProbeDriver,
  G1ProbeIdentityTarget,
  G1ReuseResult
} from '../src/main/tun/g1-probe'

export interface FakeG1ProbeOptions {
  architecture?: string
  pid?: number
  identity?: G1AdapterIdentity
  /** Passed to loadPinnedWintun (default verified:true). */
  dllVerified?: boolean
  dllDigest?: string
  /** Returned by matchingAdapterCount (default 1). */
  matchingCount?: number
  /** Returned by pollMihomoReuse (default true). */
  reuse?: boolean
  /** Returned by startMihomoProbe / pollMihomoReuse pid (default 777). */
  mihomoPid?: number
  /** Returned by adapterStillPresent (default false => adapter gone). */
  adapterStillPresent?: boolean
  /** Override the identity read back by liveAdapterIdentity (default = identity). */
  liveIdentity?: G1AdapterIdentity | null
  /** If true, the second network snapshot differs from the first => networkMutated. */
  networkAfterChanged?: boolean
  /** Throw here (on the first call of that method) to fault-inject a boundary. */
  faultAt?: keyof G1ProbeDriver
  error?: Error
}

const DEFAULT_IDENTITY: G1AdapterIdentity = {
  name: 'ProductTunProbeTemp',
  requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
  canonicalLuid: '0x1234567890abcdef'
}

const SNAP: G1NetworkSnapshot = { route: 'stable', dns: 'stable', proxy: 'stable' }

export interface FakeG1ProbeResult {
  driver: G1ProbeDriver
  state: {
    calls: string[]
    createdTarget: G1ProbeIdentityTarget & { tunnelType: string } | null
    creatorOpen: boolean
    creatorClosed: boolean
    mihomoStarted: boolean
    mihomoStopped: boolean
    cleanupMatch: boolean | null
    cleanupCalled: boolean
  }
}

export function createFakeG1Driver(opts: FakeG1ProbeOptions = {}): FakeG1ProbeResult {
  const identity = opts.identity ?? DEFAULT_IDENTITY
  const state: FakeG1ProbeResult['state'] = {
    calls: [],
    createdTarget: null,
    creatorOpen: false,
    creatorClosed: false,
    mihomoStarted: false,
    mihomoStopped: false,
    cleanupMatch: null,
    cleanupCalled: false
  }

  const record = (name: string): void => {
    state.calls.push(name)
    if (opts.faultAt === name) {
      throw opts.error ?? new Error(`fault injected at ${name}`)
    }
  }

  let snapCount = 0

  const driver: G1ProbeDriver = {
    architecture: opts.architecture ?? 'x64',
    pid: opts.pid ?? 123,

    async loadPinnedWintun() {
      record('loadPinnedWintun')
      return { verified: opts.dllVerified ?? true, digest: opts.dllDigest ?? 'a1'.repeat(32) }
    },

    async createAdapter(target: G1ProbeIdentityTarget & { tunnelType: string }) {
      record('createAdapter')
      state.createdTarget = target
      state.creatorOpen = true
    },

    async readAdapterIdentity() {
      record('readAdapterIdentity')
      return identity
    },

    async liveAdapterIdentity() {
      record('liveAdapterIdentity')
      if (!state.creatorOpen) return null
      if (opts.liveIdentity === undefined) return identity
      return opts.liveIdentity
    },

    async startMihomoProbe() {
      record('startMihomoProbe')
      state.mihomoStarted = true
      return opts.mihomoPid ?? 777
    },

    async matchingAdapterCount() {
      record('matchingAdapterCount')
      return opts.matchingCount ?? 1
    },

    async pollMihomoReuse() {
      record('pollMihomoReuse')
      const reuse: G1ReuseResult = { reused: opts.reuse ?? true, pid: opts.mihomoPid ?? 777 }
      return reuse
    },

    async stopMihomoProbe() {
      record('stopMihomoProbe')
      state.mihomoStopped = true
    },

    async closeCreatorHandle() {
      record('closeCreatorHandle')
      state.creatorClosed = true
      state.creatorOpen = false
    },

    async adapterStillPresent() {
      record('adapterStillPresent')
      return opts.adapterStillPresent ?? false
    },

    async cleanup(identityMatch: boolean) {
      record('cleanup')
      state.cleanupMatch = identityMatch
      state.cleanupCalled = true
      if (identityMatch && state.creatorOpen) {
        state.creatorOpen = false
        state.creatorClosed = true
      }
    },

    async captureNetworkSnapshot() {
      record('captureNetworkSnapshot')
      snapCount += 1
      if (snapCount === 1) return SNAP
      if (opts.networkAfterChanged) return { ...SNAP, route: 'CHANGED' }
      return SNAP
    },

    networkDiff(before: G1NetworkSnapshot, after: G1NetworkSnapshot) {
      return JSON.stringify(before) === JSON.stringify(after) ? [] : Object.keys(after)
    }
  }

  return { driver, state }
}
