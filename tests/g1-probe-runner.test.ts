/**
 * Tests for the standalone gated G1 CLI (`src/main/tun/g1-probe-runner.ts`).
 *
 * Every denial exits 2 with `G1_PROBE_EXECUTED=false` and calls NO driver — so
 * no DLL is loaded, no mihomo is spawned and the OS is untouched. The
 * driveProbe is injected here so no real driver is constructed.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runG1ProbeCli,
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

function evidenceFor(opts: G1RunOptions, errorCode: string): G1Evidence {
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

function runCli(overrides: Partial<G1ProbeCliDeps> & { env?: Record<string, string | undefined> }) {
  const outputs: string[] = []
  const driveProbe = overrides.driveProbe ?? (async (opts: G1RunOptions) => evidenceFor(opts, G1ErrorCode.none))
  return {
    outputs,
    result: runG1ProbeCli({
      argv: ['--execute-g1-probe'],
      platform: 'win32',
      env: env(),
      write: (chunk) => outputs.push(chunk),
      driveProbe,
      ...overrides
    })
  }
}

describe('runG1ProbeCli', () => {
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

  it('runs the probe and exits 0 when every gate passes and the outcome is clean', async () => {
    const driveProbe = vi.fn(async (opts: G1RunOptions) => evidenceFor(opts, G1ErrorCode.none))
    const { outputs, result } = runCli({ driveProbe })
    expect(await result).toBe(0)
    expect(driveProbe).toHaveBeenCalledTimes(1)
    expect(outputs.join('')).toContain('G1_PROBE_EXECUTED=true')
  })

  it('exits 1 when the probe runs but records a failure code', async () => {
    const driveProbe = vi.fn(async (opts: G1RunOptions) => evidenceFor(opts, G1ErrorCode.crash))
    const { outputs, result } = runCli({ driveProbe })
    expect(await result).toBe(1)
    expect(outputs.join('')).toContain('G1_PROBE_EXECUTED=true')
  })

  it('writes the evidence blob to the --evidence path', async () => {
    const path = join(tmpdir(), `g1-probe-evidence-${Date.now()}.json`)
    try {
      const driveProbe = vi.fn(async (opts: G1RunOptions) => evidenceFor(opts, G1ErrorCode.none))
      const { outputs, result } = runCli({ argv: ['--execute-g1-probe', '--evidence', path], driveProbe })
      expect(await result).toBe(0)
      expect(outputs.join('')).toContain('G1_EVIDENCE=' + path)
      const saved = await readFile(path, 'utf8')
      expect(JSON.parse(saved).probeExecuted).toBe(true)
    } finally {
      await rm(path, { force: true })
    }
  })
})
