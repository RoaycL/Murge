/**
 * G1 probe execution body + test frameworks — the pure, driver-driven core.
 *
 * This module implements the Windows G1 lifecycle probe as a **sequence of
 * injected driver steps** with zero OS side effects of its own. The driver
 * (`g1-driver.ts`) supplies the Wintun / mihomo / network primitives and is what
 * a test fakes. Everything here is platform-neutral and never blocks: the default
 * `npm test` / `npm run build` / app start / preload / IPC paths never import this
 * module (a static isolation test enforces it), so the probe can never run on the
 * Linux/Mac dev host or in normal CI.
 *
 * Hard gates (deliverable B) fail closed **before** any driver primitive is
 * called, so no DLL is loaded, no mihomo is spawned and the OS is untouched
 * unless every gate is satisfied.
 *
 * Corrected observation order (round-1 review P1-1):
 *   0. read-only preflight conflict check (P1-6) — zero change on any conflict;
 *   a. pinned DLL integrity (verified before the loader is reached);
 *   b. create the adapter and HOLD THE EXACT creator handle (P1-2);
 *   c. read the canonical identity from that handle (the cleanup key);
 *   d. mihomo opens the SAME adapter and establishes a provably active session — kept running;
 *   e. exactly one adapter matching the identity;
 *   f. confirm mihomo reused the SAME GUID+LUID with a live session;
 *   g. helper closes ITS OWN creator handle — mihomo KEEPS RUNNING;
 *   h. observe SIMULTANEOUSLY: adapter still present? session still active? still the same GUID+LUID?;
 *      Observed B is only valid when the creator handle is closed AND the session is still active (P1-1);
 *   i. stop mihomo (bounded graceful; exact PID);
 *   j. explicitly: stop mihomo -> read live identity -> close the exact handle only on strict match
 *      -> adapter presence + read-only network snapshot diff (P1-5).
 *
 * The orchestrator owns every timeout (P1-7) and maps every failure to an accurate
 * error code rather than degrading everything to `crash`.
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
 * A Wintun adapter handle as an opaque value. The real handle is a native pointer
 * carried by the binding; TS must NEVER re-derive its width or how it is passed
 * (P1-3). Only the binding creates and consumes it.
 */
export interface G1OpaqueHandle {
  readonly __g1OpaqueHandle: 'wintun-adapter'
}

/** The exact error a probe step can fail with. */
export const G1ErrorCode = {
  none: 'none',
  gateDenied: 'gate-denied',
  dllHashMismatch: 'dll-hash-mismatch',
  unsupported: 'unsupported',
  timeout: 'timeout',
  internal: 'internal',
  crash: 'crash',
  conflictPreflight: 'conflict-preflight',
  conflictDuplicate: 'conflict-duplicate',
  g1Failed: 'g1-failed',
  identityConflict: 'identity-conflict',
  networkMutated: 'network-mutated'
} as const
export type G1ErrorCode = (typeof G1ErrorCode)[keyof typeof G1ErrorCode]

/** A typed probe error so the orchestrator can map failures to accurate codes. */
export class G1ProbeError extends Error {
  constructor(
    public readonly code: G1ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'G1ProbeError'
  }
}

/** Read-only network snapshot (routes/DNS/proxy/firewall) — never mutated by the probe. */
export interface G1NetworkSnapshot {
  winhttpProxy: string
  internetSettingsProxy: string
  ipv4DefaultRoute: string
  ipv6DefaultRoute: string
  dnsServers: string
  activeAdapters: string
  firewallProfiles: string
}

/** Result of confirming mihomo reused the SAME adapter with a live session. */
export interface G1ReuseResult {
  reused: boolean
  pid: number | null
  sessionActive: boolean
  sameGuidLuid: boolean
}

/** Read-only, zero-change conflict preflight report (before any adapter is created). */
export interface G1ConflictReport {
  conflict: boolean
  reason: string | null
  sameNameCount: number
  sameGuidCount: number
  namePrefixCount: number
  leftoverProbeResources: number
}

export const G1_EMPTY_CONFLICT_REPORT: G1ConflictReport = {
  conflict: false,
  reason: null,
  sameNameCount: 0,
  sameGuidCount: 0,
  namePrefixCount: 0,
  leftoverProbeResources: 0
}

/**
 * Strict identity match — the ONLY predicate under which the probe may remove or
 * close a RECOVERED / re-opened / enumerated Wintun resource (P1-2). The current
 * live identity must agree on Name + RequestedGUID (case-insensitive) +
 * canonical LUID.
 *
 * This predicate does NOT gate the OWNED creator handle: the exact handle returned
 * by THIS call's WintunCreateAdapter is ours to close unconditionally, once, in
 * the finally (P1-2). It only governs resources the probe did not itself create.
 */
export function cleanupAllowed(
  current: G1AdapterIdentity | null,
  recorded: G1AdapterIdentity | null
): boolean {
  if (!current || !recorded) return false
  return (
    current.name === recorded.name &&
    current.requestedGuid.toLowerCase() === recorded.requestedGuid.toLowerCase() &&
    current.canonicalLuid === recorded.canonicalLuid
  )
}

/**
 * Strictly classify the simultaneous post-close observation (P1-4). Only two
 * outcomes are legal:
 *   - `A`: the adapter is GONE after the creator handle is closed;
 *   - `B`: the adapter SURVIVED AND the mihomo session is still active AND still
 *     bound to the same GUID+LUID.
 * Every other truth combination (including any unknown/null observation) is an
 * illegal combination and returns `null` — the orchestrator records `g1-failed`
 * rather than reporting a success or a mislabelled `A`.
 */
export function classifyObservation(
  adapterGone: boolean | null,
  sessionActive: boolean | null,
  sameGuidLuid: boolean | null
): 'A' | 'B' | null {
  if (adapterGone === true) return 'A'
  if (adapterGone === false && sessionActive === true && sameGuidLuid === true) return 'B'
  return null
}

/** Canonicalize a GUID string to lowercase form, or return null when invalid. */
export function canonicalizeGuid(value: string): string | null {
  const hex = value.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) return null
  const version = parseInt(hex.slice(12, 14), 16)
  const variant = parseInt(hex.slice(16, 18), 16)
  if ((version & 0xf0) !== 0x40) return null // must be RFC-4122 version 4
  if ((variant & 0xc0) !== 0x80) return null // must be RFC-4122 variant 8/9/a/b
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ]
  return groups.join('-').toLowerCase()
}

/**
 * The driver seam — supplies every Wintun / mihomo / network primitive as a
 * high-level, opaque call (P1-3). No GUID/NET_LUID/pointer width is re-derived in
 * TS; the native binding is the only ABI owner. Test drivers implement this
 * interface; the real driver fails closed to `unsupported`.
 */
export interface G1ProbeDriver {
  readonly architecture: string
  readonly pid: number

  /**
   * Every side-effecting primitive accepts an `AbortSignal` so the orchestrator can
   * cancel an in-flight op AND await its determined (settled) state on a step
   * timeout (P1-1). A signal-bearing op must settle once it can no longer produce a
   * late resource, or hand that resource back for reclamation. Read-only primitives
   * are not signal-bearing and are never aborted.
   */
  /** Read-only preflight conflict enumeration; zero change. */
  preflightConflictCheck(target: G1ProbeIdentityTarget): Promise<G1ConflictReport>

  /** (a) Verify the pinned DLL digest. Returns `verified:false` => never load. */
  loadPinnedWintun(): Promise<{ verified: boolean; digest: string }>

  /**
   * (b) Create the adapter and HOLD the exact creator handle. Accepts a signal so a
   * step timeout can cancel a late WintunCreateAdapter; the driver may still deliver
   * the exact handle after the abort, which the orchestrator reclaims (P1-1).
   */
  createAdapter(
    target: G1ProbeIdentityTarget & { tunnelType: string },
    signal?: AbortSignal
  ): Promise<G1OpaqueHandle>

  /** (c) Read the canonical identity (the cleanup key) from the handle. */
  readAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity>

  /** Re-read the live identity behind a still-open handle (null when closed). */
  liveAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity | null>

  /**
   * (d) Spawn the isolated mihomo that opens the SAME adapter; keep it running.
   * Accepts a signal so a timeout can cancel a late spawn (P1-1).
   */
  startMihomoProbe(identity: G1AdapterIdentity, signal?: AbortSignal): Promise<{ pid: number }>

  /** (e) Count adapters matching the identity. */
  matchingAdapterCount(identity: G1AdapterIdentity): Promise<number>

  /** (f) Confirm mihomo reused the SAME adapter with a live session. */
  pollMihomoReuse(identity: G1AdapterIdentity, timeoutMs: number): Promise<G1ReuseResult>

  /**
   * (i) Bounded graceful stop. Resolves `true` ONLY when the process is confirmed to
   * have exited (ChildProcess exit/close, or a PID liveness probe that reports it
   * gone); `false` when it cannot be confirmed. Accepts a signal so a timed-out
   * teardown can cancel the internal wait (P1-3).
   */
  stopMihomoProbe(timeoutMs: number, signal?: AbortSignal): Promise<boolean>

  /** (g) Close the EXACT creator handle (clears on success; idempotent). Accepts a signal (P1-1). */
  closeCreatorHandle(handle: G1OpaqueHandle, signal?: AbortSignal): Promise<void>

  /** (h) Is the adapter still present after the creator handle is closed? */
  adapterStillPresent(identity: G1AdapterIdentity): Promise<boolean>

  /** (h) Is the mihomo session still active after the creator handle close? */
  mihomoSessionActive(): Promise<boolean>

  /** (h) Is mihomo still bound to the same GUID+LUID? */
  mihomoStillBoundTo(identity: G1AdapterIdentity): Promise<boolean>

  /** Read-only network snapshot (never mutated by the probe). */
  captureNetworkSnapshot(): Promise<G1NetworkSnapshot>

  /** Compare before/after snapshots. Returns changed field names ([] = unchanged). */
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
  mihomoSessionActiveAfterClose: boolean | null
  mihomoStillSameGuidLuidAfterClose: boolean | null
  preflightConflict: boolean
  conflictReason: string | null
  networkUnchanged: boolean | null
  cleanupSucceeded: boolean | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string
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
 * Build a completed evidence record from a draft + the fields resolved only after
 * cleanup/network comparison. This is the only place evidence fields are
 * assembled, so the shape is always complete and the no-secret invariant holds
 * (the orchestrator never writes the controller secret).
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
    mihomoSessionActiveAfterClose: draft.mihomoSessionActiveAfterClose,
    mihomoStillSameGuidLuidAfterClose: draft.mihomoStillSameGuidLuidAfterClose,
    preflightConflict: draft.preflightConflict,
    conflictReason: draft.conflictReason,
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
  mihomoSessionActiveAfterClose: null,
  mihomoStillSameGuidLuidAfterClose: null,
  preflightConflict: false,
  conflictReason: null,
  startedAt: null,
  errorCode: ''
})

export interface G1RunOptions {
  /** Gate decision (from evaluateG1Gates). */
  gates: G1GateCheck
  /** The safety identifiers that must appear in evidence. */
  identifiers: { authorizationRef: string; targetAssetId: string; snapshotId: string; recoveryMethod: string }
  /** The adapter identity target (Name + fixed RequestedGUID). */
  target: G1ProbeIdentityTarget
  /** The tunnel type string. */
  tunnelType: string
  /** Timeout for the mihomo reuse poll. */
  reuseTimeoutMs: number
  /** Orchestrator-owned bound for every non-reuse step (P1-7). */
  stepTimeoutMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => Date
}

interface ProbeState {
  creatorCreated: boolean
  creatorClosed: boolean
  /** The exact handle THIS call's WintunCreateAdapter returned (owned; closed once). */
  handle: G1OpaqueHandle | null
  identity: G1AdapterIdentity | null
  mihomoAttempted: boolean
  mihomoStarted: boolean
  mihomoStopped: boolean
  /** Set only when stopMihomoProbe confirmed the process actually exited (P1-3). */
  mihomoStopConfirmed: boolean
  mihomoPid: number | null
  /** A timed-out operation produced a resource that could not be reclaimed. */
  cleanupFailed: boolean
}

const DEFAULT_STEP_TIMEOUT_MS = 15_000

interface RunStepLifecycle<T> {
  /**
   * Reclaim a resource a side-effecting op delivered AFTER a step timeout (the op
   * completed late). Registered BEFORE the op starts (P1-1): the orchestrator
   * passes a cleanup that closes the exact late handle / stops a late-spawned
   * process, so a late-success cannot leak an adapter or a mihomo process.
   */
  reclaimLate?: (value: T) => Promise<void> | void
}

/**
 * Run one step with an orchestrator-owned bound (P1-7). On timeout it ABORTS the
 * signal handed to `fn`, then waits for the op to reach a determined
 * cancelled/settled state — it never merely drops a still-running side-effecting
 * promise (P1-1). If that late op delivered a resource, `lifecycle.reclaimLate`
 * reclaims the exact value. A timeout still throws `timeout` to the caller.
 */
async function runStep<T>(
  label: string,
  timeoutMs: number,
  fn: (signal?: AbortSignal) => T | Promise<T>,
  lifecycle: RunStepLifecycle<T> = {}
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // `op` is created once and awaited both for the race and, on a timeout, to
  // await the same in-flight operation's settlement (never a second invocation).
  const op = Promise.resolve().then(() => fn(controller.signal))
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort()
        reject(new G1ProbeError(G1ErrorCode.timeout, `${label} timed out after ${timeoutMs}ms`))
      },
      timeoutMs
    )
  })
  try {
    return await Promise.race([op, timeout])
  } catch (err) {
    if (!(err instanceof G1ProbeError) || err.code !== G1ErrorCode.timeout || !lifecycle.reclaimLate) {
      throw err
    }
    // Safety wins over availability here: a side-effecting operation may not be
    // abandoned while it can still deliver a native handle or child process.
    // The driver/helper boundary is responsible for making abort settle; until it
    // does, the probe remains in teardown instead of returning a false clean result.
    const settled = await op.then(
      (value) => ({ kind: 'value' as const, value }),
      (error) => ({ kind: 'error' as const, error })
    )
    if (settled.kind === 'value' && settled.value !== null && settled.value !== undefined) {
      await lifecycle.reclaimLate(settled.value as T)
    }
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Map a thrown value to an accurate error code, or null when unrecognised. */
function classifyStepError(err: unknown): G1ErrorCode | null {
  if (err instanceof G1ProbeError) return err.code
  const msg = err instanceof Error ? err.message : String(err)
  for (const code of Object.values(G1ErrorCode)) {
    if (code === 'none') continue
    if (msg.startsWith(code)) return code
  }
  if (/timed out|timeout/i.test(msg)) return G1ErrorCode.timeout
  return null
}

/**
 * Run the G1 probe against an injected driver. This is the canonical a–j sequence
 * (P1-1). It never performs an OS operation itself and ALWAYS enters the explicit
 * finally-teardown (P1-5) on any failure, timeout or crash.
 *
 * - Gate denial returns immediately (`probeExecuted:false`) with no driver call.
 * - A DLL hash mismatch is detected *before* the DLL is loaded and aborts.
 * - A read-only conflict preflight aborts with zero change before any creation.
 * - If mihomo cannot be shown to reuse the SAME adapter with a live session, the
 *   probe stops with `g1-failed` and never lets mihomo create a second adapter.
 * - The OWNED creator handle (exactly what THIS call's WintunCreateAdapter
 *   returned) is closed unconditionally, at most once, in the finally — even when
 *   its identity could not be read (P1-2). Strict identity match (`cleanupAllowed`)
 *   governs only RECOVERED / enumerated resources, which this design never creates.
 * - mihomo is only "stopped" when stopMihomoProbe confirms the process actually
 *   exited; a false/unknown confirmation leaves mihomoStopped=false and marks
 *   cleanupSucceeded=false (P1-3).
 */
export async function runG1Probe(driver: G1ProbeDriver, opts: G1RunOptions): Promise<G1Evidence> {
  const now = opts.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const finishedAt = (): string => now().toISOString()
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS

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
    handle: null,
    identity: null,
    mihomoAttempted: false,
    mihomoStarted: false,
    mihomoStopped: false,
    mihomoStopConfirmed: false,
    mihomoPid: null,
    cleanupFailed: false
  }
  let observed: 'A' | 'B' | null = null
  let adapterGone: boolean | null = null
  let matchingAdapterCount: number | null = null
  let mihomoSessionActiveAfterClose: boolean | null = null
  let mihomoStillSameGuidLuidAfterClose: boolean | null = null
  let mihomoReusedSameGuidLuid: boolean | null = null
  let conflictReport: G1ConflictReport = G1_EMPTY_CONFLICT_REPORT
  let dll = { verified: false, digest: '' }
  let errorCode: G1ErrorCode = G1ErrorCode.none
  let networkBefore: G1NetworkSnapshot | null = null

  // Read-only baseline snapshot. A fault here just leaves the diff unverifiable
  // (networkUnchanged=null); it does not fail the probe, so the OS is never
  // touched on the basis of a snapshot helper.
  try {
    networkBefore = await runStep('captureNetworkSnapshot', stepTimeoutMs, () =>
      driver.captureNetworkSnapshot()
    )
  } catch {
    networkBefore = null
  }

  try {
    // (0) read-only preflight conflict check BEFORE any creation (P1-6).
    conflictReport = await runStep('preflightConflictCheck', stepTimeoutMs, () =>
      driver.preflightConflictCheck(opts.target)
    )
    if (conflictReport.conflict) {
      errorCode = G1ErrorCode.conflictPreflight
      throw new G1ProbeError(G1ErrorCode.conflictPreflight, conflictReport.reason ?? 'preflight conflict')
    }
    if (!conflictReport.conflict) {
      conflictReport = { ...G1_EMPTY_CONFLICT_REPORT } // normalise for evidence
    }

    // (a) pinned DLL integrity — verified before the loader is touched.
    const stepDll = await runStep('loadPinnedWintun', stepTimeoutMs, () => driver.loadPinnedWintun())
    dll = stepDll
    if (!dll.verified) {
      // Fail closed: never load the DLL, never create an adapter (deliverable B).
      errorCode = G1ErrorCode.dllHashMismatch
      throw new G1ProbeError(G1ErrorCode.dllHashMismatch, 'pinned DLL digest did not verify')
    }

    // (b) create the adapter and HOLD the exact creator handle (P1-2). The reclaim
    //     token is registered BEFORE the call starts: if WintunCreateAdapter is
    //     still delivering the exact handle after a step timeout, that late handle
    //     is reclaimed (closed) rather than leaked (P1-1).
    const handle = await runStep(
      'createAdapter',
      stepTimeoutMs,
      (signal) => driver.createAdapter({ ...opts.target, tunnelType: opts.tunnelType }, signal),
      {
        reclaimLate: async (lateHandle) => {
          try {
            await driver.closeCreatorHandle(lateHandle as G1OpaqueHandle)
          } catch {
            state.cleanupFailed = true
            throw new G1ProbeError(G1ErrorCode.identityConflict, 'late creator handle reclamation failed')
          }
        }
      }
    )
    state.handle = handle
    state.creatorCreated = true

    // (c) read the canonical identity — this becomes the cleanup key.
    const identity = await runStep('readAdapterIdentity', stepTimeoutMs, () =>
      driver.readAdapterIdentity(handle)
    )
    state.identity = identity

    // (d) mihomo opens the SAME adapter and establishes a provably active session; KEEP RUNNING.
    state.mihomoAttempted = true
    const mihomo = await runStep(
      'startMihomoProbe',
      stepTimeoutMs,
      (signal) => driver.startMihomoProbe(identity, signal),
      {
        // A late spawn after a timeout must not leave a stray mihomo process.
        reclaimLate: async () => {
          try {
            const stopped = await driver.stopMihomoProbe(stepTimeoutMs)
            if (!stopped) throw new Error('late mihomo process exit was not confirmed')
          } catch {
            state.cleanupFailed = true
            throw new G1ProbeError(G1ErrorCode.crash, 'late mihomo process reclamation failed')
          }
        }
      }
    )
    state.mihomoStarted = true
    state.mihomoStopConfirmed = false
    state.mihomoPid = mihomo.pid

    // (e) exactly one adapter matching the identity.
    const count = await runStep('matchingAdapterCount', stepTimeoutMs, () =>
      driver.matchingAdapterCount(identity)
    )
    matchingAdapterCount = count
    if (count > 1) {
      errorCode = G1ErrorCode.conflictDuplicate
      throw new G1ProbeError(G1ErrorCode.conflictDuplicate, 'more than one matching adapter')
    }
    if (count !== 1) {
      errorCode = G1ErrorCode.g1Failed
      throw new G1ProbeError(G1ErrorCode.g1Failed, 'no matching adapter found')
    }

    // (f) confirm mihomo reused the SAME adapter with a live, provably active session.
    const reuse = await runStep('pollMihomoReuse', stepTimeoutMs, () => driver.pollMihomoReuse(identity, opts.reuseTimeoutMs))
    mihomoReusedSameGuidLuid = reuse.reused && reuse.sameGuidLuid
    if (!reuse.reused || !reuse.sessionActive || !reuse.sameGuidLuid) {
      errorCode = G1ErrorCode.g1Failed
      throw new G1ProbeError(
        G1ErrorCode.g1Failed,
        'mihomo did not reuse the SAME adapter with a live active session'
      )
    }

    // (g) helper closes ITS OWN creator handle — mihomo KEEPS RUNNING.
    await runStep('closeCreatorHandle', stepTimeoutMs, (signal) => driver.closeCreatorHandle(handle, signal))
    state.creatorClosed = true

    // (h) SIMULTANEOUS observation after the creator-handle close:
    //     adapter present? session active? still the same GUID+LUID?
    const stillPresent = await runStep('adapterStillPresent', stepTimeoutMs, () =>
      driver.adapterStillPresent(identity)
    )
    adapterGone = !stillPresent
    mihomoSessionActiveAfterClose = await runStep('mihomoSessionActive', stepTimeoutMs, () =>
      driver.mihomoSessionActive()
    )
    mihomoStillSameGuidLuidAfterClose = await runStep('mihomoStillBoundTo', stepTimeoutMs, () =>
      driver.mihomoStillBoundTo(identity)
    )
    // Strict: only the exact truth combos map to A / B; every other combination is
    // an illegal observation and fails the probe (P1-4).
    observed = classifyObservation(adapterGone, mihomoSessionActiveAfterClose, mihomoStillSameGuidLuidAfterClose)
    if (observed === null) {
      errorCode = G1ErrorCode.g1Failed
      throw new G1ProbeError(
        G1ErrorCode.g1Failed,
        'illegal simultaneous observation: adapter state is not a valid A or B outcome'
      )
    }

    // (i) stop mihomo (bounded graceful; the driver terminates the exact PID on timeout).
    //     Honor the EXACT return: only a confirmed exit marks the process stopped (P1-3).
    // stopMihomoProbe owns its complete graceful -> force -> verify budget. Do not
    // wrap it in an equal outer timeout that could abort before SIGKILL executes.
    const stoppedOk = await driver.stopMihomoProbe(stepTimeoutMs)
    if (stoppedOk === true) {
      state.mihomoStopped = true
      state.mihomoStopConfirmed = true
    } else {
      // Cannot confirm mihomo exited. Do NOT mark it stopped; the finally will retry
      // and it is counted as a probe failure (cleanupSucceeded=false on a real miss).
      state.mihomoStopConfirmed = false
      errorCode = G1ErrorCode.crash
    }
  } catch (err) {
    errorCode = classifyStepError(err) ?? (errorCode === G1ErrorCode.none ? G1ErrorCode.crash : errorCode)
  } finally {
    // (j) EXPLICIT, independent teardown — no vague cleanup(boolean) (P1-5).
    let cleanupSucceeded: boolean | null = null

    // 1. Stop mihomo if it was ever started or spawned and is not yet confirmed
    //    stopped. Only a true return (confirmed exit) marks it stopped (P1-3).
    if (!state.mihomoStopped && (state.mihomoStarted || state.mihomoAttempted)) {
      let stopOk = false
      try {
        const stopped = await driver.stopMihomoProbe(stepTimeoutMs)
        stopOk = stopped === true
      } catch {
        stopOk = false
      }
      if (stopOk) {
        state.mihomoStopped = true
        state.mihomoStopConfirmed = true
      }
    }

    // 2. Re-read the LIVE identity behind the creator handle. This runs whenever a
    //    creator handle exists (the driver returns null once it is already closed,
    //    so a closed handle never re-triggers a close).
    let live: G1AdapterIdentity | null = null
    if (state.handle !== null) {
      try {
        live = await runStep('liveAdapterIdentity', stepTimeoutMs, () =>
          driver.liveAdapterIdentity(state.handle as G1OpaqueHandle)
        )
      } catch {
        live = null
      }
    }
    const acceptable = cleanupAllowed(live, state.identity)
    // 3. Close the OWNED creator handle — the EXACT handle THIS call's
    //    WintunCreateAdapter returned — unconditionally, at most once (P1-2).
    //    It is ours regardless of whether its identity could be read; the strict
    //    identity gate applies only to RECOVERED/enumerated resources, which this
    //    design never re-opens. Step (g) already closed it on the success path, so
    //    this is the single close for every fault/timeout boundary that follows (b).
    let closeResultOk = true
    if (state.handle !== null && !state.creatorClosed) {
      try {
        await runStep('closeCreatorHandle', stepTimeoutMs, (signal) =>
          driver.closeCreatorHandle(state.handle as G1OpaqueHandle, signal)
        )
        state.creatorClosed = true
      } catch {
        closeResultOk = false
      }
    }
    // Cleanup verdict (P1-3): we built an adapter that MUST be closed, and a mihomo
    // process that MUST be confirmed exited before we call the run clean. A false
    // stop confirmation (or an unconfirmable teardown) leaves cleanupSucceeded=false.
    const mihomoOk = state.mihomoStarted ? state.mihomoStopConfirmed : true
    const adapterOk = state.creatorCreated ? state.creatorClosed : true
    cleanupSucceeded =
      state.creatorCreated || state.mihomoStarted || state.cleanupFailed
        ? mihomoOk && adapterOk && closeResultOk && !state.cleanupFailed
        : null
    // A live identity that disagrees with the recorded target is an integrity
    // anomaly worth flagging (P1-2) — but it never blocks the OWNED-handle close above.
    if (
      live !== null &&
      state.identity !== null &&
      !acceptable &&
      (errorCode === G1ErrorCode.none || errorCode === G1ErrorCode.crash)
    ) {
      errorCode = G1ErrorCode.identityConflict
    }
    // 4. Adapter presence + read-only network snapshot diff (never assigns a value here).
    let networkUnchanged: boolean | null = null
    try {
      const networkAfter = await runStep('captureNetworkSnapshot', stepTimeoutMs, () =>
        driver.captureNetworkSnapshot()
      )
      if (networkBefore !== null) {
        const changed = await runStep('networkDiff', stepTimeoutMs, () =>
          driver.networkDiff(networkBefore as G1NetworkSnapshot, networkAfter)
        )
        networkUnchanged = changed.length === 0
      }
    } catch {
      networkUnchanged = null
    }
    if (networkUnchanged === false && errorCode === G1ErrorCode.none) {
      errorCode = G1ErrorCode.networkMutated
    }

    const draft: EvidenceDraft = {
      wintunDllSha256: dll.digest, // retain the verified (or detected) digest (P1-7)
      wintunDllSha256Verified: dll.verified,
      adapterName: state.identity?.name ?? null,
      requestedGuid: state.identity?.requestedGuid ?? null,
      canonicalLuid: state.identity?.canonicalLuid ?? null,
      helperPid: driver.pid,
      mihomoPid: state.mihomoPid,
      matchingAdapterCount,
      mihomoReusedSameGuidLuid,
      observed,
      creatorHandleClosed: state.creatorClosed,
      adapterGone,
      mihomoSessionActiveAfterClose,
      mihomoStillSameGuidLuidAfterClose,
      preflightConflict: conflictReport.conflict,
      conflictReason: conflictReport.reason ?? null,
      startedAt,
      errorCode
    }
    return buildG1Evidence(
      opts.identifiers,
      driver.architecture,
      true,
      draft,
      cleanupSucceeded,
      networkUnchanged,
      finishedAt()
    )
  }
}
