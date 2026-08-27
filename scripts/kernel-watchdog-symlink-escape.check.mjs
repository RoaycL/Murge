#!/usr/bin/env node
// Standalone, vitest-free verification of the watchdog cleanup's symlink /
// junction / reparse-point escape protection, executed directly by `node` so it
// runs on the Windows CI runner where Node's native ESM loader imports the
// shared `kernel-watchdog-cleanup.mjs` (which vitest's Windows transform cannot
// do). On Windows the directory links below are created as real junctions
// (`symlink(..., 'junction')`); on POSIX they degrade to symlinks — in both
// cases `lstat().isSymbolicLink()` is true, so the same assertions hold.
//
// It proves that a crafted evidence file can never make the cleanup descend a
// link out of an allowed root, by real-filesystem assertions:
//   1. a symlinked/junctioned WORKSPACE is rejected AND its external target survives
//   2. a symlinked/junctioned configDir is rejected AND its external target survives
//   3. a mihomo-workspace-* CHILD that is a junction is unlinked (only the link),
//      so the directory it points at outside the root is not deleted
//   4. a normal real workspace is still cleaned end to end
// plus the validateEvidencePaths contract (absent = OK, realpath-outside = reject,
// real-inside = OK).
//
// Usage: node scripts/kernel-watchdog-symlink-escape.check.mjs

import { mkdtemp, rm, writeFile, access, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateEvidencePaths, cleanupKernel } from './kernel-watchdog-cleanup.mjs'

const TMP = tmpdir()

function fail(message) {
  throw new Error(`SYMLINK-ESCAPE CHECK FAILED: ${message}`)
}

async function assert(cond, message) {
  if (!cond) fail(message)
}

/** Deterministic, healthy mock runner (no residual mihomo, our ports released). */
function mockRunner() {
  return {
    isWin: true,
    sleep: async () => undefined,
    pidAlive: () => false,
    exec: async (tool) => {
      if (tool === 'tasklist') {
        return { stdout: '"svchost.exe","1234","Console","1","10,000 K"\r\n', stderr: '' }
      }
      if (tool === 'netstat') {
        return { stdout: '  TCP    0.0.0.0:44411    0.0.0.0:0    LISTENING    1234\n', stderr: '' }
      }
      throw new Error(`unexpected probe tool ${tool}`)
    }
  }
}

function evidence(workspace, configDir) {
  return {
    pid: 4444,
    controllerPort: 63001,
    mixedPort: 63002,
    workspace,
    configDir,
    binaryPath: 'C:\\tools\\mihomo.exe'
  }
}

const cleanupDirs = []
async function scratch() {
  const root = await mkdtemp(join(TMP, 'mihomo-root-'))
  cleanupDirs.push(root)
  return root
}

async function teardown() {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function log(...args) {
  process.stdout.write(`[symlink-escape] ${args.join(' ')}\n`)
}

async function main() {
  // ---------------------------------------------------------------------------
  // validateEvidencePaths contract
  // ---------------------------------------------------------------------------
  const absent = join(await scratch(), 'mihomo-real-absent')
  const absentResult = await validateEvidencePaths({ workspace: absent, configDir: join(absent, 'config') })
  await assert(absentResult.length === 0, `expected absent paths to be a non-problem, got ${absentResult}`)

  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const wsLink = join(root, 'mihomo-real-esc')
    await symlink(outside, wsLink, 'junction')
    const problems = await validateEvidencePaths(
      { workspace: wsLink, configDir: join(wsLink, 'config') },
      { allowedWorkspaceRoots: [root] }
    )
    await assert(
      problems.some((p) => p.includes('workspace is a symbolic link')),
      `expected workspace symlink rejection, got ${problems}`
    )
  }

  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfgLink = join(ws, 'config')
    await symlink(outside, cfgLink, 'junction')
    const problems = await validateEvidencePaths(
      { workspace: ws, configDir: cfgLink },
      { allowedWorkspaceRoots: [root] }
    )
    await assert(
      problems.some((p) => p.includes('configDir is a symbolic link')),
      `expected configDir symlink rejection, got ${problems}`
    )
  }

  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const problems = await validateEvidencePaths(
      { workspace: outside, configDir: join(outside, 'config') },
      { allowedWorkspaceRoots: [root] }
    )
    await assert(
      problems.some((p) => p.includes('outside allowed roots')),
      `expected outside-root rejection, got ${problems}`
    )
  }

  {
    const root = await scratch()
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    const result = await validateEvidencePaths(
      { workspace: ws, configDir: cfg },
      { allowedWorkspaceRoots: [root] }
    )
    await assert(result.length === 0, `expected real inside-root paths to be OK, got ${result}`)
  }

  // ---------------------------------------------------------------------------
  // cleanupKernel end-to-end (require-evidence, real junctions)
  // ---------------------------------------------------------------------------
  async function runCleanup(ev, allowedRoot) {
    const evidenceDir = await scratch()
    const evidencePath = join(evidenceDir, 'ev.json')
    await writeFile(evidencePath, JSON.stringify(ev), 'utf8')
    return cleanupKernel(evidencePath, {
      requireEvidence: true,
      log: () => undefined,
      runner: mockRunner(),
      allowedWorkspaceRoots: [allowedRoot]
    })
  }

  // (1) symlinked workspace -> reject, external sentinel preserved
  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    const wsLink = join(root, 'mihomo-real-esc')
    await symlink(outside, wsLink, 'junction')
    const ev = evidence(wsLink, join(wsLink, 'config'))
    const evidencePath = join(root, 'ev.json')
    await writeFile(evidencePath, JSON.stringify(ev), 'utf8')
    let rejected = false
    try {
      await cleanupKernel(evidencePath, { requireEvidence: true, log: () => undefined, runner: mockRunner(), allowedWorkspaceRoots: [root] })
    } catch (e) {
      await assert(
        /workspace is a symbolic link|workspace real path/.test(e.message),
        `workspace symlink reject message was: ${e.message}`
      )
      rejected = true
    }
    await assert(rejected, 'expected a symlinked workspace to be rejected under require-evidence')
    await access(sentinel)
    log('workspace junction -> rejected, external sentinel preserved')
  }

  // (2) symlinked configDir -> reject, external sentinel preserved
  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfgLink = join(ws, 'config')
    await symlink(outside, cfgLink, 'junction')
    const ev = evidence(ws, cfgLink)
    const evidencePath = join(root, 'ev.json')
    await writeFile(evidencePath, JSON.stringify(ev), 'utf8')
    let rejected = false
    try {
      await cleanupKernel(evidencePath, { requireEvidence: true, log: () => undefined, runner: mockRunner(), allowedWorkspaceRoots: [root] })
    } catch (e) {
      await assert(
        /configDir is a symbolic link|configDir real path/.test(e.message),
        `configDir symlink reject message was: ${e.message}`
      )
      rejected = true
    }
    await assert(rejected, 'expected a symlinked configDir to be rejected under require-evidence')
    await access(sentinel)
    log('configDir junction -> rejected, external sentinel preserved')
  }

  // (3) child mihomo-workspace-* junction -> unlink only the link, target preserved
  {
    const root = await scratch()
    const outside = await mkdtemp(join(TMP, 'mihomo-real-'))
    cleanupDirs.push(outside)
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    const childLink = join(cfg, 'mihomo-workspace-evil')
    await symlink(outside, childLink, 'junction')
    const result = await runCleanup(evidence(ws, cfg), root)
    await assert(result.action === 'cleaned' && result.verified, `expected cleaned+verified, got ${JSON.stringify(result)}`)
    // The child link is gone and the workspace was removed ...
    await access(ws).then(
      () => fail('workspace should be removed'),
      () => undefined
    )
    // ... but the external directory it pointed at was never touched.
    await access(sentinel)
    log('child mihomo-workspace-* junction -> link only removed, external target preserved')
  }

  // (4) normal real workspace still cleans end to end
  {
    const root = await scratch()
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    const child = join(cfg, 'mihomo-workspace-normal')
    await mkdir(child, { recursive: true })
    await writeFile(join(child, 'store.json'), '{}', 'utf8')
    const result = await runCleanup(evidence(ws, cfg), root)
    await assert(result.action === 'cleaned' && result.verified, `expected cleaned+verified, got ${JSON.stringify(result)}`)
    await access(ws).then(
      () => fail('workspace should be removed on a normal clean'),
      () => undefined
    )
    log('normal real workspace -> cleaned end to end')
  }

  await teardown()
  log('PASS: symlink/junction/reparse-point escape protection verified')
}

main().catch((error) => {
  process.stderr.write(`[symlink-escape] ${error.message}\n`)
  process.exitCode = 1
})
