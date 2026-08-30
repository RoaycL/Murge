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
import { isAbsolute, relative, resolve, dirname, basename, sep } from 'node:path'
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
 *  - path escaping the evidence directory (absolute-path or parent escape),
 *  - a missing / symlinked / non-directory evidence base,
 *  - the target directory (or any directory between base and target) resolving
 *    OUTSIDE the canonical base, i.e. escaping through a symlink,
 *  - the target already existing (overwrite is rejected).
 *
 * Canonicalisation: containment is decided against the REAL (symlink-resolved)
 * base directory (`realpath`), NOT against a string equality of the resolved
 * strings — so a legitimate base under a symlinked prefix (e.g. macOS `/var`
 * -> `/private/var`, or Windows short/8.3 paths and case differences) is NOT a
 * false "reparse point" rejection (P1-5). The returned `path` is the
 * non-canonicalised resolved target (the exact path the caller will write).
 *
 * Returns the safe absolute path (plus the canonical base for a TOCTOU re-check)
 * on success.
 */
export async function resolveSafeEvidencePath(
  rawPath: string,
  baseDir: string
): Promise<{ path: string; baseReal: string } | { error: string }> {
  const base = resolve(baseDir)
  const target = resolve(rawPath)

  // The evidence base must be a real, non-symlinked directory.
  const baseStat = await lstat(base).catch(() => null)
  if (!baseStat) {
    return { error: 'evidence base is not a real directory' }
  }
  if (baseStat.isSymbolicLink()) {
    return { error: 'evidence base is a symbolic link' }
  }
  if (!baseStat.isDirectory()) {
    return { error: 'evidence base is not a directory' }
  }

  // Canonical base, used ONLY for containment (never as a reparse criterion).
  const baseReal = await realpath(base).catch(() => base)

  // A path that is exactly the base directory (or a parent) is never a safe
  // single-file target.
  const fileName = basename(target)
  if (!fileName || fileName === '.' || fileName === '..') {
    return { error: 'evidence path must name a single file below the evidence directory' }
  }

  // Canonicalise the target's parent directory: `realpath` fully resolves every
  // symlink between the filesystem root and the parent, so a symlink that escapes
  // the base yields a parent outside baseReal, which the containment check rejects.
  const targetDir = dirname(target)
  const targetDirReal = await realpath(targetDir).catch(() => null)
  if (targetDirReal === null) {
    return { error: 'evidence target directory does not exist' }
  }
  const relDir = relative(baseReal, targetDirReal)
  if (relDir === '..' || relDir.startsWith('..' + sep) || isAbsolute(relDir)) {
    return { error: 'evidence path escapes the evidence directory' }
  }

  // Overwrite-existing is rejected (exclusive create). Note: the OS-level 'wx'
  // write below also atomically fails (EEXIST) if the name is taken, so a symlink
  // planted at the final component is never followed.
  const targetStat = await lstat(target).catch(() => null)
  if (targetStat) {
    return { error: 'evidence file already exists (overwrite rejected)' }
  }

  return { path: target, baseReal }
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
    // TOCTOU hardening: between the validation above and this write the target
    // parent could be swapped to a symlink that escapes the evidence directory.
    // Re-canonicalise the parent's real path immediately before the exclusive
    // create; if it no longer sits inside the canonical base, refuse to write.
    const parentRealNow = await realpath(dirname(resolved.path)).catch(() => null)
    if (parentRealNow === null) {
      write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\nG1_EVIDENCE_DENIED:evidence directory vanished\n`)
      write(`${evidenceJson}\n`)
      return 1
    }
    const relNow = relative(resolved.baseReal, parentRealNow)
    if (relNow === '..' || relNow.startsWith('..' + sep) || isAbsolute(relNow)) {
      write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\nG1_EVIDENCE_DENIED:evidence directory was swapped (escape)\n`)
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
