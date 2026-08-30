/**
 * Test double for the G1 probe driver. Lets the pure orchestrator
 * (`src/main/tun/g1-probe.ts`) be exercised with deterministic, zero-side-effect
 * behavior and fault injection at any a–j boundary.
 */

import type {
  G1AdapterIdentity,
  G1ConflictReport,
  G1NetworkSnapshot,
  G1OpaqueHandle,
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
  /** Returned by pollMihomoReuse (default a reused, active, same-GUID/LUID session). */
  reuse?: boolean
  mihomoPid?: number
  /** Returned by adapterStillPresent (default false => adapter gone). */
  adapterStillPresent?: boolean
  /** Returned by mihomoSessionActive (default true). */
  mihomoSessionActive?: boolean
  /** Returned by mihomoStillBoundTo (default true). */
  mihomoStillBoundTo?: boolean
  /** Returned by the conflict preflight (default no conflict). */
  preflightConflict?: G1ConflictReport
  /** Override the identity read back by liveAdapterIdentity (default = identity). */
  liveIdentity?: G1AdapterIdentity | null
  /** If true, the second network snapshot differs from the first => networkMutated. */
  networkAfterChanged?: boolean
  /** Throw here (on the first call of that method) to fault-inject a boundary. */
  faultAt?: keyof G1ProbeDriver
  error?: Error
  /** If set, createAdapter resolves AFTER this many ms (ignoring the abort signal)
   *    so the orchestrator's "operation times out then succeeds late" path can be
   *    exercised — the late handle MUST be reclaimed (P1-1). */
  createAdapterDelayMs?: number
  /** If set, startMihomoProbe resolves AFTER this many ms (ignoring the abort
   *    signal) so a late-spawned mihomo MUST be reclaimed (P1-1). */
  startMihomoDelayMs?: number
  /** If set, stopMihomoProbe resolves AFTER this many ms (ignoring the abort
   *    signal) to exercise a late-stop settlement (P1-1). */
  stopMihomoDelayMs?: number
  /** If set, readAdapterIdentity resolves AFTER this many ms (ignoring the abort
   *    signal) to exercise an identity-read timeout (P1-2). */
  readIdentityDelayMs?: number
  /** Return value of stopMihomoProbe (default true). false = cannot confirm exit. */
  stopMihomoResult?: boolean
}

const DEFAULT_IDENTITY: G1AdapterIdentity = {
  name: 'ProductTunProbeTemp',
  requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd',
  canonicalLuid: '0x1234567890abcdef'
}

const SNAP: G1NetworkSnapshot = {
  winhttpProxy: 'stable',
  internetSettingsProxy: 'stable',
  ipv4DefaultRoute: 'stable',
  ipv6DefaultRoute: 'stable',
  dnsServers: 'stable',
  activeAdapters: 'stable',
  firewallProfiles: 'stable'
}

export interface FakeG1ProbeState {
  calls: string[]
  createdTarget: (G1ProbeIdentityTarget & { tunnelType: string }) | null
  creatorCreated: boolean
  creatorClosed: boolean
  /** The exact opaque handle createAdapter returned. */
  creatorHandle: G1OpaqueHandle | null
  /** Every handle passed to closeCreatorHandle (assert same-handle/at-most-once). */
  closeTargetHandles: G1OpaqueHandle[]
  closeCount: number
  mihomoStarted: boolean
  mihomoStopped: boolean
  mihomoStoppedCount: number
  mihomoPid: number | null
  identity: G1AdapterIdentity | null
  liveReadCount: number
  liveIdentityValue: G1AdapterIdentity | null
  matchingCount: number | null
  mihomoSessionActiveValue: boolean | null
  mihomoStillBoundToValue: boolean | null
  adapterStillPresentValue: boolean | null
  preflightConflictValue: G1ConflictReport
  snapshotCount: number
}

export interface FakeG1ProbeResult {
  driver: G1ProbeDriver
  state: FakeG1ProbeState
}

export function createFakeG1Driver(opts: FakeG1ProbeOptions = {}): FakeG1ProbeResult {
  const identity = opts.identity ?? DEFAULT_IDENTITY
  const state: FakeG1ProbeState = {
    calls: [],
    createdTarget: null,
    creatorCreated: false,
    creatorClosed: false,
    creatorHandle: null,
    closeTargetHandles: [],
    closeCount: 0,
    mihomoStarted: false,
    mihomoStopped: false,
    mihomoStoppedCount: 0,
    mihomoPid: null,
    identity: null,
    liveReadCount: 0,
    liveIdentityValue: identity,
    matchingCount: null,
    mihomoSessionActiveValue: null,
    mihomoStillBoundToValue: null,
    adapterStillPresentValue: null,
    preflightConflictValue: {
      conflict: false,
      reason: null,
      sameNameCount: 0,
      sameGuidCount: 0,
      namePrefixCount: 0,
      leftoverProbeResources: 0
    },
    snapshotCount: 0
  }

  const record = (name: string): void => {
    state.calls.push(name)
    if (opts.faultAt === name) {
      throw opts.error ?? new Error(`fault injected at ${name}`)
    }
  }

  // Honor the delay option by ignoring any abort signal, simulating an operation
  // that does not respond to cancellation but eventually settles (P1-1 late path).
  const waitMs = (delayMs: number | undefined): Promise<void> => {
    if (!delayMs || delayMs <= 0) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  const driver: G1ProbeDriver = {
    architecture: opts.architecture ?? 'x64',
    pid: opts.pid ?? 123,

    async preflightConflictCheck(target: G1ProbeIdentityTarget): Promise<G1ConflictReport> {
      record('preflightConflictCheck')
      void target
      const report = opts.preflightConflict ?? state.preflightConflictValue
      state.preflightConflictValue = report
      return report
    },

    async loadPinnedWintun(): Promise<{ verified: boolean; digest: string }> {
      record('loadPinnedWintun')
      return { verified: opts.dllVerified ?? true, digest: opts.dllDigest ?? 'a1'.repeat(32) }
    },

    async createAdapter(
      target: G1ProbeIdentityTarget & { tunnelType: string },
      _signal?: AbortSignal
    ): Promise<G1OpaqueHandle> {
      record('createAdapter')
      // Deliberately ignore signal: the abort only stops the orchestrator's wait,
      // not the underlying op (P1-1). The late handle must still be reclaimed.
      await waitMs(opts.createAdapterDelayMs)
      state.createdTarget = target
      state.creatorCreated = true
      const handle: G1OpaqueHandle = { __g1OpaqueHandle: 'wintun-adapter' }
      state.creatorHandle = handle
      return handle
    },

    async readAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity> {
      record('readAdapterIdentity')
      // A delayed read that ignores the abort signal: it is a pure read (no
      // resource is created), so a late resolve is safely ignored (P1-2 timeout).
      await waitMs(opts.readIdentityDelayMs)
      if (handle !== state.creatorHandle) throw new Error('readAdapterIdentity: non-creator handle')
      state.identity = identity
      return identity
    },

    async liveAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity | null> {
      record('liveAdapterIdentity')
      state.liveReadCount += 1
      if (handle !== state.creatorHandle || !state.creatorCreated || state.creatorClosed) return null
      const value = opts.liveIdentity === undefined ? identity : opts.liveIdentity
      state.liveIdentityValue = value
      return value
    },

    async startMihomoProbe(_identity: G1AdapterIdentity, _signal?: AbortSignal): Promise<{ pid: number }> {
      record('startMihomoProbe')
      await waitMs(opts.startMihomoDelayMs)
      state.mihomoStarted = true
      state.mihomoPid = opts.mihomoPid ?? 777
      return { pid: state.mihomoPid }
    },

    async matchingAdapterCount(_identity: G1AdapterIdentity): Promise<number> {
      record('matchingAdapterCount')
      const count = opts.matchingCount ?? 1
      state.matchingCount = count
      return count
    },

    async pollMihomoReuse(_identity: G1AdapterIdentity, _timeoutMs: number): Promise<G1ReuseResult> {
      record('pollMihomoReuse')
      const reuse = opts.reuse ?? true
      const sessionActive = reuse
      const sameGuidLuid = reuse
      state.mihomoSessionActiveValue = sessionActive
      state.mihomoStillBoundToValue = sameGuidLuid
      return {
        reused: reuse,
        pid: opts.mihomoPid ?? 777,
        sessionActive,
        sameGuidLuid
      }
    },

    async stopMihomoProbe(_timeoutMs: number, _signal?: AbortSignal): Promise<boolean> {
      record('stopMihomoProbe')
      await waitMs(opts.stopMihomoDelayMs)
      state.mihomoStoppedCount += 1
      if (opts.stopMihomoResult === false) {
        // Cannot confirm the process exited: leave it marked running.
        return false
      }
      state.mihomoStopped = true
      state.mihomoStarted = false
      return true
    },

    async closeCreatorHandle(handle: G1OpaqueHandle, _signal?: AbortSignal): Promise<void> {
      record('closeCreatorHandle')
      state.closeCount += 1
      state.closeTargetHandles.push(handle)
      if (handle !== state.creatorHandle) {
        throw new Error('closeCreatorHandle received a non-creator handle')
      }
      state.creatorClosed = true
      state.creatorCreated = false
    },

    async adapterStillPresent(_identity: G1AdapterIdentity): Promise<boolean> {
      record('adapterStillPresent')
      const value = opts.adapterStillPresent ?? false
      state.adapterStillPresentValue = value
      return value
    },

    async mihomoSessionActive(): Promise<boolean> {
      record('mihomoSessionActive')
      const value = opts.mihomoSessionActive ?? true
      state.mihomoSessionActiveValue = value
      return value
    },

    async mihomoStillBoundTo(_identity: G1AdapterIdentity): Promise<boolean> {
      record('mihomoStillBoundTo')
      const value = opts.mihomoStillBoundTo ?? true
      state.mihomoStillBoundToValue = value
      return value
    },

    async captureNetworkSnapshot(): Promise<G1NetworkSnapshot> {
      record('captureNetworkSnapshot')
      state.snapshotCount += 1
      if (state.snapshotCount === 1) return SNAP
      if (opts.networkAfterChanged) return { ...SNAP, ipv4DefaultRoute: 'CHANGED' }
      return SNAP
    },

    networkDiff(before: G1NetworkSnapshot, after: G1NetworkSnapshot): string[] {
      record('networkDiff')
      return JSON.stringify(before) === JSON.stringify(after) ? [] : ['networkChanged']
    }
  }

  return { driver, state }
}
