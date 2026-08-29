/**
 * Standalone, gated G1 probe entry point (`--execute-g1-probe`).
 *
 * This is the ONLY module that wires the pure orchestrator to the real driver.
 * It is deliberately never imported from `src/main/index.ts`, `src/preload` or
 * the IPC handlers, so the app bundle never contains it. It is also the only
 * path that could touch the OS — and it refuses to do so unless EVERY gate in
 * `evaluateG1Gates` passes, at which point the probe runs on the gated
 * `murge-tun-lab` self-hosted Windows lab behind the protected `phase9-tun-lab`
 * environment. On the dev machine or in normal CI the gates deny first (no DLL,
 * no mihomo, no network change).
 *
 * Usage: node g1-probe-runner.ts --execute-g1-probe [--evidence <path>]
 *   env: MURGE_RUN_REAL_TUN=1
 *        MURGE_TUN_ACKNOWLEDGEMENT="I AUTHORIZE MURGE G1 WINTUN PROBE"
 *        MURGE_TUN_LAB_RUNNER=murge-tun-lab
 *        MURGE_TUN_AUTHORIZATION_REF / MURGE_TUN_TARGET_ASSET_ID
 *        MURGE_TUN_SNAPSHOT_ID / MURGE_TUN_RECOVERY_METHOD
 *        MURGE_TUN_PROBE_NAME / MURGE_TUN_PROBE_REQUESTED_GUID
 */

import { writeFile } from 'node:fs/promises'
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
 * Run the G1 CLI. Returns the exit code (0 = clean, 1 = probe ran with a
 * failure, 2 = gate/validation denial). Never calls process.exit itself.
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
    const path = argv[evidenceIndex + 1]
    await writeFile(path, evidenceJson, 'utf8')
    write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\nG1_EVIDENCE=${path}\n`)
  } else {
    write(`G1_PROBE_EXECUTED=${evidence.probeExecuted}\n`)
    write(`${evidenceJson}\n`)
  }

  return evidence.errorCode === G1ErrorCode.none ? 0 : 1
}
