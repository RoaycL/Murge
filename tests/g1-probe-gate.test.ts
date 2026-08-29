import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(process.cwd(), 'scripts/g1-probe-gate.mjs')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const validEnvironment = {
  ...process.env,
  MURGE_TUN_ACKNOWLEDGEMENT: 'I AUTHORIZE MURGE G1 WINTUN PROBE',
  MURGE_TUN_AUTHORIZATION_REF: 'change/phase9-g1-001',
  MURGE_TUN_TARGET_ASSET_ID: 'lab/windows-vm-01',
  MURGE_TUN_SNAPSHOT_ID: 'snapshot/pre-g1-001',
  MURGE_TUN_RECOVERY_METHOD: 'ilo/console-and-snapshot-restore'
}

describe('G1 probe authorization gate scaffold', () => {
  it('emits sanitized validation-only evidence and never claims execution', () => {
    const directory = mkdtempSync(join(tmpdir(), 'g1-gate-test-'))
    temporaryDirectories.push(directory)
    const evidencePath = join(directory, 'evidence.json')
    const output = execFileSync(process.execPath, [script, '--validate-only', '--allow-non-windows-validation', '--evidence', evidencePath], {
      env: validEnvironment,
      encoding: 'utf8'
    })
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { probeExecuted: boolean; mode: string }
    expect(output).toContain('G1_PROBE_EXECUTED=false')
    expect(evidence).toMatchObject({ probeExecuted: false, mode: 'validation-only' })
  })

  it('fails closed without the exact acknowledgement', () => {
    expect(() => execFileSync(process.execPath, [script, '--validate-only', '--allow-non-windows-validation'], {
      env: { ...validEnvironment, MURGE_TUN_ACKNOWLEDGEMENT: 'yes' },
      stdio: 'pipe'
    })).toThrow()
  })

  it('refuses every non-validation invocation', () => {
    expect(() => execFileSync(process.execPath, [script, '--allow-non-windows-validation'], {
      env: validEnvironment,
      stdio: 'pipe'
    })).toThrow()
  })

  it('contains no Wintun, route, DNS, process-spawn or network implementation', () => {
    const source = readFileSync(script, 'utf8')
    expect(source).not.toMatch(/Wintun(?:Create|Open|Close)|child_process|spawn\s*\(|execFile|netsh|SetIpForwardEntry|SetInterfaceDnsSettings|fetch\s*\(|WebSocket/)
  })
})
