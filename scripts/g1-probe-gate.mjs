#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'

const EXACT_ACK = 'I AUTHORIZE MURGE G1 WINTUN PROBE'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/

function fail(message) {
  process.stderr.write(`G1_GATE_DENIED: ${message}\n`)
  process.exitCode = 2
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const validateOnly = process.argv.includes('--validate-only')
const allowNonWindows = process.argv.includes('--allow-non-windows-validation')
const evidencePath = argValue('--evidence')

if (!validateOnly) {
  fail('this scaffold supports validation only; the real Wintun probe is not implemented')
} else if (process.platform !== 'win32' && !allowNonWindows) {
  fail('validation must run on the approved Windows lab host')
} else {
  const authorizationRef = process.env.MURGE_TUN_AUTHORIZATION_REF ?? ''
  const targetAssetId = process.env.MURGE_TUN_TARGET_ASSET_ID ?? ''
  const snapshotId = process.env.MURGE_TUN_SNAPSHOT_ID ?? ''
  const recoveryMethod = process.env.MURGE_TUN_RECOVERY_METHOD ?? ''
  const acknowledgement = process.env.MURGE_TUN_ACKNOWLEDGEMENT ?? ''

  const fields = { authorizationRef, targetAssetId, snapshotId, recoveryMethod }
  for (const [name, value] of Object.entries(fields)) {
    if (!SAFE_ID.test(value)) {
      fail(`${name} is missing or is not a safe identifier`)
      break
    }
  }

  if (!process.exitCode && acknowledgement !== EXACT_ACK) {
    fail('exact owner acknowledgement is missing')
  }

  if (!process.exitCode) {
    const evidence = {
      schemaVersion: 1,
      mode: 'validation-only',
      probeExecuted: false,
      authorizationRef,
      targetAssetId,
      snapshotId,
      recoveryMethod,
      actor: process.env.GITHUB_ACTOR || 'local-validation',
      runId: process.env.GITHUB_RUN_ID || null,
      validatedAt: new Date().toISOString()
    }
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    process.stdout.write(`G1_GATE_VALIDATED=${JSON.stringify(evidence)}\n`)
    process.stdout.write('G1_PROBE_EXECUTED=false\n')
  }
}
