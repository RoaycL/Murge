#!/usr/bin/env node
// Owner-process crash worker for the system-proxy recovery fault-injection test.
//
// Spawned by tests/system-proxy-real.integration.test.ts as a DETACHED child on a
// real Windows runner. It behaves like the app's "owner" of an enabled system
// proxy: it records the pre-enable HKCU Internet Settings values, writes the
// owned backup to a caller-specified path (in the app's exact schema), applies
// the enabled proxy values, writes a durable evidence file, emits the crash
// marker, then SIGKILLs itself WITHOUT running any restore. Leaving the proxy
// enabled with a valid owned-backup on disk is exactly the condition the
// standalone recovery helper must be able to undo after the owner dies.
//
// It reuses the recovery helper's registery plumbing (readRegistry / applyRegistry
// / defaultRunner) so the enable + backup shape are not a private copy.
//
// CLI: node scripts/system-proxy-owner-crash.mjs --backup <owned-backup.json> --evidence <evidence.json>
import { writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRegistry, applyRegistry, defaultRunner } from './recover-system-proxy.mjs'

export const OWNER_CRASH_MARKER = 'SYSTEM-PROXY-OWNER-CRASHED'
export const TARGET = { host: '127.0.0.1', port: 7890 }

export const WRITTEN = {
  proxyEnable: { exists: true, type: 'REG_DWORD', value: 1 },
  proxyServer: {
    exists: true,
    type: 'REG_SZ',
    value: 'http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890'
  },
  proxyOverride: { exists: true, type: 'REG_SZ', value: '<local>;localhost' }
}

/**
 * Run the owner crash once. Writes the backup + evidence first, applies the
 * enabled proxy, then hard-kills this process. Never returns on success.
 *
 * @param {{ backupFile: string, evidenceFile: string, runner?: object, log?: (m:string)=>void }} opts
 */
export async function runOwnerCrash({ backupFile, evidenceFile, runner = defaultRunner(), log }) {
  const out = log ?? ((m) => process.stdout.write(`[owner-crash] ${m}\n`))
  if (runner.isWin === false) {
    out('not a Windows host; refusing to run the owner-crash worker')
    process.exitCode = 2
    return
  }

  // Pre-enable snapshot is the thing the recovery helper must restore to.
  const previous = await readRegistry(runner)

  const backup = {
    schemaVersion: 1,
    instanceId: 'owner-crash-worker',
    createdAt: new Date().toISOString(),
    target: TARGET,
    previous,
    written: WRITTEN
  }

  // Persist the backup BEFORE touching the registry so a crash at any later point
  // still leaves the recovery helper something to work from.
  await mkdir(dirname(backupFile), { recursive: true })
  await writeFile(backupFile, JSON.stringify(backup, null, 2) + '\n', 'utf8')

  await applyRegistry(runner, WRITTEN)
  const now = await readRegistry(runner)

  await mkdir(dirname(evidenceFile), { recursive: true })
  await writeFile(
    evidenceFile,
    JSON.stringify({ marker: OWNER_CRASH_MARKER, backupFile, previous, written: WRITTEN, observedAfterEnable: now, target: TARGET }, null, 2) + '\n',
    'utf8'
  )
  out(OWNER_CRASH_MARKER)

  // Hard crash the owner with no cleanup. The proxy stays enabled and the backup
  // stays on disk for the standalone recovery helper.
  process.kill(process.pid, 'SIGKILL')
}

function parseCli(argv) {
  const opts = { backupPath: null, evidencePath: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--backup') opts.backupPath = argv[++i]
    else if (argv[i] === '--evidence') opts.evidencePath = argv[++i]
  }
  return opts
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseCli(process.argv)
  runOwnerCrash({ backupFile: opts.backupPath, evidenceFile: opts.evidencePath }).catch((error) => {
    process.stderr.write(`[owner-crash] FAIL: ${error.message}\n`)
    process.exitCode = 1
  })
}
