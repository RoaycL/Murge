/**
 * Gated G1 probe entry point (`--execute-g1-probe`).
 *
 * This module is the ONLY one that wires the pure orchestrator to the real
 * driver. It is deliberately never imported from `src/main/index.ts`,
 * `src/preload` or the IPC handlers, so the app bundle never contains it.
 *
 * IMPORTANT — this is NOT a directly `node`-runnable complete CLI bootstrap. It
 * exports `runG1ProbeCli` (and helpers) for an EXPLICIT, owner-approved external
 * harness that lives outside the app bundle (the `murge-tun-lab` self-hosted
 * Windows runner, behind the protected `phase9-tun-lab` env). Without that
 * harness it does nothing and cannot be invoked as a standalone script; the file
 * is non-executable by design.
 *
 * Gate model (deliverable B): it refuses to touch the OS unless EVERY gate in
 * `evaluateG1Gates` passes. On the dev machine or in normal CI the gates deny
 * first (no DLL, no mihomo, no network change).
 */

import { lstat, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import {
  evaluateG1Gates,
  runG1Probe,
  canonicalizeGuid,
  G1ErrorCode,
  type G1Evidence,
  type G1ProbeDriver,
  type G1RunOptions
} from './g1-probe'
import { WINTUN_TUNNEL_TYPE } from './wintun-abi'

export interface G1ProbeCliDeps {
  argv: readonly string[]
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  /** Output sink (defaults to process.stdout.write). */
  write?: (chunk: string) => void
  /** Driver factory, defaulting to the real driver (lazily loaded). */
  driveProbe?: (opts: G1RunOptions) => Promise<G1Evidence>
}

function validateTarget(env: Record<string, string | undefined>): { ok: true; name: string; requestedGuid: string } | { ok: false; reason: string } {
  const name = env.MURGE_TUN_PROBE_NAME
  if (!name) return { ok: false, reason: 'missing MURGE_TUN_PROBE_NAME' }
  const requestedGuid = env.MURGE_TUN_PROBE_REQUESTED_GUID
  const canonicalGuid = requestedGuid ? canonicalizeGuid(requestedGuid) : null
  if (!canonicalGuid) return { ok: false, reason: 'missing or invalid MURGE_TUN_PROBE_REQUESTED_GUID' }
  return { ok: true, name, requestedGuid: canonicalGuid }
}

/**
 * Resolve `rawPath` to an evidence write target that is provably inside
 * `baseDir` and safe to create exclusively. Rejects (returns an error message,
 * never writes) on:
 *  - path escaping the evidence directory (absolute-path escape),
 *  - a missing / symlinked / reparse-point evidence base directory,
 *  - any symlink or reparse point traversed between baseDir and the target,
 *  - the target already existing (overwrite is rejected).
 * Returns the safe absolute path on success.
 */
export async function resolveSafeEvidencePath(
  rawPath: string,
  baseDir: string
): Promise<{ path: string } | { error: string }> {
  const base = resolve(baseDir)
  const target = resolve(rawPath)
  // Exact containment: the target must sit strictly inside baseDir.
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { error: 'evidence path escapes the evidence directory' }
  }
  // The evidence base must be a real, non-symlinked directory.
  const baseStat = await lstat(base).catch(() => null)
  if (!baseStat || baseStat.isSymbolicLink()) {
    return { error: 'evidence base is not a real directory' }
  }
  if (!baseStat.isDirectory()) {
    return { error: 'evidence base is not a directory' }
  }
  const baseReal = await realpath(base).catch(() => base)
  if (baseReal !== base) {
    return { error: 'evidence base is a reparse point or symlink' }
  }
  // No path component between baseDir and the target may be a symlink/reparse.
  let cur = dirname(target)
  while (cur.length > base.length) {
    const st = await lstat(cur).catch(() => null)
    if (st && st.isSymbolicLink()) {
      return { error: 'evidence path traverses a symlink' }
    }
    const next = dirname(cur)
    if (next === cur) break
    cur = next
  }
  // Overwrite-existing is rejected (exclusive create).
  const targetStat = await lstat(target).catch(() => null)
  if (targetStat) {
    return { error: 'evidence file already exists (overwrite rejected)' }
  }
  return { path: target }
}

/**
 * Run the G1 CLI. Returns the exit code:
 *   0 = probe ran clean,
 *   1 = probe ran but reported a failure (or the evidence path was unsafe /
 *       the evidence directory was unset, in which case evidence goes to stdout),
 *   2 = gate/validation denial (no driver call).
 * Never calls process.exit itself.
 */
export async function runG1ProbeCli(deps: G1ProbeCliDeps): Promise<number> {
  const { argv, env, platform } = deps
  const write = deps.write ?? ((chunk: string) => process.stdout.write(chunk))
  const gates = evaluateG1Gates({ argv, platform, env })

  if (!gates.allowed) {
    write(`G1_PROBE_EXECUTED=false\nG1_GATE_DENIED:${gates.deniedReason}\n`)
    return 2
  }

  const target = validateTarget(env)
  if (!target.ok) {
    write(`G1_PROBE_EXECUTED=false\nG1_GATE_DENIED:${target.reason}\n`)
    return 2
  }

  const identifiers = {
    authorizationRef: env.MURGE_TUN_AUTHORIZATION_REF as string,
    targetAssetId: env.MURGE_TUN_TARGET_ASSET_ID as string,
    snapshotId: env.MURGE_TUN_SNAPSHOT_ID as string,
    recoveryMethod: env.MURGE_TUN_RECOVERY_METHOD as string
  }

  const driveProbe =
    deps.driveProbe ??
    (async (opts: G1RunOptions) => {
      const { createRealG1ProbeDriver } = await import('./g1-driver')
      const driver: G1ProbeDriver = createRealG1ProbeDriver()
      return await runG1Probe(driver, opts)
    })

  const evidence = await driveProbe({
    gates,
    identifiers,
    target: { name: target.name, requestedGuid: target.requestedGuid },
    tunnelType: WINTUN_TUNNEL_TYPE,
    reuseTimeoutMs: 20_000
  })

  const evidenceJson = JSON.stringify(evidence, null, 2)
  const evidenceIndex = argv.indexOf('--evidence')

  if (evidenceIndex !== -1 && argv[evidenceIndex + 1]) {
    const rawPath = argv[evidenceIndex + 1]
    // Evidence may only be written into a verified RUNNER_TEMP / dedicated dir.
    const evidenceDir = env.MURGE_TUN_EVIDENCE_DIR ?? env.RUNNER_TEMP
    if (!evidenceDir) {
      write(
        `G1_PROBE_EXECUTED=${evidence.probeExecuted}\n` +
          'G1_EVIDENCE_DENIED:no evidence directory (set MURGE_TUN_EVIDENCE_DIR or RUNNER_TEMP)\n'
      )
      write(`${evidenceJson}\n`)
      return 1
    }
    const resolved = await resolveSafeEvidencePath(rawPath, evidenceDir)
    if ('error' in resolved) {
      write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\nG1_EVIDENCE_DENIED:${resolved.error}\n`)
      write(`${evidenceJson}\n`)
      return 1
    }
    // Exclusive create — overwrites are rejected atomically.
    await writeFile(resolved.path, evidenceJson, { flag: 'wx' })
    write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\nG1_EVIDENCE=${resolved.path}\n`)
  } else {
    write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\n`)
    write(`${evidenceJson}\n`)
  }

  return evidence.errorCode === G1ErrorCode.none ? 0 : 1
}
