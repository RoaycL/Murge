import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('RC Windows upgrade matrix', () => {
  it('is explicit, Windows-only, bounded, and never enables network takeover', async () => {
    const script = await readFile(path.join(root, 'scripts/rc-upgrade-matrix.ps1'), 'utf8')
    expect(script).toContain("$env:GITHUB_ACTIONS -ne 'true'")
    expect(script).toContain("$env:MURGE_RUN_RC_MATRIX -ne '1'")
    expect(script).toContain('WaitForExit')
    expect(script).toContain('taskkill.exe')
    expect(script).toContain('profile sentinel did not survive upgrade')
    expect(script).toContain('install/upgrade changed system proxy without user intent')
    expect(script).toContain('privileged service remains after uninstall')
    expect(script).not.toContain('--system-proxy-enable')
    expect(script).not.toContain('--execute-g1-probe')
  })

  it('requires the owner-approved unsigned candidate policy and checks out the immutable candidate tag', async () => {
    const workflow = await readFile(path.join(root, '.github/workflows/rc-upgrade-matrix.yml'), 'utf8')
    expect(workflow).toContain('ref: ${{ inputs.candidate_tag }}')
    expect(workflow).toContain("$signature.Status -ne 'NotSigned'")
    expect(workflow).toContain('Get-FileHash -Algorithm SHA256')
    expect(workflow).toContain('timeout-minutes: 20')
  })
})
