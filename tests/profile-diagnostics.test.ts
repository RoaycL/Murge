import { describe, expect, it } from 'vitest'
import { profileCompatibilityDiagnostics } from '../src/main/profiles/profile-diagnostics'

describe('profileCompatibilityDiagnostics', () => {
  it('warns without rejecting obsolete top-level settings and reports their lines', () => {
    const issues = profileCompatibilityDiagnostics('mode: rule\nglobal-client-fingerprint: chrome\nudp: true\nrules: [MATCH,DIRECT]\n')
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'warning', line: 2, message: expect.stringContaining('不会生效') }),
      expect.objectContaining({ severity: 'warning', line: 3, message: expect.stringContaining('不会生效') })
    ])
  })

  it('does not mistake nested proxy udp/client-fingerprint fields for obsolete globals', () => {
    expect(profileCompatibilityDiagnostics('proxies:\n  - name: p\n    udp: true\n    client-fingerprint: chrome\n')).toEqual([])
  })
})
