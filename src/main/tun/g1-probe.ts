/**
 * G1 probe execution body + test frameworks — the pure, driver-driven core.
 *
 * This module implements the Windows G1 lifecycle probe as a **sequence of
 * injected driver steps** (a–j) with zero OS side effects of its own. The
 * driver (`g1-driver.ts`) supplies the Wintun / mihomo / network primitives and
 * is what a test fakes. Everything here is platform-neutral and never blocks:
 * the default `npm test` / `npm run build` / app start / preload / IPC paths
 * never import this module (a static isolation test enforces it), so the probe
 * can never run on the Linux/Mac dev host or in normal CI.
 *
 * Hard gates (deliverable B) fail closed **before** any driver primitive is
 * called, so no DLL is loaded, no mihomo is spawned and the OS is untouched
 * unless every gate is satisfied.
 *
 * @see docs/helper-design.md §3.3 (G1 ownership probe), §12 (gates)
 */

import { WINTUN_PINNED_VERSION } from './wintun-abi'

/** The reviewer-specified exact acknowledgement that must be supplied to execute G1. */
export const G1_EXACT_ACKNOWLEDGEMENT = 'I AUTHORIZE MURGE G1 WINTUN PROBE' as const

/** The self-hosted Windows lab runner label that alone may execute G1. */
export const G1_LAB_RUNNER = 'murge-tun-lab' as const

/** Safe identifier shape (matches scripts/g1-probe-gate.mjs SAFE_ID). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/

export interface G1GateInput {
  /** Process argv (without node/script). */
  argv: readonly string[]
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

export interface G1GateCheck {
  allowed: boolean
  /** Single machine-readable denial reason, or null when allowed. */
  deniedReason: string | null
}

/**
 * Evaluate every gate that must pass before the probe may touch the OS.
 * Pure: returns a decision, never performs I/O. The checks are ordered so each
 * subsequent check is irrelevant once an earlier one fails (all zero-side-effect).
 */
export function evaluateG1Gates(input: G1GateInput): G1GateCheck {
  if (!input.argv.includes('--execute-g1-probe')) {
    return { allowed: false, deniedReason: 'missing --execute-g1-probe' }
  }
  if (input.platform !== 'win32') {
    return { allowed: false, deniedReason: 'not-win32' }
  }
  if (input.env.MURGE_RUN_REAL_TUN !== '1') {
    return { allowed: false, deniedReason: 'MURGE_RUN_REAL_TUN != 1' }
  }
  if (input.env.MURGE_TUN_ACKNOWLEDGEMENT !== G1_EXACT_ACKNOWLEDGEMENT) {
    return { allowed: false, deniedReason: 'missing exact G1 acknowledgement' }
  }
  if (input.env.MURGE_TUN_LAB_RUNNER !== G1_LAB_RUNNER) {
    return { allowed: false, deniedReason: `not the ${G1_LAB_RUNNER} self-hosted lab` }
  }
  const ids: Array<[string, string | undefined]> = [
    ['authorizationRef', input.env.MURGE_TUN_AUTHORIZATION_REF],
    ['targetAssetId', input.env.MURGE_TUN_TARGET_ASSET_ID],
    ['snapshotId', input.env.MURGE_TUN_SNAPSHOT_ID],
    ['recoveryMethod', input.env.MURGE_TUN_RECOVERY_METHOD]
  ]
  for (const [name, value] of ids) {
    if (!value || !SAFE_ID.test(value)) {
      return { allowed: false, deniedReason: `invalid ${name}` }
    }
  }
  return { allowed: true, deniedReason: null }
}

/** The identity that must match before any Wintun resource may be torn down. */
export interface G1AdapterIdentity {
  name: string
  requestedGuid: string
  canonicalLuid: string
}

/** The intended creation target. The LUID is only discovered at creation. */
export type G1ProbeIdentityTarget = Pick<G1AdapterIdentity, 'name' | 'requestedGuid'>

/**
 * Strict identity match — the ONLY predicate under which the probe may remove
 * or close a Wintun resource. The **current** live identity (read back from the
 * still-open creator handle) must equal the **recorded** creation identity on
 * Name + RequestedGUID + canonical LUID (GUID comparison is case-insensitive;
 * LUID is strict). If either side is missing or any field differs, the resource
 * at that identity is NOT the one we created and the probe refuses to touch it
 * (it records a conflict and never deletes).
 */
export function cleanupAllowed(
  current: G1AdapterIdentity | null,
  recorded: G1AdapterIdentity | null
): boolean {
  if (!current || !recorded) return false
  if (current.name !== recorded.name) return false
  if (current.requestedGuid?.toLowerCase() !== recorded.requestedGuid.toLowerCase()) return false
  if (current.canonicalLuid !== recorded.canonicalLuid) return false
  return true
}

/** Normalize a GUID string to its canonical lowercase form, or null when invalid. */
export function canonicalizeGuid(guid: string): string | null {
  const value = guid.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    return null
  }
  return value
}

/**
 * The set of machine-readable outcomes the probe can record. `none` means the
 * probe ran to completion without an error. Everything else is a fail-closed
 * terminal state whose evidence still carries the full audit trail.
 */
export const G1ErrorCode = {
  none: 'none',
  gateDenied: 'gate-denied',
  dllHashMismatch: 'dll-hash-mismatch',
  unsupported: 'unsupported',
  g1Failed: 'g1-failed',
  conflictDuplicate: 'conflict-duplicate',
  identityConflict: 'identity-conflict',
  orphanAdapter: 'orphan-adapter',
  networkMutated: 'network-mutated',
  timeout: 'timeout',
  crash: 'crash',
  internal: 'internal'
} as const

export type G1ErrorCode = (typeof G1ErrorCode)[keyof typeof G1ErrorCode]

/** A read-only network snapshot (keys are stable, values are comparable strings). */
export type G1NetworkSnapshot = Readonly<Record<string, string>>

/** The result of the mihomo handoff check. */
export interface G1ReuseResult {
  /** True when mihomo opened the same adapter (GUID + LUID all match). */
  reused: boolean
  pid: number
}

/**
 * The injected driver surface. A real driver (`g1-driver.ts`) binds the pinned
 * Wintun ABI; tests supply a fake. None of these methods may be invoked by the
 * orchestrator unless the gates passed.
 */
export interface G1ProbeDriver {
  /** Process architecture tag for evidence (e.g. 'x64', 'arm64'). */
  readonly architecture: string
  /** PID of the probe/helper process for evidence. */
  readonly pid: number

  /** (a) Verify the pinned per-arch wintun.dll SHA-256; only on match load it. */
  loadPinnedWintun(): Promise<{ verified: boolean; digest: string }>

  /** (b) WintunCreateAdapter(Name, TunnelType, RequestedGUID); hold the creator handle. */
  createAdapter(target: G1ProbeIdentityTarget & { tunnelType: string }): Promise<void>

  /** (c) Read the created adapter's Name/GUID/LUID (used as the cleanup identity). */
  readAdapterIdentity(): Promise<G1AdapterIdentity>

  /** Read the identity of the adapter behind the still-open creator handle, or null if none. */
  liveAdapterIdentity(): Promise<G1AdapterIdentity | null>

  /** (d) Spawn the isolated mihomo probe that tries to reuse the same adapter. */
  startMihomoProbe(): Promise<number>

  /** (e) Count adapters matching Name + RequestedGUID + LUID. */
  matchingAdapterCount(identity: G1AdapterIdentity): Promise<number>

  /** (f) Poll until mihomo shows a live session on the same adapter (or times out). */
  pollMihomoReuse(identity: G1AdapterIdentity, timeoutMs: number): Promise<G1ReuseResult>

  /** (g) End the mihomo session and process. */
  stopMihomoProbe(): Promise<void>

  /** (h) Close the probe's own creator handle (removes a CreateAdapter-created adapter). */
  closeCreatorHandle(): Promise<void>

  /** (i) Is the probe-created adapter still present after the creator handle closed? */
  adapterStillPresent(identity: G1AdapterIdentity): Promise<boolean>

  /**
   * finally-cleanup. The orchestrator only triggers a destructive action when
   * `identityMatch` is true (strict Name+GUID+LUID match); otherwise the driver
   * fails closed to a no-op and records the conflict. Never throws.
   */
  cleanup(identityMatch: boolean): Promise<void>

  /** Read-only before/after network snapshot (routes/DNS/proxy/firewall). */
  captureNetworkSnapshot(): Promise<G1NetworkSnapshot>

  /** Compare before/after snapshots. Returns the list of changed field names ([] = unchanged). */
  networkDiff(before: G1NetworkSnapshot, after: G1NetworkSnapshot): string[]
}

/** The full, auditable evidence record. Never contains a secret/subscription/key/user path. */
export interface G1Evidence {
  schemaVersion: 1
  probeExecuted: boolean
  authorizationRef: string
  targetAssetId: string
  snapshotId: string
  recoveryMethod: string
  architecture: string
  pinnedWintunVersion: string
  wintunDllSha256: string
  wintunDllSha256Verified: boolean
  adapterName: string | null
  requestedGuid: string | null
  canonicalLuid: string | null
  helperPid: number | null
  mihomoPid: number | null
  matchingAdapterCount: number | null
  mihomoReusedSameGuidLuid: boolean | null
  observed: 'A' | 'B' | null
  creatorHandleClosed: boolean
  adapterGone: boolean | null
  networkUnchanged: boolean | null
  cleanupSucceeded: boolean | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string
}

interface ProbeState {
  creatorCreated: boolean
  creatorClosed: boolean
  mihomoStarted: boolean
  mihomoStopped: boolean
  identity: G1AdapterIdentity | null
  pid: number | null
}

type EvidenceDraft = Omit<
  G1Evidence,
  | 'schemaVersion'
  | 'probeExecuted'
  | 'authorizationRef'
  | 'targetAssetId'
  | 'snapshotId'
  | 'recoveryMethod'
  | 'architecture'
  | 'pinnedWintunVersion'
  | 'cleanupSucceeded'
  | 'networkUnchanged'
  | 'finishedAt'
>

/**
 * Build a completed evidence record from a draft + the two fields that can only
 * be resolved after cleanup/network comparison. This is the only place evidence
 * fields are assembled, so the shape is always complete and the no-secret
 * invariant holds (the orchestrator never writes the controller secret).
 */
export function buildG1Evidence(
  ids: { authorizationRef: string; targetAssetId: string; snapshotId: string; recoveryMethod: string },
  architecture: string,
  probeExecuted: boolean,
  draft: EvidenceDraft,
  cleanupSucceeded: boolean | null,
  networkUnchanged: boolean | null,
  finishedAt: string
): G1Evidence {
  return {
    schemaVersion: 1,
    probeExecuted,
    authorizationRef: ids.authorizationRef,
    targetAssetId: ids.targetAssetId,
    snapshotId: ids.snapshotId,
    recoveryMethod: ids.recoveryMethod,
    architecture,
    pinnedWintunVersion: WINTUN_PINNED_VERSION,
    wintunDllSha256: draft.wintunDllSha256,
    wintunDllSha256Verified: draft.wintunDllSha256Verified,
    adapterName: draft.adapterName,
    requestedGuid: draft.requestedGuid,
    canonicalLuid: draft.canonicalLuid,
    helperPid: draft.helperPid,
    mihomoPid: draft.mihomoPid,
    matchingAdapterCount: draft.matchingAdapterCount,
    mihomoReusedSameGuidLuid: draft.mihomoReusedSameGuidLuid,
    observed: draft.observed,
    creatorHandleClosed: draft.creatorHandleClosed,
    adapterGone: draft.adapterGone,
    networkUnchanged,
    cleanupSucceeded,
    startedAt: draft.startedAt,
    finishedAt,
    errorCode: draft.errorCode
  }
}

const emptyDraft = (): EvidenceDraft => ({
  wintunDllSha256: '',
  wintunDllSha256Verified: false,
  adapterName: null,
  requestedGuid: null,
  canonicalLuid: null,
  helperPid: null,
  mihomoPid: null,
  matchingAdapterCount: null,
  mihomoReusedSameGuidLuid: null,
  observed: null,
  creatorHandleClosed: false,
  adapterGone: null,
  startedAt: null,
  errorCode: ''
})

export interface G1RunOptions {
  /** Gate decision (from evaluateG1Gates). */
  gates: G1GateCheck
  /** The safety identifiers that must appear in evidence. */
  identifiers: { authorizationRef: string; targetAssetId: string; snapshotId: string; recoveryMethod: string }
  /** The adapter identity target (Name + fixed RequestedGUID + canonical LUID). */
  target: G1ProbeIdentityTarget
  /** The tunnel type string. */
  tunnelType: string
  /** Timeout for the mihomo reuse poll. */
  reuseTimeoutMs: number
  /** Injectable clock for deterministic tests. */
  now?: () => Date
}

/**
 * Run the G1 probe against an injected driver. This is the canonical a–j
 * sequence; it never performs an OS operation itself and it ALWAYS enters the
 * finally-cleanup on any failure, timeout or crash.
 *
 * - Gate denial returns immediately (`probeExecuted:false`) with no driver call.
 * - A DLL hash mismatch is detected *before* the DLL is loaded (a) and aborts.
 * - If mihomo cannot be shown to reuse the SAME adapter (Name+GUID+LUID), the
 *   probe stops with `g1-failed` and never lets mihomo create a second adapter.
 * - Any destructive teardown requires a strict identity match.
 */
export async function runG1Probe(
  driver: G1ProbeDriver,
  opts: G1RunOptions
): Promise<G1Evidence> {
  const now = opts.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const finishedAt = (): string => now().toISOString()

  // Gate denial: return immediately, before any driver primitive (deliverable B).
  if (!opts.gates.allowed) {
    return buildG1Evidence(
      opts.identifiers,
      driver.architecture,
      false,
      { ...emptyDraft(), startedAt, errorCode: G1ErrorCode.gateDenied },
      null,
      null,
      finishedAt()
    )
  }

  const state: ProbeState = {
    creatorCreated: false,
    creatorClosed: false,
    mihomoStarted: false,
    mihomoStopped: false,
    identity: null,
    pid: null
  }
  let adapterGone: boolean | null = null
  let matchingAdapterCount: number | null = null
  let cleanupSucceeded = false
  let networkUnchanged = false
  let errorCode: string = G1ErrorCode.none
  let draft: EvidenceDraft = emptyDraft()

  const networkBefore = await driver.captureNetworkSnapshot()

  try {
    // (a) pinned DLL integrity — verified before the loader is touched.
    const dll = await driver.loadPinnedWintun()
    if (!dll.verified) {
      // Hash mismatch: fail closed, never load the DLL, never create an adapter.
      errorCode = G1ErrorCode.dllHashMismatch
      draft = { ...emptyDraft(), startedAt, wintunDllSha256: dll.digest, wintunDllSha256Verified: false, helperPid: driver.pid, errorCode }
    } else {
      // (b) create the adapter and hold the creator handle.
      await driver.createAdapter({ ...opts.target, tunnelType: opts.tunnelType })
      state.creatorCreated = true

      // (c) read the canonical identity — this becomes the cleanup key.
      const identity = await driver.readAdapterIdentity()
      state.identity = identity

      // (d) spawn the isolated mihomo probe that tries to reuse the same adapter.
      state.mihomoStarted = true
      const mihomoPid = await driver.startMihomoProbe()
      state.pid = mihomoPid

      // (e) exactly one matching adapter must exist, and it must be ours.
      matchingAdapterCount = await driver.matchingAdapterCount(identity)
      if (matchingAdapterCount > 1) {
        errorCode = G1ErrorCode.conflictDuplicate
        throw new Error(`duplicate sibling adapter found (${matchingAdapterCount} matches)`)
      }
      if (matchingAdapterCount !== 1) {
        errorCode = G1ErrorCode.g1Failed
        throw new Error(`expected exactly one matching adapter, saw ${matchingAdapterCount}`)
      }

      // (f) confirm mihomo actually opened/uses the SAME adapter (not a second one).
      const reuse = await driver.pollMihomoReuse(identity, opts.reuseTimeoutMs)
      if (!reuse.reused) {
        // Deliverable A: if mihomo cannot reuse via an explicit supported path, we
        // STOP and report G1 unproven — we never let mihomo create a second adapter.
        errorCode = G1ErrorCode.g1Failed
        throw new Error('mihomo did not reuse the helper adapter (no dual ownership)')
      }

      // (g) end the mihomo session + process.
      await driver.stopMihomoProbe()
      state.mihomoStopped = true

      // (h) close our own creator handle (the only 0.14.1 removal op).
      await driver.closeCreatorHandle()
      state.creatorClosed = true

      // (i) the probe-created adapter must now be gone.
      adapterGone = !(await driver.adapterStillPresent(identity))

      draft = {
        ...emptyDraft(),
        startedAt,
        wintunDllSha256: dll.digest,
        wintunDllSha256Verified: true,
        adapterName: identity.name,
        requestedGuid: identity.requestedGuid,
        canonicalLuid: identity.canonicalLuid,
        helperPid: driver.pid,
        mihomoPid: reuse.pid,
        matchingAdapterCount,
        mihomoReusedSameGuidLuid: reuse.reused,
        observed: adapterGone ? 'A' : 'B',
        creatorHandleClosed: state.creatorClosed,
        adapterGone,
        errorCode
      }
    }
  } catch (error) {
    errorCode = errorCode === G1ErrorCode.none ? G1ErrorCode.crash : errorCode
    draft = {
      ...emptyDraft(),
      startedAt,
      adapterName: state.identity?.name ?? null,
      requestedGuid: state.identity?.requestedGuid ?? null,
      canonicalLuid: state.identity?.canonicalLuid ?? null,
      helperPid: driver.pid,
      mihomoPid: state.pid ?? null,
      matchingAdapterCount,
      mihomoReusedSameGuidLuid: null,
      observed: adapterGone == null ? null : adapterGone ? 'A' : 'B',
      creatorHandleClosed: state.creatorClosed,
      adapterGone,
      errorCode
    }
  } finally {
    // (j) ALWAYS enter finally-cleanup. Only a strict identity match may tear down
    // a Wintun resource; a mismatch is a no-op that records the conflict.
    let live: G1AdapterIdentity | null = null
    try {
      live = await driver.liveAdapterIdentity()
    } catch {
      live = null
    }
    const acceptable = cleanupAllowed(live, state.identity)
    // A live adapter that no longer matches the recorded creation identity is a
    // conflict: we refuse to touch it (fail closed) and record it. Prefer the
    // conflict code over a generic crash, but keep a specific probe failure.
    if (live !== null && !acceptable) {
      if (errorCode === G1ErrorCode.none || errorCode === G1ErrorCode.crash) {
        errorCode = G1ErrorCode.identityConflict
      }
    }
    try {
      await driver.cleanup(acceptable)
      cleanupSucceeded = !(live !== null && !acceptable)
    } catch {
      cleanupSucceeded = false
    }
    const networkAfter = await driver.captureNetworkSnapshot()
    networkUnchanged = driver.networkDiff(networkBefore, networkAfter).length === 0
    // If the read-only snapshot shows a route/DNS/proxy/firewall change, the
    // probe mutated the host: record it (a serious fail-closed finding).
    if (!networkUnchanged && errorCode === G1ErrorCode.none) {
      errorCode = G1ErrorCode.networkMutated
    }
  }

  // Assemble AFTER cleanup/network resolution so the final record carries them.
  draft.errorCode = errorCode
  return buildG1Evidence(opts.identifiers, driver.architecture, true, draft, cleanupSucceeded, networkUnchanged, finishedAt())
}
