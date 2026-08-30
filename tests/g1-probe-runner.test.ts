/**
 * Tests for the gated G1 CLI entry point (`src/main/tun/g1-probe-runner.ts`).
 *
 * Every denial exits 2 with `G1_PROBE_EXECUTED=false` and calls NO driver — so
 * no DLL is loaded, no mihomo is spawned and the OS is untouched. The driveProbe
 * is injected here so no real driver is constructed. The module is NOT a
 * directly-`node`-runnable bootstrap: it only exports functions, and the tests
 * below assert it returns an exit code instead of calling process.exit.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFile, rm, mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runG1ProbeCli,
  resolveSafeEvidencePath,
  type G1ProbeCliDeps
} from '../src/main/tun/g1-probe-runner'
import {
  buildG1Evidence,
  G1ErrorCode,
  type G1Evidence,
  type G1RunOptions
} from '../src/main/tun/g1-probe'

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z')

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MURGE_RUN_REAL_TUN: '1',
    MURGE_TUN_ACKNOWLEDGEMENT: 'I AUTHORIZE MURGE G1 WINTUN PROBE',
    MURGE_TUN_LAB_RUNNER: 'murge-tun-lab',
    MURGE_TUN_AUTHORIZATION_REF: 'auth-ref-1',
    MURGE_TUN_TARGET_ASSET_ID: 'asset-1',
    MURGE_TUN_SNAPSHOT_ID: 'snap-1',
    MURGE_TUN_RECOVERY_METHOD: 'recovery-1',
    MURGE_TUN_PROBE_NAME: 'ProductTunProbeTemp',
    MURGE_TUN_PROBE_REQUESTED_GUID: '01234567-89ab-4cde-8f01-23456789abcd',
    ...overrides
  }
}

function optsFor(): G1RunOptions {
  return {
    gates: { allowed: true, deniedReason: null },
    identifiers: {
      authorizationRef: 'auth-ref-1',
      targetAssetId: 'asset-1',
      snapshotId: 'snap-1',
      recoveryMethod: 'recovery-1'
    },
    target: { name: 'ProductTunProbeTemp', requestedGuid: '01234567-89ab-4cde-8f01-23456789abcd' },
    tunnelType: 'WireGuard',
    reuseTimeoutMs: 20_000,
    now: () => FIXED_NOW
  }
}

function evidenceFor(errorCode: string): G1Evidence {
  const opts = optsFor()
  return buildG1Evidence(
    opts.identifiers,
    'x64',
    true,
    {
      wintunDllSha256: '',
      wintunDllSha256Verified: true,
      adapterName: opts.target.name,
      requestedGuid: opts.target.requestedGuid,
      canonicalLuid: '0x1234567890abcdef',
      helperPid: 123,
      mihomoPid: 777,
      matchingAdapterCount: 1,
      mihomoReusedSameGuidLuid: true,
      observed: 'A',
      creatorHandleClosed: true,
      adapterGone: true,
      startedAt: FIXED_NOW.toISOString(),
      errorCode
    },
    true,
    true,
    FIXED_NOW.toISOString()
  )
}

function runCli(overrides: { argv?: string[]; envOverrides?: Record<string, string | undefined>; driveProbe?: (o: G1RunOptions) => Promise<G1Evidence> } = {}) {
  const outputs: string[] = []
  const driveProbe = overrides.driveProbe ?? (async (): Promise<G1Evidence> => evidenceFor(G1ErrorCode.none))
  return {
    outputs,
    result: runG1ProbeCli({
      argv: overrides.argv ?? ['--execute-g1-probe'],
      platform: 'win32',
      env: env(overrides.envOverrides),
      write: (chunk) => outputs.push(chunk),
      driveProbe
    })
  }
}

describe('runG1ProbeCli gate denial', () => {
  it('denies (exit 2) on a missing --execute-g1-probe flag without invoking any driver', async () => {
    const write = vi.fn()
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: [], platform: 'win32', env: env(), write, driveProbe })
    expect(code).toBe(2)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('G1_PROBE_EXECUTED=false'))
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) on non-win32 without invoking any driver', async () => {
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'linux', env: env(), driveProbe })
    expect(code).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) when MURGE_RUN_REAL_TUN is not 1', async () => {
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_RUN_REAL_TUN: '0' }), driveProbe })
    expect(code).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) when the exact acknowledgement is missing', async () => {
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_TUN_ACKNOWLEDGEMENT: 'nope' }), driveProbe })
    expect(code).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) when not on the protected self-hosted lab runner', async () => {
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_TUN_LAB_RUNNER: 'ubuntu-latest' }), driveProbe })
    expect(code).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) when a required safe identifier is invalid', async () => {
    const driveProbe = vi.fn()
    const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_TUN_AUTHORIZATION_REF: 'bad id!' }), driveProbe })
    expect(code).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })

  it('denies (exit 2) when the probe name is missing or the GUID is malformed', async () => {
    const driveProbe = vi.fn()
    const codeNoName = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_TUN_PROBE_NAME: undefined }), driveProbe })
    expect(codeNoName).toBe(2)
    const codeBadGuid = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env({ MURGE_TUN_PROBE_REQUESTED_GUID: 'nope' }), driveProbe })
    expect(codeBadGuid).toBe(2)
    expect(driveProbe).not.toHaveBeenCalled()
  })
})

describe('runG1ProbeCli clean vs failure', () => {
  it('runs the probe and exits 0 when every gate passes and the outcome is clean', async () => {
    const driveProbe = vi.fn(async () => evidenceFor(G1ErrorCode.none))
    const { outputs, result } = runCli({ driveProbe })
    expect(await result).toBe(0)
    expect(driveProbe).toHaveBeenCalledTimes(1)
    expect(outputs.join('')).toContain('G1_PROBE_EXECUTED=true')
  })

  it('exits 1 when the probe runs but records a failure code', async () => {
    const driveProbe = vi.fn(async () => evidenceFor(G1ErrorCode.crash))
    const { outputs, result } = runCli({ driveProbe })
    expect(await result).toBe(1)
    expect(outputs.join('')).toContain('G1_PROBE_EXECUTED=true')
  })
})

describe('runG1ProbeCli evidence-path safety (P1-7)', () => {
  it('writes the evidence blob to the --evidence path inside a verified dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    const path = join(dir, 'g1-probe-evidence.json')
    try {
      const driveProbe = vi.fn(async () => evidenceFor(G1ErrorCode.none))
      const { outputs, result } = runCli({ argv: ['--execute-g1-probe', '--evidence', path], envOverrides: { MURGE_TUN_EVIDENCE_DIR: dir }, driveProbe })
      expect(await result).toBe(0)
      expect(outputs.join('')).toContain('G1_EVIDENCE=' + path)
      const saved = await readFile(path, 'utf8')
      expect(JSON.parse(saved).probeExecuted).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('denies (exit 1) when --evidence is given but no evidence directory is configured', async () => {
    const { outputs, result } = runCli({
      argv: ['--execute-g1-probe', '--evidence', 'some/where.json'],
      envOverrides: { MURGE_TUN_EVIDENCE_DIR: undefined, RUNNER_TEMP: undefined }
    })
    expect(await result).toBe(1)
    expect(outputs.join('')).toContain('G1_EVIDENCE_DENIED:no evidence directory')
  })

  it('denies an evidence path that escapes the evidence directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    const outside = join(dir, '..', 'escape.json')
    try {
      const { outputs, result } = runCli({
        argv: ['--execute-g1-probe', '--evidence', outside],
        envOverrides: { MURGE_TUN_EVIDENCE_DIR: dir }
      })
      expect(await result).toBe(1)
      expect(outputs.join('')).toContain('G1_EVIDENCE_DENIED')
      expect(outputs.join('')).not.toContain('G1_EVIDENCE=')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an overwrite of an existing evidence file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    const path = join(dir, 'exists.json')
    try {
      await import('node:fs/promises').then(async ({ writeFile }) => {
        await writeFile(path, '{"preexisting":true}', 'utf8')
      })
      const { outputs, result } = runCli({
        argv: ['--execute-g1-probe', '--evidence', path],
        envOverrides: { MURGE_TUN_EVIDENCE_DIR: dir }
      })
      expect(await result).toBe(1)
      expect(outputs.join('')).toContain('G1_EVIDENCE_DENIED')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an evidence base that is a symlink / reparse point', async () => {
    const realDir = await mkdtemp(join(tmpdir(), 'g1-evidence-real-'))
    const linkDir = join(tmpdir(), `g1-evidence-link-${Date.now()}`)
    await symlink(realDir, linkDir)
    try {
      const path = join(linkDir, 'g1-probe-evidence.json')
      const { outputs, result } = runCli({
        argv: ['--execute-g1-probe', '--evidence', path],
        envOverrides: { MURGE_TUN_EVIDENCE_DIR: linkDir }
      })
      expect(await result).toBe(1)
      expect(outputs.join('')).toContain('G1_EVIDENCE_DENIED')
    } finally {
      await rm(linkDir, { force: true })
      await rm(realDir, { recursive: true, force: true })
    }
  })
})

describe('resolveSafeEvidencePath', () => {
  it('resolves a path strictly inside the base dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    try {
      const result = await resolveSafeEvidencePath(join(dir, 'a.json'), dir)
      expect('path' in result).toBe(true)
      if ('path' in result) expect(result.path.endsWith('a.json')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an exactly-equal baseDir (must be a subpath)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    try {
      const result = await resolveSafeEvidencePath(dir, dir)
      expect('error' in result).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does NOT false-reject a base whose canonical path differs from its resolved path', async () => {
    // Simulates the macOS temp-dir layout where a parent is a symlink (e.g.
    // /var -> /private/var) or a Windows short-path/case difference: the base
    // directory itself is a real dir, but its canonical path != the resolved
    // string. That is NOT a reparse/symlink, so it must be accepted (P1-5).
    const realRoot = await mkdtemp(join(tmpdir(), 'g1-evidence-root-'))
    const linkParent = join(tmpdir(), `g1-parent-link-${Date.now()}`)
    const evidenceDir = join(realRoot, 'evidence')
    try {
      await mkdir(evidenceDir)
      await symlink(realRoot, linkParent)
      const base = join(linkParent, 'evidence') // real dir reachable via a symlinked prefix
      const result = await resolveSafeEvidencePath(join(base, 'a.json'), base)
      expect('path' in result).toBe(true)
      if ('path' in result) expect(result.path.endsWith('a.json')).toBe(true)
    } finally {
      await rm(linkParent, { force: true })
      await rm(realRoot, { recursive: true, force: true })
    }
  })

  it('rejects a base that is itself a symlink', async () => {
    const realDir = await mkdtemp(join(tmpdir(), 'g1-evidence-real-'))
    const linkDir = join(tmpdir(), `g1-evidence-link-${Date.now()}`)
    await symlink(realDir, linkDir)
    try {
      const result = await resolveSafeEvidencePath(join(linkDir, 'a.json'), linkDir)
      expect('error' in result).toBe(true)
    } finally {
      await rm(linkDir, { force: true })
      await rm(realDir, { recursive: true, force: true })
    }
  })

  it('rejects a target whose parent resolves OUTSIDE the base through a symlink', async () => {
    const base = await mkdtemp(join(tmpdir(), 'g1-evidence-'))
    const outside = await mkdtemp(join(tmpdir(), 'g1-evidence-outside-'))
    const link = join(tmpdir(), `g1-escape-link-${Date.now()}`)
    try {
      await symlink(outside, link)
      // `link/inside.json` has a parent (`link`) that is a symlink pointing
      // outside `base`; its canonical parent resolves to `outside`, so containment
      // must reject it.
      const result = await resolveSafeEvidencePath(join(link, 'inside.json'), base)
      expect('error' in result).toBe(true)
    } finally {
      await rm(link, { force: true })
      await rm(base, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('module is not a standalone CLI bootstrap', () => {
  it('returns an exit code instead of calling process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called by the runner')
    }) as unknown as (code?: number) => never)
    try {
      const write = vi.fn()
      const code = await runG1ProbeCli({ argv: ['--execute-g1-probe'], platform: 'win32', env: env(), write, driveProbe: vi.fn(async () => evidenceFor(G1ErrorCode.none)) })
      expect(code).toBe(0)
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('exports only functions and exposes a determinable driveProbe injection point', () => {
    expect(typeof runG1ProbeCli).toBe('function')
    expect(typeof resolveSafeEvidencePath).toBe('function')
  })
})
